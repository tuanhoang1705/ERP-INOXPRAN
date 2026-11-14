import { describe, expect, it } from 'vitest';
import { effectivePermissions } from './permissions';
import { AREAS, canSeeArea, canSeePath, routeArea, type Area } from './visibility';

const userOf = (role: string) => ({ roles: [role], permissions: effectivePermissions({ roles: [role] }) });
const areasOf = (role: string) => AREAS.filter((area) => canSeeArea(userOf(role), area));

const SALES_DESK: Area[] = ['catalog.products', 'catalog.dealers', 'sales.menu', 'sales.orderDetail', 'inventory.stock', 'pricing.priceList', 'pricing.manage', 'receivables'];

describe('quyền hiển thị theo vai trò (VIS-ROLE-01)', () => {
  it('Giám đốc, Admin, KSNB thấy mọi phần nghiệp vụ', () => {
    for (const role of ['ADMIN', 'DIRECTOR', 'AUDITOR']) {
      const seen = areasOf(role);
      for (const area of AREAS.filter((item) => !['sales.changeRequests', 'sales.priceApprovals', 'approvals'].includes(item) && !(role === 'AUDITOR' && item === 'warranty'))) expect(seen, `${role} ${area}`).toContain(area);
    }
    expect(canSeeArea({ roles: ['WARRANTY'], root: true }, 'payables')).toBe(true);
  });

  it('ma trận đã duyệt 13/11/2026', () => {
    expect(areasOf('SALES_MANAGER')).toEqual(['dashboard.revenue', 'dashboard.receivables', 'dashboard.approvals', 'catalog.products', 'catalog.dealers', 'catalog.regions', 'sales.menu', 'sales.orderDetail', 'approvals', 'inventory.stock', 'inventory.reports', 'pricing.priceList', 'pricing.manage', 'receivables', 'reports']);
    expect(areasOf('SALES')).toEqual(['dashboard.receivables', ...SALES_DESK]);
    expect(areasOf('ACCOUNTANT')).toEqual([
      'dashboard.revenue', 'dashboard.receivables', 'dashboard.inventoryValue', 'catalog.products', 'catalog.dealers', 'catalog.suppliers',
      'sales.menu', 'sales.orderDetail', 'sales.changeRequests', 'sales.priceApprovals',
      'inventory.stock', 'inventory.shipments', 'inventory.purchases', 'inventory.movements', 'inventory.sampleIssues', 'inventory.returns', 'inventory.counts', 'inventory.reports',
      'pricing.priceList', 'pricing.manage', 'receivables', 'payables', 'warranty', 'reports',
    ]);
    expect(areasOf('WAREHOUSE_MANAGER')).toEqual([
      'dashboard.inventoryValue', 'catalog.products', 'catalog.suppliers', 'catalog.warehouses', 'sales.orderDetail', 'sales.changeRequests',
      'inventory.stock', 'inventory.shipments', 'inventory.transfers', 'inventory.purchases', 'inventory.movements', 'inventory.sampleIssues', 'inventory.returns', 'inventory.counts', 'inventory.reports',
      'pricing.priceList', 'warranty',
    ]);
    expect(areasOf('WAREHOUSE')).toEqual([
      'catalog.products', 'catalog.warehouses', 'sales.orderDetail', 'sales.changeRequests',
      'inventory.stock', 'inventory.shipments', 'inventory.transfers', 'inventory.purchases', 'inventory.movements', 'inventory.sampleIssues', 'inventory.returns', 'inventory.counts',
    ]);
    expect(areasOf('PROCUREMENT_MANAGER')).toEqual(['catalog.products', 'catalog.suppliers', 'approvals', 'inventory.stock', 'inventory.purchases', 'payables']);
    expect(areasOf('PROCUREMENT')).toEqual(['catalog.products', 'catalog.suppliers', 'inventory.stock', 'inventory.purchases', 'payables']);
    expect(areasOf('WARRANTY')).toEqual(['catalog.products', 'warranty']);
    expect(areasOf('CATALOG_MANAGER')).toEqual(['catalog.products', 'catalog.dealers', 'catalog.suppliers', 'catalog.warehouses', 'catalog.regions', 'pricing.priceList']);
  });

  it('quyền nghiệp vụ được phân riêng mở thêm vùng', () => {
    // Tài khoản bảo hành được Admin phân bước đối chiếu với khách → thấy phiếu BH.
    expect(canSeeArea({ roles: ['WARRANTY'], permissions: ['sales.step.confirm'] }, 'sales.menu')).toBe(true);
    expect(canSeeArea({ roles: ['WARRANTY'], permissions: ['sales.step.ship'] }, 'sales.orderDetail')).toBe(true);
    expect(canSeeArea({ roles: ['WARRANTY'], permissions: ['sales.step.ship'] }, 'sales.menu')).toBe(false);
    expect(canSeeArea(null, 'catalog.products')).toBe(false);
  });

  it('đường dẫn → vùng (khớp tiền tố dài nhất)', () => {
    expect(routeArea('/')).toBeNull();
    expect(routeArea('/account')).toBeNull();
    expect(routeArea('/sales/orders')).toBe('sales.menu');
    expect(routeArea('/sales/orders?stage=check')).toBe('sales.menu');
    expect(routeArea('/sales/orders/new')).toBe('sales.menu');
    expect(routeArea('/sales/orders/abc')).toBe('sales.orderDetail');
    expect(routeArea('/sales/orders/abc/edit')).toBe('sales.orderDetail');
    expect(routeArea('/sales/change-requests')).toBe('sales.changeRequests');
    expect(routeArea('/inventory')).toBe('inventory.stock');
    expect(routeArea('/inventory/sample-issues/x/edit')).toBe('inventory.sampleIssues');
    expect(routeArea('/inventory/reports/monthly')).toBe('inventory.reports');
    expect(routeArea('/inventory-x')).toBeNull();
    expect(routeArea('/pricing/tiers')).toBe('pricing.manage');
    expect(routeArea('/print/sales-issue/1')).toBe('sales.orderDetail');
  });

  it('chặn mở trang bằng đường dẫn', () => {
    const keeper = userOf('WAREHOUSE');
    expect(canSeePath(keeper, '/sales/orders/abc')).toBe(true);
    expect(canSeePath(keeper, '/print/sales-issue/abc')).toBe(true);
    expect(canSeePath(keeper, '/sales/orders')).toBe(false);
    expect(canSeePath(keeper, '/sales/change-requests')).toBe(true);
    expect(canSeePath(keeper, '/inventory/reports/monthly')).toBe(false);
    expect(canSeePath(keeper, '/receivables')).toBe(false);
    expect(canSeePath(keeper, '/')).toBe(true);
    // Đơn mua: người theo dõi phải trả cũng mở được (kế toán, mua hàng).
    expect(canSeePath(userOf('PROCUREMENT'), '/procurement/abc')).toBe(true);
    expect(canSeePath(userOf('WARRANTY'), '/procurement')).toBe(false);
    expect(canSeePath(userOf('SALES'), '/payables')).toBe(false);
    expect(canSeePath(userOf('SALES'), '/reports/sales')).toBe(false);
    expect(canSeePath(userOf('SALES_MANAGER'), '/reports/sales')).toBe(true);
    expect(canSeePath(null, '/')).toBe(false);
  });
});
