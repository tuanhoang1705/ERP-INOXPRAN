import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY, ROOT_ONLY_KEY } from './roles.decorator';
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
    if (!expected?.length) return true;
    if (request.user.roles.some((role) => expected.includes(role))) return true;
    throw new ForbiddenException({ code: 'ROLE_FORBIDDEN', message: 'Bạn không có quyền thực hiện thao tác này' });
  }
}
