import { describe, expect, it } from 'vitest';
import { canAssignRoles, canManageUser, isReadOnlyUser, passwordProblem, pendingSetup, requiresMfa } from './user-admin';

const root = { id: 'r', roles: ['ADMIN', 'DIRECTOR'], root: true };
const admin = { id: 'a', roles: ['ADMIN'] };
const accountant = { id: 'k', roles: ['ACCOUNTANT'] };

describe('canManageUser', () => {
  it('lets an admin manage ordinary users but not other admins or the root account', () => {
    expect(canManageUser(admin, accountant)).toBe(true);
    expect(canManageUser(admin, { id: 'b', roles: ['ADMIN'] })).toBe(false);
    expect(canManageUser(admin, root)).toBe(false);
  });

  it('lets only the root account manage admins, and nobody manages root through the UI', () => {
    expect(canManageUser(root, admin)).toBe(true);
    expect(canManageUser(root, root)).toBe(false);
    expect(canManageUser(accountant, { id: 's', roles: ['SALES'] })).toBe(false);
  });
});

describe('isReadOnlyUser', () => {
  it('treats a director-only account as view-only, but not when it also holds a working role or is root', () => {
    expect(isReadOnlyUser({ roles: ['DIRECTOR'] })).toBe(true);
    expect(isReadOnlyUser({ roles: ['DIRECTOR', 'ACCOUNTANT'] })).toBe(false);
    expect(isReadOnlyUser(root)).toBe(false);
    expect(isReadOnlyUser({ roles: [] })).toBe(false);
    expect(isReadOnlyUser(accountant)).toBe(false);
    expect(isReadOnlyUser(undefined)).toBe(false);
  });
});

describe('canAssignRoles', () => {
  it('reserves the ADMIN role for the root account to grant', () => {
    expect(canAssignRoles(admin, ['SALES', 'SALES_MANAGER'])).toBe(true);
    expect(canAssignRoles(admin, ['ADMIN'])).toBe(false);
    expect(canAssignRoles(root, ['ADMIN'])).toBe(true);
  });
});

describe('pendingSetup', () => {
  it('asks for a new password after a temporary one and MFA for privileged roles when enforced', () => {
    expect(pendingSetup({ roles: ['ACCOUNTANT'], mfaEnabled: false, mustChangePassword: true }, true)).toEqual(['PASSWORD', 'MFA']);
    expect(pendingSetup({ roles: ['SALES'], mfaEnabled: false }, true)).toEqual([]);
    expect(pendingSetup({ roles: ['DIRECTOR'], mfaEnabled: false }, false)).toEqual([]);
  });

  it('always requires MFA for the root account', () => {
    expect(requiresMfa({ roles: ['ADMIN'], root: true }, false)).toBe(true);
    expect(pendingSetup({ roles: ['ADMIN'], root: true, mfaEnabled: true }, false)).toEqual([]);
  });
});

describe('passwordProblem', () => {
  it('requires 12+ characters with letters and digits', () => {
    expect(passwordProblem('ngan123')).toBe('TOO_SHORT');
    expect(passwordProblem('chicochuthoima')).toBe('NEEDS_LETTER_AND_DIGIT');
    expect(passwordProblem('Inoxpran-2026-kho')).toBeNull();
  });
});

describe('requiresMfa — Admin đặt riêng (MFA-02)', () => {
  it('chưa đặt riêng: theo vai trò như trước', () => {
    expect(requiresMfa({ roles: ['ACCOUNTANT'] }, true)).toBe(true);
    expect(requiresMfa({ roles: ['SALES'] }, true)).toBe(false);
    expect(requiresMfa({ roles: ['ACCOUNTANT'] }, false)).toBe(false);
  });
  it('Admin tắt yêu cầu cho kế toán → không bắt buộc kể cả khi môi trường bắt buộc theo vai trò', () => {
    expect(requiresMfa({ roles: ['ACCOUNTANT'], mfaRequired: false }, true)).toBe(false);
    expect(pendingSetup({ roles: ['ACCOUNTANT'], mfaEnabled: false, mfaRequired: false }, true)).toEqual([]);
  });
  it('Admin bật yêu cầu cho NVKD → phải thiết lập 2 lớp', () => {
    expect(requiresMfa({ roles: ['SALES'], mfaRequired: true }, false)).toBe(true);
    expect(pendingSetup({ roles: ['SALES'], mfaEnabled: false, mfaRequired: true }, false)).toEqual(['MFA']);
    expect(pendingSetup({ roles: ['SALES'], mfaEnabled: true, mfaRequired: true }, false)).toEqual([]);
  });
  it('tài khoản gốc luôn bắt buộc, kể cả khi có cờ false', () => {
    expect(requiresMfa({ roles: ['ADMIN'], root: true, mfaRequired: false }, false)).toBe(true);
  });
});
