import { m } from '$lib/paraglide/messages';
export type Tone = '' | 'success' | 'warning' | 'danger' | 'neutral' | 'orange';

export const salesStatus: Record<string, { label: string; tone: Tone }> = {
  DRAFT: { label: m.nhap(), tone: 'neutral' },
  PENDING_APPROVAL: { label: m.cho_duyet(), tone: 'warning' },
  APPROVED: { label: m.da_duyet(), tone: 'success' },
  RESERVED: { label: m.da_duyet_giu_hang(), tone: 'success' },
  PARTIALLY_SHIPPED: { label: m.xuat_mot_phan(), tone: '' },
  SHIPPED: { label: m.dang_giao(), tone: '' },
  DELIVERED: { label: m.da_giao(), tone: 'success' },
  CANCELLED: { label: m.da_huy(), tone: 'danger' },
};

export const purchaseStatus: Record<string, { label: string; tone: Tone }> = {
  DRAFT: { label: m.nhap(), tone: 'neutral' },
  PENDING_APPROVAL: { label: m.cho_duyet(), tone: 'warning' },
  APPROVED: { label: m.da_duyet_cho_nhap(), tone: '' },
  PARTIALLY_RECEIVED: { label: m.nhap_mot_phan(), tone: 'warning' },
  RECEIVED: { label: m.da_nhap_du(), tone: 'success' },
  CANCELLED: { label: m.da_huy(), tone: 'danger' },
};

export const receivableStatus: Record<string, { label: string; tone: Tone }> = {
  OPEN: { label: m.chua_thu(), tone: '' },
  PARTIALLY_PAID: { label: m.thu_mot_phan(), tone: 'warning' },
  PAID: { label: m.da_thu_du(), tone: 'success' },
  OVERDUE: { label: m.qua_han(), tone: 'danger' },
  VOIDED: { label: m.cn_da_huy_theo_phieu(), tone: 'neutral' },
};

export const overdueLevel: Record<string, { label: string; tone: Tone }> = {
  REMINDER: { label: m.nhac_no(), tone: '' },
  WARNING: { label: m.canh_bao(), tone: 'warning' },
  DANGER: { label: m.nguy_hiem(), tone: 'danger' },
};

export const tierLabel: Record<string, string> = {
  TIER_1: m.npp_cap_1(),
  TIER_2: m.dai_ly_cap_2(),
  RETAIL: m.khach_le(),
};

export const availabilityLabel: Record<string, { label: string; tone: Tone }> = {
  IN_STOCK: { label: m.con_hang(), tone: 'success' },
  INCOMING: { label: m.dang_ve(), tone: '' },
  OUT_OF_STOCK: { label: m.chua_co_hang(), tone: 'danger' },
};

export const partnerStatus: Record<string, { label: string; tone: Tone }> = {
  ACTIVE: { label: m.hoat_dong(), tone: 'success' },
  ON_HOLD: { label: m.tam_khoa_dat_hang(), tone: 'danger' },
  INACTIVE: { label: m.ngung_giao_dich(), tone: 'neutral' },
};

export const roleLabel: Record<string, string> = {
  ADMIN: m.vai_tro_admin(),
  DIRECTOR: m.ban_giam_doc(),
  SALES_MANAGER: m.truong_phong_kd(),
  SALES: m.nhan_vien_kinh_doanh(),
  PROCUREMENT_MANAGER: m.truong_phong_mua_hang(),
  PROCUREMENT: m.nhan_vien_mua_hang(),
  WAREHOUSE_MANAGER: m.quan_ly_kho(),
  WAREHOUSE: m.nhan_vien_kho(),
  ACCOUNTANT: m.ke_toan(),
  CATALOG_MANAGER: m.quan_ly_danh_muc(),
  AUDITOR: m.kiem_soat_noi_bo(),
  WARRANTY: m.role_warranty(),
};

export const approvalReason: Record<string, string> = {
  ORDER_VALUE_THRESHOLD: m.gia_tri_don_vuot_nguong_duyet(),
  DISCOUNT_THRESHOLD: m.chiet_khau_vuot_nguong(),
  CREDIT_LIMIT_EXCEEDED: m.vuot_han_muc_cong_no(),
  PURCHASE_VALUE_THRESHOLD: m.gia_tri_don_mua_vuot_nguong(),
};

export const movementLabel: Record<string, string> = {
  OPENING: m.ton_dau_ky(),
  PURCHASE_RECEIPT: m.nhap_mua_hang(),
  SALES_SHIPMENT: m.xuat_ban(),
  CUSTOMER_RETURN: m.khach_tra_hang(),
  SUPPLIER_RETURN: m.tra_nha_cung_cap(),
  TRANSFER_IN: m.chuyen_kho_den(),
  TRANSFER_OUT: m.chuyen_kho_di(),
  ADJUSTMENT_IN: m.dieu_chinh_tang(),
  ADJUSTMENT_OUT: m.dieu_chinh_giam(),
  REVERSAL: m.dao_but_toan(),
  WARRANTY_EXCHANGE_OUT: m.wr_mv_exchange_out(),
  WARRANTY_DEFECT_IN: m.wr_mv_defect_in(),
};

export function hasRole(roles: string[] | undefined, allowed: string[]): boolean {
  return Boolean(roles?.some((role) => role === 'ADMIN' || allowed.includes(role)));
}

/**
 * Bước xử lý của phiếu xuất kho bán hàng theo quy trình INOXPRAN:
 * Kế toán lập BH → (duyệt nếu vượt ngưỡng) → Kinh doanh đối chiếu với khách → Kho lập SWK & xuất → Giao hàng.
 */
export function orderStage(order: { status: string; confirmationStatus?: string | undefined }): { label: string; tone: Tone } {
  if (order.status === 'DRAFT') {
    return order.confirmationStatus === 'REVISION_REQUESTED'
      ? { label: m.kd_yeu_cau_sua_phieu(), tone: 'danger' }
      : { label: m.nhap_cho_kt_phat_hanh(), tone: 'neutral' };
  }
  if (order.status === 'RESERVED') {
    if (order.confirmationStatus === 'PENDING') return { label: m.cho_kd_doi_chieu_voi_khach(), tone: 'warning' };
    if (order.confirmationStatus === 'CONFIRMED') return { label: m.cho_kho_lap_swk(), tone: '' };
  }
  if (order.status === 'SHIPPED') return { label: m.da_xuat_kho_dang_giao(), tone: '' };
  return salesStatus[order.status] ?? { label: order.status, tone: '' };
}

/** Bộ lọc theo bước xử lý dùng trên danh sách phiếu. */
export const stageFilters: Array<{ value: string; label: string; query: Record<string, string> }> = [
  { value: 'draft', label: m.nhap_cho_ke_toan_phat_hanh(), query: { status: 'DRAFT' } },
  { value: 'approval', label: m.cho_duyet_ngoai_le(), query: { status: 'PENDING_APPROVAL' } },
  { value: 'check', label: m.cho_kd_doi_chieu_voi_khach(), query: { status: 'RESERVED', confirmation: 'PENDING' } },
  { value: 'warehouse', label: m.cho_kho_lap_phieu_swk(), query: { status: 'RESERVED', confirmation: 'CONFIRMED' } },
  { value: 'shipping', label: m.da_xuat_kho_dang_giao(), query: { status: 'SHIPPED' } },
  { value: 'delivered', label: m.da_giao(), query: { status: 'DELIVERED' } },
  { value: 'cancelled', label: m.da_huy(), query: { status: 'CANCELLED' } },
];
