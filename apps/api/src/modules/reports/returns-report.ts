import { RETURN_LAG_BUCKETS, type ReturnBucketState, type ReturnDebtState, type ReturnsSplit } from '@inoxpran/contracts';
import Decimal from 'decimal.js';
import type { Document } from 'mongodb';
import { decimalString, vnDayStart, vnParts } from '../../common/domain';

/** Phần tính thuần của báo cáo Doanh số & hàng trả (RPT-RET-01) — tách khỏi truy vấn để kiểm thử. */

export const DAY_MS = 86_400_000;
const ZERO = new Decimal(0);

/** Ngày nhận hàng trả của phiếu NK (phiếu cũ chưa có ngày nhận: ngày ghi kho / ngày lập). */
export function slipReceivedAt(slip: Document): Date {
  return (slip.receivedAt as Date | undefined) ?? (slip.postedAt as Date | undefined) ?? (slip.createdAt as Date);
}

/**
 * Bộ lọc MongoDB "nhận hàng trả trong [from, to)" cùng thứ tự ưu tiên với slipReceivedAt: ngày nhận → ngày ghi kho → ngày lập
 * (phiếu cũ / dữ liệu mẫu có thể thiếu ngày nhận). `null` khớp cả trường thiếu.
 */
export function receivedBetween(from: Date, to?: Date): Document {
  const range = { $gte: from, ...(to ? { $lt: to } : {}) };
  return { $or: [{ receivedAt: range }, { receivedAt: null, postedAt: range }, { receivedAt: null, postedAt: null, createdAt: range }] };
}

/** Trạng thái công nợ: chờ kế toán / đã giảm nợ / không giảm nợ / không ảnh hưởng tiền (hàng tặng trả lại, phiếu 0 đ). */
export function slipState(slip: Document): ReturnDebtState {
  if (slip.accountingStatus === 'PENDING') return 'PENDING';
  if (slip.accountingStatus === 'DONE') return slip.accountingMode === 'CREDIT' && slip.creditNote ? 'CREDITED' : 'NOT_CREDITED';
  return 'NO_MONEY';
}

/**
 * Giá trị phiếu (gồm VAT): đã giảm nợ = số kế toán đã ghi giảm; còn lại = giá theo phiếu BH gốc; hàng tặng = 0.
 * null = chưa định giá (không có phiếu BH gốc, kế toán chưa xử lý / không giảm nợ).
 */
export function slipValue(slip: Document): Decimal | null {
  const state = slipState(slip);
  if (state === 'CREDITED') return new Decimal(decimalString((slip.creditNote as Document).amount));
  if (state === 'NO_MONEY') return ZERO;
  const total = (slip.value as Document | undefined)?.total;
  return total === undefined || total === null ? null : new Decimal(decimalString(total));
}

export function slipQuantity(slip: Document): Decimal {
  return ((slip.lines as Document[] | undefined) ?? []).reduce<Decimal>((sum, line) => sum.add(decimalString(line.quantity ?? '0')), new Decimal(0));
}

export function monthKeyOf(date: Date): string {
  const { year, month } = vnParts(date);
  return `${year}-${String(month).padStart(2, '0')}`;
}

/** Số ngày lịch (giờ Việt Nam) từ `from` đến `to`. */
export function calendarDays(from: Date, to: Date): number {
  return Math.round((vnDayStart(to).getTime() - vnDayStart(from).getTime()) / DAY_MS);
}

/**
 * Ô của bảng theo tháng bán (tháng [start, end)) và khoảng ngày `index`: chưa đến khi ngày bán đầu tháng + số ngày đầu khoảng còn
 * ở tương lai; đã xong khi ngày bán cuối tháng + số ngày cuối khoảng đã qua; khoảng cuối (trên 90 ngày) không bao giờ xong.
 */
export function lagBucketState(start: Date, end: Date, index: number, now: Date): ReturnBucketState {
  const bucket = RETURN_LAG_BUCKETS[index];
  if (!bucket) return 'NOT_YET';
  const today = vnDayStart(now).getTime();
  if (start.getTime() + bucket.from * DAY_MS > today) return 'NOT_YET';
  if (bucket.to === null) return 'RUNNING';
  const lastSaleDay = vnDayStart(new Date(end.getTime() - DAY_MS)).getTime();
  return lastSaleDay + bucket.to * DAY_MS < today ? 'DONE' : 'RUNNING';
}

/** Phần trăm một chữ số thập phân; mẫu số 0 → null. */
export function percentOf(part: Decimal.Value, whole: Decimal.Value): number | null {
  const base = new Decimal(whole);
  if (base.lte(0)) return null;
  return new Decimal(part).div(base).mul(100).toDecimalPlaces(1).toNumber();
}

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
}

export interface SplitAccumulator {
  total: Decimal;
  credited: Decimal;
  notCredited: Decimal;
  pending: Decimal;
  slips: number;
  creditedSlips: number;
  notCreditedSlips: number;
  pendingSlips: number;
  unvaluedSlips: number;
  giftQuantity: Decimal;
}

export function emptySplit(): SplitAccumulator {
  return { total: ZERO, credited: ZERO, notCredited: ZERO, pending: ZERO, slips: 0, creditedSlips: 0, notCreditedSlips: 0, pendingSlips: 0, unvaluedSlips: 0, giftQuantity: ZERO };
}

/** Cộng một phiếu vào nhóm: đếm phiếu theo trạng thái, cộng tiền khi đã định giá; hàng tặng trả lại chỉ cộng số lượng. */
export function addSlip(split: SplitAccumulator, slip: Document): void {
  const state = slipState(slip);
  const value = slipValue(slip);
  split.slips += 1;
  if (state === 'NO_MONEY') {
    if (slip.category === 'GIFT_RETURN_IN') split.giftQuantity = split.giftQuantity.add(slipQuantity(slip));
    return;
  }
  if (state === 'CREDITED') split.creditedSlips += 1;
  else if (state === 'NOT_CREDITED') split.notCreditedSlips += 1;
  else split.pendingSlips += 1;
  if (value === null) {
    split.unvaluedSlips += 1;
    return;
  }
  split.total = split.total.add(value);
  if (state === 'CREDITED') split.credited = split.credited.add(value);
  else if (state === 'NOT_CREDITED') split.notCredited = split.notCredited.add(value);
  else split.pending = split.pending.add(value);
}

export function splitView(split: SplitAccumulator): ReturnsSplit {
  return {
    total: split.total.toFixed(2),
    credited: split.credited.toFixed(2),
    notCredited: split.notCredited.toFixed(2),
    pending: split.pending.toFixed(2),
    slips: split.slips,
    creditedSlips: split.creditedSlips,
    notCreditedSlips: split.notCreditedSlips,
    pendingSlips: split.pendingSlips,
    unvaluedSlips: split.unvaluedSlips,
    giftQuantity: split.giftQuantity.toString(),
  };
}

/** Thu tiền / giảm nợ trả hàng / cước vận chuyển theo loại phiếu thu (thiếu loại = thu tiền; bù trừ không tính). */
export function paymentBucket(kind: unknown): 'collected' | 'returnCredits' | 'freight' | null {
  const value = String(kind ?? 'RECEIPT');
  if (value === 'OFFSET') return null;
  if (value === 'RETURN') return 'returnCredits';
  if (value === 'FREIGHT') return 'freight';
  return 'collected';
}
