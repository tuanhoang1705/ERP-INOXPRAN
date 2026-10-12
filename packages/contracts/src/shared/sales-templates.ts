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

/** Số phiếu BH tự nhập (vd. số trên phiếu giấy "BH003/0826"): chữ in hoa, số và . _ / - — 2 đến 40 ký tự. */
export const SALES_ORDER_CODE_PATTERN = /^[A-Z0-9][A-Z0-9._/-]{1,39}$/;

/**
 * Tiền tố số tự sinh của các chứng từ khác (SWK xuất kho, AR công nợ, PO đơn mua, TH/XT trả hàng, KK kiểm kê…).
 * Số phiếu BH tự nhập không được bắt đầu như vậy để thẻ kho / nhật ký / công nợ không lẫn chứng từ.
 */
export const RESERVED_DOCUMENT_PREFIXES = ['SWK', 'AR', 'PO', 'GR', 'IS', 'IMP', 'KK', 'PAY', 'SC', 'TRF', 'TH', 'XT', 'ADJ'] as const;
const RESERVED_DOCUMENT_CODE = new RegExp(`^(${RESERVED_DOCUMENT_PREFIXES.join('|')})-?\\d`);

/** Chuẩn hóa số phiếu tự nhập như máy chủ sẽ lưu: bỏ khoảng trắng hai đầu, viết hoa. */
export function normalizeSalesOrderCode(value: string): string {
  return value.trim().toUpperCase();
}

/** Lý do số phiếu tự nhập (đã chuẩn hóa) không dùng được: sai định dạng, hoặc trùng kiểu số của chứng từ khác. */
export function salesOrderCodeProblem(code: string): 'FORMAT' | 'RESERVED' | null {
  if (!SALES_ORDER_CODE_PATTERN.test(code)) return 'FORMAT';
  if (RESERVED_DOCUMENT_CODE.test(code)) return 'RESERVED';
  return null;
}
