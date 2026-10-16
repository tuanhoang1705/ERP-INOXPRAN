import { CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { effectivePermissions, pendingSetup } from '@inoxpran/contracts';
import type { FastifyRequest } from 'fastify';
import { type Db, ObjectId } from 'mongodb';
import { ALLOW_PENDING_KEY } from './allow-pending.decorator';
import { IS_PUBLIC_KEY } from './public.decorator';
import type { RequestUser } from './request-context';
import { type CachedAccount, sessionCache } from './session-cache';
import { overridesOf } from './permissions';
import { MONGO_DATABASE } from './tokens';

/** Cập nhật "lần hoạt động gần nhất" tối đa 5 phút một lần (màn giám sát: số người đang dùng). */
const SEEN_INTERVAL_MS = 5 * 60_000;

interface TokenPayload {
  sub: string;
  tv?: number;
}

/**
 * Xác thực phiên: cookie JWT hợp lệ + tài khoản còn hoạt động + phiên chưa bị thu hồi (tokenVersion).
 * Vai trò, phạm vi kho lấy từ DB (không lấy từ token) nên đổi quyền có hiệu lực ngay.
 * Tài khoản còn bước bắt buộc (đổi mật khẩu tạm / bật MFA) chỉ gọi được endpoint gắn @AllowPending.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    @Inject(MONGO_DATABASE) private readonly db: Db,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) return true;
    const request = context.switchToHttp().getRequest<FastifyRequest & { user?: RequestUser }>();
    const token = request.cookies?.erp_session;
    if (!token) throw new UnauthorizedException({ code: 'AUTH_REQUIRED', message: 'Vui lòng đăng nhập' });
    let payload: TokenPayload;
    try {
      payload = await this.jwt.verifyAsync<TokenPayload>(token);
    } catch {
      throw new UnauthorizedException({ code: 'SESSION_INVALID', message: 'Phiên đăng nhập đã hết hạn' });
    }
    const account = await this.account(payload.sub);
    if (!account || account.status !== 'ACTIVE' || account.tokenVersion !== (payload.tv ?? 0)) {
      throw new UnauthorizedException({ code: 'SESSION_REVOKED', message: 'Phiên đăng nhập đã bị thu hồi, vui lòng đăng nhập lại' });
    }
    const pending = pendingSetup(account, this.config.get<boolean>('MFA_ENFORCE_PRIVILEGED') ?? false);
    request.user = {
      sub: account.id,
      email: account.email,
      displayName: account.displayName,
      roles: account.roles,
      warehouseScopes: account.warehouseScopes,
      mfa: account.mfaEnabled,
      root: account.root,
      pending,
      permissions: effectivePermissions({ roles: account.roles, root: account.root, permissionOverrides: account.permissionOverrides ?? null }),
    };
    if (pending.length && !this.reflector.getAllAndOverride<boolean>(ALLOW_PENDING_KEY, targets)) {
      throw new ForbiddenException({
        code: 'SETUP_REQUIRED',
        message: pending.includes('PASSWORD') ? 'Vui lòng đổi mật khẩu tạm trước khi sử dụng hệ thống' : 'Vui lòng bật xác thực 2 lớp trước khi sử dụng hệ thống',
        details: { pending },
      });
    }
    return true;
  }

  private async account(userId: string): Promise<CachedAccount | null> {
    const cached = sessionCache.get(userId);
    if (cached !== undefined) return cached;
    if (!ObjectId.isValid(userId)) return null;
    const user = await this.db.collection('users').findOne(
      { _id: new ObjectId(userId) },
      { projection: { email: 1, displayName: 1, roles: 1, warehouseScopes: 1, status: 1, tokenVersion: 1, root: 1, mfaEnabled: 1, mustChangePassword: 1, lastSeenAt: 1, permissionGrants: 1, permissionRevokes: 1 } },
    );
    const account: CachedAccount | null = user
      ? {
          id: userId,
          email: String(user.email),
          displayName: String(user.displayName),
          roles: (user.roles as string[] | undefined) ?? [],
          warehouseScopes: (user.warehouseScopes as string[] | undefined) ?? [],
          status: String(user.status),
          tokenVersion: Number(user.tokenVersion ?? 0),
          root: Boolean(user.root),
          mfaEnabled: Boolean(user.mfaEnabled),
          mustChangePassword: Boolean(user.mustChangePassword),
          lastSeenAt: user.lastSeenAt as Date | undefined,
          permissionOverrides: overridesOf(user),
        }
      : null;
    sessionCache.set(userId, account);
    if (account && (!account.lastSeenAt || Date.now() - account.lastSeenAt.getTime() > SEEN_INTERVAL_MS)) {
      account.lastSeenAt = new Date();
      void this.db.collection('users').updateOne({ _id: new ObjectId(userId) }, { $set: { lastSeenAt: account.lastSeenAt } }).catch(() => undefined);
    }
    return account;
  }
}
