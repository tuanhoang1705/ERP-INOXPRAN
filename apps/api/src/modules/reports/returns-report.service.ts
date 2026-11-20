import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import {
  CUSTOMER_RETURN_CATEGORIES,
  customerProvince,
  customerReturnRating,
  DEFECT_RETURN_CATEGORIES,
  provinceReportName,
  RETURN_THRESHOLDS,
  returnMonthTone,
  SALE_ONLY_FILTER,
  type ReturnDebtState,
  type ReturnRating,
  type ReturnsReport,
  type ReturnsReportCustomer,
  type ReturnsReportMonth,
  type ReturnsReportProduct,
  type ReturnsReportRep,
  type ReturnsReportSlip,
  type ReturnsScope,
} from '@inoxpran/contracts';
import Decimal from 'decimal.js';
import { ObjectId, type Db, type Document } from 'mongodb';
import { decimal, decimalString, toObjectId, vnDayStart, vnMonthStart, vnParts } from '../../common/domain';
import { MONGO_DATABASE } from '../../common/tokens';
import { defectiveWarehouseIds } from '../../common/warehouses';
import { daysOverdue, OPEN_RECEIVABLE_STATUSES } from '../receivables/overdue-review';
import { REVENUE_STATUSES } from '../sales/pricing.service';
import {
  addSlip,
  calendarDays,
  DAY_MS,
  emptySplit,
  monthKeyOf,
  paymentBucket,
  percentOf,
  receivedBetween,
  slipQuantity,
  slipReceivedAt,
  slipState,
  slipValue,
  splitView,
  type SplitAccumulator,
} from './returns-report';

const TIER_LABELS: Record<string, string> = { TIER_1: 'NPP · Cấp 1', TIER_2: 'Đại lý · Cấp 2', RETAIL: 'Khách lẻ' };
const RATING_ORDER: Record<ReturnRating, number> = { HIGH_RISK: 0, WARNING: 1, WATCH: 2, NORMAL: 3 };
const NO_REP = 'Chưa giao NVKD';
const pad = (value: number) => String(value).padStart(2, '0');
const add = (sum: Decimal, value: unknown) => sum.add(decimalString(value ?? '0'));

export interface ReturnsReportFilter {
  /** YYYY-MM, mặc định tháng hiện tại (giờ Việt Nam). */
  month?: string | undefined;
  scope: ReturnsScope;
  /** Tỉnh mới (34) theo tỉnh hiện tại của khách. */
  region?: string | undefined;
  /** NVKD đang phụ trách khách (PV-01). */
  salesRepId?: string | undefined;
  tier?: string | undefined;
  /** Loại hàng trả (chỉ lọc phiếu NK, không lọc doanh số). */
  category?: string | undefined;
}

export interface ReturnsSlipFilter extends Omit<ReturnsReportFilter, 'month' | 'scope'> {
  from: string;
  to: string;
  customerId?: string | undefined;
  state?: ReturnDebtState | undefined;
  warehouseId?: string | undefined;
  /** NVKD của phiếu BH gốc ("none" = chưa giao NVKD). */
  repId?: string | undefined;
  /** Tháng giao của phiếu BH gốc (YYYY-MM) — bảng theo tháng bán. */
  soldMonth?: string | undefined;
  /** "none" = chỉ phiếu không có phiếu BH gốc trên ERP. */
  linked?: 'none' | undefined;
}

interface Scope {
  partners: Map<string, Document>;
  /** null = không lọc theo khách. */
  ids: ObjectId[] | null;
}

function parseMonth(value: string | undefined, now: Date): { year: number; month: number } {
  if (!value) return vnParts(now);
  const match = /^(\d{4})-(\d{2})$/.exec(value);
  const year = Number(match?.[1]);
  const month = Number(match?.[2]);
  if (!match || month < 1 || month > 12) throw new BadRequestException({ code: 'INVALID_MONTH', message: 'Tháng phải có dạng YYYY-MM' });
  return { year, month };
}

function parseDay(value: string, field: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new BadRequestException({ code: 'INVALID_DATE', message: `${field} phải có dạng YYYY-MM-DD` });
  return new Date(`${value}T00:00:00+07:00`);
}

function isoDay(date: Date): string {
  const { year, month, day } = vnParts(date);
  return `${year}-${pad(month)}-${pad(day)}`;
}

function dmy(date: Date): string {
  const { year, month, day } = vnParts(date);
  return `${pad(day)}/${pad(month)}/${year}`;
}

function monthLabel(start: Date): string {
  const { year, month } = vnParts(start);
  return `${pad(month)}/${year}`;
}

/**
 * Báo cáo Doanh số & hàng trả (RPT-RET-01, 18/11/2026). Doanh số = phiếu BH bán đã giao theo ngày giao (như trang chủ); hàng trả = phiếu NK
 * khách trả theo ngày nhận hàng, tách đã giảm công nợ / không giảm / chờ kế toán; đối chiếu công nợ cùng công thức sổ công nợ (CN-KH-01).
 * Chỉ đọc dữ liệu — không thay đổi cách tính doanh thu ở trang chủ / báo cáo doanh số.
 */
@Injectable()
export class ReturnsReportService {
  constructor(@Inject(MONGO_DATABASE) private readonly db: Db) {}

  private async scope(filter: Pick<ReturnsReportFilter, 'region' | 'salesRepId' | 'tier'>): Promise<Scope> {
    const rows = await this.db.collection('partners').find(
      { kind: { $in: ['CUSTOMER', 'BOTH'] } },
      { projection: { code: 1, name: 1, customerTier: 1, salesRepId: 1, salesRepName: 1, provinceOldCode: 1, provinceNewCode: 1, regionCode: 1, province: 1 } },
    ).toArray();
    const partners = new Map(rows.map((row) => [(row._id as ObjectId).toHexString(), row]));
    if (!filter.region && !filter.salesRepId && !filter.tier) return { partners, ids: null };
    const keep = rows.filter((row) => {
      if (filter.tier && String(row.customerTier ?? 'RETAIL') !== filter.tier) return false;
      if (filter.salesRepId && String(row.salesRepId ?? '') !== filter.salesRepId) return false;
      if (filter.region && customerProvince(row).newCode !== filter.region) return false;
      return true;
    });
    return { partners, ids: keep.map((row) => row._id as ObjectId) };
  }

  private partnerMatch(scope: Scope, field: string): Document {
    return scope.ids ? { [field]: { $in: scope.ids } } : {};
  }

  /** Phiếu BH gốc của các phiếu NK (ngày giao + NVKD), lấy thêm những phiếu nằm ngoài khoảng đã tải. */
  private async sourceOrders(slips: Document[], loaded: Document[]): Promise<Map<string, Document>> {
    const byCode = new Map(loaded.map((order) => [String(order.code), order]));
    const missing = [...new Set(slips.map((slip) => slip.salesOrderCode as string | undefined).filter((code): code is string => Boolean(code) && !byCode.has(code as string)))];
    if (missing.length) {
      const rows = await this.db.collection('sales_orders').find({ code: { $in: missing } }, { projection: { code: 1, deliveredAt: 1, salesRepId: 1, salesRepName: 1, customerId: 1 } }).toArray();
      for (const row of rows) byCode.set(String(row.code), row);
    }
    return byCode;
  }

  private async employeeNames(): Promise<Map<string, string>> {
    const rows = await this.db.collection('employees').find({}, { projection: { name: 1 } }).toArray();
    return new Map(rows.map((row) => [(row._id as ObjectId).toHexString(), String(row.name ?? '')]));
  }

  /** Công nợ tại thời điểm `at` (cùng công thức sổ chi tiết công nợ — reports.service closingDebt), cộng cho cả nhóm khách. */
  private async debtAt(scope: Scope, at: Date): Promise<Decimal> {
    const positive = { $gt: decimal('0') };
    const match = this.partnerMatch(scope, 'partnerId');
    const total = async (collection: string, filter: Document) => {
      const rows = await this.db.collection(collection).aggregate([{ $match: { ...match, ...filter } }, { $group: { _id: null, total: { $sum: '$amount' } } }]).toArray();
      return new Decimal(decimalString(rows[0]?.total ?? '0'));
    };
    const [debits, voided, reductions] = await Promise.all([
      total('receivables', { createdAt: { $lt: at }, amount: positive }),
      total('receivables', { status: 'VOIDED', amount: positive, $or: [{ voidedAt: { $lt: at } }, { voidedAt: { $exists: false }, updatedAt: { $lt: at } }] }),
      total('payments', { receivedAt: { $lt: at }, status: 'POSTED', kind: { $ne: 'OFFSET' } }),
    ]);
    return debits.minus(voided).minus(reductions);
  }

  private async ledger(scope: Scope, from: Date, to: Date, pendingSlips: Document[], now: Date): Promise<ReturnsReport['ledger']> {
    const [opening, closing, payments] = await Promise.all([
      this.debtAt(scope, from),
      this.debtAt(scope, to),
      this.db.collection('payments').aggregate([
        { $match: { ...this.partnerMatch(scope, 'partnerId'), status: 'POSTED', receivedAt: { $gte: from, $lt: to } } },
        { $group: { _id: { $ifNull: ['$kind', 'RECEIPT'] }, total: { $sum: '$amount' } } },
      ]).toArray(),
    ]);
    const sums = { collected: new Decimal(0), returnCredits: new Decimal(0), freight: new Decimal(0) };
    for (const row of payments) {
      const bucket = paymentBucket(row._id);
      if (bucket) sums[bucket] = add(sums[bucket], row.total);
    }
    // Phát sinh nợ = chênh lệch sổ trừ đi các khoản giảm nợ trong tháng (chứng từ mới − chứng từ hủy trong tháng).
    const debits = closing.minus(opening).add(sums.collected).add(sums.returnCredits).add(sums.freight);
    const [created, voided] = await Promise.all([
      this.db.collection('receivables').aggregate([
        { $match: { ...this.partnerMatch(scope, 'partnerId'), createdAt: { $gte: from, $lt: to }, amount: { $gt: decimal('0') } } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]).toArray(),
      this.db.collection('receivables').aggregate([
        { $match: { ...this.partnerMatch(scope, 'partnerId'), status: 'VOIDED', amount: { $gt: decimal('0') }, $or: [{ voidedAt: { $gte: from, $lt: to } }, { voidedAt: { $exists: false }, updatedAt: { $gte: from, $lt: to } }] } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]).toArray(),
    ]);
    const booked = add(new Decimal(0), created[0]?.total).minus(decimalString(voided[0]?.total ?? '0'));
    let pendingValue = new Decimal(0);
    let pendingOverdue = 0;
    for (const slip of pendingSlips) {
      pendingValue = pendingValue.add(slipValue(slip) ?? 0);
      if (calendarDays(slipReceivedAt(slip), now) > RETURN_THRESHOLDS.pendingDays) pendingOverdue += 1;
    }
    return {
      opening: opening.toFixed(2),
      debits: booked.toFixed(2),
      collected: sums.collected.toFixed(2),
      returnCredits: sums.returnCredits.toFixed(2),
      freight: sums.freight.toFixed(2),
      other: debits.minus(booked).toFixed(2),
      closing: closing.toFixed(2),
      pendingValue: pendingValue.toFixed(2),
      pendingSlips: pendingSlips.length,
      pendingOverdueSlips: pendingOverdue,
      expectedClosing: closing.minus(pendingValue).toFixed(2),
      debtByReturns: percentOf(sums.returnCredits, sums.collected.add(sums.returnCredits)),
    };
  }

  private monthView(entry: { key: string; start: Date; end: Date; sales: Decimal; orders: number; split: SplitAccumulator; collected: Decimal; returnCredits: Decimal }, now: Date): ReturnsReportMonth {
    const rate = percentOf(entry.split.total, entry.sales);
    return {
      key: entry.key,
      label: monthLabel(entry.start),
      partial: now < entry.end,
      sales: entry.sales.toFixed(2),
      salesOrders: entry.orders,
      returns: splitView(entry.split),
      rate,
      tone: returnMonthTone(rate),
      netSales: entry.sales.minus(entry.split.credited).toFixed(2),
      collected: entry.collected.toFixed(2),
      returnCredits: entry.returnCredits.toFixed(2),
      debtByReturns: percentOf(entry.returnCredits, entry.collected.add(entry.returnCredits)),
    };
  }

  async report(filter: ReturnsReportFilter, now = new Date()): Promise<ReturnsReport> {
    const { year, month } = parseMonth(filter.month, now);
    const monthStart = vnMonthStart(year, month);
    if (monthStart.getTime() > now.getTime()) throw new BadRequestException({ code: 'MONTH_IN_FUTURE', message: 'Tháng báo cáo chưa bắt đầu' });
    const monthEnd = vnMonthStart(year, month + 1);
    const partial = now < monthEnd;
    const starts = Array.from({ length: 7 }, (_, index) => vnMonthStart(year, month - 5 + index));
    // Khoảng xem theo khách / mã / NVKD: trọn ngày, kết thúc hôm nay (tháng đang chạy) hoặc cuối tháng đã chọn.
    const windowTo = partial ? new Date(vnDayStart(now).getTime() + DAY_MS) : monthEnd;
    const windowFrom = filter.scope === 'month' ? monthStart : new Date(windowTo.getTime() - Number(filter.scope) * DAY_MS);
    const earliest = new Date(Math.min((starts[0] as Date).getTime(), windowFrom.getTime()));
    const scope = await this.scope(filter);
    const categoryOk = (slip: Document) => !filter.category || slip.category === filter.category;

    const [orders, allSlips, payments, pendingAll, defective, names] = await Promise.all([
      this.db.collection('sales_orders').find(
        { status: { $in: REVENUE_STATUSES }, ...SALE_ONLY_FILTER, deliveredAt: { $gte: earliest, $lt: monthEnd }, ...this.partnerMatch(scope, 'customerId') },
        { projection: { code: 1, customerId: 1, deliveredAt: 1, grandTotal: 1, salesRepId: 1, salesRepName: 1, 'lines.productId': 1, 'lines.baseQuantity': 1, 'lines.gift': 1, 'lines.sku': 1, 'lines.productName': 1 } },
      ).toArray(),
      this.db.collection('stock_returns').find({
        kind: 'CUSTOMER', status: { $ne: 'VOIDED' }, ...this.partnerMatch(scope, 'partnerId'), ...receivedBetween(earliest),
      }).toArray(),
      this.db.collection('payments').find(
        { status: 'POSTED', receivedAt: { $gte: earliest, $lt: monthEnd }, ...this.partnerMatch(scope, 'partnerId') },
        { projection: { partnerId: 1, kind: 1, amount: 1, receivedAt: 1 } },
      ).toArray(),
      this.db.collection('stock_returns').find({ kind: 'CUSTOMER', status: { $ne: 'VOIDED' }, accountingStatus: 'PENDING', ...this.partnerMatch(scope, 'partnerId') }).toArray(),
      defectiveWarehouseIds(this.db),
      this.employeeNames(),
    ]);
    const slips = allSlips.filter(categoryOk);
    const sources = await this.sourceOrders(slips, orders);
    const defectiveIds = new Set(defective.map((id) => id.toHexString()));
    const inRange = (date: Date, from: Date, to: Date) => date.getTime() >= from.getTime() && date.getTime() < to.getTime();

    // 1. Sáu tháng (theo ngày giao / ngày nhận hàng trả / ngày thu).
    const months = starts.slice(0, 6).map((start, index) => ({
      key: monthKeyOf(start), start, end: starts[index + 1] as Date,
      sales: new Decimal(0), orders: 0, split: emptySplit(), collected: new Decimal(0), returnCredits: new Decimal(0),
    }));
    const monthIndex = new Map(months.map((entry, index) => [entry.key, index]));
    for (const order of orders) {
      const entry = months[monthIndex.get(monthKeyOf(order.deliveredAt as Date)) ?? -1];
      if (!entry) continue;
      entry.sales = add(entry.sales, order.grandTotal);
      entry.orders += 1;
    }
    for (const slip of slips) {
      const at = slipReceivedAt(slip);
      if (at >= monthEnd) continue;
      const entry = months[monthIndex.get(monthKeyOf(at)) ?? -1];
      if (entry) addSlip(entry.split, slip);
    }
    for (const payment of payments) {
      const entry = months[monthIndex.get(monthKeyOf(payment.receivedAt as Date)) ?? -1];
      const bucket = paymentBucket(payment.kind);
      if (!entry || (bucket !== 'collected' && bucket !== 'returnCredits')) continue;
      entry[bucket] = add(entry[bucket], payment.amount);
    }
    const monthViews = months.map((entry) => this.monthView(entry, now));
    const current = monthViews[5] as ReturnsReportMonth;
    const currentSplit = (months[5] as (typeof months)[number]).split;

    // 2. Tháng đang chọn: theo kho nhận và theo loại hàng trả.
    const monthSlips = slips.filter((slip) => inRange(slipReceivedAt(slip), monthStart, monthEnd));
    const warehouses = new Map<string, { name: string; split: SplitAccumulator }>();
    const reasons = new Map<string, { value: Decimal; quantity: Decimal; slips: number }>(CUSTOMER_RETURN_CATEGORIES.map((category) => [category, { value: new Decimal(0), quantity: new Decimal(0), slips: 0 }]));
    for (const slip of monthSlips) {
      const id = (slip.warehouseId as ObjectId).toHexString();
      const entry = warehouses.get(id) ?? { name: String(slip.warehouseName ?? ''), split: emptySplit() };
      addSlip(entry.split, slip);
      warehouses.set(id, entry);
      const reason = reasons.get(String(slip.category));
      if (reason) {
        reason.slips += 1;
        reason.quantity = reason.quantity.add(slipQuantity(slip));
        reason.value = reason.value.add(slipValue(slip) ?? 0);
      }
    }

    // 3. Đối chiếu công nợ tháng (không theo bộ lọc loại hàng trả — sổ công nợ là của khách).
    const pendingToMonthEnd = pendingAll.filter((slip) => slipReceivedAt(slip) < monthEnd);
    const ledger = await this.ledger(scope, monthStart, monthEnd, pendingToMonthEnd, now);

    // 4. Theo khách / mã hàng / NVKD trong khoảng xem.
    type CustomerEntry = { sales: Decimal; split: SplitAccumulator; slow: Decimal; defect: Decimal; collected: Decimal; returnCredits: Decimal };
    const customers = new Map<string, CustomerEntry>();
    const customer = (id: string) => {
      let entry = customers.get(id);
      if (!entry) {
        entry = { sales: new Decimal(0), split: emptySplit(), slow: new Decimal(0), defect: new Decimal(0), collected: new Decimal(0), returnCredits: new Decimal(0) };
        customers.set(id, entry);
      }
      return entry;
    };
    type RepEntry = { id: string | null; name: string; customers: Set<string>; sales: Decimal; split: SplitAccumulator };
    const reps = new Map<string, RepEntry>();
    const rep = (id: unknown, name: unknown) => {
      const key = id ? String(id) : '';
      let entry = reps.get(key);
      if (!entry) {
        entry = { id: key || null, name: key ? (names.get(key) || String(name ?? '') || NO_REP) : NO_REP, customers: new Set(), sales: new Decimal(0), split: emptySplit() };
        reps.set(key, entry);
      }
      return entry;
    };
    type ProductEntry = { sku: string; name: string; sold: Decimal; returned: Decimal; byCategory: Map<string, Decimal> };
    const products = new Map<string, ProductEntry>();
    const product = (id: string, sku: unknown, name: unknown) => {
      let entry = products.get(id);
      if (!entry) {
        entry = { sku: String(sku ?? ''), name: String(name ?? ''), sold: new Decimal(0), returned: new Decimal(0), byCategory: new Map() };
        products.set(id, entry);
      }
      if (!entry.sku && sku) entry.sku = String(sku);
      if (!entry.name && name) entry.name = String(name);
      return entry;
    };
    const defectSet = new Set<string>(DEFECT_RETURN_CATEGORIES);
    for (const order of orders) {
      if (!inRange(order.deliveredAt as Date, windowFrom, windowTo)) continue;
      const customerId = String(order.customerId);
      customer(customerId).sales = add(customer(customerId).sales, order.grandTotal);
      const partner = scope.partners.get(customerId);
      const owner = rep(order.salesRepId ?? partner?.salesRepId, order.salesRepName ?? partner?.salesRepName);
      owner.sales = add(owner.sales, order.grandTotal);
      owner.customers.add(customerId);
      for (const line of (order.lines as Document[] | undefined) ?? []) {
        if (line.gift) continue;
        const entry = product(String(line.productId), line.sku, line.productName);
        entry.sold = add(entry.sold, line.baseQuantity);
      }
    }
    for (const slip of slips) {
      if (!inRange(slipReceivedAt(slip), windowFrom, windowTo)) continue;
      const customerId = String(slip.partnerId);
      const entry = customer(customerId);
      addSlip(entry.split, slip);
      const value = slipValue(slip);
      if (value && slipState(slip) !== 'NO_MONEY') {
        if (slip.category === 'SLOW_RETURN_IN') entry.slow = entry.slow.add(value);
        else if (defectSet.has(String(slip.category))) entry.defect = entry.defect.add(value);
      }
      const source = slip.salesOrderCode ? sources.get(String(slip.salesOrderCode)) : undefined;
      const partner = scope.partners.get(customerId);
      const owner = source?.salesRepId ? rep(source.salesRepId, source.salesRepName) : rep(partner?.salesRepId, partner?.salesRepName);
      addSlip(owner.split, slip);
      owner.customers.add(customerId);
      if (slip.category === 'GIFT_RETURN_IN') continue;
      for (const line of (slip.lines as Document[] | undefined) ?? []) {
        const item = product(String(line.productId), line.sku, line.productName);
        item.returned = add(item.returned, line.quantity);
        item.byCategory.set(String(slip.category), add(item.byCategory.get(String(slip.category)) ?? new Decimal(0), line.quantity));
      }
    }
    for (const payment of payments) {
      if (!inRange(payment.receivedAt as Date, windowFrom, windowTo) || !payment.partnerId) continue;
      const bucket = paymentBucket(payment.kind);
      const id = String(payment.partnerId);
      if (!customers.has(id) || (bucket !== 'collected' && bucket !== 'returnCredits')) continue;
      const entry = customer(id);
      entry[bucket] = add(entry[bucket], payment.amount);
    }
    const customerIds = [...customers.keys()].map((id) => new ObjectId(id));
    const segmentLeft = { $reduce: { input: { $ifNull: ['$segments', []] }, initialValue: decimal('0'), in: { $add: ['$$value', { $subtract: ['$$this.amount', '$$this.paid'] }] } } };
    const [exposure, units] = await Promise.all([
      customerIds.length ? this.db.collection('receivables').aggregate([
        { $match: { partnerId: { $in: customerIds }, status: { $in: OPEN_RECEIVABLE_STATUSES } } },
        { $addFields: { left: { $subtract: ['$amount', '$paidAmount'] }, segmentLeft } },
        // Quá hạn chỉ xét phần nợ thường (nhóm công nợ tách riêng không tính quá hạn — CN-SEG-01), như sổ công nợ theo khách.
        { $group: { _id: '$partnerId', outstanding: { $sum: '$left' }, oldestDue: { $min: { $cond: [{ $gt: [{ $subtract: ['$left', '$segmentLeft'] }, 0] }, '$dueDate', null] } } } },
      ]).toArray() : Promise.resolve([] as Document[]),
      this.db.collection('products').find({ _id: { $in: [...products.entries()].filter(([, entry]) => entry.returned.gt(0)).map(([id]) => new ObjectId(id)) } }, { projection: { baseUnit: 1, sku: 1, name: 1 } }).toArray(),
    ]);
    const exposureById = new Map(exposure.map((row) => [String(row._id), row]));
    const customerRows: ReturnsReportCustomer[] = [...customers.entries()].map(([id, entry]) => {
      const partner = scope.partners.get(id);
      const debt = exposureById.get(id);
      const maxDaysOverdue = debt?.oldestDue ? Math.max(0, daysOverdue(debt.oldestDue as Date, now)) : 0;
      const rate = percentOf(entry.split.total, entry.sales);
      const debtByReturns = percentOf(entry.returnCredits, entry.collected.add(entry.returnCredits));
      const province = partner ? customerProvince(partner) : {};
      return {
        customerId: id,
        code: String(partner?.code ?? '—'),
        name: String(partner?.name ?? '—'),
        tier: TIER_LABELS[String(partner?.customerTier ?? 'RETAIL')] ?? '—',
        regionName: provinceReportName(province) || 'Chưa có tỉnh',
        ...(partner?.salesRepName ? { salesRepName: String(partner.salesRepName) } : {}),
        sales: entry.sales.toFixed(2),
        returns: entry.split.total.toFixed(2),
        rate,
        slow: entry.slow.toFixed(2),
        defect: entry.defect.toFixed(2),
        credited: entry.split.credited.toFixed(2),
        notCredited: entry.split.notCredited.add(entry.split.pending).toFixed(2),
        pending: entry.split.pending.toFixed(2),
        unvaluedSlips: entry.split.unvaluedSlips,
        slips: entry.split.slips,
        collected: entry.collected.toFixed(2),
        returnCredits: entry.returnCredits.toFixed(2),
        debtByReturns,
        outstanding: new Decimal(decimalString(debt?.outstanding ?? '0')).toFixed(2),
        maxDaysOverdue,
        rating: customerReturnRating({ rate, returns: entry.split.total.toNumber(), maxDaysOverdue, debtByReturns }),
      };
    }).sort((a, b) => RATING_ORDER[a.rating] - RATING_ORDER[b.rating] || Number(b.returns) - Number(a.returns) || Number(b.sales) - Number(a.sales) || a.code.localeCompare(b.code));

    const unitById = new Map(units.map((row) => [String(row._id), row]));
    const productRows: ReturnsReportProduct[] = [...products.entries()]
      .filter(([, entry]) => entry.returned.gt(0))
      .map(([id, entry]) => {
        const info = unitById.get(id);
        const byCategory = Object.fromEntries([...entry.byCategory.entries()].map(([category, quantity]) => [category, quantity.toString()]));
        const mainCategory = [...entry.byCategory.entries()].sort((a, b) => b[1].comparedTo(a[1]))[0]?.[0] ?? '';
        return {
          productId: id,
          sku: String(info?.sku ?? entry.sku),
          name: String(info?.name ?? entry.name),
          unit: String(info?.baseUnit ?? ''),
          soldQuantity: entry.sold.toString(),
          returnedQuantity: entry.returned.toString(),
          rate: percentOf(entry.returned, entry.sold),
          mainCategory,
          byCategory,
        };
      })
      .sort((a, b) => Number(b.returnedQuantity) - Number(a.returnedQuantity) || a.sku.localeCompare(b.sku))
      .slice(0, 100);

    const repRows: ReturnsReportRep[] = [...reps.values()]
      .map((entry) => ({
        id: entry.id,
        name: entry.name,
        customers: entry.customers.size,
        sales: entry.sales.toFixed(2),
        returns: entry.split.total.toFixed(2),
        rate: percentOf(entry.split.total, entry.sales),
        credited: entry.split.credited.toFixed(2),
        pending: entry.split.pending.toFixed(2),
        slips: entry.split.slips,
      }))
      .sort((a, b) => Number(b.returns) - Number(a.returns) || Number(b.sales) - Number(a.sales));

    const pendingOverdueSlips = pendingToMonthEnd.filter((slip) => categoryOk(slip) && calendarDays(slipReceivedAt(slip), now) > RETURN_THRESHOLDS.pendingDays).length;
    return {
      month: { key: monthKeyOf(monthStart), label: monthLabel(monthStart), from: isoDay(monthStart), to: isoDay(new Date(monthEnd.getTime() - DAY_MS)), partial },
      window: { scope: filter.scope, from: isoDay(windowFrom), to: isoDay(new Date(windowTo.getTime() - DAY_MS)), label: `${dmy(windowFrom)} – ${dmy(new Date(windowTo.getTime() - DAY_MS))}` },
      generatedAt: now.toISOString(),
      filters: {
        ...(filter.region ? { region: filter.region } : {}),
        ...(filter.salesRepId ? { salesRepId: filter.salesRepId } : {}),
        ...(filter.tier ? { tier: filter.tier } : {}),
        ...(filter.category ? { category: filter.category } : {}),
      },
      summary: {
        ...current,
        previousRate: monthViews[4]?.rate ?? null,
        expectedNetSales: new Decimal(current.netSales).minus(currentSplit.pending).toFixed(2),
        pendingOverdueSlips,
      },
      months: monthViews,
      warehouses: [...warehouses.entries()].map(([id, entry]) => ({
        id, name: entry.name, defective: defectiveIds.has(id),
        total: entry.split.total.toFixed(2), credited: entry.split.credited.toFixed(2), notCredited: entry.split.notCredited.toFixed(2), pending: entry.split.pending.toFixed(2), slips: entry.split.slips,
      })).sort((a, b) => Number(a.defective) - Number(b.defective) || Number(b.total) - Number(a.total)),
      reasons: [...reasons.entries()].map(([category, entry]) => ({
        category, value: entry.value.toFixed(2), quantity: entry.quantity.toString(), slips: entry.slips, share: percentOf(entry.value, currentSplit.total),
      })),
      ledger,
      customers: customerRows,
      products: productRows,
      reps: repRows,
    };
  }

  /** Danh sách phiếu NK tạo nên một con số trên báo cáo (bấm vào số để mở). */
  async slips(filter: ReturnsSlipFilter, now = new Date()): Promise<ReturnsReportSlip[]> {
    const from = parseDay(filter.from, 'from');
    const toExclusive = new Date(parseDay(filter.to, 'to').getTime() + DAY_MS);
    if (toExclusive <= from) throw new BadRequestException({ code: 'INVALID_PERIOD', message: 'Khoảng ngày không hợp lệ' });
    const scope = await this.scope(filter);
    const partnerFilter: Document = filter.customerId ? { partnerId: toObjectId(filter.customerId, 'customerId') } : this.partnerMatch(scope, 'partnerId');
    if (filter.customerId && scope.ids && !scope.ids.some((id) => id.toHexString() === filter.customerId)) return [];
    const rows = await this.db.collection('stock_returns').find({
      kind: 'CUSTOMER', status: { $ne: 'VOIDED' }, ...partnerFilter,
      ...(filter.category ? { category: filter.category } : {}),
      ...(filter.warehouseId ? { warehouseId: toObjectId(filter.warehouseId, 'warehouseId') } : {}),
      ...receivedBetween(from, toExclusive),
    }).limit(2000).toArray();
    rows.sort((a, b) => slipReceivedAt(b).getTime() - slipReceivedAt(a).getTime() || String(b.code).localeCompare(String(a.code)));
    const [sources, defective, names] = await Promise.all([this.sourceOrders(rows, []), defectiveWarehouseIds(this.db), this.employeeNames()]);
    const defectiveIds = new Set(defective.map((id) => id.toHexString()));
    const result: ReturnsReportSlip[] = [];
    for (const row of rows) {
      const state = slipState(row);
      if (filter.state && state !== filter.state) continue;
      const source = row.salesOrderCode ? sources.get(String(row.salesOrderCode)) : undefined;
      if (filter.linked === 'none' && source?.deliveredAt) continue;
      const deliveredAt = source?.deliveredAt as Date | undefined;
      if (filter.soldMonth && (!deliveredAt || monthKeyOf(deliveredAt) !== filter.soldMonth)) continue;
      const partner = scope.partners.get(String(row.partnerId));
      const repId = source?.salesRepId ? String(source.salesRepId) : partner?.salesRepId ? String(partner.salesRepId) : '';
      if (filter.repId && (filter.repId === 'none' ? repId !== '' : repId !== filter.repId)) continue;
      const receivedAt = slipReceivedAt(row);
      const value = slipValue(row);
      const credit = row.creditNote as Document | undefined;
      const repName = repId ? (names.get(repId) || String(source?.salesRepName ?? partner?.salesRepName ?? '')) : '';
      result.push({
        id: (row._id as ObjectId).toHexString(),
        code: String(row.code),
        receivedAt: receivedAt.toISOString(),
        customerId: String(row.partnerId),
        customerCode: String(row.partnerCode ?? partner?.code ?? ''),
        customerName: String(row.partnerName ?? partner?.name ?? ''),
        ...(row.salesOrderCode ? { salesOrderCode: String(row.salesOrderCode) } : {}),
        ...(source?._id ? { salesOrderId: (source._id as ObjectId).toHexString() } : {}),
        ...(row.preErpSalesCode ? { preErpSalesCode: String(row.preErpSalesCode) } : {}),
        ...(deliveredAt ? { deliveredAt: deliveredAt.toISOString(), days: Math.max(0, calendarDays(deliveredAt, receivedAt)) } : {}),
        category: String(row.category ?? ''),
        warehouseName: String(row.warehouseName ?? ''),
        defective: defectiveIds.has(String(row.warehouseId)),
        value: value === null ? null : value.toFixed(2),
        state,
        ...(state === 'CREDITED' && credit ? { creditCode: String(credit.code ?? ''), creditPostedOn: String(credit.postedOn ?? '') } : {}),
        ...(state === 'PENDING' ? { pendingDays: Math.max(0, calendarDays(receivedAt, now)) } : {}),
        ...(repName ? { salesRepName: repName } : {}),
        note: String(row.note ?? ''),
      });
      if (result.length >= 1000) break;
    }
    return result;
  }
}
