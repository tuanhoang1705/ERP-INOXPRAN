import { ForbiddenException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { READ_ONLY_ALLOWED_KEY, ROLES_KEY } from './roles.decorator';
import { RolesGuard } from './roles.guard';

function check(user: Record<string, unknown> | undefined, method: string, metadata: Record<string, unknown> = {}) {
  const reflector = { getAllAndOverride: (key: string) => metadata[key] };
  const context = { getHandler: () => undefined, getClass: () => undefined, switchToHttp: () => ({ getRequest: () => ({ method, user }) }) };
  return () => new RolesGuard(reflector as never).canActivate(context as never);
}

const director = { roles: ['DIRECTOR'], permissions: [] };

describe('RolesGuard — tài khoản chỉ xem (ROLE-DIR-01)', () => {
  it('lets a director read but blocks every write that is not marked AllowReadOnly', () => {
    expect(check(director, 'GET')()).toBe(true);
    expect(check(director, 'GET', { [ROLES_KEY]: ['ADMIN', 'DIRECTOR'] })()).toBe(true);
    for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
      expect(check(director, method)).toThrow(ForbiddenException);
    }
    // Danh sách vai trò cũ còn ghi DIRECTOR cũng không mở được thao tác ghi.
    expect(check(director, 'POST', { [ROLES_KEY]: ['ADMIN', 'DIRECTOR'] })).toThrow(/chỉ xem/);
  });

  it('keeps the approvals and own-account actions marked AllowReadOnly', () => {
    expect(check(director, 'POST', { [READ_ONLY_ALLOWED_KEY]: true, [ROLES_KEY]: ['ADMIN', 'SALES_MANAGER', 'DIRECTOR'] })()).toBe(true);
    expect(check(director, 'POST', { [READ_ONLY_ALLOWED_KEY]: true })()).toBe(true);
  });

  it('does not restrict a director who also holds a working role, the root account, or public routes', () => {
    expect(check({ roles: ['DIRECTOR', 'ACCOUNTANT'], permissions: [] }, 'POST', { [ROLES_KEY]: ['ADMIN', 'ACCOUNTANT'] })()).toBe(true);
    expect(check({ roles: ['ADMIN', 'DIRECTOR'], root: true, permissions: [] }, 'DELETE')()).toBe(true);
    expect(check(undefined, 'POST')()).toBe(true);
  });
});
