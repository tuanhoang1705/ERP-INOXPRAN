/**
 * Quản trị người dùng — quy tắc dùng chung cho API (kiểm tra thật) và giao diện (ẩn / hiện nút).
 * - Tài khoản gốc (root): chỉ tạo bằng script trên máy chủ, luôn có vai trò ADMIN và bắt buộc MFA,
 *   không bị khóa / đổi quyền / đặt lại qua giao diện; là người duy nhất cấp hoặc thu hồi vai trò ADMIN.
 * - Quản trị (ADMIN) thường: tạo, sửa, khóa, đặt lại mật khẩu / MFA cho người dùng không phải ADMIN.
 */
export const USER_ROLES = [
  'ADMIN',
  'DIRECTOR',
  'SALES_MANAGER',
  'SALES',
  'ACCOUNTANT',
  'WAREHOUSE_MANAGER',
  'WAREHOUSE',
  'PROCUREMENT_MANAGER',
  'PROCUREMENT',
  'CATALOG_MANAGER',
  'WARRANTY',
  'AUDITOR',
] as const;
export type UserRole = (typeof USER_ROLES)[number];

/** Vai trò đặc quyền: bắt buộc bật xác thực 2 lớp khi môi trường bật MFA_ENFORCE_PRIVILEGED (production). */
export const PRIVILEGED_ROLES: readonly string[] = ['ADMIN', 'DIRECTOR', 'ACCOUNTANT'];
/** Xem (chỉ đọc) danh sách người dùng, lịch sử đăng nhập, giám sát hệ thống, nhật ký: quản trị, Giám đốc, kiểm soát nội bộ. */
export const USER_VIEWER_ROLES = ['ADMIN', 'DIRECTOR', 'AUDITOR'];
export const MIN_PASSWORD_LENGTH = 12;

/** Bước bắt buộc trước khi dùng hệ thống: đổi mật khẩu tạm, bật xác thực 2 lớp. */
export type SetupStep = 'PASSWORD' | 'MFA';

export interface AccountState {
  roles: readonly string[];
  root?: boolean | undefined;
  mfaEnabled: boolean;
  mustChangePassword?: boolean | undefined;
}

export function requiresMfa(user: Pick<AccountState, 'roles' | 'root'>, enforcePrivileged: boolean): boolean {
  return Boolean(user.root) || (enforcePrivileged && user.roles.some((role) => PRIVILEGED_ROLES.includes(role)));
}

export function pendingSetup(user: AccountState, enforcePrivileged: boolean): SetupStep[] {
  const steps: SetupStep[] = [];
  if (user.mustChangePassword) steps.push('PASSWORD');
  if (!user.mfaEnabled && requiresMfa(user, enforcePrivileged)) steps.push('MFA');
  return steps;
}

export interface Actor {
  id: string;
  roles: readonly string[];
  root?: boolean | undefined;
}
export interface TargetUser {
  id: string;
  roles: readonly string[];
  root?: boolean | undefined;
}

/** Người thao tác có được sửa / khóa / đặt lại tài khoản này không. */
export function canManageUser(actor: Actor, target: TargetUser): boolean {
  if (!actor.roles.includes('ADMIN')) return false;
  if (target.root) return false;
  if (target.roles.includes('ADMIN')) return Boolean(actor.root);
  return true;
}

/** Có được gán bộ vai trò này không (chỉ root cấp ADMIN). */
export function canAssignRoles(actor: Actor, roles: readonly string[]): boolean {
  if (!actor.roles.includes('ADMIN')) return false;
  return !roles.includes('ADMIN') || Boolean(actor.root);
}

/** Mật khẩu: tối thiểu 12 ký tự, có cả chữ và số. Trả mã lỗi hoặc null. */
export function passwordProblem(password: string): 'TOO_SHORT' | 'NEEDS_LETTER_AND_DIGIT' | null {
  if (password.length < MIN_PASSWORD_LENGTH) return 'TOO_SHORT';
  if (!/[A-Za-zÀ-ỹ]/.test(password) || !/\d/.test(password)) return 'NEEDS_LETTER_AND_DIGIT';
  return null;
}
