import { ForbiddenException } from '@nestjs/common';
import type { AuthenticatedRequest } from './request-context';

export function assertWarehouseAccess(request: AuthenticatedRequest, warehouseId: string): void {
  // Quản trị và Giám đốc thao tác được trên mọi kho.
  if (request.user.roles.includes('ADMIN') || request.user.roles.includes('DIRECTOR')) return;
  if (request.user.warehouseScopes.includes(warehouseId)) return;
  throw new ForbiddenException({
    code: 'WAREHOUSE_SCOPE_FORBIDDEN',
    message: 'Bạn không được thao tác trên kho này',
  });
}
