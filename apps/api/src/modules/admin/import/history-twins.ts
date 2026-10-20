import Decimal from 'decimal.js';
import { normalizeSku } from '../../receivables/segments';

/** Chứng từ bán trong file lịch sử, kèm dòng hàng (mã, số lượng, thành tiền). */
export interface TwinEntry {
  id: string;
  customerCode: string;
  date: string;
  documentNo?: string | undefined;
  amount: string;
  lines?: ReadonlyArray<{ sku?: string | undefined; quantity?: string | undefined; amount?: string | undefined }> | undefined;
}
/** Phiếu BH trên ERP: ngày phiếu (YYYY-MM-DD giờ VN), công nợ đang ghi, dòng có tiền (bỏ dòng tặng). */
export interface TwinOrder {
  code: string;
  customerCode: string;
  orderDate: string;
  debt: string;
  lines: ReadonlyArray<{ sku?: string | undefined; quantity: string; paid: boolean }>;
}
export interface Twin {
  id: string;
  customerCode: string;
  date: string;
  documentNo: string;
  amount: string;
  order: { code: string; orderDate: string; debt: string };
  sameAmount: boolean;
  sameLines: boolean;
}

const DAY_MS = 86_400_000;
const shift = (iso: string, days: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

/** Khóa dòng hàng có tiền: "MÃ:số lượng" gộp theo mã, sắp xếp — so được giữa sổ cũ và phiếu ERP. */
function lineKey(lines: ReadonlyArray<{ sku?: string | undefined; quantity?: string | undefined }>): string {
  const totals = new Map<string, Decimal>();
  for (const line of lines) {
    const sku = normalizeSku(line.sku);
    if (!sku || !line.quantity) continue;
    totals.set(sku, (totals.get(sku) ?? new Decimal(0)).add(line.quantity));
  }
  return [...totals].filter(([, quantity]) => !quantity.isZero()).sort(([a], [b]) => a.localeCompare(b)).map(([sku, quantity]) => `${sku}:${quantity.toString()}`).join('|');
}

/**
 * Chứng từ bán ở sổ cũ nghi đã được lập lại trên ERP với số khác (IMP-AR-01, 19/10/2026) — VD sổ cũ ghi theo ngày đơn 30/09,
 * kho xuất 01/10 nên phiếu ERP lập ngày 01/10: cùng khách, phiếu ERP từ 3 ngày trước đến 30 ngày sau ngày chứng từ, và
 * công nợ lệch không quá 1 đ hoặc cùng dòng hàng có tiền (mã + số lượng). Mỗi phiếu ERP ghép với nhiều nhất một chứng từ,
 * ưu tiên khớp cả hai tiêu chí rồi ngày gần nhất. Chỉ là gợi ý — kế toán kiểm chứng từ xuất rồi mới ghép.
 */
export function findErpTwins(entries: readonly TwinEntry[], orders: readonly TwinOrder[]): Twin[] {
  const candidates: Array<Twin & { score: number; gap: number }> = [];
  for (const entry of entries) {
    const key = lineKey((entry.lines ?? []).filter((line) => new Decimal(line.amount ?? 0).gt(0)));
    for (const order of orders) {
      if (order.customerCode !== entry.customerCode || order.orderDate < shift(entry.date, -3) || order.orderDate > shift(entry.date, 30)) continue;
      const sameAmount = new Decimal(order.debt).minus(entry.amount).abs().lte(1);
      const sameLines = Boolean(key) && key === lineKey(order.lines.filter((line) => line.paid));
      if (!sameAmount && !sameLines) continue;
      candidates.push({
        id: entry.id, customerCode: entry.customerCode, date: entry.date, documentNo: entry.documentNo ?? '', amount: entry.amount,
        order: { code: order.code, orderDate: order.orderDate, debt: order.debt }, sameAmount, sameLines,
        score: Number(sameAmount) + Number(sameLines), gap: Math.abs(Date.parse(order.orderDate) - Date.parse(entry.date)),
      });
    }
  }
  candidates.sort((a, b) => b.score - a.score || a.gap - b.gap || a.id.localeCompare(b.id));
  const usedEntries = new Set<string>();
  const usedOrders = new Set<string>();
  const twins: Twin[] = [];
  for (const { score: _score, gap: _gap, ...twin } of candidates) {
    if (usedEntries.has(twin.id) || usedOrders.has(twin.order.code)) continue;
    usedEntries.add(twin.id);
    usedOrders.add(twin.order.code);
    twins.push(twin);
  }
  return twins.sort((a, b) => a.customerCode.localeCompare(b.customerCode) || a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
}
