import type { PermissionKey } from './permissions';
import type { UserRole } from './user-admin';

/**
 * Quyền hiển thị theo vai trò (VIS-ROLE-01, 13/11/2026): mỗi tài khoản chỉ thấy phần liên quan đến công việc của mình.
 * Một nguồn quy tắc cho cả giao diện (ẩn tab / mục menu / ô tìm chức năng, chặn mở trang bằng đường dẫn) và API
 * (chặn đọc dữ liệu nghiệp vụ — `@Area(...)` ở apps/api). Giám đốc, Admin, Kiểm soát nội bộ và quản trị gốc thấy tất cả
 * (Giám đốc / KSNB vẫn chỉ xem). Một vùng có thể mở thêm theo quyền nghiệp vụ (PERM-01) — VD tài khoản được Admin phân
 * bước phiếu BH thì thấy phiếu BH dù vai trò không có.
 * Thêm trang mới: thêm vùng (nếu cần) và một dòng ROUTE_AREAS; trang không khớp dòng nào thì mọi tài khoản mở được.
 */
export const AREAS = [
  'dashboard.revenue',
  'dashboard.receivables',
  'dashboard.inventoryValue',
  'dashboard.approvals',
  'catalog.products',
  'catalog.dealers',
  'catalog.suppliers',
  'catalog.warehouses',
  'catalog.regions',
  'sales.menu',
  'sales.orderDetail',
  'sales.changeRequests',
  'sales.priceApprovals',
  'approvals',
  'inventory.stock',
  'inventory.shipments',
  'inventory.transfers',
  'inventory.purchases',
  'inventory.movements',
  'inventory.sampleIssues',
  'inventory.returns',
  'inventory.counts',
  'inventory.reports',
  'pricing.priceList',
  'pricing.manage',
  'receivables',
  'payables',
  'warranty',
  'reports',
  'users',
] as const;
export type Area = (typeof AREAS)[number];

export interface AreaRule {
  roles: readonly UserRole[];
  /** Có một trong các quyền này cũng được thấy (dù vai trò không có). */
  permissions?: readonly PermissionKey[];
}

/** Thấy mọi phần (Giám đốc / KSNB chỉ xem). */
export const VIEW_ALL_ROLES = ['ADMIN', 'DIRECTOR', 'AUDITOR'] as const satisfies readonly UserRole[];
const all = (...roles: UserRole[]): readonly UserRole[] => [...VIEW_ALL_ROLES, ...roles];

const SALES_STAFF: UserRole[] = ['SALES_MANAGER', 'SALES'];
const WAREHOUSE_STAFF: UserRole[] = ['WAREHOUSE_MANAGER', 'WAREHOUSE'];
const PROCUREMENT_STAFF: UserRole[] = ['PROCUREMENT_MANAGER', 'PROCUREMENT'];
/** Bước 1–3, 5 của phiếu BH: người được phân công thấy tab Đơn hàng. */
const SALES_FLOW_STEPS: PermissionKey[] = ['sales.step.create', 'sales.step.issue', 'sales.step.confirm'];

/** Ma trận vai trò → phần được thấy (đã duyệt 13/11/2026). */
export const AREA_RULES: Record<Area, AreaRule> = {
  // Tổng quan: thẻ số liệu theo vùng.
  'dashboard.revenue': { roles: all('SALES_MANAGER', 'ACCOUNTANT') },
  'dashboard.receivables': { roles: all(...SALES_STAFF, 'ACCOUNTANT') },
  'dashboard.inventoryValue': { roles: all('WAREHOUSE_MANAGER', 'ACCOUNTANT') },
  // Ô "Đơn hàng chờ duyệt" và cảnh báo chờ duyệt: người duyệt phiếu BH ngoại lệ.
  'dashboard.approvals': { roles: all('SALES_MANAGER') },
  // Danh mục.
  'catalog.products': { roles: all(...SALES_STAFF, 'ACCOUNTANT', ...WAREHOUSE_STAFF, ...PROCUREMENT_STAFF, 'WARRANTY', 'CATALOG_MANAGER') },
  'catalog.dealers': { roles: all(...SALES_STAFF, 'ACCOUNTANT', 'CATALOG_MANAGER') },
  'catalog.suppliers': { roles: all('ACCOUNTANT', 'WAREHOUSE_MANAGER', ...PROCUREMENT_STAFF, 'CATALOG_MANAGER') },
  'catalog.warehouses': { roles: all(...WAREHOUSE_STAFF, 'CATALOG_MANAGER') },
  'catalog.regions': { roles: all('SALES_MANAGER', 'CATALOG_MANAGER') },
  // Đơn hàng: tab + danh sách; chi tiết / bản in phiếu BH thêm kho (phiếu được giao).
  'sales.menu': { roles: all(...SALES_STAFF, 'ACCOUNTANT'), permissions: SALES_FLOW_STEPS },
  'sales.orderDetail': { roles: all(...SALES_STAFF, 'ACCOUNTANT', ...WAREHOUSE_STAFF), permissions: [...SALES_FLOW_STEPS, 'sales.step.ship', 'sales.step.deliver'] },
  // Đề nghị sửa / hủy phiếu và duyệt sửa đơn giá: theo quyền nghiệp vụ như trước (kho gửi đề nghị dù không có tab Đơn hàng).
  'sales.changeRequests': { roles: [], permissions: ['sales.change_request', 'sales.change_approve'] },
  'sales.priceApprovals': { roles: [], permissions: ['sales.price_override_approve'] },
  'approvals': { roles: ['ADMIN', 'DIRECTOR', 'SALES_MANAGER', 'PROCUREMENT_MANAGER'] },
  // Kho & Giao hàng.
  'inventory.stock': { roles: all(...SALES_STAFF, 'ACCOUNTANT', ...WAREHOUSE_STAFF, ...PROCUREMENT_STAFF) },
  'inventory.shipments': { roles: all('ACCOUNTANT', ...WAREHOUSE_STAFF), permissions: ['sales.step.ship', 'sales.step.deliver'] },
  'inventory.transfers': { roles: all(...WAREHOUSE_STAFF) },
  'inventory.purchases': { roles: all('ACCOUNTANT', ...WAREHOUSE_STAFF, ...PROCUREMENT_STAFF) },
  'inventory.movements': { roles: all('ACCOUNTANT', ...WAREHOUSE_STAFF) },
  'inventory.sampleIssues': { roles: all('ACCOUNTANT', ...WAREHOUSE_STAFF) },
  'inventory.returns': { roles: all('ACCOUNTANT', ...WAREHOUSE_STAFF) },
  'inventory.counts': { roles: all('ACCOUNTANT', ...WAREHOUSE_STAFF) },
  'inventory.reports': { roles: all('SALES_MANAGER', 'ACCOUNTANT', 'WAREHOUSE_MANAGER') },
  // Giá & khuyến mãi.
  'pricing.priceList': { roles: all(...SALES_STAFF, 'ACCOUNTANT', 'WAREHOUSE_MANAGER', 'CATALOG_MANAGER') },
  'pricing.manage': { roles: all(...SALES_STAFF, 'ACCOUNTANT') },
  // Công nợ.
  'receivables': { roles: all(...SALES_STAFF, 'ACCOUNTANT') },
  'payables': { roles: all('ACCOUNTANT', ...PROCUREMENT_STAFF) },
  // Bảo hành: như API (WARRANTY_VIEWER_ROLES) — Kiểm soát nội bộ chưa xem phiếu bảo hành.
  'warranty': { roles: ['ADMIN', 'DIRECTOR', 'WARRANTY', 'WAREHOUSE_MANAGER', 'ACCOUNTANT'] },
  'reports': { roles: all('SALES_MANAGER', 'ACCOUNTANT') },
  'users': { roles: [...VIEW_ALL_ROLES] },
};

/** Vai trò của vùng (cho `@Roles` ở API); quyền đi kèm xem AREA_RULES. */
export const AREA_ROLES = Object.fromEntries(AREAS.map((area) => [area, AREA_RULES[area].roles])) as Record<Area, readonly UserRole[]>;

export interface VisibilityUser {
  roles: readonly string[];
  root?: boolean | undefined;
  /** Quyền nghiệp vụ hiệu lực (PERM-01). */
  permissions?: readonly string[] | undefined;
}

export function canSeeArea(user: VisibilityUser | null | undefined, area: Area): boolean {
  if (!user) return false;
  if (user.root) return true;
  const rule = AREA_RULES[area];
  return user.roles.some((role) => (rule.roles as readonly string[]).includes(role)) || Boolean(rule.permissions?.some((key) => user.permissions?.includes(key)));
}

/** Gộp nhiều vùng (thấy một trong các vùng là được) — cho endpoint dùng chung, VD đơn mua: nhập kho ∪ phải trả. */
export function areaRolesOf(...areas: Area[]): UserRole[] {
  return [...new Set(areas.flatMap((area) => AREA_RULES[area].roles))];
}
export function areaPermissionsOf(...areas: Area[]): PermissionKey[] {
  return [...new Set(areas.flatMap((area) => AREA_RULES[area].permissions ?? []))];
}

/**
 * Tiền tố đường dẫn web → vùng; khớp tiền tố dài nhất (`/x` khớp `/x` và `/x/...`; tiền tố kết thúc bằng `/` chỉ khớp trang con).
 * Trang không có vùng (Tổng quan, Tài khoản của tôi, trang quản trị gốc) mở cho mọi tài khoản như trước.
 */
export const ROUTE_AREAS: ReadonlyArray<readonly [string, Area]> = [
  ['/catalog/products', 'catalog.products'],
  ['/catalog/dealers', 'catalog.dealers'],
  ['/catalog/suppliers', 'catalog.suppliers'],
  ['/catalog/warehouses', 'catalog.warehouses'],
  ['/catalog/regions', 'catalog.regions'],
  ['/sales', 'sales.menu'],
  ['/sales/orders/', 'sales.orderDetail'],
  ['/sales/orders/new', 'sales.menu'],
  ['/sales/change-requests', 'sales.changeRequests'],
  ['/sales/price-approvals', 'sales.priceApprovals'],
  ['/approvals', 'approvals'],
  ['/inventory', 'inventory.stock'],
  ['/inventory/shipments', 'inventory.shipments'],
  ['/inventory/transfers', 'inventory.transfers'],
  ['/inventory/movements', 'inventory.movements'],
  ['/inventory/sample-issues', 'inventory.sampleIssues'],
  ['/inventory/returns', 'inventory.returns'],
  ['/inventory/counts', 'inventory.counts'],
  ['/inventory/reports', 'inventory.reports'],
  ['/procurement', 'inventory.purchases'],
  ['/pricing', 'pricing.priceList'],
  ['/pricing/promotions', 'pricing.manage'],
  ['/pricing/tiers', 'pricing.manage'],
  ['/receivables', 'receivables'],
  ['/payables', 'payables'],
  ['/warranty', 'warranty'],
  ['/reports', 'reports'],
  ['/admin/users', 'users'],
  // Bản in (ngoài khung ứng dụng).
  ['/print/sales-issue', 'sales.orderDetail'],
  ['/print/stock-return', 'inventory.returns'],
  ['/print/warranty', 'warranty'],
  ['/print/purchase-contract', 'inventory.purchases'],
  ['/print/packing-list', 'inventory.purchases'],
];

/** Đơn mua / hợp đồng / lô hàng nhập: người nhập kho và người theo dõi phải trả NCC đều mở được. */
const ROUTE_EXTRA: Partial<Record<string, Area[]>> = {
  '/procurement': ['payables'],
  '/print/purchase-contract': ['payables'],
  '/print/packing-list': ['payables'],
};

function routeMatch(pathname: string, prefix: string): boolean {
  return prefix.endsWith('/') ? pathname.startsWith(prefix) && pathname.length > prefix.length : pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/** Tiền tố khớp dài nhất của đường dẫn (không tính ?query); không khớp → null. */
export function routeRule(pathname: string): { prefix: string; areas: Area[] } | null {
  const path = pathname.split('?')[0] ?? '';
  let best: readonly [string, Area] | undefined;
  for (const entry of ROUTE_AREAS) {
    if (routeMatch(path, entry[0]) && (!best || entry[0].length > best[0].length)) best = entry;
  }
  return best ? { prefix: best[0], areas: [best[1], ...(ROUTE_EXTRA[best[0]] ?? [])] } : null;
}

/** Vùng của đường dẫn (vùng chính). */
export function routeArea(pathname: string): Area | null {
  return routeRule(pathname)?.areas[0] ?? null;
}

/** Tài khoản được mở đường dẫn này (trang web / bản in) không. */
export function canSeePath(user: VisibilityUser | null | undefined, pathname: string): boolean {
  const rule = routeRule(pathname);
  if (!rule) return Boolean(user);
  return rule.areas.some((area) => canSeeArea(user, area));
}
