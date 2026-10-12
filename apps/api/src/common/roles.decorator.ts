import { SetMetadata } from '@nestjs/common';

export const ROLES_KEY = 'roles';
export const Roles = (...roles: string[]): MethodDecorator & ClassDecorator => SetMetadata(ROLES_KEY, roles);

export const ROOT_ONLY_KEY = 'rootOnly';
/**
 * Chỉ tài khoản quản trị gốc (root, tạo bằng script trên máy chủ): phần kỹ thuật / cấu hình hệ thống —
 * giám sát, nhật ký hệ thống, nhập dữ liệu ban đầu, thiết lập tích hợp. Admin toàn quyền cũng không xem được.
 */
export const RootOnly = (): MethodDecorator & ClassDecorator => SetMetadata(ROOT_ONLY_KEY, true);
