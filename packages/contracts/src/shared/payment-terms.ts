/** Hạn thanh toán chọn được trên phiếu BH (ngoài hạn mặc định của khách) — web và máy chủ dùng chung (SEC-UI-01, 06/11/2026). */
export const SALES_PAYMENT_TERM_OPTIONS = [0, 15, 21, 30, 45, 60] as const;

/** Các hạn được chọn cho một phiếu: danh sách chuẩn + hạn mặc định của khách + hạn đang lưu trên phiếu (sửa phiếu cũ không kẹt). */
export function paymentTermChoices(customerDefault?: number | null, current?: number | null): number[] {
  const values = new Set<number>(SALES_PAYMENT_TERM_OPTIONS);
  if (customerDefault !== undefined && customerDefault !== null) values.add(Number(customerDefault));
  if (current !== undefined && current !== null) values.add(Number(current));
  return [...values].sort((a, b) => a - b);
}
