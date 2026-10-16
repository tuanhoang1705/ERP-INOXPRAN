import { describe, expect, it } from 'vitest';
import { effectivePermissions, isPermissionKey, PERMISSION_KEYS, roleHasPermission } from './permissions';

describe('quyền nghiệp vụ theo tài khoản (PERM-01)', () => {
  it('mặc định theo vai trò', () => {
    expect(effectivePermissions({ roles: ['ACCOUNTANT'] })).toEqual(['sales.discard', 'sales.change_request']);
    expect(effectivePermissions({ roles: ['WAREHOUSE'] })).toEqual(['sales.change_request']);
    expect(effectivePermissions({ roles: ['ADMIN'] })).toEqual(['sales.discard', 'sales.edit_issued', 'sales.void_shipped', 'sales.change_approve', 'sales.price_override_approve']);
    expect(effectivePermissions({ roles: ['DIRECTOR'] })).toEqual(['sales.price_override_approve']);
    expect(effectivePermissions({ roles: ['SALES'] })).toEqual([]);
    expect(roleHasPermission(['WAREHOUSE_MANAGER'], 'sales.change_request')).toBe(true);
  });

  it('chỉnh riêng: true cấp, false thu, không có = theo vai trò', () => {
    expect(effectivePermissions({ roles: ['ACCOUNTANT'], permissionOverrides: { 'sales.void_shipped': true, 'sales.change_request': false } })).toEqual(['sales.discard', 'sales.void_shipped']);
    expect(effectivePermissions({ roles: ['ADMIN'], permissionOverrides: { 'sales.change_approve': false } })).not.toContain('sales.change_approve');
  });

  it('quản trị gốc luôn có mọi quyền', () => {
    expect(effectivePermissions({ roles: ['ADMIN'], root: true, permissionOverrides: { 'sales.discard': false } })).toEqual(PERMISSION_KEYS);
  });

  it('nhận biết mã quyền hợp lệ', () => {
    expect(isPermissionKey('sales.change_approve')).toBe(true);
    expect(isPermissionKey('sales.unknown')).toBe(false);
  });
});
