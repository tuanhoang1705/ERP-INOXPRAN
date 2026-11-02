/**
 * Quyền sửa danh mục — dùng chung cho API (RolesGuard, service) và giao diện (ẩn / hiện nút).
 * ADMIN luôn có quyền ở giao diện (hasRole); các danh sách dưới đây vẫn ghi ADMIN cho phía API.
 * (chốt 05/10/2026: tài khoản kho được thêm / sửa / xóa ở Danh mục và Kho & giao hàng; từ 28/10/2026 Giám đốc chỉ xem — ROLE-DIR-01).
 * - Hồ sơ khách hàng vẫn do phòng Kinh doanh quản lý chính; kế toán chỉ thêm khách khi lập phiếu BH;
 *   tài khoản kho không sửa hồ sơ khách.
 * - Hạn mức công nợ / số ngày nợ chỉ kế toán, quản trị được đổi (KD đề xuất, kế toán lập).
 * - CRM (06/10/2026): nhân viên kinh doanh tạo được khách "cơ hội" và ghi nhật ký chăm sóc; khách cơ hội phải được
 *   quản lý chuyển thành khách chính thức (cấp giá) mới lập phiếu bán hàng.
 */
const unique = (roles: string[]) => [...new Set(roles)];

/** Quản lý cả khách hàng lẫn nhà cung cấp (như trước đây). */
const PARTNER_MANAGERS = ['ADMIN', 'CATALOG_MANAGER', 'SALES_MANAGER', 'PROCUREMENT_MANAGER'];
const WAREHOUSE_ROLES = ['WAREHOUSE_MANAGER', 'WAREHOUSE'];

/** Kept for compatibility with earlier code: roles that manage partners of every kind. */
export const PARTNER_MANAGER_ROLES = PARTNER_MANAGERS;
export const SUPPLIER_MANAGER_ROLES = unique([...PARTNER_MANAGERS, ...WAREHOUSE_ROLES]);
/** Được gọi API thêm đối tác; loại đối tác được phép kiểm tra thêm ở canCreatePartnerKind. */
export const PARTNER_CREATE_ROLES = unique([...SUPPLIER_MANAGER_ROLES, 'ACCOUNTANT', 'SALES']);
/** Nhật ký chăm sóc khách, hẹn chăm sóc lại. */
export const CRM_ROLES = ['ADMIN', 'SALES_MANAGER', 'SALES'];
export const CREDIT_TERMS_ROLES = ['ADMIN', 'ACCOUNTANT'];

/** Sản phẩm, nhóm hàng, định mức tồn. */
export const PRODUCT_EDITOR_ROLES = unique(['ADMIN', 'CATALOG_MANAGER', ...WAREHOUSE_ROLES]);
/** Thêm mã sản phẩm mới: người sửa danh mục + người lập đơn mua (tạo mã ngay trên đơn mua — PO-NEWSKU-01, 16/10/2026). Sửa / xóa vẫn theo PRODUCT_EDITOR_ROLES. */
export const PRODUCT_CREATE_ROLES = unique([...PRODUCT_EDITOR_ROLES, 'PROCUREMENT', 'PROCUREMENT_MANAGER']);
/** Kho, vị trí lưu, điều chỉnh tồn, chuyển kho. */
export const WAREHOUSE_EDITOR_ROLES = unique(['ADMIN', ...WAREHOUSE_ROLES]);
/** Khu vực bán hàng, nhân viên kinh doanh. */
export const SALES_STRUCTURE_ROLES = ['ADMIN', 'SALES_MANAGER'];
/** Bậc doanh số, trần chiết khấu, CK theo cấp, chương trình khuyến mãi (chốt 08/10/2026: kế toán; Giám đốc chỉ xem từ 28/10/2026). */
export const PRICING_EDITOR_ROLES = ['ADMIN', 'ACCOUNTANT'];

const has = (roles: string[], allowed: string[]) => roles.some((role) => allowed.includes(role));

/** Được quản lý (sửa / xóa) đối tác loại này. */
export function canManagePartnerKind(roles: string[], kind: string): boolean {
  if (has(roles, PARTNER_MANAGERS)) return true;
  return kind === 'SUPPLIER' && has(roles, WAREHOUSE_ROLES);
}

export function canCreatePartnerKind(roles: string[], kind: string, stage?: string): boolean {
  if (canManagePartnerKind(roles, kind)) return true;
  if (kind !== 'CUSTOMER') return false;
  return roles.includes('ACCOUNTANT') || (stage === 'PROSPECT' && roles.includes('SALES'));
}

/** Chuyển khách cơ hội thành khách chính thức (gán cấp giá) — người quản lý hồ sơ khách. */
export function canConvertProspect(roles: string[]): boolean {
  return canManagePartnerKind(roles, 'CUSTOMER');
}

export function canLogActivity(roles: string[]): boolean {
  return has(roles, CRM_ROLES);
}

export function canChangeCreditTerms(roles: string[]): boolean {
  return has(roles, CREDIT_TERMS_ROLES);
}

export function canEditPricing(roles: string[]): boolean {
  return has(roles, PRICING_EDITOR_ROLES);
}
