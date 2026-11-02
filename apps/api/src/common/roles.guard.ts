import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { adminAssignable, isReadOnlyUser } from '@inoxpran/contracts';
import { PERMISSION_KEY, READ_ONLY_ALLOWED_KEY, ROLES_KEY, ROOT_ONLY_KEY } from './roles.decorator';
import type { AuthenticatedRequest } from './request-context';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const expected = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const rootOnly = this.reflector.getAllAndOverride<boolean>(ROOT_ONLY_KEY, [context.getHandler(), context.getClass()]);
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (rootOnly && !request.user?.root) {
      throw new ForbiddenException({ code: 'ROOT_ONLY', message: 'Chỉ tài khoản quản trị gốc (root) được xem mục này' });
    }
    // Tài khoản chỉ xem (ROLE-DIR-01): mọi request ghi bị chặn, trừ thao tác được đánh dấu AllowReadOnly.
    if (!SAFE_METHODS.has(request.method) && isReadOnlyUser(request.user)) {
      const allowed = this.reflector.getAllAndOverride<boolean>(READ_ONLY_ALLOWED_KEY, [context.getHandler(), context.getClass()]);
      if (!allowed) throw new ForbiddenException({ code: 'READ_ONLY_ROLE', message: 'Vai trò Giám đốc chỉ xem — không thêm / sửa / xóa được' });
    }
    // Quyền nghiệp vụ (PERM-01): chỉ có quyền → phải có quyền; có cả vai trò → đúng vai trò HOẶC có quyền đều được.
    const permissions = this.reflector.getAllAndOverride<string[]>(PERMISSION_KEY, [context.getHandler(), context.getClass()]);
    const permitted = Boolean(permissions?.length) && (Boolean(request.user?.root) || Boolean(permissions?.some((key) => request.user?.permissions?.includes(key))));
    if (permissions?.length && !expected?.length) {
      if (permitted) return true;
      // Bước phiếu BH (SAL-STEP-01) do Admin phân công; quyền đặc biệt do quản trị gốc phân.
      const message = permissions.every(adminAssignable)
        ? 'Tài khoản chưa được phân công bước này của phiếu bán hàng — liên hệ Admin'
        : 'Tài khoản chưa được cấp quyền thực hiện thao tác này — liên hệ quản trị gốc';
      throw new ForbiddenException({ code: 'PERMISSION_FORBIDDEN', message, details: { permissions } });
    }
    if (!expected?.length) return true;
    if (request.user.roles.some((role) => expected.includes(role)) || permitted) return true;
    throw new ForbiddenException({ code: 'ROLE_FORBIDDEN', message: 'Bạn không có quyền thực hiện thao tác này' });
  }
}
