import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { IS_PUBLIC_KEY } from './public.decorator';

@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<FastifyRequest>();
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return true;
    const cookieToken = request.cookies?.erp_csrf;
    const headerToken = request.headers['x-csrf-token'];
    if (!cookieToken || typeof headerToken !== 'string') {
      throw new ForbiddenException({ code: 'CSRF_INVALID', message: 'Mã bảo vệ yêu cầu không hợp lệ' });
    }
    const left = Buffer.from(cookieToken);
    const right = Buffer.from(headerToken);
    if (left.length !== right.length || !timingSafeEqual(left, right)) {
      throw new ForbiddenException({ code: 'CSRF_INVALID', message: 'Mã bảo vệ yêu cầu không hợp lệ' });
    }
    return true;
  }
}
