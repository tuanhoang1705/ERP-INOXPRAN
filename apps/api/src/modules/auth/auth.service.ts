import { BadRequestException, Inject, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { type AuthUser, type ChangePassword, type LoginEvent, type LoginInput, passwordProblem, pendingSetup } from '@inoxpran/contracts';
import { authenticator } from 'otplib';
import { type Db, ObjectId } from 'mongodb';
import { AuditService } from '../../common/audit.service';
import type { RequestUser } from '../../common/request-context';
import { sessionCache } from '../../common/session-cache';
import { MONGO_DATABASE } from '../../common/tokens';
import { decryptSecret, encryptSecret } from './secret';
import { hashPassword, verifyPassword } from './password';

// Chấp nhận lệch tối đa một chu kỳ (30 giây) để bù sai số đồng hồ thiết bị.
authenticator.options = { window: 1 };

export const LOGIN_EVENTS = 'login_events';

interface UserDocument {
  _id: ObjectId;
  email: string;
  displayName: string;
  passwordHash: string;
  roles: string[];
  warehouseScopes: string[];
  status: 'ACTIVE' | 'DISABLED';
  root?: boolean;
  mfaEnabled: boolean;
  mfaSecret?: string;
  pendingMfaSecret?: string;
  mustChangePassword?: boolean;
  tokenVersion?: number;
  failedLoginCount?: number;
  lockedUntil?: Date;
}

/** Thông tin máy khách ghi vào lịch sử đăng nhập. */
export interface ClientInfo {
  ip?: string | undefined;
  userAgent?: string | undefined;
}

@Injectable()
export class AuthService {
  constructor(
    @Inject(MONGO_DATABASE) private readonly db: Db,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
  ) {}

  private encryptionKey(): string {
    return this.config.get<string>('MFA_ENCRYPTION_KEY') ?? this.config.getOrThrow<string>('JWT_SECRET');
  }

  private enforceMfa(): boolean {
    return this.config.get<boolean>('MFA_ENFORCE_PRIVILEGED') ?? false;
  }

  private users() {
    return this.db.collection<UserDocument>('users');
  }

  private async recordLogin(email: string, success: boolean, reason: string, client: ClientInfo, user?: UserDocument | null) {
    await this.db.collection(LOGIN_EVENTS).insertOne({
      _id: new ObjectId(),
      at: new Date(),
      email,
      ...(user ? { userId: user._id, displayName: user.displayName } : {}),
      success,
      reason,
      ...(client.ip ? { ip: client.ip } : {}),
      ...(client.userAgent ? { userAgent: client.userAgent.slice(0, 300) } : {}),
    }).catch(() => undefined);
  }

  private authUser(user: UserDocument): AuthUser {
    const pending = pendingSetup(user, this.enforceMfa());
    return {
      id: user._id.toHexString(),
      email: user.email,
      displayName: user.displayName,
      roles: user.roles,
      warehouseScopes: user.warehouseScopes,
      mfaEnabled: user.mfaEnabled,
      ...(user.root ? { root: true } : {}),
      ...(pending.length ? { pending } : {}),
    };
  }

  async login(input: LoginInput, client: ClientInfo = {}): Promise<{ user: AuthUser; token: string }> {
    const collection = this.users();
    const user = await collection.findOne({ email: input.email });
    const now = new Date();
    if (!user || user.status !== 'ACTIVE' || (user.lockedUntil && user.lockedUntil > now)) {
      await this.recordLogin(input.email, false, !user ? 'UNKNOWN_EMAIL' : user.status !== 'ACTIVE' ? 'DISABLED' : 'LOCKED', client, user);
      throw new UnauthorizedException({ code: 'INVALID_CREDENTIALS', message: 'Email hoặc mật khẩu không đúng' });
    }

    const valid = await verifyPassword(input.password, user.passwordHash);
    if (!valid) {
      const failures = (user.failedLoginCount ?? 0) + 1;
      await collection.updateOne(
        { _id: user._id },
        {
          $set: {
            failedLoginCount: failures,
            ...(failures >= 5 ? { lockedUntil: new Date(Date.now() + 15 * 60_000) } : {}),
          },
        },
      );
      await this.recordLogin(input.email, false, failures >= 5 ? 'BAD_PASSWORD_LOCKED' : 'BAD_PASSWORD', client, user);
      throw new UnauthorizedException({ code: 'INVALID_CREDENTIALS', message: 'Email hoặc mật khẩu không đúng' });
    }

    if (user.mfaEnabled) {
      if (!input.totpCode) {
        throw new UnauthorizedException({ code: 'MFA_REQUIRED', message: 'Vui lòng nhập mã xác thực 6 số' });
      }
      const secret = decryptSecret(user.mfaSecret ?? '', this.encryptionKey());
      if (!authenticator.check(input.totpCode, secret)) {
        await this.recordLogin(input.email, false, 'MFA_INVALID', client, user);
        throw new UnauthorizedException({ code: 'MFA_INVALID', message: 'Mã xác thực không đúng' });
      }
    }
    // Tài khoản đặc quyền chưa bật MFA (khi môi trường bắt buộc) vẫn đăng nhập được nhưng phiên chỉ dùng để bật MFA
    // (JwtAuthGuard chặn mọi chức năng khác) — trước đây bị chặn hẳn nên không có đường tự bật MFA.

    await collection.updateOne(
      { _id: user._id },
      { $set: { failedLoginCount: 0, lastLoginAt: now, lastSeenAt: now }, $unset: { lockedUntil: '' } },
    );
    sessionCache.invalidate(user._id.toHexString());
    const authUser = this.authUser(user);
    await this.recordLogin(input.email, true, authUser.pending?.length ? `SETUP_${authUser.pending.join('_')}` : 'SUCCESS', client, user);
    const token = await this.jwt.signAsync({
      sub: authUser.id,
      email: authUser.email,
      displayName: authUser.displayName,
      tv: user.tokenVersion ?? 0,
    });
    return { user: authUser, token };
  }

  /** Thông tin phiên hiện tại (vai trò, phạm vi kho, bước bắt buộc còn thiếu) lấy từ DB qua JwtAuthGuard. */
  me(user: RequestUser) {
    return { ...user, ...(user.pending?.length ? {} : { pending: undefined }) };
  }

  async changePassword(user: RequestUser, input: ChangePassword) {
    const account = await this.users().findOne({ _id: new ObjectId(user.sub) });
    if (!account) throw new NotFoundException({ code: 'USER_NOT_FOUND', message: 'Không tìm thấy tài khoản' });
    if (!(await verifyPassword(input.currentPassword, account.passwordHash))) {
      throw new BadRequestException({ code: 'PASSWORD_INCORRECT', message: 'Mật khẩu hiện tại không đúng' });
    }
    const problem = passwordProblem(input.newPassword);
    if (problem) {
      throw new BadRequestException({ code: `PASSWORD_${problem}`, message: problem === 'TOO_SHORT' ? 'Mật khẩu mới phải có ít nhất 12 ký tự' : 'Mật khẩu mới phải có cả chữ và số' });
    }
    if (await verifyPassword(input.newPassword, account.passwordHash)) {
      throw new BadRequestException({ code: 'PASSWORD_REUSED', message: 'Mật khẩu mới phải khác mật khẩu hiện tại' });
    }
    await this.users().updateOne(
      { _id: account._id },
      { $set: { passwordHash: await hashPassword(input.newPassword), passwordChangedAt: new Date(), updatedAt: new Date() }, $unset: { mustChangePassword: '' } },
    );
    sessionCache.invalidate(user.sub);
    await this.audit.record({ actorId: user.sub, actorEmail: user.email, correlationId: '', action: 'USER_PASSWORD_CHANGED', entityType: 'User', entityId: user.sub });
    return { changed: true };
  }

  async beginMfa(userId: string): Promise<{ secret: string; uri: string }> {
    const secret = authenticator.generateSecret();
    const user = await this.users().findOne({ _id: new ObjectId(userId) });
    if (!user) throw new UnauthorizedException();
    await this.users().updateOne(
      { _id: user._id },
      { $set: { pendingMfaSecret: encryptSecret(secret, this.encryptionKey()) } },
    );
    return { secret, uri: authenticator.keyuri(user.email, 'INOXPRAN ERP', secret) };
  }

  async confirmMfa(user: RequestUser, code: string): Promise<void> {
    const account = await this.users().findOne({ _id: new ObjectId(user.sub) });
    if (!account?.pendingMfaSecret) throw new BadRequestException({ code: 'MFA_NOT_STARTED', message: 'Hãy bấm "Bắt đầu" để tạo mã thiết lập trước' });
    const secret = decryptSecret(account.pendingMfaSecret, this.encryptionKey());
    if (!authenticator.check(code, secret)) {
      throw new UnauthorizedException({ code: 'MFA_INVALID', message: 'Mã xác thực không đúng' });
    }
    await this.users().updateOne(
      { _id: account._id },
      {
        $set: { mfaEnabled: true, mfaSecret: account.pendingMfaSecret, updatedAt: new Date() },
        $unset: { pendingMfaSecret: '' },
      },
    );
    sessionCache.invalidate(user.sub);
    await this.audit.record({ actorId: user.sub, actorEmail: user.email, correlationId: '', action: 'USER_MFA_ENABLED', entityType: 'User', entityId: user.sub });
  }

  /** Lịch sử đăng nhập của chính mình (30 lần gần nhất). */
  async myLogins(user: RequestUser): Promise<LoginEvent[]> {
    const rows = await this.db.collection(LOGIN_EVENTS).find({ userId: new ObjectId(user.sub) }).sort({ at: -1 }).limit(30).toArray();
    return rows.map((row) => ({
      id: (row._id as ObjectId).toHexString(),
      at: (row.at as Date).toISOString(),
      email: String(row.email),
      success: Boolean(row.success),
      reason: String(row.reason),
      ...(row.ip ? { ip: String(row.ip) } : {}),
      ...(row.userAgent ? { userAgent: String(row.userAgent) } : {}),
    }));
  }
}
