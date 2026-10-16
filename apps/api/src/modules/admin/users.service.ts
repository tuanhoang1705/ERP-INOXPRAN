import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { type AdminUser, canAssignRoles, canManageUser, type CreateUser, isPermissionKey, type LoginEvent, type UpdateUser, type UpdateUserPermissions } from '@inoxpran/contracts';
import { randomBytes } from 'node:crypto';
import { type Db, type Document, type Filter, ObjectId } from 'mongodb';
import { dateRangeFilter } from '../../common/date-range';
import { AuditService } from '../../common/audit.service';
import { serializeDocument, toObjectId } from '../../common/domain';
import { pageOf, type PageRequest } from '../../common/paging';
import type { AuthenticatedRequest } from '../../common/request-context';
import { overridesOf, permissionsOf } from '../../common/permissions';
import { sessionCache } from '../../common/session-cache';
import { MONGO_DATABASE } from '../../common/tokens';
import { hashPassword } from '../auth/password';
import { LOGIN_EVENTS } from '../auth/auth.service';

const ESCAPE = /[.*+?^${}()|[\]\\]/g;
/** Mật khẩu tạm dễ đọc qua điện thoại (không có 0/O, 1/l/I), người dùng bắt buộc đổi ở lần đăng nhập đầu. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
export function temporaryPassword(): string {
  const bytes = randomBytes(12);
  const chars = [...bytes].map((byte) => ALPHABET[byte % ALPHABET.length]).join('');
  return `Tmp-${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`;
}

/**
 * Quản trị người dùng (màn Quản trị hệ thống › Người dùng). Quy tắc ai quản lý ai: $shared/user-admin.ts.
 * Khóa, đặt lại mật khẩu / MFA, thu hồi phiên đều tăng tokenVersion → mọi phiên đang mở bị đăng xuất ngay.
 */
@Injectable()
export class UsersAdminService {
  constructor(
    @Inject(MONGO_DATABASE) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  private users() {
    return this.db.collection('users');
  }

  private async present(rows: Document[]): Promise<AdminUser[]> {
    const warehouses = await this.db.collection('warehouses').find({}, { projection: { name: 1 } }).toArray();
    const warehouseName = new Map(warehouses.map((row) => [(row._id as ObjectId).toHexString(), String(row.name)]));
    return rows.map((row) => {
      const scopes = (row.warehouseScopes as string[] | undefined) ?? [];
      const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : undefined);
      return {
        id: (row._id as ObjectId).toHexString(),
        email: String(row.email),
        displayName: String(row.displayName),
        ...(row.title ? { title: String(row.title) } : {}),
        ...(row.department ? { department: String(row.department) } : {}),
        ...(row.phone ? { phone: String(row.phone) } : {}),
        roles: (row.roles as string[] | undefined) ?? [],
        warehouseScopes: scopes,
        warehouseNames: scopes.map((id) => warehouseName.get(id) ?? id),
        status: row.status === 'DISABLED' ? 'DISABLED' : 'ACTIVE',
        root: Boolean(row.root),
        mfaEnabled: Boolean(row.mfaEnabled),
        mustChangePassword: Boolean(row.mustChangePassword),
        ...(row.lockedUntil instanceof Date && row.lockedUntil > new Date() ? { lockedUntil: iso(row.lockedUntil) as string } : {}),
        ...(iso(row.lastLoginAt) ? { lastLoginAt: iso(row.lastLoginAt) as string } : {}),
        ...(iso(row.lastSeenAt) ? { lastSeenAt: iso(row.lastSeenAt) as string } : {}),
        ...(iso(row.createdAt) ? { createdAt: iso(row.createdAt) as string } : {}),
        ...(row.demoData ? { demoData: true } : {}),
        ...(Object.keys(overridesOf(row)).length ? { permissionOverrides: overridesOf(row) } : {}),
        permissions: permissionsOf(row),
      };
    });
  }

  async list(filter: { search?: string | undefined; role?: string | undefined; status?: string | undefined; from?: string | undefined; to?: string | undefined }, paging: PageRequest | null) {
    // Lọc theo ngày tạo tài khoản (LIST-DATE-01).
    const query: Filter<Document> = dateRangeFilter('createdAt', filter.from, filter.to);
    if (filter.role) query.roles = filter.role;
    if (filter.status) query.status = filter.status;
    if (filter.search) {
      const pattern = new RegExp(filter.search.replace(ESCAPE, '\\$&'), 'i');
      query.$or = [{ email: pattern }, { displayName: pattern }, { title: pattern }, { department: pattern }];
    }
    const cursor = this.users().find(query, { projection: { passwordHash: 0, mfaSecret: 0, pendingMfaSecret: 0 } }).sort({ root: -1, status: 1, displayName: 1, _id: 1 });
    if (!paging) return this.present(await cursor.limit(500).toArray());
    const [rows, total] = await Promise.all([cursor.skip(paging.skip).limit(paging.pageSize).toArray(), this.users().countDocuments(query)]);
    return pageOf(await this.present(rows), total, paging);
  }

  private async load(id: string): Promise<Document> {
    const user = await this.users().findOne({ _id: toObjectId(id) }, { projection: { passwordHash: 0, mfaSecret: 0, pendingMfaSecret: 0 } });
    if (!user) throw new NotFoundException({ code: 'USER_NOT_FOUND', message: 'Không tìm thấy người dùng' });
    return user;
  }

  private actor(request: AuthenticatedRequest) {
    return { id: request.user.sub, roles: request.user.roles, root: request.user.root };
  }

  private assertCanManage(request: AuthenticatedRequest, target: Document) {
    if (target._id.toHexString() === request.user.sub) {
      throw new ForbiddenException({ code: 'USER_SELF_FORBIDDEN', message: 'Không tự khóa / đổi quyền / đặt lại tài khoản của chính mình — dùng mục Tài khoản của tôi' });
    }
    if (!canManageUser(this.actor(request), { id: target._id.toHexString(), roles: (target.roles as string[]) ?? [], root: Boolean(target.root) })) {
      throw new ForbiddenException({
        code: target.root ? 'USER_ROOT_PROTECTED' : 'USER_ADMIN_ROOT_ONLY',
        message: target.root ? 'Tài khoản quản trị gốc chỉ thay đổi được bằng script trên máy chủ' : 'Chỉ tài khoản quản trị gốc được thay đổi tài khoản quản trị',
      });
    }
  }

  private assertRoles(request: AuthenticatedRequest, roles: readonly string[]) {
    if (!canAssignRoles(this.actor(request), roles)) {
      throw new ForbiddenException({ code: 'USER_ADMIN_ROOT_ONLY', message: 'Chỉ tài khoản quản trị gốc được cấp vai trò Quản trị hệ thống' });
    }
  }

  private async assertWarehouses(ids: readonly string[]) {
    if (!ids.length) return;
    const found = await this.db.collection('warehouses').countDocuments({ _id: { $in: ids.map((id) => toObjectId(id, 'warehouseScopes')) } });
    if (found !== new Set(ids).size) throw new BadRequestException({ code: 'WAREHOUSE_NOT_FOUND', message: 'Có kho không tồn tại trong phạm vi kho' });
  }

  private async record(request: AuthenticatedRequest, action: string, target: Document, metadata?: Record<string, unknown>, before?: Document | null, after?: Document | null) {
    await this.audit.record({
      actorId: request.user.sub,
      actorEmail: request.user.email,
      correlationId: request.correlationId,
      action,
      entityType: 'User',
      entityId: (target._id as ObjectId).toHexString(),
      ...(before ? { before: serializeDocument(before) } : {}),
      ...(after ? { after: serializeDocument(after) } : {}),
      metadata: { email: target.email, ...(metadata ?? {}) },
    });
  }

  async create(input: CreateUser, request: AuthenticatedRequest) {
    this.assertRoles(request, input.roles);
    await this.assertWarehouses(input.warehouseScopes);
    const password = temporaryPassword();
    const now = new Date();
    const document = {
      _id: new ObjectId(),
      email: input.email,
      displayName: input.displayName,
      ...(input.title ? { title: input.title } : {}),
      ...(input.department ? { department: input.department } : {}),
      ...(input.phone ? { phone: input.phone } : {}),
      roles: [...new Set(input.roles)],
      warehouseScopes: [...new Set(input.warehouseScopes)],
      passwordHash: await hashPassword(password),
      status: 'ACTIVE',
      mfaEnabled: false,
      mustChangePassword: true,
      tokenVersion: 0,
      createdBy: toObjectId(request.user.sub),
      createdAt: now,
      updatedAt: now,
    };
    try {
      await this.users().insertOne(document);
    } catch (error) {
      if ((error as { code?: number }).code === 11000) throw new ConflictException({ code: 'USER_EMAIL_EXISTS', message: `Email ${input.email} đã có tài khoản` });
      throw error;
    }
    const { passwordHash: _hash, ...visible } = document;
    await this.record(request, 'USER_CREATED', document, undefined, null, visible);
    return { user: (await this.present([document]))[0] as AdminUser, temporaryPassword: password };
  }

  async update(id: string, input: UpdateUser, request: AuthenticatedRequest) {
    const before = await this.load(id);
    this.assertCanManage(request, before);
    if (input.roles) this.assertRoles(request, input.roles);
    if (input.warehouseScopes) await this.assertWarehouses(input.warehouseScopes);
    const set: Document = { updatedAt: new Date() };
    for (const key of ['displayName', 'title', 'department', 'phone'] as const) if (input[key] !== undefined) set[key] = input[key];
    if (input.roles) set.roles = [...new Set(input.roles)];
    if (input.warehouseScopes) set.warehouseScopes = [...new Set(input.warehouseScopes)];
    const after = await this.users().findOneAndUpdate({ _id: before._id }, { $set: set }, { returnDocument: 'after', projection: { passwordHash: 0, mfaSecret: 0, pendingMfaSecret: 0 } });
    sessionCache.invalidate(id);
    await this.record(request, input.roles ? 'USER_ROLES_CHANGED' : 'USER_UPDATED', before, undefined, before, after);
    return (await this.present([after as Document]))[0];
  }

  /**
   * Quyền nghiệp vụ theo tài khoản (PERM-01): chỉ quản trị gốc tích / bỏ tích; true = cấp, false = thu, null = về mặc định theo vai trò.
   * Tài khoản gốc luôn có mọi quyền (không chỉnh). Có hiệu lực ngay (xóa bộ nhớ phiên).
   */
  async updatePermissions(id: string, input: UpdateUserPermissions, request: AuthenticatedRequest) {
    if (!request.user.root) throw new ForbiddenException({ code: 'ROOT_ONLY', message: 'Chỉ quản trị gốc được cấp / thu quyền nghiệp vụ' });
    const before = await this.load(id);
    if (before.root) throw new ConflictException({ code: 'USER_ROOT_PERMISSIONS', message: 'Tài khoản quản trị gốc luôn có mọi quyền' });
    const unknown = Object.keys(input.overrides).filter((key) => !isPermissionKey(key));
    if (unknown.length) throw new BadRequestException({ code: 'PERMISSION_UNKNOWN', message: `Không có quyền: ${unknown.join(', ')}` });
    const overrides = overridesOf(before);
    for (const [key, value] of Object.entries(input.overrides)) {
      if (value === null) delete overrides[key];
      else overrides[key] = value;
    }
    const permissionGrants = Object.keys(overrides).filter((key) => overrides[key] === true).sort();
    const permissionRevokes = Object.keys(overrides).filter((key) => overrides[key] === false).sort();
    const after = await this.users().findOneAndUpdate(
      { _id: before._id },
      { $set: { permissionGrants, permissionRevokes, updatedAt: new Date() } },
      { returnDocument: 'after', projection: { passwordHash: 0, mfaSecret: 0, pendingMfaSecret: 0 } },
    );
    sessionCache.invalidate(id);
    await this.record(request, 'USER_PERMISSIONS_UPDATED', before, undefined, { permissionOverrides: overridesOf(before) }, { permissionOverrides: overrides });
    return (await this.present([after as Document]))[0];
  }

  /** Khóa / mở khóa. Khóa đăng xuất mọi phiên ngay; mở khóa xóa luôn khóa tạm do nhập sai mật khẩu. */
  async setStatus(id: string, status: 'ACTIVE' | 'DISABLED', request: AuthenticatedRequest) {
    const before = await this.load(id);
    this.assertCanManage(request, before);
    const update: Document = status === 'DISABLED'
      ? { $set: { status, disabledAt: new Date(), updatedAt: new Date() }, $inc: { tokenVersion: 1 } }
      : { $set: { status, updatedAt: new Date() }, $unset: { lockedUntil: '', failedLoginCount: '', disabledAt: '' } };
    await this.users().updateOne({ _id: before._id }, update);
    sessionCache.invalidate(id);
    await this.record(request, status === 'DISABLED' ? 'USER_DISABLED' : 'USER_ENABLED', before);
    return (await this.present([await this.load(id)]))[0];
  }

  async resetPassword(id: string, request: AuthenticatedRequest) {
    const target = await this.load(id);
    this.assertCanManage(request, target);
    const password = temporaryPassword();
    await this.users().updateOne(
      { _id: target._id },
      { $set: { passwordHash: await hashPassword(password), mustChangePassword: true, updatedAt: new Date() }, $inc: { tokenVersion: 1 }, $unset: { lockedUntil: '', failedLoginCount: '' } },
    );
    sessionCache.invalidate(id);
    await this.record(request, 'USER_PASSWORD_RESET', target);
    return { temporaryPassword: password };
  }

  /** Mất điện thoại / đổi máy: tắt MFA, người dùng bật lại ở lần đăng nhập sau (bắt buộc với vai trò đặc quyền). */
  async resetMfa(id: string, request: AuthenticatedRequest) {
    const target = await this.load(id);
    this.assertCanManage(request, target);
    await this.users().updateOne(
      { _id: target._id },
      { $set: { mfaEnabled: false, updatedAt: new Date() }, $unset: { mfaSecret: '', pendingMfaSecret: '' }, $inc: { tokenVersion: 1 } },
    );
    sessionCache.invalidate(id);
    await this.record(request, 'USER_MFA_RESET', target);
    return (await this.present([await this.load(id)]))[0];
  }

  async revokeSessions(id: string, request: AuthenticatedRequest) {
    const target = await this.load(id);
    this.assertCanManage(request, target);
    await this.users().updateOne({ _id: target._id }, { $inc: { tokenVersion: 1 }, $set: { updatedAt: new Date() } });
    sessionCache.invalidate(id);
    await this.record(request, 'USER_SESSIONS_REVOKED', target);
    return { revoked: true };
  }

  async loginEvents(filter: { userId?: string | undefined; success?: string | undefined; search?: string | undefined; from?: string | undefined; to?: string | undefined }, paging: PageRequest) {
    const query: Filter<Document> = dateRangeFilter('at', filter.from, filter.to);
    if (filter.userId) query.userId = toObjectId(filter.userId, 'userId');
    if (filter.success === 'true' || filter.success === 'false') query.success = filter.success === 'true';
    if (filter.search) query.email = new RegExp(filter.search.replace(ESCAPE, '\\$&'), 'i');
    const [rows, total] = await Promise.all([
      this.db.collection(LOGIN_EVENTS).find(query).sort({ at: -1, _id: -1 }).skip(paging.skip).limit(paging.pageSize).toArray(),
      this.db.collection(LOGIN_EVENTS).countDocuments(query),
    ]);
    const events: LoginEvent[] = rows.map((row) => ({
      id: (row._id as ObjectId).toHexString(),
      at: (row.at as Date).toISOString(),
      email: String(row.email),
      ...(row.userId ? { userId: (row.userId as ObjectId).toHexString() } : {}),
      ...(row.displayName ? { displayName: String(row.displayName) } : {}),
      success: Boolean(row.success),
      reason: String(row.reason),
      ...(row.ip ? { ip: String(row.ip) } : {}),
      ...(row.userAgent ? { userAgent: String(row.userAgent) } : {}),
    }));
    return pageOf(events, total, paging);
  }
}
