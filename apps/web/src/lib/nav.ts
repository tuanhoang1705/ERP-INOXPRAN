import { m } from '$lib/paraglide/messages';
export interface NavItem {
  label: string;
  href: string;
  /** Chỉ hiện với các vai trò này (ADMIN luôn thấy). Bỏ trống = mọi người dùng. */
  roles?: string[];
  /** Chỉ tài khoản quản trị gốc (root) thấy — phần kỹ thuật / cấu hình hệ thống. */
  rootOnly?: boolean;
  /** Chỉ hiện khi có một trong các quyền nghiệp vụ này (PERM-01); quản trị gốc luôn thấy. */
  permissions?: string[];
  badge?: 'approvals' | 'changes';
}

export interface NavGroup {
  title: string;
  items: NavItem[];
}

export interface NavSection {
  key: string;
  label: string;
  href: string;
  /** Tiền tố đường dẫn thuộc phân hệ; dùng để tô sáng tab đang mở. */
  match: string[];
  roles?: string[];
  groups: NavGroup[];
}

const APPROVERS = ['SALES_MANAGER', 'PROCUREMENT_MANAGER', 'DIRECTOR'];
const REPORT_VIEWERS = ['DIRECTOR', 'SALES_MANAGER', 'ACCOUNTANT', 'AUDITOR'];

/** Hai cấp menu theo sơ đồ BFD của đồ án: 6 chức năng chính + Tổng quan. */
export const sections: NavSection[] = [
  {
    key: 'overview',
    label: m.tong_quan(),
    href: '/',
    match: ['/', '/admin', '/settings', '/account'],
    groups: [
      {
        title: m.chuc_nang(),
        items: [
          { label: m.bang_dieu_khien(), href: '/' },
          { label: m.phieu_xuat_kho_ban_hang(), href: '/sales/orders' },
          { label: m.cho_doi_chieu_voi_khach(), href: '/sales/orders?stage=check', permissions: ['sales.step.confirm'] },
          { label: m.duyet_ngoai_le(), href: '/approvals', roles: APPROVERS, badge: 'approvals' },
          { label: m.gia_duyet_tieu_de(), href: '/sales/price-approvals', permissions: ['sales.price_override_approve'] },
          { label: m.yc_menu(), href: '/sales/change-requests', permissions: ['sales.change_request', 'sales.change_approve'], badge: 'changes' },
          { label: m.canh_bao_cong_no(), href: '/receivables/overdue' },
        ],
      },
      {
        title: m.quan_tri(),
        items: [
          { label: m.danh_muc_san_pham(), href: '/catalog/products' },
          { label: m.ho_so_dai_ly(), href: '/catalog/dealers' },
          { label: m.bang_gia_chiet_khau(), href: '/pricing' },
          { label: m.nguoi_dung_phan_quyen(), href: '/admin/users', roles: ['DIRECTOR', 'AUDITOR'] },
          { label: m.sys_title(), href: '/admin/system', rootOnly: true },
          { label: m.aud_title(), href: '/admin/audit', rootOnly: true },
          { label: m.imp_title(), href: '/admin/import', rootOnly: true },
          { label: m.thiet_lap_he_thong(), href: '/settings', rootOnly: true },
        ],
      },
    ],
  },
  {
    key: 'catalog',
    label: m.danh_muc(),
    href: '/catalog/products',
    match: ['/catalog'],
    groups: [
      {
        title: m.danh_muc(),
        items: [
          { label: m.san_pham_sku(), href: '/catalog/products' },
          { label: m.ho_so_dai_ly_khach_hang(), href: '/catalog/dealers' },
          { label: m.nha_cung_cap(), href: '/catalog/suppliers' },
          { label: m.kho_vi_tri_luu(), href: '/catalog/warehouses' },
          { label: m.khu_vuc_nhan_vien_kd(), href: '/catalog/regions' },
        ],
      },
    ],
  },
  {
    key: 'orders',
    label: m.don_hang(),
    href: '/sales/orders',
    match: ['/sales', '/approvals'],
    groups: [
      {
        title: m.phieu_xuat_kho_ban_hang(),
        items: [
          // 5 bước phiếu BH theo người được Admin phân công (SAL-STEP-01).
          { label: m.lap_phieu_xuat_kho_bh(), href: '/sales/orders/new', permissions: ['sales.step.create'] },
          { label: m.tat_ca_phieu(), href: '/sales/orders' },
          { label: m.cho_ke_toan_phat_hanh_sua(), href: '/sales/orders?stage=draft', permissions: ['sales.step.create', 'sales.step.issue'] },
          { label: m.cho_doi_chieu_voi_khach(), href: '/sales/orders?stage=check', permissions: ['sales.step.confirm'] },
          { label: m.cho_kho_lap_phieu_swk(), href: '/sales/orders?stage=warehouse' },
          { label: m.sst_nav_cho_giao(), href: '/sales/orders?stage=shipping', permissions: ['sales.step.deliver'] },
          { label: m.duyet_ngoai_le(), href: '/approvals', roles: APPROVERS, badge: 'approvals' },
          { label: m.gia_duyet_tieu_de(), href: '/sales/price-approvals', permissions: ['sales.price_override_approve'] },
          { label: m.yc_menu(), href: '/sales/change-requests', permissions: ['sales.change_request', 'sales.change_approve'], badge: 'changes' },
        ],
      },
      {
        title: m.lp_theo_loai_phieu(),
        items: [
          { label: m.dai_ly_npp_b2b(), href: '/sales/orders?type=B2B' },
          { label: m.khach_le_b2c(), href: '/sales/orders?type=B2C' },
          { label: m.lp_ngan_hang_mau(), href: '/sales/orders?type=SAMPLE' },
          { label: m.lp_ngan_kiem_dinh(), href: '/sales/orders?type=INSPECTION' },
          { label: m.lp_ngan_xuat_tang(), href: '/sales/orders?type=GIFT' },
          { label: m.lp_hang_mau_chua_tra(), href: '/sales/orders?loan=OUT' },
        ],
      },
    ],
  },
  {
    key: 'inventory',
    label: m.kho_giao_hang(),
    href: '/inventory',
    match: ['/inventory', '/procurement'],
    groups: [
      {
        title: m.kho_van(),
        items: [
          { label: m.ton_kho(), href: '/inventory' },
          { label: m.lap_phieu_swk_giao_hang(), href: '/inventory/shipments' },
          { label: m.nhap_kho_don_mua(), href: '/procurement' },
          { label: m.ls_lo_hang_nhap(), href: '/procurement/shipments' },
          { label: m.the_kho(), href: '/inventory/movements' },
          { label: m.inv_phieu_tra_hang(), href: '/inventory/returns' },
          { label: m.kk_title(), href: '/inventory/counts', roles: ['DIRECTOR', 'WAREHOUSE_MANAGER', 'WAREHOUSE', 'ACCOUNTANT', 'AUDITOR'] },
        ],
      },
      {
        title: m.inv_bao_cao_kho(),
        items: [
          { label: m.inv_ton_kho_thang(), href: '/inventory/reports/monthly' },
          { label: m.inv_nhat_ky(), href: '/inventory/reports/journal' },
        ],
      },
    ],
  },
  {
    key: 'pricing',
    label: m.gia_khuyen_mai(),
    href: '/pricing',
    match: ['/pricing'],
    groups: [
      {
        title: m.gia_khuyen_mai_2(),
        items: [
          { label: m.bang_gia_theo_cap(), href: '/pricing' },
          { label: m.chuong_trinh_khuyen_mai(), href: '/pricing/promotions' },
          { label: m.chiet_khau_bac_doanh_so(), href: '/pricing/tiers' },
        ],
      },
    ],
  },
  {
    key: 'receivables',
    label: m.cong_no(),
    href: '/receivables/customers',
    match: ['/receivables', '/payables'],
    groups: [
      {
        title: m.thanh_toan_cong_no(),
        items: [
          { label: m.cn_nav(), href: '/receivables/customers' },
          { label: m.so_chi_tiet_cong_no(), href: '/receivables' },
          { label: m.tuoi_no_canh_bao_qua_han(), href: '/receivables/overdue' },
          { label: m.seg_nav(), href: '/receivables/segments' },
          // Sổ phải trả nhà cung cấp (D2, 22/10/2026).
          { label: m.apb_nav(), href: '/payables', roles: ['ACCOUNTANT', 'DIRECTOR', 'AUDITOR', 'PROCUREMENT', 'PROCUREMENT_MANAGER'] },
        ],
      },
    ],
  },
  {
    key: 'warranty',
    label: m.wr_nav(),
    href: '/warranty',
    match: ['/warranty'],
    // Quản lý kho có mọi quyền bảo hành và duyệt (WAR-ROLE-01, 28/10/2026); Giám đốc chỉ xem.
    roles: ['WARRANTY', 'WAREHOUSE_MANAGER', 'DIRECTOR'],
    groups: [
      {
        title: m.wr_nav_group(),
        items: [
          { label: m.wr_nav_list(), href: '/warranty' },
          { label: m.wr_nav_new(), href: '/warranty/new', roles: ['WARRANTY', 'WAREHOUSE_MANAGER'] },
          { label: m.wr_nav_overdue(), href: '/warranty?tone=overdue' },
          { label: m.wr_nav_approval(), href: '/warranty?status=PENDING_APPROVAL', roles: ['WAREHOUSE_MANAGER'] },
          { label: m.wr_nav_reports(), href: '/warranty/reports' },
          { label: m.wr_nav_fault_codes(), href: '/warranty/fault-codes' },
        ],
      },
    ],
  },
  {
    key: 'reports',
    label: m.bao_cao(),
    href: '/reports/sales',
    match: ['/reports'],
    roles: REPORT_VIEWERS,
    groups: [
      {
        title: m.bao_cao_thong_ke(),
        items: [
          { label: m.doanh_so_theo_dai_ly_khu(), href: '/reports/sales' },
          { label: m.ton_kho_duoi_dinh_muc(), href: '/inventory?low=1' },
          { label: m.inv_ton_kho_thang(), href: '/inventory/reports/monthly' },
          { label: m.wr_report_title(), href: '/warranty/reports', roles: ['DIRECTOR'] },
          { label: m.cong_no_theo_tuoi_no(), href: '/receivables/overdue' },
        ],
      },
    ],
  },
];

export function allowed(roles: string[] | undefined, required: string[] | undefined): boolean {
  if (!required?.length) return true;
  return Boolean(roles?.some((role) => role === 'ADMIN' || required.includes(role)));
}

export function activeSection(pathname: string): NavSection {
  let best: NavSection = sections[0] as NavSection;
  let bestLength = -1;
  for (const section of sections) {
    for (const prefix of section.match) {
      const hit = prefix === '/' ? pathname === '/' : pathname === prefix || pathname.startsWith(`${prefix}/`);
      if (hit && prefix.length > bestLength) {
        best = section;
        bestLength = prefix.length;
      }
    }
  }
  return best;
}
