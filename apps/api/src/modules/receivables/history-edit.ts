import Decimal from 'decimal.js';

/**
 * Tính lại phần đã phân bổ của phiếu giảm nợ sổ cũ sau khi kế toán sửa / xóa một dòng sổ cũ (CN-HIST-EDIT-01, 02/11/2026).
 *
 * Phiếu thu / bù trừ lập trên ERP giữ nguyên tổng đã phân bổ; phiếu giảm nợ sổ cũ (`mode: HISTORY`) co giãn: theo thứ tự ngày,
 * mỗi phiếu lấy tối đa phần sức chứa còn lại của khách (tổng chứng từ còn hiệu lực − phần phiếu ERP đã chiếm), phần không
 * vào được chứng từ nào → khoản khách trả trước của sổ cũ. Phân bổ trung gian xếp vào chứng từ còn chỗ (hạn sớm trước);
 * sau đó `reallocatePartner` xếp lại theo quy tắc nhóm công nợ tách riêng / nợ thường trước (reallocate.ts).
 */
export interface HistoryDocRoom {
  id: string;
  code: string;
  /** Số tiền chứng từ − phần phiếu ngoài sổ cũ đang phân bổ vào (có thể âm nếu vừa giảm số tiền). */
  room: string;
  dueDate: Date;
  createdAt: Date;
}

export interface HistoryCredit {
  id: string;
  code: string;
  amount: string;
  receivedAt: Date;
  createdAt: Date;
}

export interface HistoryCreditPlan {
  allocations: Array<{ receivableId: string; amount: string }>;
  unapplied: string;
}

export interface HistoryPlan {
  credits: Map<string, HistoryCreditPlan>;
  /** Tổng phần không phân bổ được → khoản khách trả trước của sổ cũ (số dương). */
  leftover: string;
}

/** `capacity`: sức chứa của khách dành cho phiếu sổ cũ = tổng chứng từ còn hiệu lực − tổng phần phiếu ngoài sổ cũ đã chiếm. */
export function planHistoryCredits(docs: readonly HistoryDocRoom[], credits: readonly HistoryCredit[], capacity: Decimal.Value): HistoryPlan {
  let budget = Decimal.max(new Decimal(capacity), 0);
  const rooms = [...docs]
    .map((doc) => ({ ...doc, left: Decimal.max(new Decimal(doc.room), 0) }))
    .sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime() || a.createdAt.getTime() - b.createdAt.getTime() || a.code.localeCompare(b.code));
  const ordered = [...credits].sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime() || a.createdAt.getTime() - b.createdAt.getTime() || a.code.localeCompare(b.code));
  const result = new Map<string, HistoryCreditPlan>();
  let leftover = new Decimal(0);
  for (const credit of ordered) {
    const amount = new Decimal(credit.amount);
    let take = Decimal.min(amount, budget);
    budget = budget.minus(take);
    const allocations: HistoryCreditPlan['allocations'] = [];
    for (const doc of rooms) {
      if (take.lte(0)) break;
      if (doc.left.lte(0)) continue;
      const piece = Decimal.min(doc.left, take);
      allocations.push({ receivableId: doc.id, amount: piece.toFixed(2) });
      doc.left = doc.left.minus(piece);
      take = take.minus(piece);
    }
    // Sức chứa tổng luôn ≤ tổng chỗ trống dương nên `take` hết; phòng sai số thì phần thừa tính vào trả trước.
    const placed = allocations.reduce((sum, row) => sum.add(row.amount), new Decimal(0));
    const unapplied = amount.minus(placed);
    leftover = leftover.add(unapplied);
    result.set(credit.id, { allocations, unapplied: unapplied.toFixed(2) });
  }
  return { credits: result, leftover: leftover.toFixed(2) };
}

/** Trạng thái chứng từ theo số đã thu (khoản âm = trả trước: đã bù trừ hết là PAID). */
export function receivableStatus(amount: Decimal.Value, paid: Decimal.Value): 'PAID' | 'PARTIALLY_PAID' | 'OPEN' {
  const total = new Decimal(amount);
  const done = new Decimal(paid);
  if (total.lt(0)) return done.eq(total) ? 'PAID' : 'OPEN';
  return done.gte(total) ? 'PAID' : done.gt(0) ? 'PARTIALLY_PAID' : 'OPEN';
}
