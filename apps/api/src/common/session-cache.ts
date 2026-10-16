/**
 * Bộ nhớ đệm tài khoản cho JwtAuthGuard: mỗi request kiểm tra tài khoản còn hoạt động, phiên chưa bị thu hồi
 * (tokenVersion) và lấy vai trò / phạm vi kho mới nhất từ DB — đọc DB tối đa một lần mỗi TTL cho mỗi người.
 * Khóa tài khoản, đổi quyền, đặt lại mật khẩu gọi invalidate() để có hiệu lực ngay trên tiến trình API này.
 */
export interface CachedAccount {
  id: string;
  email: string;
  displayName: string;
  roles: string[];
  warehouseScopes: string[];
  status: string;
  tokenVersion: number;
  root: boolean;
  mfaEnabled: boolean;
  mustChangePassword: boolean;
  lastSeenAt?: Date | undefined;
  permissionOverrides?: Record<string, boolean> | undefined;
}

export const SESSION_CACHE_TTL_MS = 15_000;
const entries = new Map<string, { account: CachedAccount | null; loadedAt: number }>();

export const sessionCache = {
  get(userId: string, now = Date.now()): CachedAccount | null | undefined {
    const entry = entries.get(userId);
    if (!entry || now - entry.loadedAt > SESSION_CACHE_TTL_MS) return undefined;
    return entry.account;
  },
  set(userId: string, account: CachedAccount | null, now = Date.now()): void {
    if (entries.size > 5_000) entries.clear();
    entries.set(userId, { account, loadedAt: now });
  },
  invalidate(userId: string): void {
    entries.delete(userId);
  },
  clear(): void {
    entries.clear();
  },
};
