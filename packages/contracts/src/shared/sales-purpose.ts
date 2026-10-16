/**
 * Loại phiếu xuất kho (SAL-TYPE-01, 15/10/2026). Phiếu BH ngoài bán hàng (B2B / B2C) còn dùng để xuất hàng KHÔNG bán:
 * - SAMPLE: hàng mẫu NVKD mang đi cho đại lý / NPP xem, vài ngày sau mang về nhập lại kho.
 * - INSPECTION: hàng mang đi kiểm định.
 * - GIFT: xuất tặng — không thu hồi.
 * Phiếu không phải bán: không khách hàng (người nhận = nhân viên phụ trách + nơi gửi / tặng cho), đơn giá 0, không công nợ,
 * không tính doanh thu. Hàng mẫu / kiểm định có hẹn trả (mặc định 15 ngày), mang về nhập lại theo phiếu, phần không về thì
 * chốt kèm lý do; thẻ kho ghi "Hàng mẫu xuất" / "Xuất kiểm định". Xuất tặng ghi "Hàng tặng KM / combo xuất".
 * Phiếu cũ không có `purpose` là phiếu bán.
 */
import type { InventoryCategory } from './inventory-categories.js';

export const SALES_PURPOSES = ['SALE', 'SAMPLE', 'INSPECTION', 'GIFT'] as const;
export type SalesPurpose = (typeof SALES_PURPOSES)[number];
export const NON_SALE_PURPOSES = ['SAMPLE', 'INSPECTION', 'GIFT'] as const satisfies readonly SalesPurpose[];
export type NonSalePurpose = (typeof NON_SALE_PURPOSES)[number];
/** Loại có hàng mang về: hẹn trả, nhập lại, chốt phần chưa trả. */
export const LOAN_PURPOSES = ['SAMPLE', 'INSPECTION'] as const satisfies readonly NonSalePurpose[];
export type LoanPurpose = (typeof LOAN_PURPOSES)[number];

/** "Loại phiếu" hiển thị và lọc: bán B2B / bán lẻ B2C / xuất hàng mẫu / xuất kiểm định / xuất tặng. */
export const SALES_SLIP_TYPES = ['B2B', 'B2C', 'SAMPLE', 'INSPECTION', 'GIFT'] as const;
export type SalesSlipType = (typeof SALES_SLIP_TYPES)[number];

/** Hẹn trả mặc định của hàng mẫu / kiểm định: hôm nay + 15 ngày. */
export const LOAN_RETURN_DAYS = 15;

/** Tình trạng hàng của phiếu hàng mẫu / kiểm định sau khi xuất kho. */
export const LOAN_STATUSES = ['OUT', 'PARTIAL', 'RETURNED', 'CLOSED'] as const;
export type LoanStatus = (typeof LOAN_STATUSES)[number];
/** Chốt phần chưa trả: CONSUMED = hỏng / tiêu hao khi kiểm định / tặng (không nhập lại); SOLD = đại lý giữ, chuyển thành bán. */
export const LOAN_CLOSE_OUTCOMES = ['CONSUMED', 'SOLD'] as const;
export type LoanCloseOutcome = (typeof LOAN_CLOSE_OUTCOMES)[number];

/** Phiếu (bản ghi Mongo / dữ liệu API) — chỉ cần trường `purpose`. */
type PurposeLike = { purpose?: unknown; [key: string]: unknown };

export function isNonSalePurpose(purpose: unknown): purpose is NonSalePurpose {
  return purpose === 'SAMPLE' || purpose === 'INSPECTION' || purpose === 'GIFT';
}

export function isLoanPurpose(purpose: unknown): purpose is LoanPurpose {
  return purpose === 'SAMPLE' || purpose === 'INSPECTION';
}

export function isNonSale(order: PurposeLike | null | undefined): boolean {
  return isNonSalePurpose(order?.purpose);
}

export function purposeOf(order: PurposeLike | null | undefined): SalesPurpose {
  return isNonSalePurpose(order?.purpose) ? order.purpose : 'SALE';
}

export function slipTypeOf(order: PurposeLike & { channel?: unknown }): SalesSlipType {
  if (isNonSalePurpose(order.purpose)) return order.purpose;
  return order.channel === 'B2C' ? 'B2C' : 'B2B';
}

/** Điều kiện Mongo của một loại phiếu (danh sách / bộ lọc). */
export function slipTypeFilter(type: SalesSlipType): Record<string, unknown> {
  if (isNonSalePurpose(type)) return { purpose: type };
  return { purpose: { $nin: [...NON_SALE_PURPOSES] }, channel: type === 'B2C' ? 'B2C' : { $ne: 'B2C' } };
}

/** Chỉ phiếu bán — điều kiện thêm vào mọi phép cộng doanh thu / doanh số. */
export const SALE_ONLY_FILTER: Readonly<Record<string, unknown>> = { purpose: { $nin: [...NON_SALE_PURPOSES] } };

/** Loại phát sinh thẻ kho khi xuất phiếu không phải bán. */
export function nonSaleOutCategory(purpose: NonSalePurpose): InventoryCategory {
  return purpose === 'INSPECTION' ? 'INSPECTION_OUT' : purpose === 'GIFT' ? 'GIFT_OUT' : 'SAMPLE_OUT';
}

export function loanInCategory(purpose: LoanPurpose): InventoryCategory {
  return purpose === 'INSPECTION' ? 'INSPECTION_IN' : 'SAMPLE_IN';
}

/** Ngày hẹn trả mặc định (YYYY-MM-DD) tính từ ngày `today` (YYYY-MM-DD, giờ Việt Nam). */
export function defaultReturnDate(today: string): string {
  return new Date(Date.parse(`${today}T00:00:00Z`) + LOAN_RETURN_DAYS * 86_400_000).toISOString().slice(0, 10);
}

export const PURPOSE_LABEL_VI: Readonly<Record<SalesPurpose, string>> = {
  SALE: 'Bán hàng',
  SAMPLE: 'Xuất hàng mẫu',
  INSPECTION: 'Xuất kiểm định',
  GIFT: 'Xuất tặng',
};

/** Tiêu đề phiếu in theo loại. */
export const PURPOSE_TITLE_VI: Readonly<Record<SalesPurpose, string>> = {
  SALE: 'PHIẾU XUẤT KHO BÁN HÀNG',
  SAMPLE: 'PHIẾU XUẤT KHO HÀNG MẪU',
  INSPECTION: 'PHIẾU XUẤT KHO KIỂM ĐỊNH',
  GIFT: 'PHIẾU XUẤT KHO HÀNG TẶNG',
};

/** Bên nhận trên phiếu (thông báo / nhật ký phía máy chủ): tên khách, hoặc "Hàng mẫu — <NV> (gửi <nơi>)" / "Xuất tặng — <NV> (tặng <ai>)". */
export function orderParty(order: PurposeLike & { customerName?: unknown; salesRepName?: unknown; destination?: unknown }): string {
  if (!isNonSalePurpose(order.purpose)) return String(order.customerName ?? '');
  const head = order.purpose === 'INSPECTION' ? 'Kiểm định' : order.purpose === 'GIFT' ? 'Xuất tặng' : 'Hàng mẫu';
  const who = order.salesRepName ? ` — ${String(order.salesRepName)}` : '';
  const where = order.destination ? ` (${order.purpose === 'GIFT' ? 'tặng' : 'gửi'} ${String(order.destination)})` : '';
  return `${head}${who}${where}`;
}
