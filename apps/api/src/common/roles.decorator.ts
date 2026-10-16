import { SetMetadata } from '@nestjs/common';
import type { PermissionKey } from '@inoxpran/contracts';

export const ROLES_KEY = 'roles';
export const Roles = (...roles: string[]): MethodDecorator & ClassDecorator => SetMetadata(ROLES_KEY, roles);

export const ROOT_ONLY_KEY = 'rootOnly';
/**
 * Chỉ tài khoản quản trị gốc (root, tạo bằng script trên máy chủ): phần kỹ thuật / cấu hình hệ thống —
 * giám sát, nhật ký hệ thống, nhập dữ liệu ban đầu, thiết lập tích hợp. Admin toàn quyền cũng không xem được.
 */
export const RootOnly = (): MethodDecorator & ClassDecorator => SetMetadata(ROOT_ONLY_KEY, true);

export const PERMISSION_KEY = 'permission';
/** Cần một trong các quyền nghiệp vụ (PERM-01, gắn theo tài khoản — `shared/permissions.ts`); quản trị gốc luôn qua. */
export const RequirePermission = (...keys: PermissionKey[]): MethodDecorator & ClassDecorator => SetMetadata(PERMISSION_KEY, keys);
