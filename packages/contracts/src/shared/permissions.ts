import { canManageUser, type Actor, type TargetUser } from './user-admin';

/**
 * Quyền nghiệp vụ gắn theo tài khoản (PERM-01, 14/10/2026). Mỗi quyền có vai trò mặc định; tích / bỏ tích từng tài khoản ở
 * "Người dùng & phân quyền" (lưu trên tài khoản thành hai mảng `permissionGrants` / `permissionRevokes`; không có = theo vai trò).
 * Thêm quyền mới: thêm một dòng vào PERMISSIONS (và kiểm tra quyền ở API) — màn hình phân quyền tự hiện ô tích.
 * Quản trị gốc luôn có mọi quyền (không tự khóa mình).
 * Nhóm `adminAssignable` (SAL-STEP-01, 26/10/2026): Admin phân cho tài khoản không phải Admin; nhóm còn lại chỉ quản trị gốc phân.
 */
export const PERMISSION_GROUPS = [
  { key: 'SALES_STEP', vi: 'Các bước phiếu bán hàng (BH) — Admin phân công', zh: '销售单 (BH) 流程步骤 — 由管理员分配', adminAssignable: true },
  { key: 'SALES', vi: 'Phiếu xuất kho bán hàng (BH) — quyền đặc biệt (chỉ quản trị gốc phân)', zh: '销售出库单 (BH) — 特殊权限（仅超级管理员分配）', adminAssignable: false },
] as const;

export const PERMISSIONS = [
  // 5 bước phiếu BH (SAL-STEP-01): mặc định đúng như phân theo vai trò trước 26/10/2026.
  {
    key: 'sales.step.create', group: 'SALES_STEP', roles: ['ADMIN', 'ACCOUNTANT', 'SALES', 'SALES_MANAGER'],
    vi: 'Bước 1 — Lập phiếu BH / gửi đề nghị xuất bán', zh: '第1步 — 开具销售单 / 提交出货申请',
  },
  {
    key: 'sales.step.issue', group: 'SALES_STEP', roles: ['ADMIN', 'ACCOUNTANT'],
    vi: 'Bước 2 — KT phát hành phiếu BH (chọn thủ kho, tự nhập số phiếu)', zh: '第2步 — 会计发出销售单（指定仓管、手动编号）',
  },
  {
    key: 'sales.step.confirm', group: 'SALES_STEP', roles: ['ADMIN', 'ACCOUNTANT', 'SALES', 'SALES_MANAGER'],
    vi: 'Bước 3 — KD đối chiếu với khách (kèm ảnh) / yêu cầu sửa', zh: '第3步 — 业务与客户核对（附截图）/ 要求修改',
  },
  {
    key: 'sales.step.ship', group: 'SALES_STEP', roles: ['ADMIN', 'WAREHOUSE', 'WAREHOUSE_MANAGER'],
    vi: 'Bước 4 — Kho lập SWK & xuất kho (thủ kho được giao trên phiếu)', zh: '第4步 — 仓库开具 SWK 并出库（单据指定的仓管）',
  },
  {
    key: 'sales.step.deliver', group: 'SALES_STEP', roles: ['ADMIN', 'WAREHOUSE', 'WAREHOUSE_MANAGER'],
    vi: 'Bước 5 — Xác nhận giao hàng thành công', zh: '第5步 — 确认送达',
  },
  {
    key: 'sales.discard', group: 'SALES', roles: ['ACCOUNTANT', 'ADMIN'],
    vi: 'Xóa phiếu nháp / hủy phiếu chưa xuất kho (làm ngay)', zh: '删除草稿 / 作废未出库单据（直接执行）',
  },
  {
    key: 'sales.edit_issued', group: 'SALES', roles: ['ADMIN'],
    vi: 'Sửa phiếu đã phát hành / đã xuất / đã giao (làm ngay)', zh: '修改已发出 / 已出库 / 已送达单据（直接执行）',
  },
  {
    key: 'sales.void_shipped', group: 'SALES', roles: ['ADMIN'],
    vi: 'Hủy phiếu đã xuất / đã giao (làm ngay)', zh: '作废已出库 / 已送达单据（直接执行）',
  },
  {
    key: 'sales.change_request', group: 'SALES', roles: ['ACCOUNTANT', 'WAREHOUSE', 'WAREHOUSE_MANAGER'],
    vi: 'Gửi đề nghị sửa / hủy / xóa phiếu (Admin duyệt mới thực hiện)', zh: '提交修改 / 作废 / 删除单据申请（管理员批准后执行）',
  },
  {
    key: 'sales.change_approve', group: 'SALES', roles: ['ADMIN'],
    vi: 'Duyệt đề nghị sửa / hủy / xóa phiếu', zh: '审批修改 / 作废 / 删除单据申请',
  },
  // Kế toán có quyền này từ 29/10/2026 (SAL-PRICE-01): tự lập phiếu thì quyền sửa giá được cấp ngay như Admin.
  {
    key: 'sales.price_override_approve', group: 'SALES', roles: ['ADMIN', 'ACCOUNTANT', 'DIRECTOR'],
    vi: 'Duyệt / tự cấp quyền sửa đơn giá khi lập phiếu', zh: '审批 / 自行授予开单改价权限',
  },
] as const;

export type PermissionKey = (typeof PERMISSIONS)[number]['key'];
export const PERMISSION_KEYS = PERMISSIONS.map((item) => item.key) as PermissionKey[];
export type PermissionOverrides = Partial<Record<PermissionKey, boolean>>;

/** 5 bước phiếu BH theo thứ tự (SAL-STEP-01). */
export const SALES_STEP_KEYS = ['sales.step.create', 'sales.step.issue', 'sales.step.confirm', 'sales.step.ship', 'sales.step.deliver'] as const satisfies readonly PermissionKey[];
export type SalesStepKey = (typeof SALES_STEP_KEYS)[number];

export function isPermissionKey(value: string): value is PermissionKey {
  return (PERMISSION_KEYS as string[]).includes(value);
}

/** Quyền mặc định theo vai trò (chưa tính chỉnh riêng). */
export function roleHasPermission(roles: readonly string[], key: PermissionKey): boolean {
  const item = PERMISSIONS.find((row) => row.key === key);
  return Boolean(item && item.roles.some((role) => roles.includes(role)));
}

/** Quyền hiệu lực: vai trò mặc định, rồi áp chỉnh riêng (true = cấp, false = thu); quản trị gốc có mọi quyền. */
export function effectivePermissions(user: { roles: readonly string[]; root?: boolean | undefined; permissionOverrides?: PermissionOverrides | null | undefined }): PermissionKey[] {
  if (user.root) return [...PERMISSION_KEYS];
  return PERMISSION_KEYS.filter((key) => {
    const override = user.permissionOverrides?.[key];
    return typeof override === 'boolean' ? override : roleHasPermission(user.roles, key);
  });
}

/** Quyền thuộc nhóm Admin được phân (5 bước phiếu BH); nhóm khác chỉ quản trị gốc phân. */
export function adminAssignable(key: string): boolean {
  const item = PERMISSIONS.find((row) => row.key === key);
  return Boolean(item && PERMISSION_GROUPS.find((group) => group.key === item.group)?.adminAssignable);
}

/**
 * Các quyền `actor` được tích / bỏ tích cho `target`: quản trị gốc — mọi quyền (trừ tài khoản gốc); Admin — chỉ 5 bước
 * phiếu BH, với tài khoản mình quản lý (không phải Admin, không phải chính mình); vai trò khác — không quyền nào.
 */
export function editablePermissionKeys(actor: Actor, target: TargetUser): PermissionKey[] {
  if (target.root || actor.id === target.id || !canManageUser(actor, target)) return [];
  return actor.root ? [...PERMISSION_KEYS] : PERMISSION_KEYS.filter(adminAssignable);
}

/**
 * "Người làm bước": giữ quyền qua vai trò không phải ADMIN hoặc được tích riêng. Quản trị gốc và quyền mặc định của vai trò
 * ADMIN không tính — dùng để chọn người nhận thông báo, danh sách thủ kho, người phụ trách bước (Admin làm được nhưng
 * không phải người được phân công).
 */
export function isStepHolder(user: { roles: readonly string[]; root?: boolean | undefined; permissionOverrides?: PermissionOverrides | null | undefined }, key: PermissionKey): boolean {
  if (user.root) return false;
  return effectivePermissions({ roles: user.roles.filter((role) => role !== 'ADMIN'), permissionOverrides: user.permissionOverrides }).includes(key);
}
