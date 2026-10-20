import Decimal from 'decimal.js';

/** Chứng từ còn nợ (outstanding > 0) dùng để phân bổ phiếu thu theo khách (CN-KH-01). */
export interface OpenItem {
  id: string;
  outstanding: string;
  dueDate: Date;
  createdAt: Date;
  code?: string | undefined;
}

export interface FifoPlan {
  allocations: Array<{ id: string; amount: string }>;
  /** Phần thu vượt tổng còn nợ — ghi thành khoản khách trả trước. */
  leftover: string;
}

/**
 * Phân bổ số tiền vào các chứng từ còn nợ: hạn trả sớm nhất trước, rồi ngày phát sinh, rồi mã chứng từ (ổn định).
 * Bỏ qua khoản còn nợ <= 0. Trả về phân bổ (tổng = min(số tiền, tổng còn nợ)) và phần dư.
 */
export function planFifoAllocation(open: readonly OpenItem[], amount: string): FifoPlan {
  let remaining = new Decimal(amount);
  if (remaining.lte(0)) return { allocations: [], leftover: '0.00' };
  const ordered = [...open]
    .filter((item) => new Decimal(item.outstanding).gt(0))
    .sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime() || a.createdAt.getTime() - b.createdAt.getTime() || (a.code ?? a.id).localeCompare(b.code ?? b.id));
  const allocations: FifoPlan['allocations'] = [];
  for (const item of ordered) {
    if (remaining.lte(0)) break;
    const take = Decimal.min(remaining, new Decimal(item.outstanding));
    allocations.push({ id: item.id, amount: take.toFixed(2) });
    remaining = remaining.minus(take);
  }
  return { allocations, leftover: remaining.toFixed(2) };
}
