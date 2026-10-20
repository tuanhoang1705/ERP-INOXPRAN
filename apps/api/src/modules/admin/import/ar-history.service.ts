import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import Decimal from 'decimal.js';
import { ObjectId, type ClientSession, type Db, type Document } from 'mongodb';
import { AuditService } from '../../../common/audit.service';
import { decimal, decimalString, toObjectId } from '../../../common/domain';
import type { AuthenticatedRequest } from '../../../common/request-context';
import { SequenceService } from '../../../common/sequence.service';
import { MONGO_DATABASE } from '../../../common/tokens';
import { planFifoAllocation } from '../../receivables/allocation';
import { daysOverdue } from '../../receivables/overdue-review';
import { DOCUMENT_MODES } from '../../receivables/reallocate';
import { historyLineSegments, reallocatePartner, segmentContext } from '../../receivables/segment-store';
import { openParts, planPartsAllocation } from '../../receivables/segments';
import { planDocumentPins, type DocumentPin } from './history-pins';
import { findErpTwins, type TwinOrder } from './history-twins';
import { AR_HISTORY_SHEETS, type ArHistoryType } from './import-sheets';
import { ImportService, pushIssue, type ImportIssue, type Parsed } from './import.service';

/**
 * Nhập lịch sử công nợ theo khách (IMP-AR-01, 16/10/2026) từ sổ công nợ cũ (每日订单汇总表):
 * - chứng từ bán / hoàn tiền → khoản phải thu `HISTORY_IMPORT` (ngày phát sinh = ngày chứng từ, hạn = ngày chứng từ + số ngày nợ của khách);
 * - thu tiền / phí vận chuyển khách trả / trả hàng / giảm giá → phiếu giảm nợ `mode: HISTORY` (kind RECEIPT / FREIGHT / RETURN),
 *   phân bổ vào chứng từ lịch sử của khách, cũ nhất trước; dư → khoản khách trả trước;
 * - dòng sau ngày chốt **không nhập** (19/10/2026: từ ngày chốt kế toán nhập trên ERP) — chỉ liệt kê làm danh sách việc: phiếu BH
 *   đã có trên ERP, khoản thu trùng khách + ngày + số tiền với phiếu thu ERP (nghi trùng), phiếu bán có thể đã lập trên ERP với số khác,
 *   còn lại "chưa có trên ERP";
 * - ô "Phiếu ERP (trùng)": cùng một lần xuất đã có phiếu BH trên ERP (VD sổ cũ ghi theo ngày đơn, kho xuất sang tháng sau) → không nhập;
 *   chứng từ bán gần ngày chốt khớp phiếu ERP khác số (cùng khách, cùng tiền hoặc cùng dòng hàng) → cảnh báo nghi trùng;
 * - mỗi lần ghi là một lô (import_batches, kind AR_HISTORY), đối chiếu / xác nhận / hoàn tác như lô nhập dữ liệu ban đầu.
 */
const DEBIT_TYPES: readonly ArHistoryType[] = ['BAN_HANG', 'HOAN_TIEN'];
const PAYMENT_KIND: Record<ArHistoryType, 'RECEIPT' | 'FREIGHT' | 'RETURN' | null> = {
  BAN_HANG: null, HOAN_TIEN: null, TRA_HANG: 'RETURN', THU_TIEN: 'RECEIPT', PHI_VAN_CHUYEN: 'FREIGHT', GIAM_GIA: 'RETURN', TRU_LUONG: 'RETURN',
};
const TYPE_LABEL: Record<ArHistoryType, string> = {
  BAN_HANG: 'Bán hàng', HOAN_TIEN: 'Hoàn tiền cho khách', TRA_HANG: 'Trả hàng / điều chỉnh giảm', THU_TIEN: 'Thu tiền', PHI_VAN_CHUYEN: 'Phí vận chuyển khách trả', GIAM_GIA: 'Giảm giá / chiết khấu', TRU_LUONG: 'Trừ vào lương',
};
export const DEFAULT_CUTOFF = '2026-09-30';
const DAY_MS = 86_400_000;

/** Dòng sau ngày chốt không nhập (19/10/2026): kế toán nhập trên ERP; SAU_CHOT_CHUA_CO = chưa thấy trên ERP. */
type EntryStatus = 'NHAP' | 'BO_QUA_DA_CO_ERP' | 'BO_QUA_NGHI_TRUNG' | 'SAU_CHOT_CHUA_CO';
interface Entry {
  row: number;
  id: string;
  customerCode: string;
  date: string;
  type: ArHistoryType;
  documentNo?: string | undefined;
  invoiceNo?: string | undefined;
  /** Ô "Phiếu ERP (trùng)": cùng lần xuất đã có phiếu BH trên ERP — không nhập dòng này. */
  erpOrderNo?: string | undefined;
  amount: string;
  description?: string | undefined;
  note?: string | undefined;
  source?: string | undefined;
  flags?: string | undefined;
  afterCutoff: boolean;
  status: EntryStatus;
  match?: string | undefined;
}
interface Line { entryId: string; sku?: string | undefined; productName?: string | undefined; unit?: string | undefined; quantity?: string | undefined; unitPrice?: string | undefined; amount?: string }
interface CustomerSummary {
  code: string;
  name: string;
  partnerId: string;
  exempt: boolean;
  rows: number;
  included: number;
  skipped: number;
  afterCutoff: number;
  debit: string;
  receipt: string;
  freight: string;
  returns: string;
  /** Phần nợ nhóm công nợ tách riêng còn lại sau mô phỏng (CN-SEG-01). */
  segment?: string;
  balance: string;
  prepayment: string;
  fileBalance: string;
  expected?: { tongCongNo?: string | undefined; daThanhToan?: string | undefined; phiVanChuyen?: string | undefined; conLai?: string | undefined; sheet?: string | undefined; note?: string | undefined } | undefined;
  overdue60: { amount: string; days: number } | null;
}

const vnNoon = (day: string) => new Date(`${day}T12:00:00+07:00`);
const vnMidnight = (day: string) => new Date(`${day}T00:00:00+07:00`);
const addDays = (day: string, days: number) => new Date(vnMidnight(day).getTime() + days * DAY_MS);
const todayVn = () => new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);
const vnDay = (value: Date) => new Date(value.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);
const viDate = (day: string) => day.split('-').reverse().join('/');
const vnd = (value: Decimal.Value) => new Decimal(value).toDecimalPlaces(2).toNumber().toLocaleString('vi-VN', { maximumFractionDigits: 2 });
/** "công nợ trên ERP …, sổ cũ …, chênh …" — để kế toán thấy lệch vài đồng do làm tròn thuế. */
const debtGap = (onErp: Decimal, file: string) => {
  const gap = onErp.minus(file);
  return gap.isZero() ? 'công nợ khớp sổ cũ' : `công nợ trên ERP ${vnd(onErp)} đ, sổ cũ ${vnd(file)} đ, chênh ${vnd(gap)} đ`;
};
const text = (value: unknown) => (value === undefined || value === null || value === '' ? undefined : String(value));
const signedText = (value: unknown): string | undefined => {
  const raw = text(value)?.replace(/[\s,₫]/g, '');
  if (!raw) return undefined;
  const negative = /^\(.*\)$/.test(raw);
  const clean = raw.replace(/[()]/g, '');
  return /^-?\d+(\.\d+)?$/.test(clean) ? (negative ? `-${clean}` : clean) : undefined;
};

@Injectable()
export class ArHistoryImportService {
  constructor(
    @Inject(MONGO_DATABASE) private readonly db: Db,
    private readonly imports: ImportService,
    private readonly audit: AuditService,
    private readonly sequences: SequenceService,
  ) {}

  private cutoffOf(value: string | undefined): string {
    const cutoff = (value ?? '').trim() || DEFAULT_CUTOFF;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(cutoff) || Number.isNaN(vnMidnight(cutoff).getTime())) {
      throw new BadRequestException({ code: 'CUTOFF_INVALID', message: 'Ngày chốt phải có dạng YYYY-MM-DD' });
    }
    return cutoff;
  }

  /** Kiểm tra file + đối chiếu với dữ liệu ERP; trả kế hoạch ghi (dùng cho chạy thử và ghi thật). */
  private async analyze(parsed: Parsed, cutoff: string, session?: ClientSession, replacingBatchId?: ObjectId) {
    const options = session ? { session } : {};
    const errors = parsed.errors;
    const warnings: string[] = [];
    const issue = (sheet: string, row: number, column: string, message: string) => pushIssue(errors, { sheet, row, column, message });
    const rows = parsed.sheets.get('CONG_NO_LICH_SU') ?? [];
    const lineRows = parsed.sheets.get('CONG_NO_LICH_SU_HANG') ?? [];
    const expectRows = parsed.sheets.get('DOI_CHIEU_CONG_NO') ?? [];
    const today = todayVn();

    const entries: Entry[] = [];
    const seen = new Map<string, number>();
    for (const row of rows) {
      const v = row.values;
      const id = String(v.id ?? '');
      if (!id || !v.customerCode || !v.date || !v.type || v.amount === undefined) continue;
      if (seen.has(id)) issue('CONG_NO_LICH_SU', row.row, 'Mã dòng', `Trùng với dòng ${seen.get(id)}`);
      else seen.set(id, row.row);
      if (String(v.date) > today) issue('CONG_NO_LICH_SU', row.row, 'Ngày chứng từ', 'Ngày ở tương lai');
      if (!(Number(v.amount) > 0)) issue('CONG_NO_LICH_SU', row.row, 'Số tiền', 'Số tiền phải lớn hơn 0');
      entries.push({
        row: row.row, id, customerCode: String(v.customerCode), date: String(v.date), type: String(v.type) as ArHistoryType, amount: String(v.amount),
        documentNo: text(v.documentNo), invoiceNo: text(v.invoiceNo), erpOrderNo: text(v.erpOrderNo)?.trim().toUpperCase(), description: text(v.description), note: text(v.note), source: text(v.source), flags: text(v.flags),
        afterCutoff: String(v.date) > cutoff, status: 'NHAP',
      });
    }
    if (!entries.length && !errors.length) issue('CONG_NO_LICH_SU', 0, '—', 'File không có dòng lịch sử công nợ (sheet CONG_NO_LICH_SU)');

    // Dòng đã nhập ở lô trước (còn hiệu lực).
    const ids = entries.map((entry) => entry.id);
    // Thay lô bằng file mới: dòng của chính lô đó không tính là "đã nhập".
    const usedFilter: Document = { historyRowId: { $in: ids }, ...(replacingBatchId ? { importBatchId: { $ne: replacingBatchId } } : {}) };
    const [usedReceivables, usedPayments] = await Promise.all([
      this.db.collection('receivables').find(usedFilter, { projection: { historyRowId: 1, importBatchId: 1 }, ...options }).toArray(),
      this.db.collection('payments').find(usedFilter, { projection: { historyRowId: 1, importBatchId: 1 }, ...options }).toArray(),
    ]);
    const used = new Set([...usedReceivables, ...usedPayments].map((row) => String(row.historyRowId)));
    for (const entry of entries) if (used.has(entry.id)) issue('CONG_NO_LICH_SU', entry.row, 'Mã dòng', 'Dòng này đã nhập ở lô trước — hoàn tác lô đó trước khi nhập lại');

    // Khách hàng.
    const codes = [...new Set([...entries.map((entry) => entry.customerCode), ...expectRows.map((row) => String(row.values.customerCode))])];
    const partners = await this.db.collection('partners').find({ code: { $in: codes }, kind: { $in: ['CUSTOMER', 'BOTH'] } }, options).toArray();
    const partnerByCode = new Map(partners.map((row) => [String(row.code), row]));
    for (const entry of entries) if (!partnerByCode.has(entry.customerCode)) issue('CONG_NO_LICH_SU', entry.row, 'Mã KH', `Không có khách hàng ${entry.customerCode} trên ERP`);

    // Dòng hàng.
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    const linesByEntry = new Map<string, Line[]>();
    for (const row of lineRows) {
      const v = row.values;
      const entry = byId.get(String(v.entryId));
      if (!entry) {
        issue('CONG_NO_LICH_SU_HANG', row.row, 'Mã dòng', 'Không có mã dòng này ở sheet CONG_NO_LICH_SU');
        continue;
      }
      if (entry.type !== 'BAN_HANG' && entry.type !== 'TRA_HANG') issue('CONG_NO_LICH_SU_HANG', row.row, 'Mã dòng', 'Chỉ chứng từ bán / trả hàng có dòng hàng');
      const quantity = signedText(v.quantity);
      const unitPrice = signedText(v.unitPrice);
      linesByEntry.set(entry.id, [...(linesByEntry.get(entry.id) ?? []), {
        entryId: entry.id, ...(text(v.sku) ? { sku: text(v.sku) } : {}), ...(text(v.productName) ? { productName: text(v.productName) } : {}), ...(text(v.unit) ? { unit: text(v.unit) } : {}),
        ...(quantity ? { quantity } : {}), ...(unitPrice ? { unitPrice } : {}), ...(v.amount !== undefined ? { amount: String(v.amount) } : {}),
      }]);
    }
    for (const [entryId, lines] of linesByEntry) {
      const entry = byId.get(entryId) as Entry;
      const sum = lines.reduce((total, line) => total.add(line.amount ?? 0), new Decimal(0));
      if (sum.minus(entry.amount).abs().gt(1)) warnings.push(`${entry.id} (${entry.customerCode}): tổng dòng hàng ${sum.toFixed(0)} khác số tiền chứng từ ${new Decimal(entry.amount).toFixed(0)}`);
    }

    // Đối chiếu với phiếu BH trên ERP (19/10/2026): phiếu theo số chứng từ của dòng sau ngày chốt, phiếu kế toán ghép ở ô
    // "Phiếu ERP (trùng)", và mọi phiếu của các khách trong file từ 30 ngày trước ngày chốt (tìm phiếu lập lại với số khác).
    const after = entries.filter((entry) => entry.afterCutoff);
    const wanted = [...new Set([...after.map((entry) => entry.documentNo), ...entries.map((entry) => entry.erpOrderNo)].filter((value): value is string => Boolean(value)).map((value) => value.toUpperCase()))];
    const customerIds = [...partnerByCode.values()].map((row) => row._id as ObjectId);
    const codeOfPartner = new Map([...partnerByCode].map(([code, row]) => [String(row._id), code]));
    const windowStart = addDays(cutoff, -30);
    const orders = wanted.length || customerIds.length
      ? await this.db.collection('sales_orders').find(
        { $or: [...(wanted.length ? [{ code: { $in: wanted } }] : []), ...(customerIds.length ? [{ customerId: { $in: customerIds }, orderDate: { $gte: windowStart } }] : [])] },
        { projection: { code: 1, status: 1, customerId: 1, orderDate: 1, grandTotal: 1, 'lines.sku': 1, 'lines.gift': 1, 'lines.quantity': 1, 'lines.lineTotal': 1 }, ...options },
      ).toArray()
      : [];
    const liveOrders = orders.filter((row) => row.status !== 'CANCELLED');
    const orderByCode = new Map(liveOrders.map((row) => [String(row.code), row]));
    // Số công nợ phiếu BH đang ghi trên ERP (phiếu chưa xuất kho: tổng phiếu).
    const orderDebt = new Map<string, Decimal>();
    if (liveOrders.length) {
      const codeOf = new Map(liveOrders.map((row) => [String(row._id), String(row.code)]));
      const debts = await this.db.collection('receivables').find({ salesOrderId: { $in: liveOrders.map((row) => row._id) }, sourceType: { $ne: 'SALES_VOID_CREDIT' }, status: { $ne: 'VOIDED' } }, { projection: { salesOrderId: 1, amount: 1 }, ...options }).toArray();
      for (const debt of debts) {
        const code = codeOf.get(String(debt.salesOrderId)) as string;
        orderDebt.set(code, (orderDebt.get(code) ?? new Decimal(0)).add(decimalString(debt.amount)));
      }
    }
    const debtOf = (code: string) => orderDebt.get(code) ?? new Decimal(decimalString(orderByCode.get(code)?.grandTotal ?? 0));
    const consumed = new Set<string>();

    // Kế toán ghép: cùng một lần xuất đã có phiếu trên ERP (VD sổ cũ ghi theo ngày đơn 30/09, kho xuất 01/10) → không nhập, giữ phiếu ERP.
    for (const entry of entries.filter((row) => row.erpOrderNo)) {
      const code = entry.erpOrderNo as string;
      const order = orderByCode.get(code);
      const partner = partnerByCode.get(entry.customerCode);
      if (!DEBIT_TYPES.includes(entry.type)) issue('CONG_NO_LICH_SU', entry.row, 'Phiếu ERP (trùng)', 'Chỉ chứng từ bán / hoàn tiền ghép được với phiếu BH trên ERP');
      else if (!order) issue('CONG_NO_LICH_SU', entry.row, 'Phiếu ERP (trùng)', `Không có phiếu ${code} trên ERP (hoặc phiếu đã hủy)`);
      else if (partner && String(order.customerId) !== String(partner._id)) issue('CONG_NO_LICH_SU', entry.row, 'Phiếu ERP (trùng)', `Phiếu ${code} là của khách ${codeOfPartner.get(String(order.customerId)) ?? 'khác'}, không phải ${entry.customerCode}`);
      else {
        entry.status = 'BO_QUA_DA_CO_ERP';
        entry.match = `Kế toán ghép với phiếu ${code} trên ERP — ${debtGap(debtOf(code), entry.amount)}`;
        consumed.add(code);
      }
    }

    // Dòng sau ngày chốt: không nhập — kế toán nhập trên ERP. Đối chiếu để có danh sách việc: đã có / nghi trùng / chưa có.
    const partnerIds = [...new Set(after.map((entry) => partnerByCode.get(entry.customerCode)?._id).filter(Boolean))] as ObjectId[];
    const payments = partnerIds.length
      ? await this.db.collection('payments').find({ partnerId: { $in: partnerIds }, status: 'POSTED', mode: { $ne: 'HISTORY' }, receivedAt: { $gte: vnMidnight(cutoff) } }, { projection: { code: 1, partnerId: 1, amount: 1, receivedAt: 1, kind: 1 }, ...options }).toArray()
      : [];
    const matchedPayments = new Set<string>();
    for (const entry of after.filter((row) => row.status === 'NHAP')) {
      const code = entry.documentNo?.toUpperCase();
      if (code && orderByCode.has(code) && (DEBIT_TYPES.includes(entry.type) || entry.type === 'TRA_HANG')) {
        entry.status = 'BO_QUA_DA_CO_ERP';
        entry.match = `Phiếu ${code} đã có trên ERP${DEBIT_TYPES.includes(entry.type) ? ` — ${debtGap(debtOf(code), entry.amount)}` : ''}`;
        consumed.add(code);
        continue;
      }
      const kind = PAYMENT_KIND[entry.type];
      const partner = partnerByCode.get(entry.customerCode);
      if (kind && partner) {
        const twin = payments.find((payment) => !matchedPayments.has(String(payment._id))
          && (payment.partnerId as ObjectId).equals(partner._id as ObjectId)
          && vnDay(payment.receivedAt as Date) === entry.date
          && new Decimal(decimalString(payment.amount)).eq(entry.amount)
          && (String(payment.kind ?? 'RECEIPT') === kind));
        if (twin) {
          matchedPayments.add(String(twin._id));
          entry.status = 'BO_QUA_NGHI_TRUNG';
          entry.match = `Trùng phiếu ${String(twin.code)} trên ERP (cùng khách, ngày, số tiền)`;
        }
      }
    }

    // Phiếu ERP lập lại với số khác: gợi ý cho chứng từ bán chưa ghép (trước ngày chốt: cảnh báo, vẫn nhập; sau ngày chốt: nghi trùng).
    const twinOrders: TwinOrder[] = liveOrders
      .filter((row) => !consumed.has(String(row.code)) && !['DRAFT', 'VOIDED'].includes(String(row.status)) && row.orderDate && codeOfPartner.has(String(row.customerId)) && new Decimal(decimalString(row.grandTotal ?? 0)).gt(0))
      .map((row) => ({
        code: String(row.code), customerCode: codeOfPartner.get(String(row.customerId)) as string, orderDate: vnDay(row.orderDate as Date), debt: debtOf(String(row.code)).toFixed(2),
        lines: ((row.lines as Document[] | undefined) ?? []).map((line) => ({ sku: text(line.sku), quantity: decimalString(line.quantity), paid: line.gift !== true && new Decimal(decimalString(line.lineTotal ?? 0)).gt(0) })),
      }));
    const twinEntry = (entry: Entry) => ({ id: entry.id, customerCode: entry.customerCode, date: entry.date, documentNo: entry.documentNo, amount: entry.amount, lines: linesByEntry.get(entry.id) });
    const afterTwins = findErpTwins(after.filter((entry) => entry.status === 'NHAP' && entry.type === 'BAN_HANG').map(twinEntry), twinOrders);
    for (const twin of afterTwins) {
      const entry = byId.get(twin.id) as Entry;
      entry.status = 'BO_QUA_NGHI_TRUNG';
      entry.match = `Có thể đã lập trên ERP là phiếu ${twin.order.code} ngày ${viDate(twin.order.orderDate)} (${[twin.sameLines ? 'cùng dòng hàng' : '', twin.sameAmount ? 'cùng số tiền' : ''].filter(Boolean).join(', ')}) — kế toán kiểm lại`;
    }
    for (const entry of after) {
      if (entry.status !== 'NHAP') continue;
      entry.status = 'SAU_CHOT_CHUA_CO';
      entry.match = 'Chưa thấy trên ERP — kế toán nhập trên ERP';
    }
    const usedByAfter = new Set(afterTwins.map((twin) => twin.order.code));
    const recentStart = vnDay(windowStart);
    const twins = findErpTwins(
      entries.filter((entry) => entry.status === 'NHAP' && entry.type === 'BAN_HANG' && entry.date >= recentStart).map(twinEntry),
      twinOrders.filter((order) => !usedByAfter.has(order.code)),
    );
    if (twins.length) warnings.push(`${twins.length} chứng từ bán ở sổ cũ nghi đã được lập lại trên ERP với số khác — xem bảng "Nghi trùng với phiếu BH trên ERP"; nếu đúng là một lần xuất, ghi số phiếu ERP vào cột "Phiếu ERP (trùng)" rồi chạy lại`);
    const linked = entries.filter((entry) => entry.erpOrderNo && entry.status === 'BO_QUA_DA_CO_ERP').map((entry) => {
      const code = entry.erpOrderNo as string;
      const order = orderByCode.get(code);
      return { id: entry.id, customerCode: entry.customerCode, date: entry.date, documentNo: entry.documentNo ?? '', amount: entry.amount, order: { code, orderDate: order?.orderDate ? vnDay(order.orderDate as Date) : '', debt: debtOf(code).toFixed(2) } };
    });

    // Số đối chiếu.
    const expected = new Map<string, NonNullable<CustomerSummary['expected']>>();
    for (const row of expectRows) {
      const v = row.values;
      const code = String(v.customerCode);
      const pick = (key: string) => {
        const value = signedText(v[key]);
        if (text(v[key]) && value === undefined) issue('DOI_CHIEU_CONG_NO', row.row, key, 'Phải là số');
        return value;
      };
      expected.set(code, {
        ...(pick('tongCongNo') ? { tongCongNo: pick('tongCongNo') } : {}), ...(pick('daThanhToan') ? { daThanhToan: pick('daThanhToan') } : {}),
        ...(pick('phiVanChuyen') ? { phiVanChuyen: pick('phiVanChuyen') } : {}), ...(pick('conLai') ? { conLai: pick('conLai') } : {}),
        ...(text(v.sheet) ? { sheet: text(v.sheet) } : {}), ...(text(v.note) ? { note: text(v.note) } : {}),
      });
    }

    // Tổng theo khách + mô phỏng phân bổ (cảnh báo tự khóa) — nợ thường trước, phần nhóm công nợ tách riêng không tính quá hạn (CN-SEG-01).
    const ctx = await segmentContext(this.db, session);
    const customers: CustomerSummary[] = [];
    const byCustomer = new Map<string, Entry[]>();
    for (const entry of entries) byCustomer.set(entry.customerCode, [...(byCustomer.get(entry.customerCode) ?? []), entry]);
    const now = new Date();
    for (const [code, list] of [...byCustomer].sort(([a], [b]) => a.localeCompare(b))) {
      const partner = partnerByCode.get(code);
      const included = list.filter((entry) => entry.status === 'NHAP');
      const sum = (types: ArHistoryType[], source: Entry[] = included) => source.filter((entry) => types.includes(entry.type)).reduce((total, entry) => total.add(entry.amount), new Decimal(0));
      const debit = sum(['BAN_HANG', 'HOAN_TIEN']);
      const credits = sum(['THU_TIEN', 'PHI_VAN_CHUYEN', 'TRA_HANG', 'GIAM_GIA', 'TRU_LUONG']);
      const fileBalance = sum(['BAN_HANG', 'HOAN_TIEN'], list).minus(sum(['THU_TIEN', 'PHI_VAN_CHUYEN', 'TRA_HANG', 'GIAM_GIA', 'TRU_LUONG'], list));
      const term = Number(partner?.paymentTermDays ?? 0);
      const debts = included.filter((entry) => DEBIT_TYPES.includes(entry.type)).map((entry) => ({
        id: entry.id, code: entry.id, amount: entry.amount, paidAmount: '0', dueDate: addDays(entry.date, term), createdAt: vnNoon(entry.date),
        segments: historyLineSegments(linesByEntry.get(entry.id), entry.amount, ctx, partner ? String(partner._id) : undefined).map((part) => ({ ...part, paid: '0' })),
      }));
      const byDebt = new Map(debts.map((debt) => [debt.id, debt]));
      let leftover = new Decimal(0);
      for (const credit of included.filter((entry) => !DEBIT_TYPES.includes(entry.type)).sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id))) {
        let remaining = new Decimal(credit.amount);
        const place = (amount: Decimal, prefer: string | null) => {
          const plan = planPartsAllocation(debts.flatMap((debt) => openParts(debt)), amount.toFixed(2), prefer);
          for (const allocation of plan.allocations) {
            const debt = byDebt.get(allocation.receivableId) as (typeof debts)[number];
            debt.paidAmount = new Decimal(debt.paidAmount).add(allocation.amount).toFixed(2);
            const part = allocation.segment ? debt.segments.find((item) => item.code === allocation.segment) : undefined;
            if (part) part.paid = new Decimal(part.paid).add(allocation.amount).toFixed(2);
          }
          return new Decimal(plan.leftover);
        };
        if (credit.type === 'TRA_HANG') {
          for (const part of historyLineSegments(linesByEntry.get(credit.id), credit.amount, ctx, partner ? String(partner._id) : undefined)) {
            const share = Decimal.min(remaining, part.amount);
            remaining = remaining.minus(share).add(place(share, part.code));
          }
        }
        leftover = leftover.add(place(remaining, null));
      }
      let overdueAmount = new Decimal(0);
      let overdueDays = 0;
      for (const debt of debts) {
        const left = openParts(debt).filter((part) => part.segment === null).reduce((total, part) => total.add(part.outstanding), new Decimal(0));
        const days = daysOverdue(debt.dueDate, now);
        if (left.gt(0) && days > 60) {
          overdueAmount = overdueAmount.add(left);
          overdueDays = Math.max(overdueDays, days);
        }
      }
      const segmentLeft = debts.reduce((total, debt) => total.add(debt.segments.reduce((sum, part) => sum.add(part.amount).minus(part.paid), new Decimal(0))), new Decimal(0));
      const summary: CustomerSummary = {
        code, name: String(partner?.name ?? ''), partnerId: partner ? (partner._id as ObjectId).toHexString() : '', exempt: partner?.autoHoldExempt === true,
        rows: list.length, included: included.length, skipped: list.length - included.length, afterCutoff: list.filter((entry) => entry.afterCutoff).length,
        debit: debit.toFixed(2), receipt: sum(['THU_TIEN']).toFixed(2), freight: sum(['PHI_VAN_CHUYEN']).toFixed(2), returns: sum(['TRA_HANG', 'GIAM_GIA', 'TRU_LUONG']).toFixed(2),
        balance: debit.minus(credits).toFixed(2), prepayment: leftover.toFixed(2), segment: segmentLeft.toFixed(2), fileBalance: fileBalance.toFixed(2),
        ...(expected.has(code) ? { expected: expected.get(code) } : {}),
        overdue60: overdueAmount.gt(0) ? { amount: overdueAmount.toFixed(2), days: overdueDays } : null,
      };
      if (summary.overdue60 && !summary.exempt && partner?.status === 'ACTIVE') {
        warnings.push(`${code} ${summary.name}: còn ${new Decimal(summary.overdue60.amount).toFixed(0)} đ nợ quá 60 ngày — sẽ bị tự khóa đặt hàng ở lần rà soát tới (tích "Không tự khóa" ở sổ công nợ theo khách nếu là NPP trả gối đầu)`);
      }
      customers.push(summary);
    }
    return { entries, linesByEntry, partnerByCode, customers, warnings, twins, linked };
  }

  private summarize(analysis: Awaited<ReturnType<ArHistoryImportService['analyze']>>, errors: ImportIssue[]) {
    const included = analysis.entries.filter((entry) => entry.status === 'NHAP');
    const total = (pick: (row: CustomerSummary) => string) => analysis.customers.reduce((sum, row) => sum.add(pick(row)), new Decimal(0)).toFixed(2);
    return {
      sheets: AR_HISTORY_SHEETS.map((sheet) => ({
        name: sheet.name, title: sheet.title,
        rows: sheet.name === 'CONG_NO_LICH_SU' ? analysis.entries.length : sheet.name === 'CONG_NO_LICH_SU_HANG' ? [...analysis.linesByEntry.values()].reduce((sum, lines) => sum + lines.length, 0) : analysis.customers.filter((row) => row.expected).length,
        create: sheet.name === 'CONG_NO_LICH_SU' ? included.length : 0, update: 0,
        errors: errors.filter((error) => error.sheet === sheet.name).length,
      })),
      totals: {
        customers: analysis.customers.length,
        included: included.length,
        skipped: analysis.entries.length - included.length,
        debit: total((row) => row.debit),
        receipt: total((row) => row.receipt),
        freight: total((row) => row.freight),
        returns: total((row) => row.returns),
        balance: total((row) => row.balance),
        prepayment: total((row) => row.prepayment),
        // Giữ trường của lô nhập ban đầu để danh sách lô hiển thị được.
        receivablesAmount: total((row) => row.debit),
        receivablesByCustomer: analysis.customers.map((row) => ({ code: row.code, amount: row.balance })),
      },
      customers: analysis.customers,
      afterCutoff: analysis.entries.filter((entry) => entry.afterCutoff).map((entry) => ({
        id: entry.id, customerCode: entry.customerCode, date: entry.date, type: entry.type, typeLabel: TYPE_LABEL[entry.type], documentNo: entry.documentNo ?? entry.invoiceNo ?? '',
        amount: entry.amount, status: entry.status, ...(entry.match ? { match: entry.match } : {}), ...(entry.description ? { description: entry.description } : {}),
      })),
      flagged: analysis.entries.filter((entry) => entry.flags).map((entry) => ({ id: entry.id, customerCode: entry.customerCode, date: entry.date, type: entry.type, amount: entry.amount, flags: entry.flags, source: entry.source ?? '' })),
      warnings: analysis.warnings,
      // Phiếu BH trên ERP: kế toán đã ghép (không nhập) / nghi trùng chưa ghép (vẫn nhập, cần kiểm).
      linked: analysis.linked,
      twins: analysis.twins,
    };
  }

  async dryRun(body: unknown, fileName: string | undefined, cutoffInput: string | undefined) {
    const cutoff = this.cutoffOf(cutoffInput);
    const { workbook, sha256 } = await this.imports.readWorkbook(body);
    const parsed = this.imports.parseSheets(workbook, sha256, AR_HISTORY_SHEETS);
    const analysis = await this.analyze(parsed, cutoff);
    const committed = await this.db.collection('import_batches').findOne({ sha256, status: 'COMMITTED' }, { projection: { code: 1 } });
    if (committed) parsed.errors.unshift({ sheet: '—', row: 0, column: '—', message: `File này đã được ghi ở lô ${String(committed.code)} — hoàn tác lô đó trước khi ghi lại` });
    return { ok: parsed.errors.length === 0 && analysis.entries.length > 0, kind: 'AR_HISTORY', cutoff, fileName: fileName ?? 'lich-su-cong-no.xlsx', sha256, ...this.summarize(analysis, parsed.errors), errors: parsed.errors, truncated: parsed.errors.length >= 500 };
  }

  async commit(body: unknown, fileName: string | undefined, cutoffInput: string | undefined, request: AuthenticatedRequest) {
    const cutoff = this.cutoffOf(cutoffInput);
    const { workbook, sha256 } = await this.imports.readWorkbook(body);
    if (await this.db.collection('import_batches').findOne({ sha256, status: 'COMMITTED' }, { projection: { _id: 1 } })) {
      throw new ConflictException({ code: 'IMPORT_ALREADY_COMMITTED', message: 'File này đã được ghi — hoàn tác lô cũ trước khi ghi lại' });
    }
    const session = this.db.client.startSession();
    try {
      let batch: Document | null = null;
      await session.withTransaction(async () => {
        const parsed = this.imports.parseSheets(workbook, sha256, AR_HISTORY_SHEETS);
        const analysis = await this.analyze(parsed, cutoff, session);
        if (parsed.errors.length) throw new UnprocessableEntityException({ code: 'IMPORT_HAS_ERRORS', message: `File còn ${parsed.errors.length} lỗi — chạy kiểm tra và sửa trước khi ghi`, details: parsed.errors.slice(0, 50) });
        const summary = this.summarize(analysis, parsed.errors);
        const batchId = new ObjectId();
        const code = await this.sequences.next('IMP', session, 3);
        const now = new Date();
        const { receivables, payments, byCustomer } = await this.buildRecords(analysis, batchId, code, cutoff, now, request, session);
        if (receivables.length) await this.db.collection('receivables').insertMany(receivables, { session });
        if (payments.length) await this.db.collection('payments').insertMany(payments, { session });
        // Tách phần nhóm công nợ (VD quạt) và phân bổ lại: tiền thu trừ nợ thường trước (CN-SEG-01).
        for (const entries of byCustomer.values()) {
          const partner = analysis.partnerByCode.get(entries[0]?.customerCode ?? '');
          if (partner) await reallocatePartner(this.db, partner._id as ObjectId, session, now);
        }
        batch = {
          _id: batchId,
          code,
          kind: 'AR_HISTORY',
          cutoff,
          fileName: fileName ?? 'lich-su-cong-no.xlsx',
          sha256,
          status: 'COMMITTED',
          sheets: summary.sheets,
          totals: summary.totals,
          customers: summary.customers,
          afterCutoff: summary.afterCutoff,
          linked: summary.linked,
          twins: summary.twins,
          receivableIds: receivables.map((row) => row._id as ObjectId),
          paymentIds: payments.map((row) => row._id as ObjectId),
          created: {},
          updated: [],
          openings: [],
          createdBy: toObjectId(request.user.sub),
          createdByName: request.user.displayName,
          createdAt: now,
          confirmations: [],
        };
        await this.db.collection('import_batches').insertOne(batch, { session });
        await this.audit.record({
          actorId: request.user.sub, actorEmail: request.user.email, correlationId: request.correlationId,
          action: 'IMPORT_COMMITTED', entityType: 'ImportBatch', entityId: batchId.toHexString(),
          metadata: { code, kind: 'AR_HISTORY', fileName, sha256, cutoff, totals: { ...summary.totals, receivablesByCustomer: undefined }, receivables: receivables.length, payments: payments.length },
        }, session);
      });
      return this.imports.presentBatch(batch as unknown as Document);
    } finally {
      await session.endSession();
    }
  }

  /**
   * Dựng khoản phải thu (chứng từ tăng nợ) + phiếu giảm nợ của lô lịch sử từ kết quả kiểm tra. Phiếu giảm nợ phân bổ chứng từ lịch sử
   * cũ nhất trước (sau đó reallocatePartner phân bổ lại theo nhóm công nợ tách riêng); thu vượt → khoản trả trước.
   * reuse (thay lô): giữ nguyên _id / mã của chứng từ / phiếu cùng mã dòng và khoản trả trước theo khách — phiếu ngoài lô vẫn trỏ đúng.
   */
  private async buildRecords(
    analysis: Awaited<ReturnType<ArHistoryImportService['analyze']>>,
    batchId: ObjectId,
    code: string,
    cutoff: string,
    now: Date,
    request: AuthenticatedRequest,
    session: ClientSession,
    reuse?: { receivables: Map<string, Document>; payments: Map<string, Document>; prepayments: Map<string, Document>; floors?: Map<string, Decimal> },
  ) {
    const stamp = { importBatchId: batchId };
    const receivables: Document[] = [];
    const payments: Document[] = [];
    const farFuture = new Date(now);
    farFuture.setUTCFullYear(farFuture.getUTCFullYear() + 10);
    const identity = async (old: Document | undefined, prefix: 'AR' | 'PAY') => (old ? { _id: old._id as ObjectId, code: String(old.code) } : { _id: new ObjectId(), code: await this.sequences.next(prefix, session) });

    const byCustomer = new Map<string, Entry[]>();
    for (const entry of analysis.entries) if (entry.status === 'NHAP') byCustomer.set(entry.customerCode, [...(byCustomer.get(entry.customerCode) ?? []), entry]);
    for (const [customerCode, entries] of byCustomer) {
      const partner = analysis.partnerByCode.get(customerCode) as Document;
      const partnerId = partner._id as ObjectId;
      const term = Number(partner.paymentTermDays ?? 0);
      // Chứng từ phải thu.
      const debts = new Map<string, Document>();
      for (const entry of entries.filter((row) => DEBIT_TYPES.includes(row.type)).sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id))) {
        const lines = analysis.linesByEntry.get(entry.id) ?? [];
        // Thay lô: phiếu thu theo chứng từ đã thu đủ số cũ, số mới nhỏ hơn dưới 1 đ → giữ số đã thu (ghi lại số theo file).
        const floor = reuse?.floors?.get(entry.id);
        const kept = floor && floor.gt(entry.amount) ? floor : null;
        const doc: Document = {
          ...(await identity(reuse?.receivables.get(entry.id), 'AR')),
          partnerId,
          sourceType: 'HISTORY_IMPORT',
          historyRowId: entry.id,
          historyType: entry.type,
          ...(entry.documentNo ? { historyDocumentNo: entry.documentNo } : {}),
          ...(entry.invoiceNo ? { historyInvoiceNo: entry.invoiceNo } : {}),
          documentDate: entry.date,
          note: [entry.type === 'HOAN_TIEN' ? TYPE_LABEL.HOAN_TIEN : '', entry.description, entry.note].filter(Boolean).join(' · ') || undefined,
          ...(entry.source ? { historySource: entry.source } : {}),
          ...(lines.length ? { historyLines: lines.map(({ entryId: _id, ...line }) => line) } : {}),
          amount: kept ?? new Decimal(entry.amount),
          ...(kept ? { historyFileAmount: decimal(new Decimal(entry.amount).toFixed(2)) } : {}),
          paidAmount: new Decimal(0),
          dueDate: addDays(entry.date, term),
          createdAt: vnNoon(entry.date),
          importedAt: now,
          updatedAt: now,
          version: 1,
          ...stamp,
        };
        if (doc.note === undefined) delete doc.note;
        debts.set(entry.id, doc);
      }
      // Phiếu giảm nợ theo thứ tự ngày, phân bổ chứng từ lịch sử cũ nhất trước.
      let lastCreditDate = '';
      for (const entry of entries.filter((row) => !DEBIT_TYPES.includes(row.type)).sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id))) {
        const kind = PAYMENT_KIND[entry.type] as 'RECEIPT' | 'FREIGHT' | 'RETURN';
        const open = [...debts.values()].map((doc) => ({ id: String(doc.historyRowId), outstanding: (doc.amount as Decimal).minus(doc.paidAmount as Decimal).toFixed(2), dueDate: doc.dueDate as Date, createdAt: doc.createdAt as Date, code: String(doc.historyRowId) }));
        const plan = planFifoAllocation(open, entry.amount);
        const allocations = plan.allocations.map((allocation) => {
          const doc = debts.get(allocation.id) as Document;
          doc.paidAmount = (doc.paidAmount as Decimal).add(allocation.amount);
          return { receivableId: doc._id as ObjectId, amount: decimal(allocation.amount) };
        });
        const bank = /chuy[eể]n kho[aả]n|ng[aâ]n h[aà]ng|銀行|银行/i.test(entry.description ?? '');
        payments.push({
          ...(await identity(reuse?.payments.get(entry.id), 'PAY')),
          partnerId,
          amount: decimal(entry.amount),
          kind,
          mode: 'HISTORY',
          method: kind === 'RECEIPT' && bank ? 'BANK_TRANSFER' : 'OTHER',
          receivedAt: vnNoon(entry.date),
          ...(entry.documentNo || entry.invoiceNo ? { reference: entry.documentNo ?? entry.invoiceNo } : {}),
          note: [TYPE_LABEL[entry.type], entry.description, entry.note].filter(Boolean).join(' · '),
          historyRowId: entry.id,
          historyType: entry.type,
          ...(entry.documentNo ? { historyDocumentNo: entry.documentNo } : {}),
          ...(entry.source ? { historySource: entry.source } : {}),
          // Dòng hàng của phiếu trả hàng: phần hàng thuộc nhóm công nợ tách riêng trừ vào phần nhóm (CN-SEG-01).
          ...(analysis.linesByEntry.get(entry.id)?.length ? { historyLines: (analysis.linesByEntry.get(entry.id) ?? []).map(({ entryId: _id, ...line }) => line) } : {}),
          allocations,
          ...(new Decimal(plan.leftover).gt(0) ? { unappliedAmount: decimal(plan.leftover) } : {}),
          status: 'POSTED',
          postedBy: toObjectId(request.user.sub),
          postedAt: now,
          createdAt: now,
          ...stamp,
        });
        lastCreditDate = entry.date;
      }
      for (const doc of debts.values()) {
        const amount = doc.amount as Decimal;
        const paid = doc.paidAmount as Decimal;
        receivables.push({ ...doc, amount: decimal(amount.toFixed(2)), paidAmount: decimal(paid.toFixed(2)), status: paid.eq(amount) ? 'PAID' : paid.gt(0) ? 'PARTIALLY_PAID' : 'OPEN' });
      }
      // Thu vượt tổng chứng từ lịch sử → khoản khách trả trước (phải thu âm).
      const leftover = payments.filter((row) => (row.partnerId as ObjectId).equals(partnerId) && row.unappliedAmount).reduce((sum, row) => sum.add(decimalString(row.unappliedAmount)), new Decimal(0));
      if (leftover.gt(0)) {
        receivables.push({
          ...(await identity(reuse?.prepayments.get(partnerId.toHexString()), 'AR')),
          partnerId,
          sourceType: 'CUSTOMER_PREPAYMENT',
          historyPrepayment: true,
          amount: decimal(`-${leftover.toFixed(2)}`),
          paidAmount: decimal('0'),
          status: 'OPEN',
          dueDate: farFuture,
          note: `Sổ công nợ cũ: đã thu / giảm nợ vượt số phát sinh — khách trả trước (lô ${code})`,
          createdAt: vnNoon(lastCreditDate || cutoff),
          importedAt: now,
          updatedAt: now,
          version: 1,
          ...stamp,
        });
      }
    }
    return { receivables, payments, byCustomer };
  }

  /**
   * Chạy thử thay lô lịch sử bằng file mới (VD file dựng từ Excel gốc, số chính xác đến số lẻ thay bản trích PDF làm tròn):
   * cùng ngày chốt của lô; so từng khách số cũ → mới.
   */
  async replaceDryRun(id: string, body: unknown, fileName: string | undefined) {
    const batch = await this.load(id);
    if (batch.status !== 'COMMITTED') throw new ConflictException({ code: 'IMPORT_BATCH_STATE', message: 'Lô không còn ở trạng thái đã ghi' });
    const { workbook, sha256 } = await this.imports.readWorkbook(body);
    const parsed = this.imports.parseSheets(workbook, sha256, AR_HISTORY_SHEETS);
    const analysis = await this.analyze(parsed, String(batch.cutoff), undefined, batch._id as ObjectId);
    if (sha256 === batch.sha256) parsed.errors.unshift({ sheet: '—', row: 0, column: '—', message: `File này chính là file đang dùng ở lô ${String(batch.code)}` });
    const other = await this.db.collection('import_batches').findOne({ sha256, status: 'COMMITTED', _id: { $ne: batch._id } }, { projection: { code: 1 } });
    if (other) parsed.errors.unshift({ sheet: '—', row: 0, column: '—', message: `File này đã được ghi ở lô ${String(other.code)}` });
    const pins = planDocumentPins(analysis.entries, await this.documentPins(batch));
    for (const message of pins.blocked) parsed.errors.push({ sheet: AR_HISTORY_SHEETS[0]?.name ?? '—', row: 0, column: '—', message });
    const summary = this.summarize(analysis, parsed.errors);
    return {
      ok: parsed.errors.length === 0 && analysis.entries.length > 0, kind: 'AR_HISTORY', cutoff: batch.cutoff, fileName: fileName ?? 'lich-su-cong-no.xlsx', sha256,
      ...summary, errors: parsed.errors, truncated: parsed.errors.length >= 500,
      kept: pins.kept,
      replacing: this.imports.presentBatch(batch),
      compare: ArHistoryImportService.compare((batch.customers as CustomerSummary[] | undefined) ?? [], summary.customers),
    };
  }

  /** Tổng phiếu thu theo từng chứng từ (ngoài lô) đã trả vào từng chứng từ của lô, theo mã dòng. */
  private async documentPins(batch: Document, session?: ClientSession): Promise<Map<string, DocumentPin>> {
    const options = session ? { session } : {};
    const old = await this.db.collection('receivables').find({ _id: { $in: (batch.receivableIds as ObjectId[] | undefined) ?? [] }, historyRowId: { $exists: true } }, { projection: { historyRowId: 1 }, ...options }).toArray();
    const rowOf = new Map(old.map((row) => [(row._id as ObjectId).toHexString(), String(row.historyRowId)]));
    const payments = old.length
      ? await this.db.collection('payments').find({ importBatchId: { $ne: batch._id }, status: 'POSTED', 'allocations.receivableId': { $in: old.map((row) => row._id as ObjectId) } }, { projection: { code: 1, mode: 1, allocations: 1 }, ...options }).toArray()
      : [];
    const pins = new Map<string, DocumentPin>();
    for (const payment of payments) {
      if (!DOCUMENT_MODES.has(String(payment.mode ?? ''))) continue;
      for (const allocation of (payment.allocations as Document[] | undefined) ?? []) {
        const rowId = rowOf.get(String(allocation.receivableId));
        if (!rowId) continue;
        const pin = pins.get(rowId) ?? { paid: new Decimal(0), payments: [] };
        pin.paid = pin.paid.add(decimalString(allocation.amount));
        if (!pin.payments.includes(String(payment.code))) pin.payments.push(String(payment.code));
        pins.set(rowId, pin);
      }
    }
    return pins;
  }

  /** So từng khách: phát sinh / thu / phí vận chuyển / trả hàng / còn lại của lô cũ → file mới. */
  private static compare(before: CustomerSummary[], after: CustomerSummary[]) {
    const old = new Map(before.map((row) => [row.code, row]));
    const codes = [...new Set([...before.map((row) => row.code), ...after.map((row) => row.code)])].sort();
    const fresh = new Map(after.map((row) => [row.code, row]));
    return codes.map((code) => {
      const a = old.get(code);
      const b = fresh.get(code);
      const delta = new Decimal(b?.balance ?? 0).minus(a?.balance ?? 0);
      return {
        code, name: b?.name ?? a?.name ?? '',
        before: a ? { debit: a.debit, receipt: a.receipt, freight: a.freight, returns: a.returns, balance: a.balance, rows: a.included } : null,
        after: b ? { debit: b.debit, receipt: b.receipt, freight: b.freight, returns: b.returns, balance: b.balance, rows: b.included } : null,
        delta: delta.toFixed(2),
      };
    });
  }

  /**
   * Thay lô lịch sử bằng file mới trong một giao dịch: giữ _id / mã của chứng từ và phiếu cùng mã dòng (phiếu thu ngoài lô vẫn trỏ đúng),
   * gỡ phần phiếu lô cũ đã trả cho chứng từ ngoài lô, ghi bản ghi mới, phân bổ lại từng khách (nhóm công nợ tách riêng, nợ thường trước).
   */
  async replace(id: string, body: unknown, fileName: string | undefined, request: AuthenticatedRequest) {
    const { workbook, sha256 } = await this.imports.readWorkbook(body);
    const session = this.db.client.startSession();
    try {
      let result: Document | null = null;
      await session.withTransaction(async () => {
        const batch = await this.db.collection('import_batches').findOne({ _id: toObjectId(id), kind: 'AR_HISTORY', status: 'COMMITTED' }, { session });
        if (!batch) throw new ConflictException({ code: 'IMPORT_BATCH_STATE', message: 'Lô không còn ở trạng thái đã ghi' });
        if (sha256 === batch.sha256) throw new ConflictException({ code: 'IMPORT_SAME_FILE', message: `File này chính là file đang dùng ở lô ${String(batch.code)}` });
        const parsed = this.imports.parseSheets(workbook, sha256, AR_HISTORY_SHEETS);
        const analysis = await this.analyze(parsed, String(batch.cutoff), session, batch._id as ObjectId);
        if (parsed.errors.length) throw new UnprocessableEntityException({ code: 'IMPORT_HAS_ERRORS', message: `File còn ${parsed.errors.length} lỗi — chạy kiểm tra và sửa trước khi ghi`, details: parsed.errors.slice(0, 50) });
        const pins = planDocumentPins(analysis.entries, await this.documentPins(batch, session));
        if (pins.blocked.length) throw new ConflictException({ code: 'IMPORT_REPLACE_BLOCKED', message: `Không thay được lô ${String(batch.code)}: ${pins.blocked[0]}` });
        const summary = this.summarize(analysis, parsed.errors);
        const now = new Date();
        const batchId = batch._id as ObjectId;
        const oldReceivableIds = (batch.receivableIds as ObjectId[]) ?? [];
        const oldPaymentIds = (batch.paymentIds as ObjectId[]) ?? [];
        const [oldReceivables, oldPayments] = await Promise.all([
          this.db.collection('receivables').find({ _id: { $in: oldReceivableIds } }, { session }).toArray(),
          this.db.collection('payments').find({ _id: { $in: oldPaymentIds } }, { session }).toArray(),
        ]);
        const reuse = {
          receivables: new Map(oldReceivables.filter((row) => row.historyRowId).map((row) => [String(row.historyRowId), row])),
          payments: new Map(oldPayments.filter((row) => row.historyRowId).map((row) => [String(row.historyRowId), row])),
          prepayments: new Map(oldReceivables.filter((row) => row.historyPrepayment).map((row) => [String(row.partnerId), row])),
          floors: pins.floors,
        };
        // Gỡ phần phiếu lô cũ đã trả cho chứng từ ngoài lô (sau khi phân bổ nợ thường trước), rồi xóa bản ghi cũ của lô.
        const batchReceivables = new Set(oldReceivableIds.map((row) => row.toHexString()));
        for (const payment of oldPayments) {
          for (const allocation of (payment.allocations as Document[] | undefined) ?? []) {
            if (batchReceivables.has(String(allocation.receivableId))) continue;
            const amount = new Decimal(decimalString(allocation.amount)).neg().toFixed(2);
            await this.db.collection('receivables').updateOne(
              { _id: allocation.receivableId as ObjectId },
              { $inc: { paidAmount: decimal(amount), version: 1, ...(allocation.segment ? { 'segments.$[part].paid': decimal(amount) } : {}) }, $set: { updatedAt: now } },
              { session, ...(allocation.segment ? { arrayFilters: [{ 'part.code': allocation.segment }] } : {}) },
            );
          }
        }
        await this.db.collection('payments').deleteMany({ _id: { $in: oldPaymentIds }, importBatchId: batchId }, { session });
        await this.db.collection('receivables').deleteMany({ _id: { $in: oldReceivableIds }, importBatchId: batchId }, { session });

        const { receivables, payments } = await this.buildRecords(analysis, batchId, String(batch.code), String(batch.cutoff), now, request, session, reuse);
        // Phiếu ngoài lô (thu theo khách / theo chứng từ / bù trừ) vẫn trỏ vào chứng từ giữ _id: cộng vào số đã thu để khớp tổng phân bổ.
        const ids = receivables.map((row) => row._id as ObjectId);
        const outside = await this.db.collection('payments').find({ _id: { $nin: payments.map((row) => row._id as ObjectId) }, 'allocations.receivableId': { $in: ids } }, { session }).toArray();
        const extra = new Map<string, Decimal>();
        for (const payment of outside) {
          for (const allocation of (payment.allocations as Document[] | undefined) ?? []) {
            const key = String(allocation.receivableId);
            if (ids.some((row) => row.toHexString() === key)) extra.set(key, (extra.get(key) ?? new Decimal(0)).add(decimalString(allocation.amount)));
          }
        }
        for (const row of receivables) {
          const add = extra.get((row._id as ObjectId).toHexString());
          if (!add) continue;
          const paid = new Decimal(decimalString(row.paidAmount)).add(add);
          const amount = new Decimal(decimalString(row.amount));
          if (amount.lt(0) && paid.lt(amount)) {
            throw new ConflictException({ code: 'IMPORT_REPLACE_BLOCKED', message: `Khoản khách trả trước ${String(row.code)} đã bù trừ ${add.neg().toFixed(0)} đ, nhiều hơn số trả trước theo file mới ${amount.neg().toFixed(0)} đ` });
          }
          row.paidAmount = decimal(paid.toFixed(2));
          row.status = amount.lt(0) ? (paid.eq(amount) ? 'PAID' : 'OPEN') : paid.gte(amount) ? 'PAID' : paid.gt(0) ? 'PARTIALLY_PAID' : 'OPEN';
        }
        if (receivables.length) await this.db.collection('receivables').insertMany(receivables, { session });
        if (payments.length) await this.db.collection('payments').insertMany(payments, { session });
        const partnerIds = new Set<string>([
          ...((batch.customers as CustomerSummary[] | undefined) ?? []).map((row) => row.partnerId).filter(Boolean),
          ...summary.customers.map((row) => row.partnerId).filter(Boolean),
        ]);
        for (const partnerId of partnerIds) {
          try {
            await reallocatePartner(this.db, new ObjectId(partnerId), session, now);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const code = summary.customers.find((row) => row.partnerId === partnerId)?.code ?? partnerId;
            throw new ConflictException({ code: 'IMPORT_REPLACE_BLOCKED', message: `Không thay được lô ${String(batch.code)}: ${code} — ${message}` });
          }
        }
        const replacement = { at: now, byName: request.user.displayName, by: toObjectId(request.user.sub), fileName: batch.fileName, sha256: batch.sha256, totals: batch.totals, ...(pins.kept.length ? { kept: pins.kept } : {}) };
        result = await this.db.collection('import_batches').findOneAndUpdate(
          { _id: batchId },
          {
            $set: {
              fileName: fileName ?? 'lich-su-cong-no.xlsx', sha256, sheets: summary.sheets, totals: summary.totals, customers: summary.customers, afterCutoff: summary.afterCutoff, linked: summary.linked, twins: summary.twins,
              receivableIds: ids, paymentIds: payments.map((row) => row._id as ObjectId), confirmations: [], replacedAt: now, replacedByName: request.user.displayName,
            },
            $push: { replacements: replacement },
          } as Document,
          { returnDocument: 'after', session },
        );
        await this.audit.record({
          actorId: request.user.sub, actorEmail: request.user.email, correlationId: request.correlationId,
          action: 'IMPORT_REPLACED', entityType: 'ImportBatch', entityId: id,
          metadata: { code: batch.code, kind: 'AR_HISTORY', previous: { fileName: batch.fileName, sha256: batch.sha256 }, fileName, sha256, receivables: receivables.length, payments: payments.length, kept: pins.kept.length },
        }, session);
      });
      return this.imports.presentBatch(result as unknown as Document);
    } finally {
      await session.endSession();
    }
  }

  private async load(id: string) {
    const batch = await this.db.collection('import_batches').findOne({ _id: toObjectId(id), kind: 'AR_HISTORY' });
    if (!batch) throw new NotFoundException({ code: 'IMPORT_BATCH_NOT_FOUND', message: 'Không tìm thấy lô nhập lịch sử công nợ' });
    return batch;
  }

  /** Đối chiếu sau nhập: theo từng khách, số trong file / đã ghi / số tổng sổ cũ; số chứng từ, phiếu thực có. */
  async report(id: string) {
    const batch = await this.load(id);
    const receivableIds = (batch.receivableIds as ObjectId[]) ?? [];
    const paymentIds = (batch.paymentIds as ObjectId[]) ?? [];
    const [receivables, payments] = await Promise.all([
      this.db.collection('receivables').find({ _id: { $in: receivableIds } }).toArray(),
      this.db.collection('payments').find({ _id: { $in: paymentIds } }).toArray(),
    ]);
    const customers = ((batch.customers as CustomerSummary[]) ?? []).map((row) => {
      const partnerId = row.partnerId;
      const own = receivables.filter((doc) => String(doc.partnerId) === partnerId);
      const mine = payments.filter((doc) => String(doc.partnerId) === partnerId);
      const sum = (docs: Document[], pick: (doc: Document) => boolean, field = 'amount') => docs.filter(pick).reduce((total, doc) => total.add(decimalString(doc[field])), new Decimal(0));
      const debit = sum(own, (doc) => doc.sourceType === 'HISTORY_IMPORT');
      const receipt = sum(mine, (doc) => doc.kind === 'RECEIPT');
      const freight = sum(mine, (doc) => doc.kind === 'FREIGHT');
      const returns = sum(mine, (doc) => doc.kind === 'RETURN');
      const outstanding = own.reduce((total, doc) => total.add(decimalString(doc.amount)).minus(decimalString(doc.paidAmount)), new Decimal(0));
      // Chứng từ giữ số đã thu theo chứng từ khi thay lô (lệch dưới 1 đ so với file): so với file theo số ghi trong file.
      const kept = own.filter((doc) => doc.historyFileAmount !== undefined).reduce((total, doc) => total.add(decimalString(doc.amount)).minus(decimalString(doc.historyFileAmount)), new Decimal(0));
      const imported = {
        debit: debit.toFixed(2), receipt: receipt.toFixed(2), freight: freight.toFixed(2), returns: returns.toFixed(2), balance: debit.minus(receipt).minus(freight).minus(returns).toFixed(2), outstanding: outstanding.toFixed(2),
        ...(kept.isZero() ? {} : { kept: kept.toFixed(2) }),
      };
      const fileDebit = debit.minus(kept);
      const ok = fileDebit.toFixed(2) === row.debit && imported.receipt === row.receipt && imported.freight === row.freight && imported.returns === row.returns && fileDebit.minus(receipt).minus(freight).minus(returns).toFixed(2) === row.balance;
      const diffs: Array<{ field: string; ours: string; excel: string; delta: string }> = [];
      const expected = row.expected ?? {};
      const compare = (field: string, ours: string, excel: string | undefined) => {
        if (excel === undefined) return;
        const delta = new Decimal(ours).minus(excel);
        if (!delta.isZero()) diffs.push({ field, ours, excel, delta: delta.toFixed(2) });
      };
      compare('tongCongNo', new Decimal(row.debit).minus(row.returns).toFixed(2), expected.tongCongNo);
      compare('daThanhToan', row.receipt, expected.daThanhToan);
      compare('phiVanChuyen', row.freight, expected.phiVanChuyen);
      compare('conLai', row.fileBalance, expected.conLai);
      return { ...row, imported, ok, diffs };
    });
    return {
      batch: this.imports.presentBatch(batch),
      records: [
        { collection: 'receivables', expected: receivableIds.length, actual: receivables.length, ok: receivableIds.length === receivables.length },
        { collection: 'payments', expected: paymentIds.length, actual: payments.length, ok: paymentIds.length === payments.length },
      ],
      customers,
      afterCutoff: batch.afterCutoff ?? [],
      linked: batch.linked ?? [],
      twins: batch.twins ?? [],
      ok: customers.every((row) => row.ok) && receivableIds.length === receivables.length && paymentIds.length === payments.length,
    };
  }

  /**
   * Bổ sung dòng hàng của phiếu trả hàng / giảm nợ cho lô đã ghi trước khi có CN-SEG-01 (lúc đó dòng hàng phiếu trả bị bỏ):
   * nạp lại đúng file đã ghi (cùng SHA-256), ghi historyLines vào phiếu theo mã dòng. Sau đó áp dụng lại nhóm công nợ tách riêng.
   */
  async attachReturnLines(id: string, body: unknown, request: AuthenticatedRequest) {
    const batch = await this.load(id);
    if (batch.status !== 'COMMITTED') throw new ConflictException({ code: 'IMPORT_BATCH_STATE', message: 'Lô không còn ở trạng thái đã ghi' });
    const { workbook, sha256 } = await this.imports.readWorkbook(body);
    if (sha256 !== batch.sha256) throw new ConflictException({ code: 'IMPORT_FILE_MISMATCH', message: `File khác file đã ghi ở lô ${String(batch.code)} — chọn đúng file đã ghi` });
    const parsed = this.imports.parseSheets(workbook, sha256, AR_HISTORY_SHEETS);
    const lines = new Map<string, Document[]>();
    for (const row of parsed.sheets.get('CONG_NO_LICH_SU_HANG') ?? []) {
      const v = row.values;
      const quantity = signedText(v.quantity);
      const unitPrice = signedText(v.unitPrice);
      const line = {
        ...(text(v.sku) ? { sku: text(v.sku) } : {}), ...(text(v.productName) ? { productName: text(v.productName) } : {}), ...(text(v.unit) ? { unit: text(v.unit) } : {}),
        ...(quantity ? { quantity } : {}), ...(unitPrice ? { unitPrice } : {}), ...(v.amount !== undefined ? { amount: String(v.amount) } : {}),
      };
      lines.set(String(v.entryId), [...(lines.get(String(v.entryId)) ?? []), line]);
    }
    const payments = await this.db.collection('payments').find({ importBatchId: batch._id, historyRowId: { $in: [...lines.keys()] } }, { projection: { historyRowId: 1 } }).toArray();
    let updated = 0;
    for (const payment of payments) {
      const result = await this.db.collection('payments').updateOne({ _id: payment._id }, { $set: { historyLines: lines.get(String(payment.historyRowId)) ?? [] } });
      updated += result.modifiedCount;
    }
    await this.db.collection<{ _id: string } & Document>('debt_segment_state').updateOne({ _id: 'state' }, { $inc: { configVersion: 1 }, $set: { updatedAt: new Date() } }, { upsert: true });
    await this.db.collection('import_batches').updateOne({ _id: batch._id }, { $set: { returnLinesAttachedAt: new Date(), returnLinesAttachedBy: request.user.displayName } });
    await this.audit.record({ actorId: request.user.sub, actorEmail: request.user.email, correlationId: request.correlationId, action: 'IMPORT_RETURN_LINES_ATTACHED', entityType: 'ImportBatch', entityId: id, metadata: { code: batch.code, payments: payments.length, updated } });
    return { code: batch.code, payments: payments.length, updated };
  }

  /** Hoàn tác lô lịch sử công nợ khi chứng từ trong lô chưa được thu / bù trừ ngoài lô. */
  async rollback(id: string, request: AuthenticatedRequest) {
    const session = this.db.client.startSession();
    try {
      let result: Document | null = null;
      await session.withTransaction(async () => {
        const batch = await this.db.collection('import_batches').findOne({ _id: toObjectId(id), kind: 'AR_HISTORY', status: 'COMMITTED' }, { session });
        if (!batch) throw new ConflictException({ code: 'IMPORT_BATCH_STATE', message: 'Lô không còn ở trạng thái đã ghi' });
        const receivableIds = (batch.receivableIds as ObjectId[]) ?? [];
        const paymentIds = (batch.paymentIds as ObjectId[]) ?? [];
        // Phiếu ngoài lô thu theo từng chứng từ / bù trừ vào chứng từ trong lô thì chặn; phiếu thu theo khách được phân bổ lại.
        const outside = await this.db.collection('payments').findOne(
          { _id: { $nin: paymentIds }, 'allocations.receivableId': { $in: receivableIds }, $or: [{ mode: { $in: ['DOCUMENT', null] } }, { kind: 'OFFSET' }] },
          { session, projection: { code: 1 } },
        );
        if (outside) {
          throw new ConflictException({
            code: 'IMPORT_ROLLBACK_BLOCKED',
            message: `Không hoàn tác được lô ${String(batch.code)}: chứng từ lịch sử đã được thu / bù trừ ngoài lô (phiếu ${String(outside.code)}) — hủy phiếu đó trước`,
            details: { blockers: [`phiếu ${String(outside.code)}`] },
          });
        }
        // Gỡ phần các phiếu trong lô đã trả cho chứng từ ngoài lô (sau khi phân bổ nợ thường trước) rồi mới xóa.
        const batchReceivables = new Set(receivableIds.map((row) => row.toHexString()));
        const batchPayments = await this.db.collection('payments').find({ _id: { $in: paymentIds } }, { session, projection: { allocations: 1 } }).toArray();
        for (const payment of batchPayments) {
          for (const allocation of (payment.allocations as Document[] | undefined) ?? []) {
            if (batchReceivables.has(String(allocation.receivableId))) continue;
            const amount = new Decimal(decimalString(allocation.amount)).neg().toFixed(2);
            await this.db.collection('receivables').updateOne(
              { _id: allocation.receivableId as ObjectId },
              { $inc: { paidAmount: decimal(amount), version: 1, ...(allocation.segment ? { 'segments.$[part].paid': decimal(amount) } : {}) }, $set: { updatedAt: new Date() } },
              { session, ...(allocation.segment ? { arrayFilters: [{ 'part.code': allocation.segment }] } : {}) },
            );
          }
        }
        await this.db.collection('payments').deleteMany({ _id: { $in: paymentIds }, importBatchId: batch._id }, { session });
        await this.db.collection('receivables').deleteMany({ _id: { $in: receivableIds }, importBatchId: batch._id }, { session });
        for (const customer of (batch.customers as CustomerSummary[] | undefined) ?? []) {
          if (!customer.partnerId) continue;
          try {
            await reallocatePartner(this.db, new ObjectId(customer.partnerId), session);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new ConflictException({ code: 'IMPORT_ROLLBACK_BLOCKED', message: `Không hoàn tác được lô ${String(batch.code)}: ${customer.code} — ${message}` });
          }
        }
        result = await this.db.collection('import_batches').findOneAndUpdate(
          { _id: batch._id },
          { $set: { status: 'ROLLED_BACK', rolledBackAt: new Date(), rolledBackBy: toObjectId(request.user.sub), rolledBackByName: request.user.displayName } },
          { returnDocument: 'after', session },
        );
        await this.audit.record({ actorId: request.user.sub, actorEmail: request.user.email, correlationId: request.correlationId, action: 'IMPORT_ROLLED_BACK', entityType: 'ImportBatch', entityId: id, metadata: { code: batch.code, kind: 'AR_HISTORY' } }, session);
      });
      return this.imports.presentBatch(result as unknown as Document);
    } finally {
      await session.endSession();
    }
  }
}
