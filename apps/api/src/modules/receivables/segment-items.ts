import Decimal from 'decimal.js';
import { type ClientSession, type Db, type Document, ObjectId } from 'mongodb';
import { decimalString } from '../../common/domain';
import { segmentContext } from './segment-store';
import { lineSegment, normalizeSku, rulesFor, type SegmentRule } from './segments';

/** Dòng hàng đã chuẩn hóa (mã theo danh mục nếu ghép được); `weight` = giá trị dòng dùng để chia phần nhóm. */
export interface ItemLine {
  sku?: string | undefined;
  categoryId?: string | undefined;
  name?: string | undefined;
  unit?: string | undefined;
  quantity: string;
  weight: string;
  gift?: boolean | undefined;
}
export interface ItemDocument {
  id: string;
  code: string;
  date: string;
  partnerId: string;
  tag?: string | undefined;
  parts: ReadonlyArray<{ code: string; amount: string; paid: string }>;
  lines: readonly ItemLine[];
}
export interface ItemReturn {
  partnerId: string;
  /** Phân bổ của phiếu trả hàng (có số tiền) — phần trả hàng không làm chứng từ "đã trả tiền". */
  allocations: ReadonlyArray<{ receivableId: string; segment?: string | undefined; amount: string }>;
  lines: readonly ItemLine[];
}
export interface SegmentItem { sku: string; name: string; unit: string; quantity: string; returned: string; amount: string }
export interface SegmentHolding {
  code: string;
  partnerId: string;
  outstanding: string;
  skuCount: number;
  quantity: string;
  items: SegmentItem[];
  documents: Array<{ id: string; code: string; date: string; outstanding: string }>;
}

const NO_DETAIL = '—';
/** Mã gốc của mã theo màu / biến thể: INP6401-A → INP6401. */
const baseSku = (sku: string) => sku.replace(/-[A-Z0-9]{1,2}$/, '');

/**
 * Mã hàng trả lại khớp dòng đã lấy: đúng mã; nếu không có thì theo mã gốc — VD sổ cũ bán ghi chung INP6401 (không rõ màu)
 * nhưng trả lại ghi INP6401(XANH) / (ĐEN) đã ghép INP6401-A / -B, hoặc ngược lại.
 */
function matchItem<T>(items: Map<string, T>, sku: string): T | undefined {
  return items.get(sku) ?? items.get(baseSku(sku)) ?? [...items.entries()].find(([key]) => baseSku(key) === sku || baseSku(key) === baseSku(sku))?.[1];
}

/** Dòng hàng của chứng từ thuộc nhóm: gắn tay cả chứng từ → mọi dòng có tiền; nhóm theo hàng → dòng khớp luật của khách. */
function partLines(doc: { tag?: string | undefined; partnerId: string; lines: readonly ItemLine[] }, code: string, rules: readonly SegmentRule[]) {
  const paid = doc.lines.filter((line) => !line.gift && new Decimal(line.weight || 0).gt(0));
  if (doc.tag === code) return paid;
  const own = rulesFor(doc.partnerId, rules);
  return paid.filter((line) => lineSegment(line, own) === code);
}

/**
 * Hàng khách đang nợ của từng nhóm công nợ tách riêng (CN-SEG-01, 19/10/2026), theo chứng từ còn nợ:
 * - chứng từ hiện khi phần nhóm chưa được TRẢ TIỀN đủ (thu tiền / thu cho nhóm); phần bù bằng hàng trả lại không tính là đã trả tiền
 *   (tiền hàng trả được trừ vào chứng từ cũ nhất, không phải chứng từ có mã đó);
 * - số lượng = dòng hàng thuộc nhóm của các chứng từ đó − hàng trả lại vào nhóm (theo mã);
 * - số còn nợ của nhóm chia cho các mã theo số lượng còn lại × đơn giá bình quân → tổng = công nợ nhóm.
 */
export function segmentItems(docs: readonly ItemDocument[], returns: readonly ItemReturn[], rules: readonly SegmentRule[], filter: { code?: string | undefined } = {}): SegmentHolding[] {
  type Item = { sku: string; name: string; unit: string; taken: Decimal; value: Decimal; returned: Decimal; order: number };
  type Holding = { code: string; partnerId: string; outstanding: Decimal; noDetail: Decimal; items: Map<string, Item>; documents: SegmentHolding['documents'] };
  const holdings = new Map<string, Holding>();
  const holdingOf = (code: string, partnerId: string) => {
    const key = `${code}|${partnerId}`;
    let holding = holdings.get(key);
    if (!holding) {
      holding = { code, partnerId, outstanding: new Decimal(0), noDetail: new Decimal(0), items: new Map(), documents: [] };
      holdings.set(key, holding);
    }
    return holding;
  };
  const itemOf = (holding: Holding, line: ItemLine) => {
    const key = normalizeSku(line.sku) || NO_DETAIL;
    let item = holding.items.get(key);
    if (!item) {
      item = { sku: line.sku?.trim() || NO_DETAIL, name: line.name ?? '', unit: line.unit ?? '', taken: new Decimal(0), value: new Decimal(0), returned: new Decimal(0), order: holding.items.size };
      holding.items.set(key, item);
    }
    if (!item.name && line.name) item.name = line.name;
    if (!item.unit && line.unit) item.unit = line.unit;
    return item;
  };

  // Phần đã bù bằng hàng trả lại của từng (chứng từ, nhóm).
  const byReturn = new Map<string, Decimal>();
  for (const row of returns) {
    for (const allocation of row.allocations) {
      if (!allocation.segment) continue;
      const key = `${allocation.receivableId}|${allocation.segment}`;
      byReturn.set(key, (byReturn.get(key) ?? new Decimal(0)).add(allocation.amount));
    }
  }

  for (const doc of docs) {
    for (const part of doc.parts) {
      if (filter.code && part.code !== filter.code) continue;
      const outstanding = new Decimal(part.amount).minus(part.paid);
      const paidByMoney = new Decimal(part.paid).minus(byReturn.get(`${doc.id}|${part.code}`) ?? 0);
      if (new Decimal(part.amount).minus(paidByMoney).lte(0)) continue;
      const holding = holdingOf(part.code, doc.partnerId);
      holding.outstanding = holding.outstanding.add(Decimal.max(outstanding, 0));
      holding.documents.push({ id: doc.id, code: doc.code, date: doc.date, outstanding: Decimal.max(outstanding, 0).toFixed(2) });
      const lines = partLines(doc, part.code, rules);
      if (!lines.length) holding.noDetail = holding.noDetail.add(Decimal.max(outstanding, 0));
      for (const line of lines) {
        const item = itemOf(holding, line);
        item.taken = item.taken.add(line.quantity || 0);
        item.value = item.value.add(line.weight || 0);
      }
    }
  }

  // Hàng trả lại vào nhóm: trừ theo mã (sổ cũ ghi số lượng trả là số âm — lấy độ lớn).
  const taggedDocs = new Map(docs.filter((doc) => doc.tag).map((doc) => [doc.id, doc.tag as string]));
  for (const row of returns) {
    const codes = new Set(row.allocations.filter((allocation) => allocation.segment).map((allocation) => allocation.segment as string));
    for (const code of codes) {
      if (filter.code && code !== filter.code) continue;
      const holding = holdings.get(`${code}|${row.partnerId}`);
      if (!holding) continue;
      const tagged = row.allocations.some((allocation) => allocation.segment === code && taggedDocs.get(allocation.receivableId) === code);
      for (const line of partLines({ tag: tagged ? code : undefined, partnerId: row.partnerId, lines: row.lines }, code, rules)) {
        const item = matchItem(holding.items, normalizeSku(line.sku) || NO_DETAIL);
        if (item) item.returned = item.returned.add(new Decimal(line.quantity || 0).abs());
      }
    }
  }

  return [...holdings.values()].map((holding) => {
    const rows = [...holding.items.values()].sort((a, b) => a.order - b.order).map((item) => {
      const left = Decimal.max(item.taken.minus(item.returned), 0);
      const unit = item.taken.gt(0) ? item.value.div(item.taken) : new Decimal(0);
      return { item, left, weight: left.mul(unit) };
    }).filter((row) => row.left.gt(0));
    const weights = rows.reduce((sum, row) => sum.add(row.weight), new Decimal(0));
    const spread = holding.outstanding.minus(holding.noDetail);
    let rest = spread;
    const items: SegmentItem[] = rows.map((row, index) => {
      const share = index === rows.length - 1 ? rest : weights.gt(0) ? spread.mul(row.weight).div(weights).toDecimalPlaces(2) : new Decimal(0);
      rest = rest.minus(share);
      return { sku: row.item.sku, name: row.item.name, unit: row.item.unit, quantity: row.left.toString(), returned: row.item.returned.toString(), amount: share.toFixed(2) };
    });
    // Chứng từ không có chi tiết dòng hàng (hoặc hàng đã trả hết mà tiền còn): ghi một dòng "—".
    const unassigned = items.length ? holding.noDetail : holding.outstanding;
    if (unassigned.gt(0)) items.push({ sku: NO_DETAIL, name: '', unit: '', quantity: '0', returned: '0', amount: unassigned.toFixed(2) });
    const counted = items.filter((item) => item.sku !== NO_DETAIL);
    return {
      code: holding.code, partnerId: holding.partnerId, outstanding: holding.outstanding.toFixed(2),
      skuCount: counted.length, quantity: counted.reduce((sum, item) => sum.add(item.quantity), new Decimal(0)).toString(),
      items, documents: holding.documents.filter((row) => new Decimal(row.outstanding).gt(0)).sort((a, b) => a.date.localeCompare(b.date) || a.code.localeCompare(b.code)),
    };
  }).filter((holding) => new Decimal(holding.outstanding).gt(0))
    .sort((a, b) => a.code.localeCompare(b.code) || a.partnerId.localeCompare(b.partnerId));
}

const vnDay = (value: unknown) => (value instanceof Date ? new Date(value.getTime() + 7 * 3_600_000).toISOString().slice(0, 10) : '');

/** Đọc chứng từ còn nợ có phần nhóm (+ dòng hàng lịch sử / phiếu BH, phiếu trả hàng có dòng hàng) rồi tính hàng đang nợ theo nhóm. */
export async function loadSegmentItems(db: Db, filter: { code?: string | undefined; partnerId?: ObjectId | undefined } = {}, session?: ClientSession): Promise<SegmentHolding[]> {
  const options = session ? { session } : {};
  const ctx = await segmentContext(db, session);
  const receivables = await db.collection('receivables').find(
    // Cả chứng từ đã đủ tiền: phần bù bằng hàng trả lại không tính là đã trả tiền (hàng của chứng từ đó vẫn đem trừ theo mã).
    { status: { $ne: 'VOIDED' }, 'segments.0': { $exists: true }, ...(filter.code ? { 'segments.code': filter.code } : {}), ...(filter.partnerId ? { partnerId: filter.partnerId } : {}) },
    { projection: { code: 1, partnerId: 1, segments: 1, segmentTag: 1, historyLines: 1, historyDocumentNo: 1, salesOrderId: 1, salesOrderCode: 1, documentDate: 1, createdAt: 1 }, ...options },
  ).toArray();
  if (!receivables.length) return [];
  const orderIds = receivables.map((row) => row.salesOrderId).filter(Boolean) as ObjectId[];
  const orders = orderIds.length
    ? await db.collection('sales_orders').find({ _id: { $in: orderIds } }, { projection: { lines: 1, orderDate: 1 }, ...options }).toArray()
    : [];
  const orderById = new Map(orders.map((row) => [String(row._id), row]));
  const historyLine = (line: Document): ItemLine => {
    const entry = ctx.catalog.get(normalizeSku(line.sku as string | undefined));
    return {
      sku: entry?.sku ?? (line.sku as string | undefined), categoryId: entry?.categoryId,
      name: line.productName as string | undefined, unit: line.unit as string | undefined,
      quantity: line.quantity === undefined ? '0' : decimalString(line.quantity), weight: line.amount === undefined ? '0' : decimalString(line.amount),
    };
  };
  const docs: ItemDocument[] = receivables.map((row) => {
    const order = row.salesOrderId ? orderById.get(String(row.salesOrderId)) : undefined;
    const lines: ItemLine[] = order
      ? ((order.lines as Document[] | undefined) ?? []).map((line) => ({
        sku: line.sku as string | undefined, categoryId: line.categoryId ? String(line.categoryId) : undefined,
        name: line.productName as string | undefined, unit: line.unit as string | undefined, gift: line.gift === true,
        quantity: decimalString(line.quantity ?? '0'), weight: decimalString(line.netAmount ?? line.pricingSnapshot?.netAmount ?? '0'),
      }))
      : ((row.historyLines as Document[] | undefined) ?? []).map(historyLine);
    return {
      id: (row._id as ObjectId).toHexString(),
      code: String(row.salesOrderCode ?? row.historyDocumentNo ?? row.code),
      date: (row.documentDate as string | undefined) ?? vnDay(order?.orderDate ?? row.createdAt),
      partnerId: String(row.partnerId),
      tag: row.segmentTag?.code as string | undefined,
      parts: ((row.segments as Document[] | undefined) ?? []).map((part) => ({ code: String(part.code), amount: decimalString(part.amount), paid: decimalString(part.paid ?? '0') })),
      lines,
    };
  });
  const partnerIds = [...new Set(receivables.map((row) => String(row.partnerId)))].map((id) => new ObjectId(id));
  const returns = await db.collection('payments').find(
    { partnerId: { $in: partnerIds }, kind: 'RETURN', status: 'POSTED', 'historyLines.0': { $exists: true }, 'allocations.segment': { $exists: true } },
    { projection: { partnerId: 1, allocations: 1, historyLines: 1 }, ...options },
  ).toArray();
  return segmentItems(docs, returns.map((row) => ({
    partnerId: String(row.partnerId),
    allocations: ((row.allocations as Document[] | undefined) ?? []).map((allocation) => ({ receivableId: String(allocation.receivableId), segment: allocation.segment as string | undefined, amount: decimalString(allocation.amount ?? '0') })),
    lines: ((row.historyLines as Document[] | undefined) ?? []).map(historyLine),
  })), ctx.rules, { code: filter.code });
}
