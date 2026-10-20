import Decimal from 'decimal.js';
import { ConflictException } from '@nestjs/common';
import { type ClientSession, type Db, type Document, ObjectId } from 'mongodb';
import { decimal, decimalString, vnDayStart } from '../../common/domain';
import { OPEN_RECEIVABLE_STATUSES } from './overdue-review';
import { reallocateCustomer, ReallocationError, type EnginePayment, type EngineReceivable, type EngineResult } from './reallocate';
import { historySegments, normalizeSku, normalOutstanding, orderSegments, rulesFor, segmentOutstanding, type SegmentAmount, type SegmentRule } from './segments';

/** Cấu hình nhóm công nợ tách riêng và bảng ghép mã hàng cũ (CN-SEG-01). */
export const DEBT_SEGMENTS = 'debt_segments';
export const SKU_ALIASES = 'sku_aliases';
const DAY_MS = 86_400_000;

const opts = (session?: ClientSession) => (session ? { session } : {});

export async function loadSegmentRules(db: Db, session?: ClientSession): Promise<SegmentRule[]> {
  const rows = await db.collection(DEBT_SEGMENTS).find({}, opts(session)).toArray();
  return rows.map((row) => ({
    code: String(row.code),
    name: String(row.name ?? row.code),
    categoryIds: ((row.categoryIds as unknown[]) ?? []).map(String),
    skus: ((row.skus as unknown[]) ?? []).map(String),
    manualOnly: row.manualOnly === true,
    active: row.active !== false,
    sortOrder: Number(row.sortOrder ?? 0),
    scope: row.scope === 'SELECTED' ? 'SELECTED' : 'ALL',
    partnerIds: ((row.partnerIds as unknown[]) ?? []).map(String),
  }));
}

export interface CatalogEntry {
  productId: string;
  sku: string;
  categoryId?: string | undefined;
}

/** Mã hàng (đã chuẩn hóa) → sản phẩm danh mục; gồm cả mã cũ trong sổ đã ghép (sku_aliases). */
export async function skuCatalog(db: Db, session?: ClientSession): Promise<Map<string, CatalogEntry>> {
  const [products, aliases] = await Promise.all([
    db.collection('products').find({}, { projection: { sku: 1, categoryId: 1 }, ...opts(session) }).toArray(),
    db.collection(SKU_ALIASES).find({}, opts(session)).toArray(),
  ]);
  const map = new Map<string, CatalogEntry>();
  const byId = new Map<string, CatalogEntry>();
  for (const row of products) {
    const entry = { productId: (row._id as ObjectId).toHexString(), sku: String(row.sku), ...(row.categoryId ? { categoryId: String(row.categoryId) } : {}) };
    map.set(normalizeSku(entry.sku), entry);
    byId.set(entry.productId, entry);
  }
  for (const row of aliases) {
    const target = byId.get(String(row.productId));
    if (target) map.set(normalizeSku(String(row.oldSku)), target);
  }
  return map;
}

export interface SegmentContext {
  rules: SegmentRule[];
  catalog: Map<string, CatalogEntry>;
}

export async function segmentContext(db: Db, session?: ClientSession): Promise<SegmentContext> {
  const [rules, catalog] = await Promise.all([loadSegmentRules(db, session), skuCatalog(db, session)]);
  return { rules, catalog };
}

/** Dòng hàng lịch sử → mã / nhóm hàng theo danh mục (qua bảng ghép mã). */
export function resolveLines(lines: unknown, catalog: Map<string, CatalogEntry>) {
  return ((lines as Document[] | undefined) ?? []).map((line) => {
    const entry = catalog.get(normalizeSku(line.sku as string | undefined));
    return { sku: entry?.sku ?? (line.sku as string | undefined), categoryId: entry?.categoryId, amount: line.amount === undefined ? undefined : decimalString(line.amount) };
  });
}

/** Phần nhóm của một chứng từ / phiếu trả hàng lịch sử theo dòng hàng (dùng khi chạy thử nhập lịch sử). */
export function historyLineSegments(lines: unknown, total: Decimal.Value, ctx: SegmentContext, partnerId?: string): SegmentAmount[] {
  return historySegments(resolveLines(lines, ctx.catalog), total, rulesFor(partnerId, ctx.rules));
}

/** Dòng phiếu BH (đã chụp nhóm hàng khi tính giá) dùng để tính phần nhóm. */
export function orderLinesForSegments(order: Document) {
  return ((order.lines as Document[] | undefined) ?? []).map((line) => ({
    sku: line.sku as string | undefined,
    categoryId: line.categoryId ? String(line.categoryId) : undefined,
    gift: line.gift === true,
    netAmount: decimalString(line.netAmount ?? line.pricingSnapshot?.netAmount ?? '0'),
  }));
}

/** Phần nhóm mục tiêu của một khoản phải thu: gắn tay > phiếu BH ERP > dòng hàng chứng từ lịch sử. */
export function targetSegments(doc: Document, order: Document | undefined, ctx: SegmentContext): SegmentAmount[] {
  const amount = new Decimal(decimalString(doc.amount));
  if (doc.status === 'VOIDED' || amount.lte(0)) return [];
  const tag = doc.segmentTag?.code as string | undefined;
  if (tag && ctx.rules.some((rule) => rule.code === tag && rule.active)) return [{ code: tag, amount: amount.toFixed(2) }];
  // Nhóm "chọn khách" (VD quạt chỉ tách cho NPP được nợ riêng): khách ngoài danh sách thì hàng nhóm tính như nợ thường.
  const rules = rulesFor(doc.partnerId ? String(doc.partnerId) : undefined, ctx.rules);
  if (order) return orderSegments(orderLinesForSegments(order), String(order.taxRate ?? '8'), amount, rules);
  if (doc.sourceType === 'HISTORY_IMPORT' && Array.isArray(doc.historyLines)) return historySegments(resolveLines(doc.historyLines, ctx.catalog), amount, rules);
  return [];
}

/** Phiếu trả hàng lịch sử có dòng hàng: phần hàng thuộc từng nhóm. */
export function returnSegments(payment: Document, ctx: SegmentContext): SegmentAmount[] {
  if ((payment.kind ?? 'RECEIPT') !== 'RETURN' || !Array.isArray(payment.historyLines)) return [];
  return historySegments(resolveLines(payment.historyLines, ctx.catalog), decimalString(payment.amount), rulesFor(payment.partnerId ? String(payment.partnerId) : undefined, ctx.rules));
}

export interface PartnerSummary {
  balance: string;
  segment: string;
  normal: string;
  overdue60: string;
}

/** Tổng hiện tại của một khách: còn nợ, nợ nhóm, nợ thường, nợ thường quá hạn trên 60 ngày. */
export function summarize(docs: ReadonlyArray<Document>, now = new Date()): PartnerSummary {
  const threshold = new Date(vnDayStart(now).getTime() - 60 * DAY_MS);
  let balance = new Decimal(0);
  let segment = new Decimal(0);
  let normal = new Decimal(0);
  let overdue60 = new Decimal(0);
  for (const doc of docs) {
    if (!OPEN_RECEIVABLE_STATUSES.includes(String(doc.status))) continue;
    const outstanding = new Decimal(decimalString(doc.amount)).minus(decimalString(doc.paidAmount));
    balance = balance.add(outstanding);
    if (outstanding.lte(0)) continue;
    const seg = segmentOutstanding(doc as never);
    const norm = normalOutstanding(doc as never);
    segment = segment.add(seg);
    normal = normal.add(norm);
    if ((doc.dueDate as Date) < threshold && norm.gt(0)) overdue60 = overdue60.add(norm);
  }
  return { balance: balance.toFixed(2), segment: segment.toFixed(2), normal: normal.toFixed(2), overdue60: overdue60.toFixed(2) };
}

export interface PartnerPlan {
  partnerId: ObjectId;
  receivables: Document[];
  payments: Document[];
  result: EngineResult;
  before: PartnerSummary;
  after: PartnerSummary;
}

const canonicalSegments = (list: ReadonlyArray<{ code: string; amount: unknown; paid: unknown }> | undefined) =>
  (list ?? []).map((part) => `${part.code}:${new Decimal(decimalString(part.amount)).toFixed(2)}:${new Decimal(decimalString(part.paid)).toFixed(2)}`).join(';');

/** Tính phần nhóm mục tiêu + phân bổ lại cho một khách (không ghi). */
export async function planPartner(db: Db, partnerId: ObjectId, ctx: SegmentContext, session?: ClientSession, now = new Date()): Promise<PartnerPlan> {
  const [receivables, payments] = await Promise.all([
    db.collection('receivables').find({ partnerId }, opts(session)).toArray(),
    db.collection('payments').find({ partnerId, status: 'POSTED' }, opts(session)).toArray(),
  ]);
  const orderIds = [...new Set(receivables.map((row) => row.salesOrderId).filter(Boolean).map(String))].map((id) => new ObjectId(id));
  const orders = orderIds.length ? await db.collection('sales_orders').find({ _id: { $in: orderIds } }, { projection: { lines: 1, taxRate: 1 }, ...opts(session) }).toArray() : [];
  const orderById = new Map(orders.map((row) => [(row._id as ObjectId).toHexString(), row]));
  const engineReceivables: EngineReceivable[] = receivables.map((row) => ({
    id: (row._id as ObjectId).toHexString(),
    code: String(row.code),
    amount: decimalString(row.amount),
    paidAmount: decimalString(row.paidAmount),
    status: String(row.status),
    dueDate: row.dueDate as Date,
    createdAt: row.createdAt as Date,
    segments: targetSegments(row, row.salesOrderId && row.sourceType !== 'SALES_VOID_CREDIT' ? orderById.get(String(row.salesOrderId)) : undefined, ctx),
  }));
  const enginePayments: EnginePayment[] = payments.map((row) => ({
    id: (row._id as ObjectId).toHexString(),
    code: String(row.code),
    receivedAt: row.receivedAt as Date,
    createdAt: (row.createdAt as Date | undefined) ?? (row.receivedAt as Date),
    kind: String(row.kind ?? 'RECEIPT'),
    mode: row.mode === undefined ? undefined : String(row.mode),
    segment: (row.segment as string | undefined) ?? null,
    returnSegments: returnSegments(row, ctx),
    allocations: ((row.allocations as Document[] | undefined) ?? []).map((allocation) => ({
      receivableId: String(allocation.receivableId),
      amount: decimalString(allocation.amount),
      segment: (allocation.segment as string | undefined) ?? null,
    })),
  }));
  const result = reallocateCustomer(engineReceivables, enginePayments);
  const afterDocs = receivables.map((row) => {
    const next = result.receivables.get((row._id as ObjectId).toHexString());
    return next ? { ...row, paidAmount: next.paidAmount, status: next.status, segments: next.segments } : row;
  });
  return { partnerId, receivables, payments, result, before: summarize(receivables, now), after: summarize(afterDocs, now) };
}

export interface WriteSnapshot {
  receivables: Array<{ _id: ObjectId; paidAmount: unknown; status: unknown; segments: unknown; version: number }>;
  payments: Array<{ _id: ObjectId; allocations: unknown }>;
}

/** Ghi kết quả phân bổ lại (chỉ chứng từ / phiếu có thay đổi); trả trạng thái trước để hoàn tác. */
export async function writePlan(db: Db, plan: PartnerPlan, session: ClientSession, now = new Date()): Promise<WriteSnapshot> {
  const snapshot: WriteSnapshot = { receivables: [], payments: [] };
  for (const row of plan.receivables) {
    const next = plan.result.receivables.get((row._id as ObjectId).toHexString());
    if (!next) continue;
    const samePaid = new Decimal(decimalString(row.paidAmount)).eq(next.paidAmount);
    if (samePaid && row.status === next.status && canonicalSegments(row.segments as never) === canonicalSegments(next.segments)) continue;
    const segments = next.segments.map((part) => ({ code: part.code, amount: decimal(part.amount), paid: decimal(part.paid) }));
    const update = await db.collection('receivables').updateOne(
      { _id: row._id, version: row.version },
      {
        $set: { paidAmount: decimal(next.paidAmount), status: next.status, updatedAt: now, ...(segments.length ? { segments } : {}) },
        ...(segments.length ? {} : { $unset: { segments: '' } }),
        $inc: { version: 1 },
      },
      { session },
    );
    if (update.matchedCount !== 1) throw new ConflictException({ code: 'RECEIVABLE_CHANGED', message: `Chứng từ ${String(row.code)} vừa được cập nhật — tải lại rồi thử lại` });
    snapshot.receivables.push({ _id: row._id as ObjectId, paidAmount: row.paidAmount, status: row.status, segments: row.segments ?? null, version: Number(row.version ?? 0) + 1 });
  }
  const changed = new Set(plan.result.changedPayments);
  for (const row of plan.payments) {
    const id = (row._id as ObjectId).toHexString();
    if (!changed.has(id)) continue;
    const allocations = (plan.result.payments.get(id) ?? []).map((allocation) => ({
      receivableId: new ObjectId(allocation.receivableId),
      amount: decimal(allocation.amount),
      ...(allocation.segment ? { segment: allocation.segment } : {}),
    }));
    await db.collection('payments').updateOne({ _id: row._id }, { $set: { allocations, reallocatedAt: now } }, { session });
    snapshot.payments.push({ _id: row._id as ObjectId, allocations: row.allocations });
  }
  return snapshot;
}

/** Tính lại phần nhóm và phân bổ lại cho một khách ngay trong giao dịch (gắn tay nhóm, sửa phiếu sau phát hành). */
export async function reallocatePartner(db: Db, partnerId: ObjectId, session: ClientSession, now = new Date()): Promise<{ plan: PartnerPlan; snapshot: WriteSnapshot }> {
  const ctx = await segmentContext(db, session);
  let plan: PartnerPlan;
  try {
    plan = await planPartner(db, partnerId, ctx, session, now);
  } catch (error) {
    if (error instanceof ReallocationError) throw new ConflictException({ code: error.code, message: error.message });
    throw error;
  }
  const snapshot = await writePlan(db, plan, session, now);
  return { plan, snapshot };
}
