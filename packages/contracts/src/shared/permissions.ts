/**
 * Quyền nghiệp vụ gắn theo tài khoản (PERM-01, 14/10/2026). Mỗi quyền có vai trò mặc định; quản trị gốc tích / bỏ tích từng
 * tài khoản ở "Người dùng & phân quyền" (lưu `permissionOverrides` trên tài khoản, không có giá trị = theo vai trò).
 * Thêm quyền mới: thêm một dòng vào PERMISSIONS (và kiểm tra quyền ở API) — màn hình phân quyền tự hiện ô tích.
 * Quản trị gốc luôn có mọi quyền (không tự khóa mình).
 */
export const PERMISSION_GROUPS = [
  { key: 'SALES', vi: 'Phiếu xuất kho bán hàng (BH)', zh: '销售出库单 (BH)' },
] as const;

export const PERMISSIONS = [
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
  {
    key: 'sales.price_override_approve', group: 'SALES', roles: ['ADMIN', 'DIRECTOR'],
    vi: 'Duyệt yêu cầu sửa đơn giá khi lập phiếu', zh: '审批开单改价申请',
  },
] as const;

export type PermissionKey = (typeof PERMISSIONS)[number]['key'];
export const PERMISSION_KEYS = PERMISSIONS.map((item) => item.key) as PermissionKey[];
export type PermissionOverrides = Partial<Record<PermissionKey, boolean>>;

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
