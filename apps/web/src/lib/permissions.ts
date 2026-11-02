/**
 * Ẩn / hiện nút thêm-sửa-xóa theo cùng bảng quyền với API ($shared/catalog-access.ts).
 * Chỉ để giao diện gọn; máy chủ vẫn kiểm tra quyền ở mọi thao tác.
 */
import {
  canChangeCreditTerms,
  canConvertProspect,
  canCreatePartnerKind,
  canEditPricing,
  canLogActivity,
  canManagePartnerKind,
  PRODUCT_EDITOR_ROLES,
  SALES_STRUCTURE_ROLES,
  SUPPLIER_MANAGER_ROLES,
  WAREHOUSE_EDITOR_ROLES,
} from '$shared/catalog-access';
import { hasRole } from './labels';
import { session } from './session.svelte';

const roles = () => session.user?.roles ?? [];
const isAdmin = () => roles().includes('ADMIN');

export const can = {
  editProducts: () => hasRole(roles(), PRODUCT_EDITOR_ROLES),
  editWarehouses: () => hasRole(roles(), WAREHOUSE_EDITOR_ROLES),
  editSuppliers: () => hasRole(roles(), SUPPLIER_MANAGER_ROLES),
  editCustomers: () => isAdmin() || canManagePartnerKind(roles(), 'CUSTOMER'),
  editCreditTerms: () => isAdmin() || canChangeCreditTerms(roles()),
  editSalesStructure: () => hasRole(roles(), SALES_STRUCTURE_ROLES),
  createProspects: () => isAdmin() || canCreatePartnerKind(roles(), 'CUSTOMER', 'PROSPECT'),
  convertProspects: () => isAdmin() || canConvertProspect(roles()),
  logActivities: () => isAdmin() || canLogActivity(roles()),
  editPricing: () => isAdmin() || canEditPricing(roles()),
  /** Lập đơn mua (BUYERS của API): phòng mua hàng. */
  createPurchaseOrders: () => hasRole(roles(), ['PROCUREMENT', 'PROCUREMENT_MANAGER']),
  /** Giao NVKD khác người phụ trách vùng (ngoại lệ phân vùng PV-01): Admin / quản trị gốc. */
  overrideTerritory: () => isAdmin() || Boolean(session.user?.root),
};
