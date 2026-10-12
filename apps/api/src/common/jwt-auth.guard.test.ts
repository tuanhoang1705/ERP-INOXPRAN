import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { ObjectId } from 'mongodb';
import { beforeEach, describe, expect, it } from 'vitest';
import { ALLOW_PENDING_KEY } from './allow-pending.decorator';
import { JwtAuthGuard } from './jwt-auth.guard';
import { sessionCache } from './session-cache';
import { temporaryPassword } from '../modules/admin/users.service';

const userId = new ObjectId();
let stored: Record<string, unknown>;

function guardWith(options: { allowPending?: boolean; enforceMfa?: boolean; tv?: number } = {}) {
  const reflector = { getAllAndOverride: (key: string) => (key === ALLOW_PENDING_KEY ? Boolean(options.allowPending) : false) };
  const jwt = { verifyAsync: async () => ({ sub: userId.toHexString(), tv: options.tv ?? 0 }) };
  const config = { get: (key: string) => (key === 'MFA_ENFORCE_PRIVILEGED' ? Boolean(options.enforceMfa) : undefined) };
  const db = { collection: () => ({ findOne: async () => stored, updateOne: async () => ({}) }) };
  return new JwtAuthGuard(reflector as never, jwt as never, config as never, db as never);
}
function contextFor(request: Record<string, unknown>) {
  return { getHandler: () => undefined, getClass: () => undefined, switchToHttp: () => ({ getRequest: () => request }) } as never;
}

beforeEach(() => {
  sessionCache.clear();
  stored = { _id: userId, email: 'kho@inoxpran.vn', displayName: 'Kho', roles: ['WAREHOUSE'], warehouseScopes: ['w1', 'w2'], status: 'ACTIVE', tokenVersion: 0, mfaEnabled: false, lastSeenAt: new Date() };
});

describe('JwtAuthGuard', () => {
  it('takes roles and warehouse scopes from the database, not from the token', async () => {
    const request: Record<string, unknown> = { cookies: { erp_session: 'token' } };
    await expect(guardWith().canActivate(contextFor(request))).resolves.toBe(true);
    expect(request.user).toMatchObject({ roles: ['WAREHOUSE'], warehouseScopes: ['w1', 'w2'], pending: [] });
  });

  it('rejects a session after the account is disabled or its sessions are revoked', async () => {
    stored.status = 'DISABLED';
    await expect(guardWith().canActivate(contextFor({ cookies: { erp_session: 'token' } }))).rejects.toBeInstanceOf(UnauthorizedException);
    sessionCache.clear();
    stored.status = 'ACTIVE';
    stored.tokenVersion = 3;
    await expect(guardWith({ tv: 2 }).canActivate(contextFor({ cookies: { erp_session: 'token' } }))).rejects.toThrow(/thu hồi/);
  });

  it('limits accounts with a temporary password or missing MFA to the setup endpoints', async () => {
    stored.mustChangePassword = true;
    await expect(guardWith().canActivate(contextFor({ cookies: { erp_session: 'token' } }))).rejects.toBeInstanceOf(ForbiddenException);
    await expect(guardWith({ allowPending: true }).canActivate(contextFor({ cookies: { erp_session: 'token' } }))).resolves.toBe(true);
    sessionCache.clear();
    stored.mustChangePassword = false;
    stored.roles = ['ACCOUNTANT'];
    const request: Record<string, unknown> = { cookies: { erp_session: 'token' } };
    await expect(guardWith({ enforceMfa: true }).canActivate(contextFor(request))).rejects.toThrow(/xác thực 2 lớp/);
  });
});

describe('temporaryPassword', () => {
  it('is long enough for the login form and avoids look-alike characters', () => {
    const password = temporaryPassword();
    expect(password).toMatch(/^Tmp-[A-HJ-NP-Za-km-z2-9]{4}-[A-HJ-NP-Za-km-z2-9]{4}-[A-HJ-NP-Za-km-z2-9]{4}$/);
    expect(password.length).toBeGreaterThanOrEqual(10);
  });
});
