import Decimal from 'decimal.js';
import { partRank, type SegmentAmount } from './segments';

/**
 * Phân bổ lại tiền đã thu của một khách theo quy tắc nhóm công nợ tách riêng (CN-SEG-01): nợ thường trước, phiếu chọn
 * nhóm thì phần nhóm đó trước, phiếu trả hàng có dòng hàng thuộc nhóm thì phần đó vào phần nhóm.
 *
 * Bất biến:
 * - tổng tiền phân bổ của mỗi phiếu không đổi (nên khoản khách trả trước không đổi);
 * - phân bổ vào chứng từ đã hủy / khoản trả trước (phải thu âm) giữ nguyên;
 * - phiếu thu theo từng chứng từ (mode DOCUMENT, hoặc bản ghi cũ không có mode) chỉ chia lại trong chính chứng từ đó;
 * - không phần nào bị trả quá số của nó; số đã thu mỗi chứng từ phải khớp tổng phân bổ (lệch thì dừng, không tự sửa).
 */
export interface EngineReceivable {
  id: string;
  code: string;
  amount: string;
  paidAmount: string;
  status: string;
  dueDate: Date;
  createdAt: Date;
  /** Phần nhóm mục tiêu (đã tính lại theo cấu hình / gắn tay). */
  segments: readonly SegmentAmount[];
}

export interface EngineAllocation {
  receivableId: string;
  amount: string;
  segment?: string | null | undefined;
}

export interface EnginePayment {
  id: string;
  code: string;
  receivedAt: Date;
  createdAt: Date;
  kind: string;
  mode?: string | undefined;
  /** Phiếu thu chọn "Thu cho nhóm …". */
  segment?: string | null | undefined;
  /** Phiếu trả hàng lịch sử: phần hàng thuộc từng nhóm. */
  returnSegments?: readonly SegmentAmount[] | undefined;
  allocations: readonly EngineAllocation[];
}

export interface EngineResult {
  receivables: Map<string, { paidAmount: string; status: string; segments: Array<{ code: string; amount: string; paid: string }> }>;
  payments: Map<string, EngineAllocation[]>;
  changedPayments: string[];
  changedReceivables: string[];
}

export class ReallocationError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
  }
}

const key = (receivableId: string, segment: string | null) => `${receivableId}|${segment ?? ''}`;
export const DOCUMENT_MODES = new Set(['DOCUMENT', '']);

export function reallocateCustomer(receivables: readonly EngineReceivable[], payments: readonly EnginePayment[]): EngineResult {
  const byId = new Map(receivables.map((row) => [row.id, row]));
  // Sức chứa từng phần của chứng từ phải thu dương còn hiệu lực.
  const capacity = new Map<string, Decimal>();
  const partsOf = new Map<string, Array<{ segment: string | null; amount: Decimal }>>();
  const pooled = (row: EngineReceivable) => row.status !== 'VOIDED' && new Decimal(row.amount).gt(0);
  for (const row of receivables) {
    if (!pooled(row)) continue;
    const segmentTotal = row.segments.reduce((sum, part) => sum.add(part.amount), new Decimal(0));
    const normal = new Decimal(row.amount).minus(segmentTotal);
    if (normal.lt(0)) throw new ReallocationError(`Phần nhóm của chứng từ ${row.code} vượt số tiền chứng từ`, 'SEGMENT_EXCEEDS_AMOUNT');
    const parts = [{ segment: null as string | null, amount: normal }, ...row.segments.map((part) => ({ segment: part.code, amount: new Decimal(part.amount) }))].filter((part) => part.amount.gt(0));
    partsOf.set(row.id, parts);
    for (const part of parts) capacity.set(key(row.id, part.segment), part.amount);
  }

  const ordered = [...payments].sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime() || a.createdAt.getTime() - b.createdAt.getTime() || a.code.localeCompare(b.code));
  const result = new Map<string, Map<string, Decimal>>(ordered.map((payment) => [payment.id, new Map()]));
  const add = (paymentId: string, receivableId: string, segment: string | null, amount: Decimal) => {
    const target = result.get(paymentId) as Map<string, Decimal>;
    const k = key(receivableId, segment);
    target.set(k, (target.get(k) ?? new Decimal(0)).add(amount));
  };
  const take = (paymentId: string, receivableId: string, segment: string | null, amount: Decimal) => {
    const k = key(receivableId, segment);
    capacity.set(k, (capacity.get(k) ?? new Decimal(0)).minus(amount));
    add(paymentId, receivableId, segment, amount);
  };

  // 1) Phân bổ giữ nguyên chứng từ: vào chứng từ hủy / khoản âm (giữ nguyên), phiếu thu theo từng chứng từ (chia lại trong chứng từ).
  const pool = new Map<string, Decimal>();
  for (const payment of ordered) {
    const documentMode = DOCUMENT_MODES.has(payment.mode ?? '');
    for (const allocation of payment.allocations) {
      const amount = new Decimal(allocation.amount);
      const receivable = byId.get(allocation.receivableId);
      if (!receivable) {
        // Chứng từ đã bị xóa (VD hoàn tác lô lịch sử): phiếu thu theo khách được phân bổ lại; phiếu theo chứng từ / bù trừ thì dừng.
        if (documentMode || amount.lte(0)) throw new ReallocationError(`Phiếu ${payment.code} phân bổ vào chứng từ không còn tồn tại`, 'ALLOCATION_TARGET_MISSING');
        pool.set(payment.id, (pool.get(payment.id) ?? new Decimal(0)).add(amount));
        continue;
      }
      if (!pooled(receivable) || amount.lte(0)) {
        add(payment.id, allocation.receivableId, allocation.segment ?? null, amount);
        continue;
      }
      if (!documentMode) {
        pool.set(payment.id, (pool.get(payment.id) ?? new Decimal(0)).add(amount));
        continue;
      }
      let remaining = amount;
      const parts = [...(partsOf.get(receivable.id) ?? [])].sort((a, b) => partRank(a.segment, payment.segment ?? null) - partRank(b.segment, payment.segment ?? null));
      for (const part of parts) {
        if (remaining.lte(0)) break;
        const room = capacity.get(key(receivable.id, part.segment)) ?? new Decimal(0);
        const piece = Decimal.min(room, remaining);
        if (piece.gt(0)) {
          take(payment.id, receivable.id, part.segment, piece);
          remaining = remaining.minus(piece);
        }
      }
      if (remaining.gt(0)) throw new ReallocationError(`Phiếu ${payment.code} thu vượt số tiền chứng từ ${receivable.code}`, 'DOCUMENT_OVERPAID');
    }
  }

  // 2) Phần còn lại phân bổ lại theo thứ tự thời gian của phiếu.
  const openParts = () => [...capacity]
    .filter(([, room]) => room.gt(0))
    .map(([k, room]) => {
      const [receivableId, segment] = k.split('|') as [string, string];
      const row = byId.get(receivableId) as EngineReceivable;
      return { receivableId, segment: segment || null, room, dueDate: row.dueDate, createdAt: row.createdAt, code: row.code };
    });
  const place = (paymentId: string, amount: Decimal, prefer: string | null): Decimal => {
    let remaining = amount;
    const queue = openParts().sort((a, b) => partRank(a.segment, prefer) - partRank(b.segment, prefer)
      || a.dueDate.getTime() - b.dueDate.getTime()
      || a.createdAt.getTime() - b.createdAt.getTime()
      || a.code.localeCompare(b.code)
      || (a.segment ?? '').localeCompare(b.segment ?? ''));
    for (const part of queue) {
      if (remaining.lte(0)) break;
      const piece = Decimal.min(part.room, remaining);
      take(paymentId, part.receivableId, part.segment, piece);
      remaining = remaining.minus(piece);
    }
    return remaining;
  };
  for (const payment of ordered) {
    let remaining = pool.get(payment.id) ?? new Decimal(0);
    if (remaining.lte(0)) continue;
    for (const part of payment.returnSegments ?? []) {
      const share = Decimal.min(remaining, new Decimal(part.amount));
      if (share.lte(0)) continue;
      const left = place(payment.id, share, part.code);
      remaining = remaining.minus(share).add(left);
      if (left.gt(0)) break;
    }
    remaining = place(payment.id, remaining, payment.segment ?? null);
    if (remaining.gt(0)) throw new ReallocationError(`Không đủ chứng từ để phân bổ phiếu ${payment.code} (thiếu ${remaining.toFixed(0)} đ)`, 'CAPACITY_SHORT');
  }

  // 3) Kết quả theo chứng từ + kiểm tra số đã thu khớp tổng phân bổ cũ.
  const paidBy = new Map<string, Map<string | null, Decimal>>();
  const allocationsOut = new Map<string, EngineAllocation[]>();
  const changedPayments: string[] = [];
  const canonical = (list: readonly EngineAllocation[]) => list
    .filter((item) => !new Decimal(item.amount).isZero())
    .map((item) => `${item.receivableId}|${item.segment ?? ''}|${new Decimal(item.amount).toFixed(2)}`)
    .sort()
    .join(';');
  for (const payment of ordered) {
    const list: EngineAllocation[] = [];
    for (const [k, amount] of result.get(payment.id) as Map<string, Decimal>) {
      if (amount.isZero()) continue;
      const [receivableId, segment] = k.split('|') as [string, string];
      list.push({ receivableId, amount: amount.toFixed(2), ...(segment ? { segment } : {}) });
      const byPart = paidBy.get(receivableId) ?? new Map<string | null, Decimal>();
      byPart.set(segment || null, (byPart.get(segment || null) ?? new Decimal(0)).add(amount));
      paidBy.set(receivableId, byPart);
    }
    allocationsOut.set(payment.id, list);
    if (canonical(list) !== canonical(payment.allocations)) changedPayments.push(payment.id);
  }
  const before = new Map<string, Decimal>();
  for (const payment of payments) for (const allocation of payment.allocations) before.set(allocation.receivableId, (before.get(allocation.receivableId) ?? new Decimal(0)).add(allocation.amount));
  const receivablesOut: EngineResult['receivables'] = new Map();
  const changedReceivables: string[] = [];
  for (const row of receivables) {
    const stored = new Decimal(row.paidAmount);
    if (!stored.eq(before.get(row.id) ?? 0)) {
      throw new ReallocationError(`Số đã thu của chứng từ ${row.code} (${stored.toFixed(0)} đ) không khớp tổng các phiếu thu (${(before.get(row.id) ?? new Decimal(0)).toFixed(0)} đ)`, 'PAID_MISMATCH');
    }
    const byPart = paidBy.get(row.id) ?? new Map<string | null, Decimal>();
    const paid = [...byPart.values()].reduce((sum, value) => sum.add(value), new Decimal(0));
    const amount = new Decimal(row.amount);
    const status = row.status === 'VOIDED' ? 'VOIDED'
      : amount.lt(0) ? (paid.eq(amount) ? 'PAID' : 'OPEN')
      : paid.eq(amount) ? 'PAID' : paid.gt(0) ? 'PARTIALLY_PAID' : 'OPEN';
    const segments = pooled(row) ? row.segments.map((part) => ({ code: part.code, amount: new Decimal(part.amount).toFixed(2), paid: (byPart.get(part.code) ?? new Decimal(0)).toFixed(2) })) : [];
    receivablesOut.set(row.id, { paidAmount: paid.toFixed(2), status, segments });
    changedReceivables.push(row.id);
  }
  return { receivables: receivablesOut, payments: allocationsOut, changedPayments, changedReceivables };
}
