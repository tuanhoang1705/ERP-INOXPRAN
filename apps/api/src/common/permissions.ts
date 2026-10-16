import { effectivePermissions, type PermissionKey } from '@inoxpran/contracts';
import type { ClientSession, Db, Document } from 'mongodb';
import type { RequestUser } from './request-context';

/** Người dùng có quyền nghiệp vụ (PERM-01) — quản trị gốc luôn có. */
export function can(user: Pick<RequestUser, 'permissions' | 'root'> | undefined, key: PermissionKey): boolean {
  return Boolean(user?.root) || Boolean(user?.permissions?.includes(key));
}

/**
 * Quyền chỉnh riêng lưu trên tài khoản thành hai mảng `permissionGrants` / `permissionRevokes`
 * (mã quyền có dấu chấm nên không dùng làm tên trường MongoDB).
 */
export function overridesOf(user: Document): Record<string, boolean> {
  return Object.fromEntries([
    ...((user.permissionGrants as string[] | undefined) ?? []).map((key) => [key, true] as const),
    ...((user.permissionRevokes as string[] | undefined) ?? []).map((key) => [key, false] as const),
  ]);
}

/** Quyền hiệu lực của một tài khoản lưu trong CSDL. */
export function permissionsOf(user: Document): PermissionKey[] {
  return effectivePermissions({ roles: (user.roles as string[] | undefined) ?? [], root: Boolean(user.root), permissionOverrides: overridesOf(user) });
}

/** Tài khoản đang hoạt động có quyền `key` (để gửi thông báo cho đúng người duyệt). */
export async function userIdsWithPermission(db: Db, key: PermissionKey, session?: ClientSession): Promise<string[]> {
  const users = await db.collection('users').find(
    { status: 'ACTIVE' },
    { projection: { roles: 1, root: 1, permissionGrants: 1, permissionRevokes: 1 }, ...(session ? { session } : {}) },
  ).toArray();
  return users.filter((user) => permissionsOf(user).includes(key)).map((user) => String(user._id));
}
