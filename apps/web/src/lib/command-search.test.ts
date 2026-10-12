import { describe, expect, it } from 'vitest';
import type { NavSection } from '$lib/nav';
import { buildCommands, searchCommands, visibleCommands, type CommandItem } from './command-search';

const sections: NavSection[] = [
  {
    key: 'inventory', label: 'Kho & Giao hàng', href: '/inventory', match: ['/inventory'],
    groups: [{ title: 'Kho vận', items: [
      { label: 'Tồn kho', href: '/inventory' },
      { label: 'Thẻ kho', href: '/inventory/movements' },
      { label: 'Kiểm kê kho', href: '/inventory/counts', roles: ['WAREHOUSE', 'WAREHOUSE_MANAGER', 'DIRECTOR'] },
    ] }],
  },
  {
    key: 'overview', label: 'Tổng quan', href: '/', match: ['/'],
    groups: [{ title: 'Quản trị', items: [
      { label: 'Tồn kho', href: '/inventory' },
      { label: 'Nhật ký hệ thống', href: '/admin/audit', rootOnly: true },
    ] }],
  },
  { key: 'warranty', label: 'Bảo hành', href: '/warranty', match: ['/warranty'], roles: ['WARRANTY', 'DIRECTOR'], groups: [{ title: 'Bảo hành', items: [{ label: 'Danh sách phiếu', href: '/warranty' }] }] },
];
const extra: CommandItem[] = [{ label: 'Lập phiếu BH', href: '/sales/orders/new', path: 'Thao tác nhanh', keywords: 'bh lap phieu de nghi xuat ban', roleGates: [['ACCOUNTANT', 'SALES']] }];
const all = buildCommands(sections, extra);

describe('ô tìm chức năng', () => {
  it('lọc theo vai trò giống menu: NVKD không thấy kiểm kê / bảo hành, thấy Lập phiếu BH', () => {
    const hrefs = visibleCommands(all, { roles: ['SALES'] }).map((item) => item.href);
    expect(hrefs).toEqual(['/inventory', '/inventory/movements', '/sales/orders/new']);
  });
  it('mục chỉ dành cho quản trị gốc; ADMIN qua mọi vai trò nhưng không thấy mục root', () => {
    expect(visibleCommands(all, { roles: ['ADMIN'] }).map((item) => item.href)).not.toContain('/admin/audit');
    expect(visibleCommands(all, { roles: ['ADMIN'], root: true }).map((item) => item.href)).toContain('/admin/audit');
    expect(visibleCommands(all, { roles: ['ADMIN'] }).map((item) => item.href)).toContain('/warranty');
  });
  it('bỏ trùng đường dẫn, giữ mục đầu (kèm đường dẫn phân hệ)', () => {
    const inventory = visibleCommands(all, { roles: ['DIRECTOR'] }).filter((item) => item.href === '/inventory');
    expect(inventory).toHaveLength(1);
    expect(inventory[0]?.path).toBe('Kho & Giao hàng › Kho vận');
  });
  it('gõ không dấu vẫn ra, xếp mục khớp tên trước mục chỉ khớp từ khóa', () => {
    const visible = visibleCommands(all, { roles: ['DIRECTOR', 'ACCOUNTANT'] });
    expect(searchCommands(visible, 'kiem ke')[0]?.href).toBe('/inventory/counts');
    expect(searchCommands(visible, 'THE KHO')[0]?.href).toBe('/inventory/movements');
    expect(searchCommands(visible, 'bh')[0]?.href).toBe('/sales/orders/new');
    expect(searchCommands(visible, 'ton')[0]?.href).toBe('/inventory');
    expect(searchCommands(visible, 'khong co gi')).toEqual([]);
  });
});
