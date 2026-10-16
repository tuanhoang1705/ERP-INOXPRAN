import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PERMISSION_KEY, ROLES_KEY, ROOT_ONLY_KEY } from './roles.decorator';
import type { AuthenticatedRequest } from './request-context';

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
    // Quyền nghiệp vụ (PERM-01): chỉ có quyền → phải có quyền; có cả vai trò → đúng vai trò HOẶC có quyền đều được.
    const permissions = this.reflector.getAllAndOverride<string[]>(PERMISSION_KEY, [context.getHandler(), context.getClass()]);
    const permitted = Boolean(permissions?.length) && (Boolean(request.user?.root) || Boolean(permissions?.some((key) => request.user?.permissions?.includes(key))));
    if (permissions?.length && !expected?.length) {
      if (permitted) return true;
      throw new ForbiddenException({ code: 'PERMISSION_FORBIDDEN', message: 'Tài khoản chưa được cấp quyền thực hiện thao tác này — liên hệ quản trị gốc' });
    }
    if (!expected?.length) return true;
    if (request.user.roles.some((role) => expected.includes(role)) || permitted) return true;
    throw new ForbiddenException({ code: 'ROLE_FORBIDDEN', message: 'Bạn không có quyền thực hiện thao tác này' });
  }
}
