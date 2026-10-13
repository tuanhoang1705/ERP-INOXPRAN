import { m } from '$lib/paraglide/messages';
export interface NavItem {
  label: string;
  href: string;
  /** Chỉ hiện với các vai trò này (ADMIN luôn thấy). Bỏ trống = mọi người dùng. */
  roles?: string[];
  /** Chỉ tài khoản quản trị gốc (root) thấy — phần kỹ thuật / cấu hình hệ thống. */
  rootOnly?: boolean;
  badge?: 'approvals';
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
          { label: m.cho_doi_chieu_voi_khach(), href: '/sales/orders?stage=check', roles: ['SALES', 'SALES_MANAGER', 'ACCOUNTANT'] },
          { label: m.duyet_ngoai_le(), href: '/approvals', roles: APPROVERS, badge: 'approvals' },
          { label: m.gia_duyet_tieu_de(), href: '/sales/price-approvals', roles: ['DIRECTOR'] },
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
          { label: m.lap_phieu_xuat_kho_bh(), href: '/sales/orders/new', roles: ['ACCOUNTANT', 'SALES', 'SALES_MANAGER'] },
          { label: m.tat_ca_phieu(), href: '/sales/orders' },
          { label: m.cho_ke_toan_phat_hanh_sua(), href: '/sales/orders?stage=draft', roles: ['ACCOUNTANT', 'SALES', 'SALES_MANAGER'] },
          { label: m.cho_doi_chieu_voi_khach(), href: '/sales/orders?stage=check', roles: ['SALES', 'SALES_MANAGER', 'ACCOUNTANT'] },
          { label: m.cho_kho_lap_phieu_swk(), href: '/sales/orders?stage=warehouse' },
          { label: m.duyet_ngoai_le(), href: '/approvals', roles: APPROVERS, badge: 'approvals' },
          { label: m.gia_duyet_tieu_de(), href: '/sales/price-approvals', roles: ['DIRECTOR'] },
        ],
      },
      {
        title: m.theo_kenh(),
        items: [
          { label: m.dai_ly_npp_b2b(), href: '/sales/orders?channel=B2B' },
          { label: m.khach_le_b2c(), href: '/sales/orders?channel=B2C' },
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
    href: '/receivables',
    match: ['/receivables'],
    groups: [
      {
        title: m.thanh_toan_cong_no(),
        items: [
          { label: m.so_chi_tiet_cong_no(), href: '/receivables' },
          { label: m.tuoi_no_canh_bao_qua_han(), href: '/receivables/overdue' },
        ],
      },
    ],
  },
  {
    key: 'warranty',
    label: m.wr_nav(),
    href: '/warranty',
    match: ['/warranty'],
    roles: ['WARRANTY', 'DIRECTOR'],
    groups: [
      {
        title: m.wr_nav_group(),
        items: [
          { label: m.wr_nav_list(), href: '/warranty' },
          { label: m.wr_nav_new(), href: '/warranty/new', roles: ['WARRANTY'] },
          { label: m.wr_nav_overdue(), href: '/warranty?tone=overdue' },
          { label: m.wr_nav_approval(), href: '/warranty?status=PENDING_APPROVAL', roles: ['DIRECTOR'] },
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
