export interface SessionUser {
  sub: string;
  email: string;
  displayName: string;
  roles: string[];
  warehouseScopes: string[];
  mfa?: boolean;
  /** Đang bị bắt buộc bật 2 lớp (gốc / Admin yêu cầu / theo vai trò) — không tự tắt được (MFA-02). */
  mfaRequired?: boolean;
  /** Tài khoản quản trị gốc. */
  root?: boolean;
  /** Bước bắt buộc còn thiếu: đổi mật khẩu tạm, bật MFA. */
  pending?: Array<'PASSWORD' | 'MFA'>;
  /** Quyền nghiệp vụ hiệu lực (PERM-01) — theo vai trò + chỉnh riêng của quản trị gốc. */
  permissions?: string[];
}

/** Phiên đăng nhập hiện tại, được AppShell nạp từ /auth/me và dùng chung cho các trang. */
export const session = $state<{ user: SessionUser | null }>({ user: null });

/** Người đang đăng nhập có quyền nghiệp vụ `key` (quản trị gốc luôn có). */
export function can(key: string): boolean {
  return Boolean(session.user?.root) || Boolean(session.user?.permissions?.includes(key));
}

/** Người đang đăng nhập theo dạng luật 5 bước phiếu BH dùng chung với API (`$shared/sales-steps`, SAL-STEP-01). */
export function stepActor(): { sub: string; roles: string[]; root?: boolean; permissions?: string[] } {
  const user = session.user;
  return { sub: user?.sub ?? '', roles: user?.roles ?? [], ...(user?.root ? { root: true } : {}), ...(user?.permissions ? { permissions: user.permissions } : {}) };
}

const WORKSPACE_KEY = 'erp.workspace';

/** Nơi làm việc chọn ở màn hình đăng nhập (văn phòng hoặc kho). */
export interface SavedWorkspace {
  id: string;
  code: string;
  name: string;
  kind: 'OFFICE' | 'WAREHOUSE';
  /** Kho dùng mặc định trên các form (văn phòng → kho mặc định của văn phòng). */
  defaultWarehouseId: string | null;
}

export function savedWorkspace(): SavedWorkspace | null {
  try {
    const raw = localStorage.getItem(WORKSPACE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<SavedWorkspace>;
    return value && typeof value.id === 'string' && typeof value.name === 'string' ? (value as SavedWorkspace) : null;
  } catch {
    // Bản cũ chỉ lưu id kho dạng chuỗi, hoặc trình duyệt chặn lưu trữ.
    return null;
  }
}
export function saveWorkspace(workspace: SavedWorkspace): void {
  try {
    localStorage.setItem(WORKSPACE_KEY, JSON.stringify(workspace));
  } catch {
    // Trình duyệt chặn lưu trữ: bỏ qua, form sẽ dùng kho đầu tiên.
  }
}
/** Id nơi làm việc đã chọn (để chọn lại ở lần đăng nhập sau). */
export function workspaceId(): string | null {
  return savedWorkspace()?.id ?? null;
}
/** Kho mặc định trên các form theo nơi làm việc đang chọn. */
export function defaultWarehouseId(): string | null {
  return savedWorkspace()?.defaultWarehouseId ?? null;
}
