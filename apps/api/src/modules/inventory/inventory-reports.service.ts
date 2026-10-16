import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  categoryAmount,
  categoryInfo,
  categoryOf,
  INVENTORY_CATEGORIES,
  isNonSale,
  MOVEMENT_TYPE_CATEGORY,
  monthlyBalance,
  orderParty,
  remainingPercent,
  type InventoryCategory,
  type InventoryJournalRow,
  type InventoryMonthlyReport,
  type InventoryMonthlyRow,
  type StockCountRow,
  type StockCountWarning,
  type StockDirection,
  vnDate,
} from '@inoxpran/contracts';
import ExcelJS from 'exceljs';
import type { Db, Document, ObjectId } from 'mongodb';
import { dateBounds, vnDayBegin } from '../../common/date-range';
import { decimalString, toObjectId, vnMonthStart, vnParts } from '../../common/domain';
import { pageOf, type PageRequest } from '../../common/paging';
import { MONGO_DATABASE } from '../../common/tokens';

const TRANSFERS = ['TRANSFER_IN', 'TRANSFER_OUT'];
const EXPORT_LIMIT = 20_000;
const round = (value: number) => Math.round(value * 10_000) / 10_000;
const pad = (value: number) => String(value).padStart(2, '0');
const day = (date: Date) => {
  const parts = vnParts(date);
  return `${pad(parts.day)}/${pad(parts.month)}/${parts.year}`;
};
const naturalSku = (a: { sku: string }, b: { sku: string }) => a.sku.localeCompare(b.sku, 'en', { numeric: true });

const COLOR = {
  navy: 'FF1F4E79',
  inFill: 'FFE2EFDA',
  outFill: 'FFFFF2CC',
  net: 'FF4472C4',
  total: 'FFFFC000',
  grey: 'FFBFBFBF',
};
/** Màu ô % tồn còn lại như file Excel của công ty (đỏ → cam → vàng → xanh). */
function percentFill(value: number): string {
  if (value < 40) return 'FFFF0000';
  if (value < 60) return 'FFFF9900';
  if (value < 75) return 'FFFFC000';
  if (value < 90) return 'FFFFFF00';
  return 'FF92D050';
}

/**
 * Báo cáo kho theo mẫu công ty: tồn kho tháng (`月库存明细单`) và nhật ký xuất nhập (`出库汇总`), có xuất Excel.
 * Tính từ thẻ kho (inventory_movements) theo loại phát sinh chuẩn ($shared/inventory-categories).
 * Xem cả công ty thì bỏ qua chuyển kho nội bộ (hai chiều triệt tiêu), cộng cả kho hàng lỗi như file Excel đang làm.
 */
/** Kỳ nhật ký xuất nhập: một tháng (YYYY-MM) hoặc khoảng ngày (YYYY-MM-DD). */
export interface JournalPeriod { month?: string | undefined; from?: string | undefined; to?: string | undefined }

@Injectable()
export class InventoryReportsService {
  constructor(@Inject(MONGO_DATABASE) private readonly db: Db) {}

  private range(month: string) {
    const match = /^(\d{4})-(\d{2})$/.exec(month ?? '');
    const year = Number(match?.[1]);
    const monthNo = Number(match?.[2]);
    if (!match || monthNo < 1 || monthNo > 12) throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'Tháng phải có dạng YYYY-MM', details: [{ path: ['month'] }] });
    const now = vnParts(new Date());
    if (year * 12 + monthNo > now.year * 12 + now.month) throw new BadRequestException({ code: 'REPORT_MONTH_IN_FUTURE', message: 'Chưa đến tháng báo cáo', details: [{ path: ['month'] }] });
    return { year, monthNo, start: vnMonthStart(year, monthNo), end: vnMonthStart(year, monthNo + 1), current: year === now.year && monthNo === now.month };
  }

  /**
   * Kỳ của nhật ký xuất nhập (LIST-DATE-01): khoảng ngày `from` – `to` (giờ Việt Nam, tối đa 366 ngày) hoặc một tháng `month` như trước.
   */
  private journalPeriod(period: JournalPeriod) {
    if (period.from || period.to) {
      const bounds = dateBounds(period.from, period.to);
      const today = vnDate(new Date());
      const fromDay = period.from || today.slice(0, 7) + '-01';
      const toDay = period.to || today;
      const start = bounds?.$gte ?? vnDayBegin(fromDay);
      const end = bounds?.$lt ?? new Date(vnDayBegin(toDay).getTime() + 86_400_000);
      if (end.getTime() - start.getTime() > 366 * 86_400_000) {
        throw new BadRequestException({ code: 'DATE_RANGE_TOO_LONG', message: 'Khoảng ngày tối đa 366 ngày', details: [{ path: ['from'] }] });
      }
      const show = (value: string) => value.split('-').reverse().join('/');
      return {
        start, end,
        title: `${fromDay} 至 ${toDay} 仓库出入库汇总 — NHẬT KÝ XUẤT NHẬP KHO TỪ ${show(fromDay)} ĐẾN ${show(toDay)}`,
        sheetName: '出入库汇总',
        fileTag: `${fromDay}_${toDay}`,
      };
    }
    const month = period.month || vnDate(new Date()).slice(0, 7);
    const range = this.range(month);
    return {
      start: range.start, end: range.end,
      title: `${range.year}年${range.monthNo}月 仓库出入库汇总 — NHẬT KÝ XUẤT NHẬP KHO THÁNG ${range.monthNo}/${range.year}`,
      sheetName: `${range.monthNo}月出入库汇总`,
      fileTag: month,
    };
  }

  private async scope(warehouseId: string | undefined) {
    if (!warehouseId) return { filter: { movementType: { $nin: TRANSFERS } } as Document, warehouse: null };
    const warehouse = await this.db.collection('warehouses').findOne({ _id: toObjectId(warehouseId, 'warehouseId') });
    if (!warehouse) throw new NotFoundException({ code: 'WAREHOUSE_NOT_FOUND', message: 'Không tìm thấy kho' });
    return { filter: { warehouseId: warehouse._id } as Document, warehouse };
  }

  /** Phiếu kiểm kê trong kỳ đã chốt mà còn lệch (STK-01) — hiện cảnh báo trên báo cáo và file Excel. */
  private async countWarnings(month: string, warehouse: Document | null) {
    return this.db.collection('stock_counts')
      .find({ status: 'CLOSED', period: month, 'variance.total': { $gt: 0 }, ...(warehouse ? { warehouseId: warehouse._id } : {}) })
      .sort({ closedAt: 1 })
      .toArray();
  }

  private warningView(row: Document): StockCountWarning {
    return {
      id: (row._id as ObjectId).toHexString(),
      code: String(row.code),
      warehouseName: String(row.warehouseName ?? ''),
      closedAt: (row.closedAt as Date).toISOString(),
      closedByName: String(row.closedByName ?? ''),
      mismatches: Number((row.variance as Document)?.total ?? 0),
      note: String(row.closeNote ?? ''),
    };
  }

  async monthly(month: string, warehouseId?: string): Promise<InventoryMonthlyReport> {
    const range = this.range(month);
    const { filter, warehouse } = await this.scope(warehouseId);
    const movements = this.db.collection('inventory_movements');
    const [grouped, openings, rollbacks, rolledBackBatches] = await Promise.all([
      movements.aggregate([
        { $match: { ...filter, occurredAt: { $lt: range.end } } },
        {
          $group: {
            _id: { productId: '$productId', movementType: '$movementType', direction: '$direction', category: '$category', inMonth: { $gte: ['$occurredAt', range.start] } },
            quantity: { $sum: '$quantity' },
          },
        },
      ]).toArray(),
      movements.find({ ...filter, movementType: 'OPENING', occurredAt: { $lt: range.end } }, { projection: { productId: 1, referenceId: 1, initialQuantity: 1 } }).toArray(),
      movements.distinct('referenceId', { movementType: 'REVERSAL', referenceType: 'ImportBatchRollback', occurredAt: { $lt: range.end } }),
      // Lô điều chỉnh chỉ đổi số nhập ban đầu thì hoàn tác không sinh dòng REVERSAL — lấy thêm theo trạng thái lô.
      this.db.collection('import_batches').distinct('code', { status: 'ROLLED_BACK', rolledBackAt: { $lt: range.end } }),
    ]);

    type Acc = { opening: number; amounts: Partial<Record<InventoryCategory, number>>; purchased: number; initialOpening: number; unknownInitial: boolean };
    const byProduct = new Map<string, Acc>();
    const acc = (productId: ObjectId) => {
      const key = productId.toHexString();
      let entry = byProduct.get(key);
      if (!entry) {
        entry = { opening: 0, amounts: {}, purchased: 0, initialOpening: 0, unknownInitial: false };
        byProduct.set(key, entry);
      }
      return entry;
    };
    for (const row of grouped) {
      const id = row._id as { productId: ObjectId; movementType: string; direction: StockDirection; category?: string; inMonth: boolean };
      const quantity = Number(decimalString(row.quantity));
      const entry = acc(id.productId);
      const category = categoryOf(id);
      if (category === 'PURCHASE_IN') entry.purchased += categoryAmount(category, id.direction, quantity);
      if (!id.inMonth) entry.opening += id.direction === 'IN' ? quantity : -quantity;
      else entry.amounts[category] = round((entry.amounts[category] ?? 0) + categoryAmount(category, id.direction, quantity));
    }
    // Số nhập ban đầu (初始入库): khai ở tồn đầu kỳ (Excel) + hàng mua đã nhập; tồn đầu kỳ không khai số này thì không tính %.
    const rolledBack = new Set([...rollbacks, ...rolledBackBatches].map(String));
    for (const opening of openings) {
      if (rolledBack.has(String(opening.referenceId))) continue;
      const entry = acc(opening.productId as ObjectId);
      if (opening.initialQuantity === undefined || opening.initialQuantity === null) entry.unknownInitial = true;
      else entry.initialOpening += Number(decimalString(opening.initialQuantity));
    }

    const productFilter: Document = warehouse
      ? { _id: { $in: [...byProduct.keys()].map((id) => toObjectId(id)) } }
      : { $or: [{ status: 'ACTIVE' }, { _id: { $in: [...byProduct.keys()].map((id) => toObjectId(id)) } }] };
    const products = await this.db.collection('products').find(productFilter, { projection: { sku: 1, name: 1, baseUnit: 1 } }).toArray();

    const balances = new Map<string, { onHand: number; reserved: number }>();
    if (range.current) {
      const rows = await this.db.collection('inventory_balances').aggregate([
        { $match: warehouse ? { warehouseId: warehouse._id } : {} },
        { $group: { _id: '$productId', onHand: { $sum: '$onHand' }, reserved: { $sum: '$reserved' } } },
      ]).toArray();
      for (const row of rows) balances.set((row._id as ObjectId).toHexString(), { onHand: Number(decimalString(row.onHand)), reserved: Number(decimalString(row.reserved)) });
    }

    const rows: InventoryMonthlyRow[] = products.map((product) => {
      const key = (product._id as ObjectId).toHexString();
      const entry = byProduct.get(key) ?? { opening: 0, amounts: {}, purchased: 0, initialOpening: 0, unknownInitial: false };
      const opening = round(entry.opening);
      const { netOut, closing } = monthlyBalance(opening, entry.amounts);
      const initial = entry.unknownInitial ? null : round(entry.initialOpening + entry.purchased);
      const balance = balances.get(key) ?? { onHand: 0, reserved: 0 };
      return {
        productId: key,
        sku: String(product.sku),
        productName: String(product.name),
        unit: String(product.baseUnit ?? ''),
        initialQuantity: initial && initial > 0 ? initial : null,
        remainingPercent: initial ? remainingPercent(closing, initial) : null,
        opening,
        amounts: entry.amounts,
        netOut,
        closing,
        available: range.current ? round(balance.onHand - balance.reserved) : null,
        ledgerMatches: range.current ? Math.abs(balance.onHand - closing) < 0.0001 : null,
      };
    }).sort(naturalSku);

    const totals = { opening: 0, amounts: {} as Partial<Record<InventoryCategory, number>>, netOut: 0, closing: 0 };
    for (const row of rows) {
      totals.opening = round(totals.opening + row.opening);
      totals.netOut = round(totals.netOut + row.netOut);
      totals.closing = round(totals.closing + row.closing);
      for (const [code, value] of Object.entries(row.amounts)) totals.amounts[code as InventoryCategory] = round((totals.amounts[code as InventoryCategory] ?? 0) + (value ?? 0));
    }
    const columns = INVENTORY_CATEGORIES.filter((item) => !('optional' in item) || (totals.amounts[item.code] ?? 0) !== 0 || rows.some((row) => (row.amounts[item.code] ?? 0) !== 0)).map((item) => item.code);
    return {
      month,
      warehouseId: warehouse ? (warehouse._id as ObjectId).toHexString() : null,
      warehouseName: warehouse ? String(warehouse.name) : 'Tất cả kho',
      current: range.current,
      columns,
      rows,
      totals,
      mismatches: rows.filter((row) => row.ledgerMatches === false).length,
      stockCountWarnings: (await this.countWarnings(month, warehouse)).map((row) => this.warningView(row)),
    };
  }

  async monthlyWorkbook(month: string, warehouseId: string | undefined, preparedBy: string): Promise<Buffer> {
    const report = await this.monthly(month, warehouseId);
    const range = this.range(month);
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'INOXPRAN ERP';
    workbook.created = new Date();
    const sheet = workbook.addWorksheet(`${range.monthNo}月库存`, { views: [{ state: 'frozen', xSplit: 3, ySplit: 5 }], pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 } });
    const head = [
      { key: 'stt', zh: '序号', vi: 'STT', width: 6 },
      { key: 'sku', zh: '型号', vi: 'Model', width: 14 },
      { key: 'name', zh: '产品名称', vi: 'Tên sản phẩm', width: 30 },
      { key: 'initial', zh: '初始入库', vi: 'Số lượng nhập ban đầu', width: 12 },
      { key: 'percent', zh: '剩余库存百分比', vi: '% tồn kho còn lại', width: 11 },
      { key: 'opening', zh: '上月库存', vi: 'Tồn kho cuối tháng trước', width: 12 },
      ...report.columns.map((code) => {
        const info = categoryInfo(code);
        return { key: code, zh: info?.zh ?? code, vi: info?.vi ?? code, width: 12, direction: info?.direction };
      }),
      { key: 'netOut', zh: '综合出库', vi: 'Xuất kho tổng hợp', width: 12 },
      { key: 'closing', zh: '库存结余', vi: 'Tồn kho cuối kỳ', width: 12 },
      ...(report.current ? [{ key: 'available', zh: '现货库存', vi: 'Tồn kho hàng có sẵn', width: 12 }, { key: 'check', zh: '数据查验', vi: 'Đối chiếu sổ', width: 10 }] : []),
      { key: 'note', zh: '备注', vi: 'Ghi chú', width: 26 },
    ] as Array<{ key: string; zh: string; vi: string; width: number; direction?: StockDirection }>;
    sheet.columns = head.map((column) => ({ key: column.key, width: column.width }));
    const last = sheet.getColumn(head.length).letter;
    sheet.mergeCells(`A1:${last}1`);
    sheet.getCell('A1').value = `___${range.monthNo}___月库存明细单`;
    sheet.getCell('A1').font = { bold: true, size: 18 };
    sheet.getCell('A1').alignment = { horizontal: 'center' };
    sheet.mergeCells(`A2:${last}2`);
    sheet.getCell('A2').value = `BÁO CÁO TỒN KHO THÁNG ${range.monthNo}/${range.year} — ${report.warehouseName.toUpperCase()}`;
    sheet.getCell('A2').font = { bold: true, size: 13, color: { argb: COLOR.navy } };
    sheet.getCell('A2').alignment = { horizontal: 'center' };
    sheet.mergeCells(`A3:${last}3`);
    sheet.getCell('A3').value = `CÔNG TY TNHH ĐẦU TƯ THẮNG VƯỢNG — INOXPRAN · Đơn vị: theo đơn vị tính cơ bản · Người lập: ${preparedBy} · Ngày kết xuất: ${day(new Date())}${report.warehouseId ? '' : ' · Cộng mọi kho (kể cả kho hàng lỗi), không tính chuyển kho nội bộ'}`;
    sheet.getCell('A3').font = { italic: true, color: { argb: 'FF5A6B7C' } };
    // Cảnh báo kiểm kê chốt còn lệch (STK-01): dòng 4 chữ đỏ + ghi chú từng mã lệch.
    const counts = await this.countWarnings(month, report.warehouseId ? await this.db.collection('warehouses').findOne({ _id: toObjectId(report.warehouseId) }) : null);
    const countNotes = new Map<string, string[]>();
    if (counts.length) {
      sheet.mergeCells(`A4:${last}4`);
      sheet.getCell('A4').value = `⚠ CẢNH BÁO KIỂM KÊ 盘点差异: ${counts.map((row) => `${String(row.code)} (${String(row.warehouseName)}, ${day(row.closedAt as Date)}, ${String(row.closedByName ?? '')}) chốt còn lệch ${Number((row.variance as Document).total)} mã — ${String(row.closeNote ?? '')}`).join(' · ')}`;
      sheet.getCell('A4').font = { bold: true, color: { argb: 'FFC00000' } };
      sheet.getCell('A4').alignment = { wrapText: true, vertical: 'middle' };
      sheet.getRow(4).height = 30;
      for (const row of counts) {
        for (const item of ((row.variance as Document).rows as StockCountRow[] | undefined) ?? []) {
          const text = `Kiểm kê ${String(row.code)}: ERP ${item.erpOnHand} / đếm ${item.counted ?? '—'}`;
          countNotes.set(item.productId, [...(countNotes.get(item.productId) ?? []), text]);
        }
      }
    }

    const header = sheet.getRow(5);
    header.values = head.map((column) => `${column.zh}\n${column.vi}`);
    header.height = 58;
    header.eachCell((cell, index) => {
      const column = head[index - 1];
      const fill = column?.key === 'netOut' ? COLOR.net : column?.direction === 'IN' ? COLOR.inFill : column?.direction === 'OUT' ? COLOR.outFill : column?.key === 'check' ? COLOR.grey : 'FFDCE8F5';
      cell.font = { bold: true, size: 9, color: { argb: column?.key === 'netOut' ? 'FFFFFFFF' : 'FF111111' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
      cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
      cell.border = { top: { style: 'thin' }, bottom: { style: 'thin' }, left: { style: 'thin' }, right: { style: 'thin' } };
    });
    report.rows.forEach((row, index) => {
      const values: Record<string, unknown> = {
        stt: index + 1,
        sku: row.sku,
        name: row.productName,
        initial: row.initialQuantity ?? '',
        percent: row.remainingPercent === null ? '' : row.remainingPercent / 100,
        opening: row.opening,
        netOut: row.netOut,
        closing: row.closing,
        available: row.available ?? '',
        check: row.ledgerMatches === null ? '' : row.ledgerMatches ? '✓' : '✗',
        note: (countNotes.get(row.productId) ?? []).join('; '),
      };
      for (const code of report.columns) values[code] = row.amounts[code] ?? 0;
      const excelRow = sheet.addRow(values);
      excelRow.eachCell({ includeEmpty: true }, (cell) => {
        cell.border = { top: { style: 'hair' }, bottom: { style: 'hair' }, left: { style: 'thin' }, right: { style: 'thin' } };
      });
      excelRow.getCell('sku').font = { bold: true };
      excelRow.getCell('closing').font = { bold: true, italic: true };
      excelRow.getCell('netOut').font = { italic: true };
      if (row.remainingPercent !== null) {
        excelRow.getCell('percent').numFmt = '0.00%';
        excelRow.getCell('percent').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: percentFill(row.remainingPercent) } };
      }
      if (row.ledgerMatches === false) excelRow.getCell('check').font = { bold: true, color: { argb: 'FFFF0000' } };
      if (countNotes.has(row.productId)) excelRow.getCell('note').font = { bold: true, color: { argb: 'FFC00000' } };
    });
    const totalValues: Record<string, unknown> = { name: `TỔNG CỘNG 合计 (${report.rows.length} mã)`, opening: report.totals.opening, netOut: report.totals.netOut, closing: report.totals.closing };
    for (const code of report.columns) totalValues[code] = report.totals.amounts[code] ?? 0;
    const totalRow = sheet.addRow(totalValues);
    totalRow.eachCell({ includeEmpty: true }, (cell) => {
      cell.font = { bold: true };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR.total } };
    });
    for (const column of head) if (!['stt', 'sku', 'name', 'percent', 'check', 'note'].includes(column.key)) sheet.getColumn(column.key).numFmt = '#,##0.####;-#,##0.####;0';
    const buffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(buffer);
  }

  /** Bộ lọc loại phát sinh, kể cả dữ liệu cũ chưa ghi `category` (suy ra từ nghiệp vụ). */
  private categoryFilter(category: InventoryCategory): Document {
    const legacyTypes = Object.entries(MOVEMENT_TYPE_CATEGORY).filter(([, value]) => value === category).map(([type]) => type);
    return { $or: [{ category }, ...(legacyTypes.length ? [{ category: { $exists: false }, movementType: { $in: legacyTypes } }] : [])] };
  }

  async journal(period: JournalPeriod, options: { warehouseId?: string | undefined; category?: InventoryCategory | undefined; search?: string | undefined }, paging: PageRequest | null) {
    const range = this.journalPeriod(period);
    const filter: Document = { occurredAt: { $gte: range.start, $lt: range.end } };
    const and: Document[] = [];
    if (options.warehouseId) filter.warehouseId = toObjectId(options.warehouseId, 'warehouseId');
    if (options.category) and.push(this.categoryFilter(options.category));
    if (options.search) {
      const pattern = { $regex: options.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
      const products = await this.db.collection('products').find({ $or: [{ sku: pattern }, { name: pattern }] }, { projection: { _id: 1 } }).limit(500).toArray();
      and.push({ $or: [{ productId: { $in: products.map((row) => row._id) } }, { referenceId: pattern }, { salesOrderCode: pattern }] });
    }
    if (and.length) filter.$and = and;
    const cursor = this.db.collection('inventory_movements').find(filter).sort({ occurredAt: 1, _id: 1 });
    const [movements, total] = paging
      ? await Promise.all([cursor.skip(paging.skip).limit(paging.pageSize).toArray(), this.db.collection('inventory_movements').countDocuments(filter)])
      : [await cursor.limit(EXPORT_LIMIT).toArray(), 0];
    const rows = await this.enrich(movements);
    return paging ? pageOf(rows, total, paging) : rows;
  }

  /** Bổ sung khách / NCC, phiếu BH, NVKD, thủ kho cho từng dòng thẻ kho. */
  private async enrich(movements: Document[]): Promise<InventoryJournalRow[]> {
    const ids = (values: unknown[]) => [...new Set(values.filter(Boolean).map(String))];
    const shipments = ids(movements.filter((row) => row.referenceType === 'Shipment').map((row) => row.referenceId));
    const receipts = ids(movements.filter((row) => row.referenceType === 'GoodsReceipt').map((row) => row.referenceId));
    const returns = ids(movements.filter((row) => row.referenceType === 'StockReturn').map((row) => row.referenceId));
    const tickets = ids(movements.filter((row) => row.referenceType === 'WarrantyTicket').map((row) => row.referenceId));
    const [products, warehouses, users, shipmentDocs, receiptDocs, returnDocs, ticketDocs] = await Promise.all([
      this.db.collection('products').find({ _id: { $in: movements.map((row) => row.productId as ObjectId) } }, { projection: { sku: 1, name: 1, baseUnit: 1 } }).toArray(),
      this.db.collection('warehouses').find({}, { projection: { code: 1 } }).toArray(),
      this.db.collection('users').find({ _id: { $in: movements.map((row) => row.actorId as ObjectId).filter(Boolean) } }, { projection: { displayName: 1 } }).toArray(),
      shipments.length ? this.db.collection('shipments').find({ code: { $in: shipments } }, { projection: { code: 1, salesOrderId: 1 } }).toArray() : [],
      receipts.length ? this.db.collection('goods_receipts').find({ code: { $in: receipts } }, { projection: { code: 1, purchaseOrderId: 1, supplierId: 1 } }).toArray() : [],
      returns.length ? this.db.collection('stock_returns').find({ code: { $in: returns } }, { projection: { code: 1, partnerCode: 1, partnerName: 1, salesOrderCode: 1 } }).toArray() : [],
      tickets.length ? this.db.collection('warranty_tickets').find({ code: { $in: tickets } }, { projection: { code: 1, customer: 1 } }).toArray() : [],
    ]);
    const orderCodes = ids([...movements.map((row) => row.salesOrderCode), ...returnDocs.map((row) => row.salesOrderCode)]);
    const orderIds = shipmentDocs.map((row) => row.salesOrderId as ObjectId).filter(Boolean);
    const orders = orderCodes.length || orderIds.length
      ? await this.db.collection('sales_orders').find({ $or: [{ code: { $in: orderCodes } }, { _id: { $in: orderIds } }] }, { projection: { code: 1, orderDate: 1, customerId: 1, customerCode: 1, customerName: 1, salesRepName: 1, purpose: 1, destination: 1 } }).toArray()
      : [];
    const partnerIds = [...orders.map((row) => row.customerId), ...receiptDocs.map((row) => row.supplierId)].filter(Boolean) as ObjectId[];
    const partners = partnerIds.length ? await this.db.collection('partners').find({ _id: { $in: partnerIds } }, { projection: { code: 1, name: 1, salesRepName: 1 } }).toArray() : [];
    const byId = <T extends Document>(rows: T[]) => new Map(rows.map((row) => [(row._id as ObjectId).toHexString(), row]));
    const productMap = byId(products);
    const warehouseMap = byId(warehouses);
    const userMap = byId(users);
    const partnerMap = byId(partners);
    const orderByCode = new Map(orders.map((row) => [String(row.code), row]));
    const orderById = byId(orders);
    const shipmentOrder = new Map(shipmentDocs.map((row) => [String(row.code), orderById.get((row.salesOrderId as ObjectId | undefined)?.toHexString() ?? '')]));
    const receiptMap = new Map(receiptDocs.map((row) => [String(row.code), row]));
    const returnMap = new Map(returnDocs.map((row) => [String(row.code), row]));
    const ticketMap = new Map(tickets.length ? ticketDocs.map((row) => [String(row.code), row]) : []);

    return movements.map((movement) => {
      const product = productMap.get((movement.productId as ObjectId).toHexString());
      const reference = String(movement.referenceId ?? '');
      const order = movement.salesOrderCode ? orderByCode.get(String(movement.salesOrderCode)) : shipmentOrder.get(reference)
        ?? (returnMap.get(reference)?.salesOrderCode ? orderByCode.get(String(returnMap.get(reference)?.salesOrderCode)) : undefined);
      const orderPartner = order?.customerId ? partnerMap.get((order.customerId as ObjectId).toHexString()) : undefined;
      const receipt = receiptMap.get(reference);
      const supplier = receipt?.supplierId ? partnerMap.get((receipt.supplierId as ObjectId).toHexString()) : undefined;
      const stockReturn = returnMap.get(reference);
      const ticket = ticketMap.get(reference);
      const partnerCode = stockReturn?.partnerCode ?? orderPartner?.code ?? order?.customerCode ?? supplier?.code ?? ticket?.customer?.code;
      // Phiếu hàng mẫu / kiểm định không có khách: hiện người mượn (SAL-TYPE-01).
      const partnerName = stockReturn?.partnerName ?? (order && isNonSale(order) ? orderParty(order) : order?.customerName) ?? orderPartner?.name ?? supplier?.name ?? ticket?.customer?.name;
      const quantity = Number(decimalString(movement.quantity));
      const category = categoryOf({ movementType: String(movement.movementType), direction: movement.direction as StockDirection, category: movement.category as string | undefined });
      return {
        id: (movement._id as ObjectId).toHexString(),
        occurredAt: (movement.occurredAt as Date).toISOString(),
        category,
        direction: movement.direction as StockDirection,
        quantity: categoryAmount(category, movement.direction as StockDirection, quantity),
        sku: String(product?.sku ?? ''),
        productName: String(product?.name ?? ''),
        unit: String(product?.baseUnit ?? movement.unit ?? ''),
        warehouseCode: String(warehouseMap.get((movement.warehouseId as ObjectId).toHexString())?.code ?? ''),
        documentNo: reference,
        documentType: String(movement.referenceType ?? ''),
        ...(order ? { salesOrderCode: String(order.code), salesOrderDate: (order.orderDate as Date | undefined)?.toISOString() } : {}),
        ...(partnerCode ? { partnerCode: String(partnerCode) } : {}),
        ...(partnerName ? { partnerName: String(partnerName) } : {}),
        ...(order?.salesRepName || orderPartner?.salesRepName ? { salesRepName: String(order?.salesRepName ?? orderPartner?.salesRepName) } : {}),
        ...(movement.actorId ? { keeperName: String(userMap.get((movement.actorId as ObjectId).toHexString())?.displayName ?? '') || undefined } : {}),
        ...(movement.reason ? { note: String(movement.reason) } : {}),
      } as InventoryJournalRow;
    });
  }

  async journalWorkbook(period: JournalPeriod, options: { warehouseId?: string | undefined; category?: InventoryCategory | undefined; search?: string | undefined }, preparedBy: string): Promise<Buffer> {
    const range = this.journalPeriod(period);
    const rows = (await this.journal(period, options, null)) as InventoryJournalRow[];
    const used = INVENTORY_CATEGORIES.filter((item) => !('optional' in item) || rows.some((row) => row.category === item.code));
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'INOXPRAN ERP';
    workbook.created = new Date();
    const sheet = workbook.addWorksheet(range.sheetName, { views: [{ state: 'frozen', ySplit: 4 }], pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 } });
    const head = [
      { key: 'stt', zh: '序号', vi: 'STT', width: 6 },
      { key: 'partner', zh: '客户', vi: 'Khách hàng / NCC', width: 30 },
      { key: 'partnerCode', zh: '客户编号', vi: 'Mã khách hàng', width: 11 },
      { key: 'orderDate', zh: '销售单日期', vi: 'Ngày của phiếu bán hàng', width: 12 },
      { key: 'order', zh: '销售单号（BH）', vi: 'Số phiếu bán hàng (BH)', width: 16 },
      { key: 'outDate', zh: '出仓日期', vi: 'Ngày xuất kho', width: 12 },
      { key: 'outDoc', zh: '出仓单号', vi: 'Số phiếu xuất kho', width: 16 },
      { key: 'inDate', zh: '入库日期', vi: 'Ngày nhập kho', width: 12 },
      { key: 'inDoc', zh: '入仓单号', vi: 'Số phiếu nhập kho', width: 16 },
      { key: 'sku', zh: '产品型号', vi: 'Model', width: 13 },
      ...used.map((item) => ({ key: item.code, zh: item.zh, vi: item.vi, width: 11, direction: item.direction })),
      { key: 'note', zh: '备注', vi: 'Ghi chú', width: 30 },
      { key: 'keeper', zh: '仓管员', vi: 'Nhân viên kho', width: 18 },
      { key: 'rep', zh: '业务员', vi: 'Nhân viên kinh doanh', width: 18 },
      { key: 'warehouse', zh: '仓库', vi: 'Kho', width: 11 },
    ] as Array<{ key: string; zh: string; vi: string; width: number; direction?: StockDirection }>;
    sheet.columns = head.map((column) => ({ key: column.key, width: column.width }));
    const last = sheet.getColumn(head.length).letter;
    sheet.mergeCells(`A1:${last}1`);
    sheet.getCell('A1').value = range.title;
    sheet.getCell('A1').font = { bold: true, size: 14, color: { argb: COLOR.navy } };
    sheet.mergeCells(`A2:${last}2`);
    sheet.getCell('A2').value = `INOXPRAN · Người lập: ${preparedBy} · Ngày kết xuất: ${day(new Date())} · ${rows.length} dòng${rows.length >= EXPORT_LIMIT ? ` (giới hạn ${EXPORT_LIMIT})` : ''}`;
    sheet.getCell('A2').font = { italic: true, color: { argb: 'FF5A6B7C' } };
    const header = sheet.getRow(4);
    header.values = head.map((column) => `${column.zh}\n${column.vi}`);
    header.height = 58;
    header.eachCell((cell, index) => {
      const column = head[index - 1];
      cell.font = { bold: true, size: 9 };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: column?.direction === 'IN' ? COLOR.inFill : column?.direction === 'OUT' ? COLOR.outFill : 'FFDCE8F5' } };
      cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
      cell.border = { top: { style: 'thin' }, bottom: { style: 'thin' }, left: { style: 'thin' }, right: { style: 'thin' } };
    });
    rows.forEach((row, index) => {
      const date = day(new Date(row.occurredAt));
      const values: Record<string, unknown> = {
        stt: index + 1,
        partner: row.partnerName ?? '',
        partnerCode: row.partnerCode ?? '',
        orderDate: row.salesOrderDate ? day(new Date(row.salesOrderDate)) : '',
        order: row.salesOrderCode ?? '',
        outDate: row.direction === 'OUT' ? date : '',
        outDoc: row.direction === 'OUT' ? row.documentNo : '',
        inDate: row.direction === 'IN' ? date : '',
        inDoc: row.direction === 'IN' ? row.documentNo : '',
        sku: row.sku,
        [row.category]: row.quantity,
        note: row.note ?? '',
        keeper: row.keeperName ?? '',
        rep: row.salesRepName ?? '',
        warehouse: row.warehouseCode,
      };
      const excelRow = sheet.addRow(values);
      excelRow.getCell('sku').font = { bold: true };
      excelRow.eachCell({ includeEmpty: true }, (cell) => {
        cell.border = { top: { style: 'hair' }, bottom: { style: 'hair' }, left: { style: 'thin' }, right: { style: 'thin' } };
      });
    });
    const totals: Record<string, unknown> = { partner: 'TỔNG CỘNG 合计' };
    for (const item of used) totals[item.code] = round(rows.filter((row) => row.category === item.code).reduce((sum, row) => sum + row.quantity, 0));
    const totalRow = sheet.addRow(totals);
    totalRow.eachCell({ includeEmpty: true }, (cell) => {
      cell.font = { bold: true };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR.total } };
    });
    for (const item of used) sheet.getColumn(item.code).numFmt = '#,##0.####;-#,##0.####;""';
    const buffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(buffer);
  }
}
