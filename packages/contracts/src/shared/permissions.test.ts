import { describe, expect, it } from 'vitest';
import { adminAssignable, editablePermissionKeys, effectivePermissions, isPermissionKey, isStepHolder, PERMISSION_KEYS, roleHasPermission, SALES_STEP_KEYS } from './permissions';

const special = (keys: readonly string[]) => keys.filter((key) => !key.startsWith('sales.step.'));
const steps = (keys: readonly string[]) => keys.filter((key) => key.startsWith('sales.step.'));

describe('quyền nghiệp vụ theo tài khoản (PERM-01)', () => {
  it('mặc định theo vai trò', () => {
    // Kế toán tự cấp quyền sửa đơn giá như Admin (SAL-PRICE-01, 29/10/2026).
    expect(special(effectivePermissions({ roles: ['ACCOUNTANT'] }))).toEqual(['sales.discard', 'sales.change_request', 'sales.price_override_approve']);
    expect(special(effectivePermissions({ roles: ['WAREHOUSE'] }))).toEqual(['sales.change_request']);
    expect(special(effectivePermissions({ roles: ['ADMIN'] }))).toEqual(['sales.discard', 'sales.edit_issued', 'sales.void_shipped', 'sales.change_approve', 'sales.price_override_approve']);
    expect(special(effectivePermissions({ roles: ['DIRECTOR'] }))).toEqual(['sales.price_override_approve']);
    expect(special(effectivePermissions({ roles: ['SALES'] }))).toEqual([]);
    expect(roleHasPermission(['WAREHOUSE_MANAGER'], 'sales.change_request')).toBe(true);
  });

  it('5 bước phiếu BH mặc định đúng như phân theo vai trò trước đây (SAL-STEP-01)', () => {
    expect(steps(effectivePermissions({ roles: ['ACCOUNTANT'] }))).toEqual(['sales.step.create', 'sales.step.issue', 'sales.step.confirm']);
    expect(steps(effectivePermissions({ roles: ['SALES'] }))).toEqual(['sales.step.create', 'sales.step.confirm']);
    expect(steps(effectivePermissions({ roles: ['SALES_MANAGER'] }))).toEqual(['sales.step.create', 'sales.step.confirm']);
    expect(steps(effectivePermissions({ roles: ['WAREHOUSE'] }))).toEqual(['sales.step.ship', 'sales.step.deliver']);
    expect(steps(effectivePermissions({ roles: ['ADMIN'] }))).toEqual([...SALES_STEP_KEYS]);
    expect(steps(effectivePermissions({ roles: ['DIRECTOR'] }))).toEqual([]);
  });

  it('chỉnh riêng: true cấp, false thu, không có = theo vai trò', () => {
    expect(special(effectivePermissions({ roles: ['ACCOUNTANT'], permissionOverrides: { 'sales.void_shipped': true, 'sales.change_request': false, 'sales.price_override_approve': false } }))).toEqual(['sales.discard', 'sales.void_shipped']);
    expect(effectivePermissions({ roles: ['ADMIN'], permissionOverrides: { 'sales.change_approve': false } })).not.toContain('sales.change_approve');
    expect(steps(effectivePermissions({ roles: ['SALES'], permissionOverrides: { 'sales.step.issue': true, 'sales.step.confirm': false } }))).toEqual(['sales.step.create', 'sales.step.issue']);
  });

  it('quản trị gốc luôn có mọi quyền', () => {
    expect(effectivePermissions({ roles: ['ADMIN'], root: true, permissionOverrides: { 'sales.discard': false } })).toEqual(PERMISSION_KEYS);
  });

  it('nhận biết mã quyền hợp lệ', () => {
    expect(isPermissionKey('sales.change_approve')).toBe(true);
    expect(isPermissionKey('sales.step.deliver')).toBe(true);
    expect(isPermissionKey('sales.unknown')).toBe(false);
  });
});

describe('ai phân quyền (SAL-STEP-01)', () => {
  const root = { id: 'root', roles: ['ADMIN'], root: true };
  const admin = { id: 'a1', roles: ['ADMIN'] };
  const boss = { id: 'b1', roles: ['ADMIN', 'DIRECTOR'] };
  const director = { id: 'd1', roles: ['DIRECTOR'] };
  const sales = { id: 's1', roles: ['SALES'] };

  it('chỉ 5 bước là nhóm Admin phân', () => {
    expect(SALES_STEP_KEYS.every(adminAssignable)).toBe(true);
    expect(adminAssignable('sales.void_shipped')).toBe(false);
    expect(adminAssignable('sales.unknown')).toBe(false);
  });

  it('quản trị gốc phân mọi quyền; Admin chỉ 5 bước cho tài khoản không phải Admin', () => {
    expect(editablePermissionKeys(root, sales)).toEqual(PERMISSION_KEYS);
    expect(editablePermissionKeys(root, boss)).toEqual(PERMISSION_KEYS);
    expect(editablePermissionKeys(admin, sales)).toEqual([...SALES_STEP_KEYS]);
    expect(editablePermissionKeys(admin, boss)).toEqual([]);
    expect(editablePermissionKeys(admin, admin)).toEqual([]);
    expect(editablePermissionKeys(root, root)).toEqual([]);
    expect(editablePermissionKeys(director, sales)).toEqual([]);
  });

  it('người làm bước: không tính quản trị gốc và quyền mặc định của vai trò ADMIN', () => {
    expect(isStepHolder({ roles: ['ADMIN'] }, 'sales.step.ship')).toBe(false);
    expect(isStepHolder({ roles: ['ADMIN'], root: true }, 'sales.step.ship')).toBe(false);
    expect(isStepHolder({ roles: ['ADMIN', 'WAREHOUSE'] }, 'sales.step.ship')).toBe(true);
    expect(isStepHolder({ roles: ['ADMIN'], permissionOverrides: { 'sales.step.deliver': true } }, 'sales.step.deliver')).toBe(true);
    expect(isStepHolder({ roles: ['WAREHOUSE'], permissionOverrides: { 'sales.step.ship': false } }, 'sales.step.ship')).toBe(false);
    expect(isStepHolder({ roles: ['SALES'], permissionOverrides: { 'sales.step.deliver': true } }, 'sales.step.deliver')).toBe(true);
  });
});
