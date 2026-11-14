import { applyDecorators, SetMetadata } from '@nestjs/common';
import { areaPermissionsOf, areaRolesOf, type Area as VisibilityArea, type PermissionKey } from '@inoxpran/contracts';

export const ROLES_KEY = 'roles';
export const Roles = (...roles: string[]): MethodDecorator & ClassDecorator => SetMetadata(ROLES_KEY, roles);

export const ROOT_ONLY_KEY = 'rootOnly';
/**
 * Chỉ tài khoản quản trị gốc (root, tạo bằng script trên máy chủ): phần kỹ thuật / cấu hình hệ thống —
 * giám sát, nhật ký hệ thống, nhập dữ liệu ban đầu, thiết lập tích hợp. Admin toàn quyền cũng không xem được.
 */
export const RootOnly = (): MethodDecorator & ClassDecorator => SetMetadata(ROOT_ONLY_KEY, true);

export const READ_ONLY_ALLOWED_KEY = 'readOnlyAllowed';
/**
 * Thao tác tài khoản chỉ xem (Giám đốc — ROLE-DIR-01, 28/10/2026) vẫn làm được: tài khoản của mình, đọc thông báo và các nút
 * duyệt Giám đốc giữ lại. Mọi request ghi khác của tài khoản chỉ xem bị RolesGuard chặn.
 */
export const AllowReadOnly = (): MethodDecorator & ClassDecorator => SetMetadata(READ_ONLY_ALLOWED_KEY, true);

export const PERMISSION_KEY = 'permission';
/** Cần một trong các quyền nghiệp vụ (PERM-01, gắn theo tài khoản — `shared/permissions.ts`); quản trị gốc luôn qua. */
export const RequirePermission = (...keys: PermissionKey[]): MethodDecorator & ClassDecorator => SetMetadata(PERMISSION_KEY, keys);

/**
 * Đọc dữ liệu nghiệp vụ theo vùng hiển thị (VIS-ROLE-01, 13/11/2026 — `shared/visibility.ts`): vai trò của vùng hoặc quyền
 * nghiệp vụ đi kèm vùng (VD người được phân bước phiếu BH). Nhiều vùng = thấy một trong các vùng là được.
 * Chỉ gắn cho endpoint đọc; thao tác ghi giữ `@Roles` / `@RequirePermission` riêng.
 */
export const Area = (...areas: VisibilityArea[]): MethodDecorator & ClassDecorator => {
  const permissions = areaPermissionsOf(...areas);
  return applyDecorators(SetMetadata(ROLES_KEY, areaRolesOf(...areas)), ...(permissions.length ? [SetMetadata(PERMISSION_KEY, permissions)] : []));
};
