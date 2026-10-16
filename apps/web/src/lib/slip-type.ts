/**
 * Loại phiếu xuất kho trên giao diện (SAL-TYPE-01, 15/10/2026): bán B2B / bán lẻ B2C / xuất hàng mẫu / xuất kiểm định / xuất tặng.
 * Phiếu không phải bán không có khách — bên nhận hiện là nhân viên phụ trách (người mượn) và nơi gửi / tặng cho.
 */
import { m } from '$lib/paraglide/messages';
import { isLoanPurpose, isNonSalePurpose, slipTypeOf, type SalesSlipType } from '$shared/sales-purpose';
import type { Tone } from '$lib/labels';

export { isLoanPurpose, isNonSalePurpose, slipTypeOf };
export type { SalesSlipType };

export const SLIP_TYPE_OPTIONS: readonly SalesSlipType[] = ['B2B', 'B2C', 'SAMPLE', 'INSPECTION', 'GIFT'];

export function slipTypeLabel(type: SalesSlipType): string {
  return { B2B: m.lp_ban_b2b, B2C: m.lp_ban_b2c, SAMPLE: m.lp_hang_mau, INSPECTION: m.lp_kiem_dinh, GIFT: m.lp_xuat_tang }[type]();
}

export function slipTypeShort(type: SalesSlipType): string {
  return { B2B: m.lp_ngan_b2b, B2C: m.lp_ngan_b2c, SAMPLE: m.lp_ngan_hang_mau, INSPECTION: m.lp_ngan_kiem_dinh, GIFT: m.lp_ngan_xuat_tang }[type]();
}

type PartyLike = { purpose?: string | undefined; channel?: string | undefined; customerName?: string | undefined; salesRepName?: string | undefined; destination?: string | undefined };

/** Bên nhận của phiếu: tên khách, hoặc "Hàng mẫu — <người mượn> (→ nơi gửi)". */
export function partyName(order: PartyLike): string {
  if (!isNonSalePurpose(order.purpose)) return order.customerName ?? '';
  const head = slipTypeShort(order.purpose);
  return `${head}${order.salesRepName ? ` — ${order.salesRepName}` : ''}${order.destination ? ` → ${order.destination}` : ''}`;
}

export function loanStatusInfo(status: string | undefined): { label: string; tone: Tone } | null {
  if (status === 'OUT') return { label: m.lp_dang_muon(), tone: 'warning' };
  if (status === 'PARTIAL') return { label: m.lp_ve_mot_phan(), tone: 'warning' };
  if (status === 'RETURNED') return { label: m.lp_da_ve_du(), tone: 'success' };
  if (status === 'CLOSED') return { label: m.lp_da_chot(), tone: 'neutral' };
  return null;
}

const DAY_MS = 86_400_000;
const VN_OFFSET_MS = 7 * 3_600_000;
const vnDay = (at: number) => Math.floor((at + VN_OFFSET_MS) / DAY_MS);

/** Số ngày hàng đã ở ngoài và số ngày quá hẹn trả (0 nếu chưa quá / không hẹn). */
export function loanAge(order: { shippedAt?: string | undefined; expectedReturnDate?: string | undefined }, now = Date.now()): { days: number; overdue: number } {
  const days = order.shippedAt ? Math.max(0, vnDay(now) - vnDay(Date.parse(order.shippedAt))) : 0;
  const overdue = order.expectedReturnDate ? Math.max(0, vnDay(now) - vnDay(Date.parse(`${order.expectedReturnDate}T00:00:00+07:00`))) : 0;
  return { days, overdue };
}
