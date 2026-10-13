/**
 * Danh mục mẫu chứng từ "Phiếu xuất kho bán hàng". Mỗi phiếu lưu mã mẫu đã dùng để form, máy chủ và bản in
 * chọn đúng cách tính thuế và bố cục. Thêm mẫu mới (ví dụ PXK-002 — thuế suất theo từng dòng hàng) bằng cách
 * khai báo ở đây rồi bổ sung cách tính / bố cục in tương ứng.
 */

export const SALES_ISSUE_TEMPLATES = ['PXK-001'] as const;
export type SalesIssueTemplate = (typeof SALES_ISSUE_TEMPLATES)[number];

export interface SalesIssueTemplateInfo {
  code: SalesIssueTemplate;
  name: string;
  /** DOCUMENT: một thuế suất GTGT cho cả phiếu. LINE: thuế suất theo từng dòng hàng (dành cho mẫu sau). */
  vatMode: 'DOCUMENT' | 'LINE';
  description: string;
}

export const SALES_ISSUE_TEMPLATE_INFO: Record<SalesIssueTemplate, SalesIssueTemplateInfo> = {
  'PXK-001': {
    code: 'PXK-001',
    name: 'Phiếu xuất kho bán hàng',
    vatMode: 'DOCUMENT',
    description: 'Một thuế suất GTGT cho cả phiếu (3% · 5% · 8% · 10% · KCT)',
  },
};

export const DEFAULT_SALES_ISSUE_TEMPLATE: SalesIssueTemplate = 'PXK-001';

/** Thông tin mẫu của một phiếu; phiếu lập trước khi có danh mục mẫu được coi là PXK-001. */
export function salesIssueTemplate(code: string | null | undefined): SalesIssueTemplateInfo {
  return SALES_ISSUE_TEMPLATE_INFO[(code ?? DEFAULT_SALES_ISSUE_TEMPLATE) as SalesIssueTemplate] ?? SALES_ISSUE_TEMPLATE_INFO[DEFAULT_SALES_ISSUE_TEMPLATE];
}

/**
 * Số phiếu BH tự nhập: chữ in hoa, số và . _ / - — 2 đến 40 ký tự (vd. số trên phiếu giấy "BH003/0826"),
 * hoặc chỉ gõ số hóa đơn 1–4 chữ số ("104") → hệ thống ghép thành BH + năm + tháng của ngày chứng từ + 4 số.
 */
export const SALES_ORDER_CODE_PATTERN = /^(?:\d{1,4}|[A-Z0-9][A-Z0-9._/-]{1,39})$/;

/**
 * Tiền tố số tự sinh của các chứng từ khác (SWK xuất kho, AR công nợ, PO đơn mua, TH/XT trả hàng, KK kiểm kê…).
 * Số phiếu BH tự nhập không được bắt đầu như vậy để thẻ kho / nhật ký / công nợ không lẫn chứng từ.
 */
export const RESERVED_DOCUMENT_PREFIXES = ['SWK', 'AR', 'PO', 'GR', 'IS', 'IMP', 'KK', 'PAY', 'SC', 'TRF', 'TH', 'XT', 'ADJ', 'SG'] as const;
const RESERVED_DOCUMENT_CODE = new RegExp(`^(${RESERVED_DOCUMENT_PREFIXES.join('|')})-?\\d`);

/** Chuẩn hóa số phiếu tự nhập như máy chủ sẽ lưu: bỏ khoảng trắng hai đầu, viết hoa. */
export function normalizeSalesOrderCode(value: string): string {
  return value.trim().toUpperCase();
}

/** Tiền tố số phiếu BH của một tháng: BH + năm + tháng (đánh số lại mỗi tháng): BH202610. */
export function salesOrderPeriodPrefix(period: { year: number; month: number }): string {
  return `BH${period.year}${String(period.month).padStart(2, '0')}`;
}

/** Năm / tháng từ ngày chứng từ dạng YYYY-MM-DD. */
export function periodOfDate(isoDate: string): { year: number; month: number } {
  return { year: Number(isoDate.slice(0, 4)), month: Number(isoDate.slice(5, 7)) };
}

/** Chỉ gõ số hóa đơn ("104") → BH2026100104 theo tháng của ngày chứng từ; số khác giữ nguyên. */
export function expandSalesOrderCode(code: string, period: { year: number; month: number }): string {
  return /^\d{1,4}$/.test(code) ? `${salesOrderPeriodPrefix(period)}${code.padStart(4, '0')}` : code;
}

/** Số thứ tự 4 số của mã dạng chuẩn trong tháng: BH2026100104 → 104; không đúng dạng (số tự nhập khác, phiếu hủy -H1) → null. */
export function salesOrderSequence(code: string, prefix: string): number | null {
  return code.startsWith(prefix) && /^\d{4}$/.test(code.slice(prefix.length)) ? Number(code.slice(prefix.length)) : null;
}

/**
 * Số tự sinh kế tiếp trong tháng = số cuối đang dùng + 1 (số của phiếu cuối bị xóa / hủy được dùng lại; số trống ở giữa
 * bỏ qua). Tháng chưa còn phiếu nào → bắt đầu lại từ số đầu tiên của tháng (vd. đơn 104), chưa từng có thì từ 1.
 */
export function nextSalesOrderSequence(highest: number | null, floor: number | null): number {
  return highest !== null ? highest + 1 : floor ?? 1;
}

/** Phiếu hủy nhả số cho phiếu mới: BH2026100104 → BH2026100104-H1 (n nhỏ nhất chưa dùng). */
export function cancelledCode(code: string, taken: ReadonlySet<string>): string {
  for (let index = 1; ; index += 1) {
    const candidate = `${code}-H${index}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Số phiếu kho (SWK) cùng số với phiếu BH: BH2026100104 → SWK2026100104; số tự nhập khác → SWK-<số>. */
export function warehouseSlipNumber(salesOrderCode: string): string {
  return salesOrderCode.startsWith('BH') ? `SWK${salesOrderCode.slice(2)}` : `SWK-${salesOrderCode}`;
}

/** Lý do số phiếu tự nhập (đã chuẩn hóa) không dùng được: sai định dạng, hoặc trùng kiểu số của chứng từ khác. */
export function salesOrderCodeProblem(code: string): 'FORMAT' | 'RESERVED' | null {
  if (!SALES_ORDER_CODE_PATTERN.test(code)) return 'FORMAT';
  if (RESERVED_DOCUMENT_CODE.test(code)) return 'RESERVED';
  return null;
}
