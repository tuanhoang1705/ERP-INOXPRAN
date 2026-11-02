import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, PayloadTooLargeException, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import {
  CreatePartnerSchema,
  CreateProductSchema,
  EmployeeInputSchema,
  ProductCategoryInputSchema,
  RegionInputSchema,
  sumAmounts,
} from '@inoxpran/contracts';
import { createHash } from 'node:crypto';
import Decimal from 'decimal.js';
import ExcelJS from 'exceljs';
import { ObjectId, type ClientSession, type Db, type Document } from 'mongodb';
import type { ZodType } from 'zod';
import { AuditService } from '../../../common/audit.service';
import { decimal, decimalString, toObjectId } from '../../../common/domain';
import { MalwareScanUnavailableError } from '../../../common/malware-scanner';
import { MalwareScannerService } from '../../../common/malware-scanner.service';
import { pageOf, type PageRequest } from '../../../common/paging';
import type { AuthenticatedRequest } from '../../../common/request-context';
import { SequenceService } from '../../../common/sequence.service';
import { MONGO_DATABASE } from '../../../common/tokens';
import { InventoryService } from '../../inventory/inventory.service';
import { addBodyRow, BRAND, brandSheet, tableHeader, titleBlock, type BrandColumn } from '../../../common/excel-brand';
import { cellText, IMPORT_SHEETS, issueMessage, normalize, parseCell, type ParsedValue, type SheetDef } from './import-sheets';

export const MAX_IMPORT_BYTES = 10 * 1024 * 1024;
const MAX_ERRORS = 500;
export type Row = { row: number; values: Record<string, ParsedValue> };
export interface ImportIssue { sheet: string; row: number; column: string; message: string }
/** NORMAL: tồn đầu kỳ chỉ nhập cho mã chưa có; ADJUST_OPENING: thay số tồn đầu kỳ đã nhập bằng số trong file (ghi phần chênh lệch). */
export type ImportMode = 'NORMAL' | 'ADJUST_OPENING';
export const importModeOf = (value: string | undefined): ImportMode => (value === 'adjust-opening' ? 'ADJUST_OPENING' : 'NORMAL');
/** Một dòng TON_DAU_KY ở chế độ điều chỉnh: đầu kỳ đang có → theo file. */
export interface OpeningAdjustment {
  row: number;
  warehouseCode: string;
  sku: string;
  previous: string;
  next: string;
  delta: string;
  previousInitial: string | null;
  nextInitial: string | null;
  /** Chênh lệch số nhập ban đầu ghi lên thẻ kho; null = mã mới chưa khai số này. */
  initialDelta: string | null;
  available: string;
  existed: boolean;
}
const changed = (row: OpeningAdjustment) => row.delta !== '0' || (row.initialDelta !== null && row.initialDelta !== '0');
export interface Parsed {
  sha256: string;
  sheets: Map<string, Row[]>;
  errors: ImportIssue[];
}
/** Mỗi ô chỉ báo lỗi đầu tiên (lỗi đọc ô → bỏ qua lỗi schema / chéo cùng ô). */
export function pushIssue(errors: ImportIssue[], entry: ImportIssue) {
  if (errors.length >= MAX_ERRORS) return;
  if (errors.some((row) => row.sheet === entry.sheet && row.row === entry.row && row.column === entry.column)) return;
  errors.push(entry);
}
/** Bản ghi đã có trong CSDL, theo mã. */
type Existing = Map<string, Document>;

const COLLECTION: Record<string, string> = { NHOM_HANG: 'product_categories', KHU_VUC: 'regions', NVKD: 'employees', NHA_CUNG_CAP: 'partners', SAN_PHAM: 'products', KHACH_HANG: 'partners' };
const sheetDef = (name: string) => IMPORT_SHEETS.find((sheet) => sheet.name === name) as SheetDef;
const label = (sheet: string, key: string) => sheetDef(sheet).columns.find((column) => column.key === key)?.label ?? key;
const present = (values: Record<string, ParsedValue>) => Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined && value !== ''));

/**
 * Nhập dữ liệu ban đầu từ Excel (giai đoạn 5): chạy thử → báo lỗi theo dòng / cột; ghi thật → upsert theo mã trong MỘT giao dịch,
 * tồn đầu kỳ ghi thẻ kho OPENING, công nợ đầu kỳ ghi receivables; mỗi lần ghi là một lô (import_batches) hoàn tác được
 * khi chưa phát sinh chứng từ. Cùng một file (SHA-256) không ghi hai lần.
 */
/** Cột giá của sheet BANG_GIA → bảng giá theo cấp khách (khách lẻ dùng giá bán lẻ của sản phẩm). */
const PRICE_TIERS = [
  { tier: 'TIER_1', field: 'distributorPrice', code: 'BG-NPP', name: 'Bảng giá Net NPP' },
  { tier: 'TIER_2', field: 'dealerPrice', code: 'BG-DAILY', name: 'Bảng giá đại lý' },
] as const;

@Injectable()
export class ImportService {
  constructor(
    @Inject(MONGO_DATABASE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly scanner: MalwareScannerService,
    private readonly inventory: InventoryService,
    private readonly sequences: SequenceService,
  ) {}

  private actor(request: AuthenticatedRequest) {
    return { actorId: request.user.sub, actorEmail: request.user.email, correlationId: request.correlationId };
  }

  // ---------- file mẫu ----------

  async template(): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'INOXPRAN ERP';
    // Sheet hướng dẫn theo bộ chuẩn Excel thương hiệu (XLS-01).
    const guideColumns: BrandColumn[] = [
      { key: 'sheet', header: 'Sheet', width: 22, type: 'code' },
      { key: 'title', header: 'Nội dung', width: 34, wrap: true },
      { key: 'note', header: 'Ghi chú', width: 90, wrap: true },
    ];
    const guide = brandSheet(workbook, 'HUONG_DAN', guideColumns);
    const guideHeader = titleBlock(guide, guideColumns.length, 'File nhập dữ liệu ban đầu — INOXPRAN ERP', [
      'Cách dùng: điền dữ liệu từ dòng 2 của mỗi sheet (giữ nguyên dòng tiêu đề). Cột tiêu đề màu cam (có *) là bắt buộc. Có thể để trống sheet không dùng.',
      'Mã đã có trong hệ thống sẽ được CẬP NHẬT theo ô có nhập (ô trống giữ nguyên); mã chưa có sẽ được THÊM MỚI.',
      'Trình tự: tải file lên → Kiểm tra (chạy thử, báo lỗi theo dòng / cột) → sửa lỗi → Ghi vào hệ thống → Đối chiếu → Kế toán + Giám đốc xác nhận.',
    ]);
    tableHeader(guide, guideHeader, guideColumns);
    IMPORT_SHEETS.forEach((sheet, index) => addBodyRow(guide, guideColumns, { sheet: sheet.name, title: sheet.title, note: sheet.note }, index));
    for (const sheet of IMPORT_SHEETS) {
      const worksheet = workbook.addWorksheet(sheet.name, { views: [{ state: 'frozen', ySplit: 1 }] });
      worksheet.columns = sheet.columns.map((column) => ({ header: `${column.label}${column.required ? ' *' : ''}`, key: column.key, width: column.width ?? 16 }));
      const header = worksheet.getRow(1);
      header.height = 34;
      sheet.columns.forEach((column, index) => {
        const cell = header.getCell(index + 1);
        cell.font = { name: 'Arial', size: 11, bold: true, color: { argb: BRAND.white } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: column.required ? BRAND.orange : BRAND.navy } };
        cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
        cell.border = { left: { style: 'thin', color: { argb: BRAND.white } }, right: { style: 'thin', color: { argb: BRAND.white } } };
      });
      sheet.columns.forEach((column, index) => {
        const note = column.hint ?? (column.type === 'date' ? 'dd/mm/yyyy' : column.type === 'money' ? 'Số tiền VND' : '');
        if (note) worksheet.getCell(1, index + 1).note = note;
        if (column.values) {
          const options = Object.keys(column.values);
          const list = column.choices ?? (column.key === 'customerTier' ? ['NPP', 'Đại lý', 'Lẻ'] : column.key === 'stage' ? ['Chính thức', 'Cơ hội'] : column.key === 'role' ? ['NVKD', 'Trưởng KD'] : options);
          for (let row = 2; row <= 2000; row += 1) {
            worksheet.getCell(row, index + 1).dataValidation = { type: 'list', allowBlank: true, formulae: [`"${list.join(',')}"`] };
          }
        }
      });
    }
    return Buffer.from(await workbook.xlsx.writeBuffer());
  }

  // ---------- đọc & kiểm tra ----------

  /** Đọc file .xlsx từ thân request: kiểm tra chữ ký, quét mã độc, tính SHA-256 (dùng chung cho nhập lịch sử công nợ). */
  async readWorkbook(body: unknown): Promise<{ workbook: ExcelJS.Workbook; sha256: string }> {
    if (!Buffer.isBuffer(body) || body.length === 0) throw new BadRequestException({ code: 'IMPORT_EMPTY', message: 'Chưa nhận được file Excel' });
    if (body.length > MAX_IMPORT_BYTES) throw new PayloadTooLargeException({ code: 'IMPORT_TOO_LARGE', message: 'File vượt quá 10 MB' });
    // .xlsx là file zip (chữ ký "PK\x03\x04").
    if (!(body[0] === 0x50 && body[1] === 0x4b && body[2] === 0x03 && body[3] === 0x04)) {
      throw new BadRequestException({ code: 'IMPORT_NOT_XLSX', message: 'Chỉ nhận file Excel .xlsx (tải file mẫu từ trang này)' });
    }
    try {
      const verdict = await this.scanner.scan(body);
      if (verdict.status === 'INFECTED') throw new UnprocessableEntityException({ code: 'EVIDENCE_MALWARE', message: `File bị chặn vì phát hiện mã độc (${verdict.signature})` });
    } catch (error) {
      if (error instanceof MalwareScanUnavailableError) {
        throw new ServiceUnavailableException({ code: 'MALWARE_SCAN_UNAVAILABLE', message: 'Dịch vụ quét mã độc tạm thời chưa sẵn sàng — vui lòng thử lại sau ít phút' });
      }
      throw error;
    }
    const workbook = new ExcelJS.Workbook();
    try {
      await workbook.xlsx.load(body as unknown as ArrayBuffer);
    } catch {
      throw new BadRequestException({ code: 'IMPORT_NOT_XLSX', message: 'Không đọc được file Excel — hãy lưu lại dạng .xlsx' });
    }
    return { workbook, sha256: createHash('sha256').update(body).digest('hex') };
  }

  private parse(workbook: ExcelJS.Workbook, sha256: string): Parsed {
    return this.parseSheets(workbook, sha256, IMPORT_SHEETS);
  }

  /** Đọc các sheet theo định nghĩa cột (tiêu đề → cột), kiểm tra từng ô theo kiểu. */
  parseSheets(workbook: ExcelJS.Workbook, sha256: string, defs: readonly SheetDef[]): Parsed {
    const sheets = new Map<string, Row[]>();
    const errors: ImportIssue[] = [];
    const issue = (sheet: string, row: number, column: string, message: string) => pushIssue(errors, { sheet, row, column, message });
    for (const def of defs) {
      const worksheet = workbook.getWorksheet(def.name);
      if (!worksheet || worksheet.actualRowCount <= 1) continue;
      const header = worksheet.getRow(1);
      const index = new Map<string, number>();
      header.eachCell((cell, col) => index.set(normalize(cellText(cell.value)), col));
      const position = new Map(def.columns.map((column) => [column.key, index.get(normalize(column.label))]));
      const missing = def.columns.filter((column) => column.required && !position.get(column.key));
      if (missing.length) {
        issue(def.name, 1, missing.map((column) => column.label).join(', '), 'Thiếu cột bắt buộc (giữ nguyên dòng tiêu đề của file mẫu)');
        continue;
      }
      const rows: Row[] = [];
      worksheet.eachRow({ includeEmpty: false }, (row, number) => {
        if (number === 1) return;
        const raw = def.columns.map((column) => {
          const col = position.get(column.key);
          return col ? cellText(row.getCell(col).value) : '';
        });
        if (raw.every((value) => !value)) return;
        const values: Record<string, ParsedValue> = {};
        def.columns.forEach((column, i) => {
          const parsed = parseCell(column, raw[i] ?? '');
          if ('error' in parsed) issue(def.name, number, column.label, parsed.error);
          else values[column.key] = parsed.value;
        });
        rows.push({ row: number, values });
      });
      sheets.set(def.name, rows);
    }
    return { sha256, sheets, errors };
  }

  /** Kiểm tra theo schema dùng chung (contracts); lỗi gán về đúng cột. */
  private validate(sheet: string, row: number, schema: ZodType, input: Record<string, unknown>, errors: ImportIssue[]): boolean {
    const result = schema.safeParse(input);
    if (result.success) return true;
    for (const problem of result.error.issues) {
      const key = String(problem.path[0] ?? '');
      pushIssue(errors, { sheet, row, column: label(sheet, key), message: issueMessage(problem as never) });
    }
    return false;
  }

  private async existing(collection: string, field: string, filter: Document = {}, session?: ClientSession): Promise<Existing> {
    const rows = await this.db.collection(collection).find(filter, session ? { session } : {}).toArray();
    return new Map(rows.map((row) => [String(row[field]), row]));
  }

  /** Kiểm tra chéo giữa các sheet và với dữ liệu đang có; trả về kế hoạch ghi. */
  private async plan(parsed: Parsed, session?: ClientSession, mode: ImportMode = 'NORMAL') {
    const { sheets, errors } = parsed;
    const rows = (name: string) => sheets.get(name) ?? [];
    const issue = (sheet: string, row: number, key: string, message: string) => pushIssue(errors, { sheet, row, column: label(sheet, key), message });
    const duplicates = (sheet: string, keyOf: (row: Row) => string | undefined, column: string) => {
      const seen = new Map<string, number>();
      for (const row of rows(sheet)) {
        const key = keyOf(row);
        if (!key) continue;
        if (seen.has(key)) issue(sheet, row.row, column, `Trùng với dòng ${seen.get(key)}`);
        else seen.set(key, row.row);
      }
    };
    duplicates('NHOM_HANG', (row) => row.values.code as string, 'code');
    duplicates('KHU_VUC', (row) => row.values.code as string, 'code');
    duplicates('NVKD', (row) => row.values.code as string, 'code');
    duplicates('NHA_CUNG_CAP', (row) => row.values.code as string, 'code');
    duplicates('SAN_PHAM', (row) => row.values.sku as string, 'sku');
    duplicates('BANG_GIA', (row) => row.values.sku as string, 'sku');
    duplicates('KHACH_HANG', (row) => row.values.code as string, 'code');
    duplicates('TON_DAU_KY', (row) => `${String(row.values.warehouseCode)}|${String(row.values.sku)}`, 'sku');
    duplicates('CONG_NO_DAU_KY', (row) => `${String(row.values.customerCode)}|${String(row.values.documentNo)}`, 'documentNo');

    const [categories, regions, employees, partners, products, warehouses, locations, priceBooks] = await Promise.all([
      this.existing('product_categories', 'code', {}, session),
      this.existing('regions', 'code', {}, session),
      this.existing('employees', 'code', {}, session),
      this.existing('partners', 'code', {}, session),
      this.existing('products', 'sku', {}, session),
      this.existing('warehouses', 'code', {}, session),
      this.db.collection('locations').find({}, session ? { session } : {}).toArray(),
      this.tierBooks(session),
    ]);
    const fileCodes = (sheet: string, field = 'code') => new Set(rows(sheet).map((row) => String(row.values[field])));
    const categoryCodes = new Set([...categories.keys(), ...fileCodes('NHOM_HANG')]);
    const regionCodes = new Set([...regions.keys(), ...fileCodes('KHU_VUC')]);
    const employeeCodes = new Set([...employees.keys(), ...fileCodes('NVKD')]);
    const supplierCodes = new Set([...[...partners.values()].filter((row) => row.kind !== 'CUSTOMER').map((row) => String(row.code)), ...fileCodes('NHA_CUNG_CAP')]);
    const customerCodes = new Set([...[...partners.values()].filter((row) => row.kind !== 'SUPPLIER').map((row) => String(row.code)), ...fileCodes('KHACH_HANG')]);
    const productCodes = new Set([...products.keys(), ...fileCodes('SAN_PHAM', 'sku')]);
    const locationKeys = new Set(locations.map((row) => `${String(row.warehouseId)}|${String(row.code)}`));

    // Danh mục nền theo schema dùng chung.
    for (const row of rows('NHOM_HANG')) this.validate('NHOM_HANG', row.row, ProductCategoryInputSchema, present(row.values), errors);
    for (const row of rows('KHU_VUC')) this.validate('KHU_VUC', row.row, RegionInputSchema, present(row.values), errors);
    for (const row of rows('NVKD')) {
      const values = { role: 'SALES', ...present(row.values) };
      this.validate('NVKD', row.row, EmployeeInputSchema, values, errors);
      if (row.values.regionCode && !regionCodes.has(String(row.values.regionCode))) issue('NVKD', row.row, 'regionCode', 'Không có khu vực này (thêm vào sheet KHU_VUC)');
    }
    for (const row of rows('NHA_CUNG_CAP')) {
      const existingPartner = partners.get(String(row.values.code));
      if (existingPartner && existingPartner.kind === 'CUSTOMER') issue('NHA_CUNG_CAP', row.row, 'code', 'Mã này đang là khách hàng');
      const { contactName, contactPhone, ...fields } = present(row.values);
      this.validate('NHA_CUNG_CAP', row.row, CreatePartnerSchema, { ...fields, kind: 'SUPPLIER', ...(contactName ? { contacts: [{ name: contactName, phone: contactPhone, primary: true }] } : {}) }, errors);
    }
    for (const row of rows('SAN_PHAM')) {
      const v = present(row.values);
      if (v.categoryCode && !categoryCodes.has(String(v.categoryCode))) issue('SAN_PHAM', row.row, 'categoryCode', 'Không có nhóm hàng này (thêm vào sheet NHOM_HANG)');
      if (v.defaultSupplierCode && !supplierCodes.has(String(v.defaultSupplierCode))) issue('SAN_PHAM', row.row, 'defaultSupplierCode', 'Không có nhà cung cấp này');
      if (v.purchasePrice && !v.purchaseCurrency) issue('SAN_PHAM', row.row, 'purchaseCurrency', 'Nhập tiền tệ của giá mua');
      const { categoryCode: _c, defaultSupplierCode: _s, cartonBarcode: _b, clearance, ...rest } = v;
      const fields = { ...rest, ...(clearance !== undefined ? { clearance: clearance === 'YES' } : {}) };
      // Mã mới: đủ trường bắt buộc; mã đã có: chỉ kiểm tra định dạng các ô có nhập.
      if (!products.has(String(v.sku))) this.validate('SAN_PHAM', row.row, CreateProductSchema, { ...fields, minimumStock: String(v.minimumStock ?? '0') }, errors);
      else this.validate('SAN_PHAM', row.row, CreateProductSchema.partial(), { ...fields, ...(v.minimumStock !== undefined ? { minimumStock: String(v.minimumStock) } : {}) }, errors);
    }
    for (const row of rows('BANG_GIA')) {
      const v = present(row.values);
      if (v.sku && !productCodes.has(String(v.sku))) issue('BANG_GIA', row.row, 'sku', 'Không có mã sản phẩm này (thêm vào sheet SAN_PHAM)');
      if (v.distributorPrice === undefined && v.dealerPrice === undefined) issue('BANG_GIA', row.row, 'distributorPrice', 'Nhập ít nhất một giá (NPP hoặc đại lý)');
      for (const key of ['distributorPrice', 'dealerPrice'] as const) {
        if (v[key] !== undefined && !(Number(v[key]) > 0)) issue('BANG_GIA', row.row, key, 'Giá phải lớn hơn 0');
      }
    }
    for (const row of rows('KHACH_HANG')) {
      const v = present(row.values);
      const existingPartner = partners.get(String(v.code));
      if (existingPartner && existingPartner.kind === 'SUPPLIER') issue('KHACH_HANG', row.row, 'code', 'Mã này đang là nhà cung cấp');
      const stage = String(v.stage ?? 'CUSTOMER');
      if (stage === 'CUSTOMER' && !v.customerTier && !existingPartner?.customerTier) issue('KHACH_HANG', row.row, 'customerTier', 'Khách chính thức phải có cấp giá');
      if (v.regionCode && !regionCodes.has(String(v.regionCode))) issue('KHACH_HANG', row.row, 'regionCode', 'Không có khu vực này');
      if (v.salesRepCode && !employeeCodes.has(String(v.salesRepCode))) issue('KHACH_HANG', row.row, 'salesRepCode', 'Không có NVKD này (thêm vào sheet NVKD)');
      const { salesRepCode: _r, contactName, contactTitle, contactPhone, deliveryAddress, ...fields } = v;
      this.validate('KHACH_HANG', row.row, CreatePartnerSchema, {
        ...fields, kind: 'CUSTOMER', stage, creditLimit: String(v.creditLimit ?? '0'),
        ...(contactName ? { contacts: [{ name: contactName, title: contactTitle, phone: contactPhone, primary: true }] } : {}),
        ...(deliveryAddress ? { addresses: [{ address: deliveryAddress, isDefault: true }] } : {}),
      }, errors);
    }
    // Tồn đầu kỳ: kho có thật, mã có trong file hoặc hệ thống, chưa có tồn đầu kỳ của lô khác.
    // Chế độ điều chỉnh (IMP-ADJ-01): mã đã có tồn đầu kỳ thì ghi phần chênh lệch; giảm thì tồn khả dụng phải đủ.
    const openingState = await this.openingState(session);
    const balances = mode === 'ADJUST_OPENING'
      ? new Map((await this.db.collection('inventory_balances').find({}, session ? { session } : {}).toArray()).map((row) => [`${String(row.warehouseId)}|${String(row.productId)}`, new Decimal(decimalString(row.onHand)).sub(decimalString(row.reserved))]))
      : new Map<string, Decimal>();
    const adjustments: OpeningAdjustment[] = [];
    for (const row of rows('TON_DAU_KY')) {
      const warehouse = warehouses.get(String(row.values.warehouseCode));
      if (!warehouse) {
        issue('TON_DAU_KY', row.row, 'warehouseCode', 'Không có kho này');
        continue;
      }
      if (!productCodes.has(String(row.values.sku))) issue('TON_DAU_KY', row.row, 'sku', 'Không có mã sản phẩm này');
      if (row.values.quantity !== undefined && mode === 'NORMAL' && !(Number(row.values.quantity) > 0)) issue('TON_DAU_KY', row.row, 'quantity', 'Số lượng phải lớn hơn 0');
      if (row.values.initialQuantity !== undefined && Number(row.values.initialQuantity) < Number(row.values.quantity ?? 0)) issue('TON_DAU_KY', row.row, 'initialQuantity', 'Số lượng nhập ban đầu không được nhỏ hơn số tồn');
      if (row.values.locationCode && !locationKeys.has(`${String(warehouse._id)}|${String(row.values.locationCode)}`)) issue('TON_DAU_KY', row.row, 'locationCode', 'Vị trí chưa khai báo trong kho (Kho & vị trí lưu)');
      const product = products.get(String(row.values.sku));
      const key = product ? `${String(warehouse._id)}|${String(product._id)}` : '';
      const current = product ? openingState.get(key) : undefined;
      if (mode === 'NORMAL') {
        if (current) issue('TON_DAU_KY', row.row, 'sku', `Mã này đã có tồn đầu kỳ ở kho (lô ${[...current.codes].join(', ')}) — hoàn tác lô đó trước, hoặc chọn "Điều chỉnh tồn đầu kỳ đã nhập"`);
        continue;
      }
      if (row.values.quantity === undefined) continue;
      const previous = current?.quantity ?? new Decimal(0);
      const next = new Decimal(String(row.values.quantity));
      const delta = next.sub(previous);
      const nextInitial = row.values.initialQuantity !== undefined ? new Decimal(String(row.values.initialQuantity)) : null;
      const previousInitial = current?.initialKnown ? current.initial : null;
      const available = balances.get(key) ?? new Decimal(0);
      if (delta.isNegative() && available.lt(delta.abs())) {
        issue('TON_DAU_KY', row.row, 'quantity', `Cần giảm tồn đầu kỳ ${delta.abs().toString()} (${previous.toString()} → ${next.toString()}) nhưng tồn khả dụng chỉ còn ${available.toString()} — nhập các phiếu nhập kho còn thiếu trước rồi kiểm tra lại`);
      }
      adjustments.push({
        row: row.row,
        warehouseCode: String(row.values.warehouseCode),
        sku: String(row.values.sku),
        previous: previous.toString(),
        next: next.toString(),
        delta: delta.toString(),
        previousInitial: previousInitial?.toString() ?? null,
        nextInitial: nextInitial?.toString() ?? null,
        initialDelta: nextInitial ? nextInitial.sub(previousInitial ?? 0).toString() : current ? '0' : null,
        available: available.toString(),
        existed: Boolean(current),
      });
    }
    // Công nợ đầu kỳ: khách có thật, chứng từ chưa nhập.
    const openingReceivables = new Set((await this.db.collection('receivables').find({ sourceType: 'OPENING_BALANCE' }, { projection: { partnerId: 1, openingDocumentNo: 1 }, ...(session ? { session } : {}) }).toArray()).map((row) => `${String(row.partnerId)}|${String(row.openingDocumentNo)}`));
    for (const row of rows('CONG_NO_DAU_KY')) {
      const code = String(row.values.customerCode);
      if (!customerCodes.has(code)) issue('CONG_NO_DAU_KY', row.row, 'customerCode', 'Không có khách hàng này');
      if (row.values.amount !== undefined && !(Number(row.values.amount) > 0)) issue('CONG_NO_DAU_KY', row.row, 'amount', 'Số tiền phải lớn hơn 0');
      const partner = partners.get(code);
      if (partner && openingReceivables.has(`${String(partner._id)}|${String(row.values.documentNo)}`)) issue('CONG_NO_DAU_KY', row.row, 'documentNo', 'Chứng từ này đã nhập công nợ đầu kỳ');
      if (row.values.documentDate && row.values.dueDate && String(row.values.dueDate) < String(row.values.documentDate)) issue('CONG_NO_DAU_KY', row.row, 'dueDate', 'Hạn thanh toán trước ngày chứng từ');
    }
    return { categories, regions, employees, partners, products, warehouses, priceBooks, adjustments };
  }

  /** Tồn đầu kỳ đang hiệu lực theo kho + mã: cộng các dòng thẻ kho OPENING (tăng / giảm) của các lô chưa hoàn tác. */
  private async openingState(session?: ClientSession) {
    const options = session ? { session } : {};
    const [movements, reversed] = await Promise.all([
      this.db.collection('inventory_movements').find({ movementType: 'OPENING' }, { projection: { warehouseId: 1, productId: 1, referenceId: 1, direction: 1, quantity: 1, initialQuantity: 1 }, ...options }).toArray(),
      this.db.collection('import_batches').find({ status: 'ROLLED_BACK' }, { projection: { code: 1 }, ...options }).toArray(),
    ]);
    const rolledBack = new Set(reversed.map((row) => String(row.code)));
    const state = new Map<string, { codes: Set<string>; quantity: Decimal; initial: Decimal; initialKnown: boolean }>();
    for (const row of movements) {
      if (rolledBack.has(String(row.referenceId))) continue;
      const key = `${String(row.warehouseId)}|${String(row.productId)}`;
      const entry = state.get(key) ?? { codes: new Set<string>(), quantity: new Decimal(0), initial: new Decimal(0), initialKnown: true };
      entry.codes.add(String(row.referenceId));
      const quantity = new Decimal(decimalString(row.quantity));
      entry.quantity = row.direction === 'OUT' ? entry.quantity.sub(quantity) : entry.quantity.add(quantity);
      if (row.initialQuantity === undefined || row.initialQuantity === null) entry.initialKnown = false;
      else entry.initial = entry.initial.add(decimalString(row.initialQuantity));
      state.set(key, entry);
    }
    return state;
  }

  /** Bảng giá đang dùng của từng cấp (ưu tiên cao nhất, bản mới nhất) — nơi sheet BANG_GIA ghi vào. */
  private async tierBooks(session?: ClientSession): Promise<Map<string, Document>> {
    const books = await this.db
      .collection('price_books')
      .find({ status: 'PUBLISHED', customerTier: { $in: [...PRICE_TIERS.map((tier) => tier.tier)] }, validTo: null }, session ? { session } : {})
      .sort({ priority: -1, version: -1 })
      .toArray();
    const result = new Map<string, Document>();
    for (const book of books) if (!result.has(String(book.customerTier))) result.set(String(book.customerTier), book);
    return result;
  }

  private summary(parsed: Parsed, existing: Awaited<ReturnType<ImportService['plan']>>, mode: ImportMode = 'NORMAL') {
    const count = (sheet: string, field: string, map: Existing) => {
      const rows = parsed.sheets.get(sheet) ?? [];
      const update = rows.filter((row) => map.has(String(row.values[field]))).length;
      return { name: sheet, title: sheetDef(sheet).title, rows: rows.length, create: rows.length - update, update, errors: parsed.errors.filter((error) => error.sheet === sheet).length };
    };
    const stock = parsed.sheets.get('TON_DAU_KY') ?? [];
    const receivables = parsed.sheets.get('CONG_NO_DAU_KY') ?? [];
    const fileProducts = new Map((parsed.sheets.get('SAN_PHAM') ?? []).map((row) => [String(row.values.sku), row.values]));
    const costOf = (row: Row) => {
      const sku = String(row.values.sku);
      const cost = row.values.unitCost ?? fileProducts.get(sku)?.standardCost ?? (existing.products.get(sku)?.standardCost !== undefined ? decimalString(existing.products.get(sku)?.standardCost) : undefined);
      return cost === undefined ? null : String(cost);
    };
    const existed = existing.adjustments.filter((row) => row.existed).length;
    const byCustomer = new Map<string, Decimal>();
    for (const row of receivables) byCustomer.set(String(row.values.customerCode), (byCustomer.get(String(row.values.customerCode)) ?? new Decimal(0)).add(String(row.values.amount ?? 0)));
    return {
      sheets: [
        count('NHOM_HANG', 'code', existing.categories),
        count('KHU_VUC', 'code', existing.regions),
        count('NVKD', 'code', existing.employees),
        count('NHA_CUNG_CAP', 'code', existing.partners),
        count('SAN_PHAM', 'sku', existing.products),
        this.priceCount(parsed, existing),
        count('KHACH_HANG', 'code', existing.partners),
        { name: 'TON_DAU_KY', title: sheetDef('TON_DAU_KY').title, rows: stock.length, create: stock.length - existed, update: existed, errors: parsed.errors.filter((error) => error.sheet === 'TON_DAU_KY').length },
        { name: 'CONG_NO_DAU_KY', title: sheetDef('CONG_NO_DAU_KY').title, rows: receivables.length, create: receivables.length, update: 0, errors: parsed.errors.filter((error) => error.sheet === 'CONG_NO_DAU_KY').length },
      ].filter((sheet) => sheet.rows > 0 || sheet.errors > 0),
      totals: {
        stockQuantity: stock.reduce((sum, row) => sum.add(String(row.values.quantity ?? 0)), new Decimal(0)).toString(),
        stockValue: stock.reduce((sum, row) => sum.add(new Decimal(String(row.values.quantity ?? 0)).mul(costOf(row) ?? 0)), new Decimal(0)).toFixed(0),
        stockWithoutCost: stock.filter((row) => costOf(row) === null).length,
        receivablesAmount: sumAmounts(receivables.map((row) => String(row.values.amount ?? 0))),
        receivablesByCustomer: [...byCustomer].map(([code, amount]) => ({ code, amount: amount.toFixed(2) })).sort((a, b) => a.code.localeCompare(b.code)),
      },
      ...(mode === 'ADJUST_OPENING' ? { adjustment: this.adjustmentSummary(existing.adjustments) } : {}),
    };
  }

  /** Tổng hợp điều chỉnh tồn đầu kỳ: số mã tăng / giảm / không đổi, tổng đầu kỳ trước → sau (chỉ các mã trong file). */
  private adjustmentSummary(rows: OpeningAdjustment[]) {
    const sum = (pick: (row: OpeningAdjustment) => string) => rows.reduce((total, row) => total.add(pick(row)), new Decimal(0)).toString();
    return {
      increased: rows.filter((row) => Number(row.delta) > 0).length,
      decreased: rows.filter((row) => Number(row.delta) < 0).length,
      unchanged: rows.filter((row) => !changed(row)).length,
      previousTotal: sum((row) => row.previous),
      nextTotal: sum((row) => row.next),
      rows: rows.filter(changed),
    };
  }

  /** BANG_GIA: số mã đã có / chưa có trong bảng giá NPP hoặc đại lý hiện hành. */
  private priceCount(parsed: Parsed, existing: Awaited<ReturnType<ImportService['plan']>>) {
    const rows = parsed.sheets.get('BANG_GIA') ?? [];
    const inBook = new Set<string>();
    for (const book of existing.priceBooks.values()) for (const line of (book.lines as Document[] | undefined) ?? []) inBook.add(String(line.sku));
    const update = rows.filter((row) => inBook.has(String(row.values.sku))).length;
    return { name: 'BANG_GIA', title: sheetDef('BANG_GIA').title, rows: rows.length, create: rows.length - update, update, errors: parsed.errors.filter((error) => error.sheet === 'BANG_GIA').length };
  }

  async dryRun(body: unknown, fileName: string | undefined, mode: ImportMode = 'NORMAL') {
    const { workbook, sha256 } = await this.readWorkbook(body);
    const parsed = this.parse(workbook, sha256);
    const existing = await this.plan(parsed, undefined, mode);
    const committed = await this.db.collection('import_batches').findOne({ sha256, status: 'COMMITTED' }, { projection: { code: 1 } });
    if (committed) parsed.errors.unshift({ sheet: '—', row: 0, column: '—', message: `File này đã được ghi ở lô ${String(committed.code)} — hoàn tác lô đó trước khi ghi lại` });
    const summary = this.summary(parsed, existing, mode);
    return { ok: parsed.errors.length === 0 && summary.sheets.length > 0, mode, fileName: fileName ?? 'du-lieu.xlsx', sha256, ...summary, errors: parsed.errors, truncated: parsed.errors.length >= MAX_ERRORS };
  }

  // ---------- ghi thật ----------

  async commit(body: unknown, fileName: string | undefined, request: AuthenticatedRequest, mode: ImportMode = 'NORMAL') {
    const { workbook, sha256 } = await this.readWorkbook(body);
    if (await this.db.collection('import_batches').findOne({ sha256, status: 'COMMITTED' }, { projection: { _id: 1 } })) {
      throw new ConflictException({ code: 'IMPORT_ALREADY_COMMITTED', message: 'File này đã được ghi — hoàn tác lô cũ trước khi ghi lại' });
    }
    const session = this.db.client.startSession();
    try {
      let batch: Document | null = null;
      await session.withTransaction(async () => {
        const parsed = this.parse(workbook, sha256);
        const existing = await this.plan(parsed, session, mode);
        if (parsed.errors.length) throw new UnprocessableEntityException({ code: 'IMPORT_HAS_ERRORS', message: `File còn ${parsed.errors.length} lỗi — chạy kiểm tra và sửa trước khi ghi`, details: parsed.errors.slice(0, 50) });
        const summary = this.summary(parsed, existing, mode);
        const batchId = new ObjectId();
        const code = await this.sequences.next('IMP', session, 3);
        const now = new Date();
        const created: Record<string, ObjectId[]> = {};
        const updated: Array<{ collection: string; id: ObjectId; before: Document; unset: string[] }> = [];
        const track = (collection: string, id: ObjectId) => (created[collection] ??= []).push(id);
        const rows = (name: string) => parsed.sheets.get(name) ?? [];
        const stamp = { importBatchId: batchId };

        /** Cập nhật theo ô có nhập; lưu giá trị cũ để hoàn tác. */
        const update = async (collection: string, document: Document, changes: Document, versioned = false) => {
          const fields = Object.keys(changes);
          if (!fields.length) return;
          const before = Object.fromEntries(fields.filter((field) => document[field] !== undefined).map((field) => [field, document[field]]));
          const unset = fields.filter((field) => document[field] === undefined);
          await this.db.collection(collection).updateOne({ _id: document._id }, { $set: { ...changes, updatedAt: now }, ...(versioned ? { $inc: { version: 1 } } : {}) }, { session });
          updated.push({ collection, id: document._id as ObjectId, before, unset });
        };

        for (const row of rows('NHOM_HANG')) {
          const v = present(row.values);
          const current = existing.categories.get(String(v.code));
          if (current) await update('product_categories', current, { name: v.name, ...(v.sortOrder !== undefined ? { sortOrder: v.sortOrder } : {}), ...(v.description ? { description: v.description } : {}) });
          else {
            const doc = { _id: new ObjectId(), code: v.code, name: v.name, description: v.description, sortOrder: v.sortOrder ?? 99, status: 'ACTIVE', createdAt: now, updatedAt: now, ...stamp };
            await this.db.collection('product_categories').insertOne(doc, { session });
            existing.categories.set(String(v.code), doc);
            track('product_categories', doc._id);
          }
        }
        for (const row of rows('KHU_VUC')) {
          const v = present(row.values);
          const current = existing.regions.get(String(v.code));
          if (current) await update('regions', current, { name: v.name, ...(v.sortOrder !== undefined ? { sortOrder: v.sortOrder } : {}) });
          else {
            const doc = { _id: new ObjectId(), code: v.code, name: v.name, sortOrder: v.sortOrder ?? 99, createdAt: now, ...stamp };
            await this.db.collection('regions').insertOne(doc, { session });
            existing.regions.set(String(v.code), doc);
            track('regions', doc._id);
          }
        }
        for (const row of rows('NVKD')) {
          const v = present(row.values);
          const current = existing.employees.get(String(v.code));
          const fields = { name: v.name, title: v.title, role: v.role ?? 'SALES', ...(v.regionCode ? { regionCode: v.regionCode } : {}), ...(v.phone ? { phone: v.phone } : {}) };
          if (current) await update('employees', current, fields);
          else {
            const doc = { _id: new ObjectId(), code: v.code, ...fields, regionCode: v.regionCode ?? null, status: 'ACTIVE', createdAt: now, updatedAt: now, ...stamp };
            await this.db.collection('employees').insertOne(doc, { session });
            existing.employees.set(String(v.code), doc);
            track('employees', doc._id);
          }
        }
        const partnerFields = (v: Record<string, ParsedValue>) => {
          const fields: Document = {};
          for (const key of ['name', 'shortName', 'taxCode', 'phone', 'email', 'address', 'website', 'province', 'regionCode', 'customerTier', 'grade', 'source']) if (v[key] !== undefined) fields[key] = v[key];
          if (v.paymentTermDays !== undefined) fields.paymentTermDays = v.paymentTermDays;
          if (v.creditLimit !== undefined) fields.creditLimit = decimal(String(v.creditLimit));
          if (v.salesRepCode) {
            const employee = existing.employees.get(String(v.salesRepCode));
            if (employee) Object.assign(fields, { salesRepId: employee._id, salesRepName: employee.name });
          }
          return fields;
        };
        const contactOf = (v: Record<string, ParsedValue>) => (v.contactName ? { name: String(v.contactName), ...(v.contactTitle ? { title: String(v.contactTitle) } : {}), ...(v.contactPhone ? { phone: String(v.contactPhone) } : {}), primary: true } : null);
        for (const [sheet, kind] of [['NHA_CUNG_CAP', 'SUPPLIER'], ['KHACH_HANG', 'CUSTOMER']] as const) {
          for (const row of rows(sheet)) {
            const v = present(row.values);
            const current = existing.partners.get(String(v.code));
            const fields = partnerFields(v);
            const contact = contactOf(v);
            if (current) {
              if (contact && !((current.contacts as Document[] | undefined) ?? []).some((item) => item.name === contact.name)) fields.contacts = [...((current.contacts as Document[] | undefined) ?? []), { ...contact, primary: !((current.contacts as Document[] | undefined) ?? []).length }];
              if (v.deliveryAddress && !((current.addresses as Document[] | undefined) ?? []).some((item) => item.address === v.deliveryAddress)) fields.addresses = [...((current.addresses as Document[] | undefined) ?? []), { address: v.deliveryAddress, isDefault: !((current.addresses as Document[] | undefined) ?? []).length }];
              if (kind === 'CUSTOMER' && v.stage && current.stage === 'PROSPECT' && v.stage === 'CUSTOMER') fields.stage = 'CUSTOMER';
              await update('partners', current, fields, true);
            } else {
              const doc = {
                _id: new ObjectId(),
                code: v.code,
                kind,
                ...fields,
                ...(kind === 'CUSTOMER' ? { stage: v.stage ?? 'CUSTOMER' } : {}),
                creditLimit: fields.creditLimit ?? decimal('0'),
                paymentTermDays: fields.paymentTermDays ?? 0,
                ...(contact ? { contacts: [contact] } : {}),
                ...(v.deliveryAddress ? { addresses: [{ address: v.deliveryAddress, isDefault: true }] } : {}),
                status: 'ACTIVE',
                version: 1,
                createdAt: now,
                updatedAt: now,
                ...stamp,
              };
              await this.db.collection('partners').insertOne(doc, { session });
              existing.partners.set(String(v.code), doc);
              track('partners', doc._id);
            }
          }
        }
        for (const row of rows('SAN_PHAM')) {
          const v = present(row.values);
          const fields: Document = {};
          for (const key of ['model', 'name', 'nameZh', 'nameEn', 'baseUnit', 'barcode', 'hsCode', 'customsName', 'cartonLengthCm', 'cartonWidthCm', 'cartonHeightCm', 'grossKgPerCarton', 'netKgPerCarton', 'purchaseCurrency', 'purchasePrice', 'supplierItemCode', 'defaultLocationCode', 'brand', 'material', 'specification']) {
            if (v[key] !== undefined) fields[key] = typeof v[key] === 'number' ? String(v[key]) : v[key];
          }
          if (v.packSize !== undefined) fields.packSize = Number(v.packSize);
          if (v.availability !== undefined) fields.availability = v.availability;
          if (v.clearance !== undefined) fields.clearance = v.clearance === 'YES';
          if (v.listPrice !== undefined) fields.listPrice = decimal(String(v.listPrice));
          if (v.standardCost !== undefined) fields.standardCost = decimal(String(v.standardCost));
          if (v.minimumStock !== undefined) fields.minimumStock = decimal(String(v.minimumStock));
          if (v.categoryCode) fields.categoryId = existing.categories.get(String(v.categoryCode))?._id;
          if (v.defaultSupplierCode) {
            const supplier = existing.partners.get(String(v.defaultSupplierCode));
            if (supplier) Object.assign(fields, { defaultSupplierId: supplier._id, defaultSupplierName: supplier.name });
          }
          if (v.packSize !== undefined) fields.unitConversions = [{ unit: 'Thùng', factorToBase: decimal(String(v.packSize)), ...(v.cartonBarcode ? { barcode: v.cartonBarcode } : {}) }];
          const current = existing.products.get(String(v.sku));
          if (current) {
            if (fields.unitConversions) fields.unitConversions = [...(fields.unitConversions as Document[]), ...((current.unitConversions as Document[] | undefined) ?? []).filter((item) => item.unit !== 'Thùng')];
            await update('products', current, fields, true);
          } else {
            const doc = {
              _id: new ObjectId(), sku: v.sku, ...fields, unitConversions: fields.unitConversions ?? [], minimumStock: fields.minimumStock ?? decimal('0'),
              availability: fields.availability ?? 'IN_STOCK', clearance: fields.clearance ?? false, status: 'ACTIVE', version: 1, createdAt: now, updatedAt: now, ...stamp,
            };
            await this.db.collection('products').insertOne(doc, { session });
            existing.products.set(String(v.sku), doc);
            track('products', doc._id);
          }
        }
        // Bảng giá theo cấp: cập nhật bảng giá hiện hành của cấp (tăng phiên bản) hoặc tạo mới; phiếu đã lập giữ giá cũ.
        for (const { tier, field, code: bookCode, name: bookName } of PRICE_TIERS) {
          const priced = rows('BANG_GIA').filter((row) => row.values[field] !== undefined);
          if (!priced.length) continue;
          const lines = priced.map((row) => {
            const product = existing.products.get(String(row.values.sku)) as Document;
            return { productId: product._id as ObjectId, sku: String(row.values.sku), baseUnitPrice: decimal(String(row.values[field])) };
          });
          const current = existing.priceBooks.get(tier);
          if (current) {
            const replaced = new Set(lines.map((line) => line.productId.toHexString()));
            const kept = ((current.lines as Document[] | undefined) ?? []).filter((line) => !replaced.has((line.productId as ObjectId).toHexString()));
            await update('price_books', current, { lines: [...kept, ...lines], sourceDocument: fileName ?? 'du-lieu.xlsx' }, true);
          } else {
            const doc = {
              _id: new ObjectId(), code: bookCode, name: bookName, customerTier: tier, priority: 20, status: 'PUBLISHED', version: 1,
              validFrom: now, validTo: null, sourceDocument: fileName ?? 'du-lieu.xlsx', lines, createdAt: now, updatedAt: now, ...stamp,
            };
            await this.db.collection('price_books').insertOne(doc, { session });
            existing.priceBooks.set(tier, doc);
            track('price_books', doc._id);
          }
        }
        // Tồn đầu kỳ: một phiếu thẻ kho OPENING cho mỗi kho; đặt giá vốn nếu mã chưa có.
        // Chế độ điều chỉnh: ghi phần chênh lệch — tăng là OPENING nhập, giảm là OPENING xuất (vẫn tính vào cột "Tồn đầu kỳ nhập hệ thống").
        const openings: Array<{ warehouseId: ObjectId; productId: ObjectId; quantity: string; locationCode?: string; direction?: 'IN' | 'OUT'; previous?: string; next?: string }> = [];
        const adjustmentOf = new Map(existing.adjustments.map((row) => [row.row, row]));
        const stockByWarehouse = new Map<string, Row[]>();
        for (const row of rows('TON_DAU_KY')) stockByWarehouse.set(String(row.values.warehouseCode), [...(stockByWarehouse.get(String(row.values.warehouseCode)) ?? []), row]);
        for (const [warehouseCode, stockRows] of stockByWarehouse) {
          const warehouse = existing.warehouses.get(warehouseCode) as Document;
          const warehouseId = (warehouse._id as ObjectId).toHexString();
          if (mode === 'ADJUST_OPENING') {
            const lines = stockRows.flatMap((row) => {
              const adjustment = adjustmentOf.get(row.row);
              if (!adjustment) return [];
              const product = existing.products.get(String(row.values.sku)) as Document;
              const delta = new Decimal(adjustment.delta);
              return [{
                adjustment,
                direction: delta.isNegative() ? 'OUT' as const : 'IN' as const,
                productId: (product._id as ObjectId).toHexString(),
                quantity: delta.abs().toString(),
                ...(row.values.locationCode ? { locationCode: String(row.values.locationCode) } : {}),
                ...(adjustment.initialDelta !== null ? { initialQuantity: adjustment.initialDelta } : {}),
              }];
            });
            // Mã không đổi chỉ ghi vào lô (để đối chiếu đủ số trong file), không ghi thẻ kho.
            for (const direction of ['IN', 'OUT'] as const) {
              const group = lines.filter((line) => line.direction === direction && changed(line.adjustment));
              if (!group.length) continue;
              await this.inventory.applyPhysicalMovement({ warehouseId, referenceType: 'ImportBatch', referenceId: code, movementType: 'OPENING', direction, lines: group.map(({ adjustment: _a, direction: _d, ...line }) => line), reason: `Điều chỉnh tồn đầu kỳ — lô nhập ${code}`, actorId: request.user.sub }, session);
            }
            for (const line of lines) {
              openings.push({ warehouseId: warehouse._id as ObjectId, productId: new ObjectId(line.productId), quantity: line.quantity, direction: line.direction, previous: line.adjustment.previous, next: line.adjustment.next, ...(line.locationCode ? { locationCode: line.locationCode } : {}) });
            }
          } else {
            const lines = stockRows.map((row) => {
              const product = existing.products.get(String(row.values.sku)) as Document;
              return {
                productId: (product._id as ObjectId).toHexString(), quantity: String(row.values.quantity),
                ...(row.values.locationCode ? { locationCode: String(row.values.locationCode) } : {}),
                ...(row.values.initialQuantity !== undefined ? { initialQuantity: String(row.values.initialQuantity) } : {}),
              };
            });
            await this.inventory.applyPhysicalMovement({ warehouseId, referenceType: 'ImportBatch', referenceId: code, movementType: 'OPENING', direction: 'IN', lines, reason: `Tồn đầu kỳ — lô nhập ${code}`, actorId: request.user.sub }, session);
            for (const line of lines) openings.push({ warehouseId: warehouse._id as ObjectId, productId: new ObjectId(line.productId), quantity: line.quantity, ...(line.locationCode ? { locationCode: line.locationCode } : {}) });
          }
          for (const row of stockRows) {
            const product = existing.products.get(String(row.values.sku)) as Document;
            if (row.values.unitCost !== undefined && product.standardCost === undefined && !created.products?.some((id) => id.equals(product._id as ObjectId))) {
              await update('products', product, { standardCost: decimal(String(row.values.unitCost)) }, true);
              product.standardCost = decimal(String(row.values.unitCost));
            } else if (row.values.unitCost !== undefined && created.products?.some((id) => id.equals(product._id as ObjectId)) && product.standardCost === undefined) {
              await this.db.collection('products').updateOne({ _id: product._id }, { $set: { standardCost: decimal(String(row.values.unitCost)) } }, { session });
              product.standardCost = decimal(String(row.values.unitCost));
            }
          }
        }
        // Công nợ đầu kỳ.
        const receivableIds: ObjectId[] = [];
        for (const row of rows('CONG_NO_DAU_KY')) {
          const partner = existing.partners.get(String(row.values.customerCode)) as Document;
          const id = new ObjectId();
          await this.db.collection('receivables').insertOne({
            _id: id,
            code: await this.sequences.next('AR', session),
            partnerId: partner._id,
            sourceType: 'OPENING_BALANCE',
            openingDocumentNo: String(row.values.documentNo),
            openingDocumentDate: String(row.values.documentDate),
            ...(row.values.note ? { note: String(row.values.note) } : {}),
            amount: decimal(String(row.values.amount)),
            paidAmount: decimal('0'),
            dueDate: new Date(`${String(row.values.dueDate)}T00:00:00+07:00`),
            status: 'OPEN',
            createdAt: now,
            updatedAt: now,
            version: 1,
            ...stamp,
          }, { session });
          receivableIds.push(id);
        }
        batch = {
          _id: batchId,
          code,
          fileName: fileName ?? 'du-lieu.xlsx',
          sha256,
          status: 'COMMITTED',
          ...(mode === 'ADJUST_OPENING' && summary.adjustment ? { mode, adjustment: (({ rows: _rows, ...totals }) => totals)(summary.adjustment) } : {}),
          sheets: summary.sheets,
          totals: summary.totals,
          created,
          updated,
          openings,
          receivableIds,
          createdBy: toObjectId(request.user.sub),
          createdByName: request.user.displayName,
          createdAt: now,
          confirmations: [],
        };
        await this.db.collection('import_batches').insertOne(batch, { session });
        await this.audit.record({ ...this.actor(request), action: 'IMPORT_COMMITTED', entityType: 'ImportBatch', entityId: batchId.toHexString(), metadata: { code, fileName, sha256, mode, sheets: summary.sheets, totals: { ...summary.totals, receivablesByCustomer: undefined } } }, session);
      });
      return this.present(batch as unknown as Document);
    } finally {
      await session.endSession();
    }
  }

  // ---------- lô nhập: danh sách, đối chiếu, xác nhận, hoàn tác ----------

  presentBatch(batch: Document) {
    return this.present(batch);
  }

  private present(batch: Document) {
    const created = (batch.created ?? {}) as Record<string, ObjectId[]>;
    return {
      id: (batch._id as ObjectId).toHexString(),
      code: batch.code,
      fileName: batch.fileName,
      status: batch.status,
      mode: (batch.mode as ImportMode | undefined) ?? 'NORMAL',
      kind: (batch.kind as string | undefined) ?? 'INITIAL',
      ...(batch.cutoff ? { cutoff: batch.cutoff } : {}),
      paymentCount: ((batch.paymentIds as unknown[]) ?? []).length,
      // Lô lịch sử đã thay bằng file mới (số chính xác từ Excel gốc): số lần thay, lần gần nhất.
      ...(batch.replacedAt ? { replacedAt: (batch.replacedAt as Date).toISOString(), replacedByName: batch.replacedByName, replacements: ((batch.replacements as unknown[]) ?? []).length } : {}),
      ...(batch.adjustment ? { adjustment: batch.adjustment } : {}),
      sheets: batch.sheets,
      totals: batch.totals,
      createdCount: Object.values(created).reduce((sum, ids) => sum + ids.length, 0),
      updatedCount: ((batch.updated as unknown[]) ?? []).length,
      openingCount: ((batch.openings as unknown[]) ?? []).length,
      receivableCount: ((batch.receivableIds as unknown[]) ?? []).length,
      createdByName: batch.createdByName,
      createdAt: (batch.createdAt as Date).toISOString(),
      confirmations: ((batch.confirmations as Document[]) ?? []).map((row) => ({ role: row.role, name: row.name, at: (row.at as Date).toISOString() })),
      ...(batch.rolledBackAt ? { rolledBackAt: (batch.rolledBackAt as Date).toISOString(), rolledBackByName: batch.rolledBackByName } : {}),
    };
  }

  async list(paging: PageRequest) {
    const [rows, total] = await Promise.all([
      this.db.collection('import_batches').find({}).sort({ createdAt: -1 }).skip(paging.skip).limit(paging.pageSize).toArray(),
      this.db.collection('import_batches').countDocuments({}),
    ]);
    return pageOf(rows.map((row) => this.present(row)), total, paging);
  }

  /** Loại lô: INITIAL (nhập dữ liệu ban đầu) / AR_HISTORY (lịch sử công nợ) — báo cáo và hoàn tác rẽ theo loại. */
  async kindOf(id: string): Promise<string> {
    return String((await this.load(id)).kind ?? 'INITIAL');
  }

  private async load(id: string) {
    const batch = await this.db.collection('import_batches').findOne({ _id: toObjectId(id) });
    if (!batch) throw new NotFoundException({ code: 'IMPORT_BATCH_NOT_FOUND', message: 'Không tìm thấy lô nhập' });
    return batch;
  }

  /** Đối chiếu số liệu file với dữ liệu đang có trong hệ thống (sau nhập). */
  async report(id: string) {
    const batch = await this.load(id);
    const openings = (batch.openings as Document[]) ?? [];
    const receivableIds = (batch.receivableIds as ObjectId[]) ?? [];
    const created = (batch.created ?? {}) as Record<string, ObjectId[]>;
    const [balances, receivables, counts, warehouses, products] = await Promise.all([
      this.db.collection('inventory_balances').find({ $or: openings.map((row) => ({ warehouseId: row.warehouseId, productId: row.productId })) }).toArray().catch(() => []),
      this.db.collection('receivables').find({ _id: { $in: receivableIds } }).toArray(),
      Promise.all(Object.entries(created).map(async ([collection, ids]) => ({ collection, expected: ids.length, actual: await this.db.collection(collection).countDocuments({ _id: { $in: ids } }) }))),
      this.db.collection('warehouses').find({}, { projection: { code: 1, name: 1 } }).toArray(),
      this.db.collection('products').find({ _id: { $in: openings.map((row) => row.productId as ObjectId) } }, { projection: { sku: 1, standardCost: 1 } }).toArray(),
    ]);
    const warehouseName = new Map(warehouses.map((row) => [String(row._id), `${String(row.code)} — ${String(row.name)}`]));
    const productById = new Map(products.map((row) => [String(row._id), row]));
    const balanceOf = new Map(balances.map((row) => [`${String(row.warehouseId)}|${String(row.productId)}`, decimalString(row.onHand)]));
    // Lô điều chỉnh: so tồn đầu kỳ theo file (sau điều chỉnh) với tồn đầu kỳ đang hiệu lực, không so với tồn hiện tại.
    const adjusting = batch.mode === 'ADJUST_OPENING';
    const openingNow = adjusting ? await this.openingState() : null;
    const stockByWarehouse = new Map<string, { imported: Decimal; current: Decimal; value: Decimal; lines: number }>();
    for (const row of openings) {
      const key = String(row.warehouseId);
      const entry = stockByWarehouse.get(key) ?? { imported: new Decimal(0), current: new Decimal(0), value: new Decimal(0), lines: 0 };
      const cost = productById.get(String(row.productId))?.standardCost;
      const quantity = adjusting ? String(row.next) : String(row.quantity);
      entry.imported = entry.imported.add(quantity);
      entry.current = entry.current.add(adjusting ? openingNow?.get(`${key}|${String(row.productId)}`)?.quantity ?? 0 : balanceOf.get(`${key}|${String(row.productId)}`) ?? '0');
      entry.value = entry.value.add(new Decimal(quantity).mul(cost !== undefined ? decimalString(cost) : 0));
      entry.lines += 1;
      stockByWarehouse.set(key, entry);
    }
    const outstanding = receivables.reduce((sum, row) => sum.add(decimalString(row.amount)).sub(decimalString(row.paidAmount)), new Decimal(0));
    return {
      batch: this.present(batch),
      records: counts.map((row) => ({ ...row, ok: row.expected === row.actual })),
      stock: [...stockByWarehouse].map(([warehouseId, entry]) => ({
        warehouse: warehouseName.get(warehouseId) ?? warehouseId,
        lines: entry.lines,
        importedQuantity: entry.imported.toString(),
        currentQuantity: entry.current.toString(),
        importedValue: entry.value.toFixed(0),
        ok: entry.imported.eq(entry.current),
      })),
      ...(adjusting ? {
        adjustments: openings.filter((row) => String(row.previous) !== String(row.next)).map((row) => ({
          warehouse: warehouseName.get(String(row.warehouseId)) ?? String(row.warehouseId),
          sku: String(productById.get(String(row.productId))?.sku ?? ''),
          previous: String(row.previous),
          next: String(row.next),
          delta: (row.direction === 'OUT' ? new Decimal(String(row.quantity)).neg() : new Decimal(String(row.quantity))).toString(),
        })).sort((a, b) => a.sku.localeCompare(b.sku, 'vi', { numeric: true })),
      } : {}),
      receivables: {
        fileTotal: String((batch.totals as Document)?.receivablesAmount ?? '0'),
        imported: sumAmounts(receivables.map((row) => decimalString(row.amount))),
        outstanding: outstanding.toFixed(2),
        documents: receivables.length,
        ok: sumAmounts(receivables.map((row) => decimalString(row.amount))) === String((batch.totals as Document)?.receivablesAmount ?? '0.00'),
        byCustomer: (batch.totals as Document)?.receivablesByCustomer ?? [],
      },
    };
  }

  /** Kế toán / Giám đốc xác nhận đã đối chiếu số liệu với sổ sách cũ. */
  async confirm(id: string, request: AuthenticatedRequest) {
    const batch = await this.load(id);
    if (batch.status !== 'COMMITTED') throw new ConflictException({ code: 'IMPORT_BATCH_STATE', message: 'Lô đã hoàn tác, không xác nhận được' });
    // Từ 09/10/2026 trang nhập dữ liệu chỉ dành cho quản trị gốc: quản trị gốc ghi nhận đã đối chiếu.
    const role = request.user.root ? 'ROOT' : request.user.roles.includes('DIRECTOR') ? 'DIRECTOR' : request.user.roles.includes('ACCOUNTANT') ? 'ACCOUNTANT' : null;
    if (!role) throw new ForbiddenException({ code: 'ROLE_FORBIDDEN', message: 'Chỉ quản trị gốc xác nhận đối chiếu' });
    const confirmations = ((batch.confirmations as Document[]) ?? []).filter((row) => row.role !== role);
    confirmations.push({ role, userId: toObjectId(request.user.sub), name: request.user.displayName, at: new Date() });
    await this.db.collection('import_batches').updateOne({ _id: batch._id }, { $set: { confirmations } });
    await this.audit.record({ ...this.actor(request), action: 'IMPORT_CONFIRMED', entityType: 'ImportBatch', entityId: id, metadata: { role } });
    return this.present({ ...batch, confirmations });
  }

  /**
   * Hoàn tác cả lô khi dữ liệu nhập chưa được dùng: không có phiếu bán / mua / bảo hành / thẻ kho khác trên mã, khách, NCC mới;
   * công nợ đầu kỳ chưa thu; hồ sơ cập nhật chưa bị sửa tiếp. Tồn đầu kỳ được trừ lại bằng thẻ kho REVERSAL.
   */
  async rollback(id: string, request: AuthenticatedRequest) {
    const session = this.db.client.startSession();
    try {
      let result: Document | null = null;
      await session.withTransaction(async () => {
        const batch = await this.db.collection('import_batches').findOne({ _id: toObjectId(id), status: 'COMMITTED' }, { session });
        if (!batch) throw new ConflictException({ code: 'IMPORT_BATCH_STATE', message: 'Lô không còn ở trạng thái đã ghi' });
        const created = (batch.created ?? {}) as Record<string, ObjectId[]>;
        const products = created.products ?? [];
        const partners = created.partners ?? [];
        const receivableIds = (batch.receivableIds as ObjectId[]) ?? [];
        const blockers: string[] = [];
        // Thẻ kho của các lô đã hoàn tác (tồn đầu kỳ + dòng trừ lại, cộng bằng 0) không tính là "đã dùng".
        const reversedCodes = (await this.db.collection('import_batches').find({ status: 'ROLLED_BACK' }, { session, projection: { code: 1 } }).toArray()).map((row) => String(row.code));
        const ownCodes = [String(batch.code), ...reversedCodes];
        const used = async (collection: string, filter: Document, label: string) => {
          if (await this.db.collection(collection).findOne(filter, { session, projection: { _id: 1 } })) blockers.push(label);
        };
        if (products.length) {
          await used('sales_orders', { 'lines.productId': { $in: products } }, 'mã hàng mới đã có phiếu bán');
          await used('purchase_orders', { 'lines.productId': { $in: products } }, 'mã hàng mới đã có đơn mua');
          await used('inventory_movements', { productId: { $in: products }, referenceId: { $nin: ownCodes } }, 'mã hàng mới đã phát sinh thẻ kho khác (hoàn tác lô tồn đầu kỳ / chứng từ dùng mã này trước)');
          await used('warranty_tickets', { 'product.productId': { $in: products } }, 'mã hàng mới đã có phiếu bảo hành');
        }
        if (partners.length) {
          await used('sales_orders', { customerId: { $in: partners } }, 'khách mới đã có phiếu bán');
          await used('purchase_orders', { supplierId: { $in: partners } }, 'nhà cung cấp mới đã có đơn mua');
          await used('receivables', { partnerId: { $in: partners }, _id: { $nin: receivableIds } }, 'khách mới đã có công nợ khác');
          await used('warranty_tickets', { 'customer.partnerId': { $in: partners } }, 'khách mới đã có phiếu bảo hành');
        }
        if (created.product_categories?.length) await used('products', { categoryId: { $in: created.product_categories }, _id: { $nin: products } }, 'nhóm hàng mới đang có sản phẩm khác');
        if (created.regions?.length) {
          const codes = (await this.db.collection('regions').find({ _id: { $in: created.regions } }, { session }).toArray()).map((row) => row.code);
          await used('partners', { regionCode: { $in: codes }, _id: { $nin: partners } }, 'khu vực mới đang được dùng');
        }
        if (created.employees?.length) await used('partners', { salesRepId: { $in: created.employees }, _id: { $nin: partners } }, 'NVKD mới đang phụ trách khách khác');
        await used('receivables', { _id: { $in: receivableIds }, paidAmount: { $gt: decimal('0') } }, 'công nợ đầu kỳ đã thu tiền');
        // Lô điều chỉnh tồn đầu kỳ ghi sau, cùng kho + mã: hoàn tác lô điều chỉnh trước (nó tính chênh lệch trên số của lô này).
        const ownKeys = new Set(((batch.openings as Document[]) ?? []).map((row) => `${String(row.warehouseId)}|${String(row.productId)}`));
        if (ownKeys.size) {
          const later = await this.db.collection('import_batches').find({ status: 'COMMITTED', mode: 'ADJUST_OPENING', createdAt: { $gt: batch.createdAt } }, { session, projection: { code: 1, openings: 1 } }).toArray();
          for (const row of later) {
            if (((row.openings as Document[]) ?? []).some((line) => ownKeys.has(`${String(line.warehouseId)}|${String(line.productId)}`))) blockers.push(`tồn đầu kỳ đã được điều chỉnh ở lô ${String(row.code)} (hoàn tác lô đó trước)`);
          }
        }
        for (const row of (batch.updated as Document[]) ?? []) {
          const current = await this.db.collection(String(row.collection)).findOne({ _id: row.id as ObjectId }, { session, projection: { updatedAt: 1 } });
          if (current && (current.updatedAt as Date | undefined)?.getTime() !== (batch.createdAt as Date).getTime()) {
            blockers.push(`hồ sơ cập nhật đã được sửa tiếp sau khi nhập (${String(row.collection)})`);
            break;
          }
        }
        if (blockers.length) {
          throw new ConflictException({ code: 'IMPORT_ROLLBACK_BLOCKED', message: `Không hoàn tác được lô ${String(batch.code)}: ${[...new Set(blockers)].join('; ')}`, details: { blockers: [...new Set(blockers)] } });
        }
        // Trừ tồn đầu kỳ (mã cũ giữ thẻ kho OPENING + REVERSAL; mã mới xóa luôn tồn / thẻ kho của lô).
        const byWarehouse = new Map<string, Document[]>();
        for (const row of (batch.openings as Document[]) ?? []) byWarehouse.set(String(row.warehouseId), [...(byWarehouse.get(String(row.warehouseId)) ?? []), row]);
        for (const [warehouseId, rows] of byWarehouse) {
          const keep = rows.filter((row) => !products.some((productId) => productId.equals(row.productId as ObjectId)) && !new Decimal(String(row.quantity)).isZero());
          // Dòng tăng (IN) trừ lại bằng REVERSAL xuất; dòng giảm của lô điều chỉnh (OUT) cộng lại bằng REVERSAL nhập.
          for (const direction of ['OUT', 'IN'] as const) {
            const group = keep.filter((row) => (row.direction === 'OUT' ? 'IN' : 'OUT') === direction);
            if (!group.length) continue;
            await this.inventory.applyPhysicalMovement({ warehouseId, referenceType: 'ImportBatchRollback', referenceId: String(batch.code), movementType: 'REVERSAL', direction, lines: group.map((row) => ({ productId: String(row.productId), quantity: String(row.quantity) })), reason: `Hoàn tác ${batch.mode === 'ADJUST_OPENING' ? 'điều chỉnh tồn đầu kỳ' : 'tồn đầu kỳ'} — lô ${String(batch.code)}`, actorId: request.user.sub }, session);
          }
        }
        if (products.length) {
          await this.db.collection('inventory_movements').deleteMany({ productId: { $in: products }, referenceId: { $in: ownCodes } }, { session });
          await this.db.collection('inventory_balances').deleteMany({ productId: { $in: products } }, { session });
        }
        await this.db.collection('receivables').deleteMany({ _id: { $in: receivableIds } }, { session });
        for (const [collection, ids] of Object.entries(created)) {
          if (ids.length) await this.db.collection(collection).deleteMany({ _id: { $in: ids }, importBatchId: batch._id }, { session });
        }
        for (const row of [...((batch.updated as Document[]) ?? [])].reverse()) {
          const unset = Object.fromEntries(((row.unset as string[]) ?? []).map((field) => [field, '']));
          await this.db.collection(String(row.collection)).updateOne({ _id: row.id as ObjectId }, { $set: { ...(row.before as Document), updatedAt: new Date() }, ...(Object.keys(unset).length ? { $unset: unset } : {}) }, { session });
        }
        result = await this.db.collection('import_batches').findOneAndUpdate(
          { _id: batch._id },
          { $set: { status: 'ROLLED_BACK', rolledBackAt: new Date(), rolledBackBy: toObjectId(request.user.sub), rolledBackByName: request.user.displayName } },
          { returnDocument: 'after', session },
        );
        await this.audit.record({ ...this.actor(request), action: 'IMPORT_ROLLED_BACK', entityType: 'ImportBatch', entityId: id, metadata: { code: batch.code } }, session);
      });
      return this.present(result as unknown as Document);
    } finally {
      await session.endSession();
    }
  }
}

