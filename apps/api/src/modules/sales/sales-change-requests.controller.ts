import { Body, Controller, Get, Headers, Param, Post, Query, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CreateSalesChangeRequestSchema, DecideSalesChangeRequestSchema, RejectSalesChangeRequestSchema, SALES_CHANGE_STATUSES } from '@inoxpran/contracts';
import { pageRequest } from '../../common/paging';
import type { AuthenticatedRequest } from '../../common/request-context';
import { RequirePermission } from '../../common/roles.decorator';
import { SalesChangeRequestsService } from './sales-change-requests.service';

/** Đề nghị sửa / hủy / xóa phiếu BH và duyệt đề nghị (SAL-CHG-01) — theo quyền nghiệp vụ gắn với tài khoản (PERM-01). */
@ApiTags('Sales')
@Controller()
export class SalesChangeRequestsController {
  constructor(private readonly requests: SalesChangeRequestsService) {}

  @RequirePermission('sales.change_request')
  @Post('sales-orders/:id/change-requests')
  create(@Param('id') id: string, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined, @Req() request: AuthenticatedRequest) {
    return this.requests.create(id, CreateSalesChangeRequestSchema.parse(body), request, key);
  }

  @RequirePermission('sales.change_request', 'sales.change_approve')
  @Get('sales-change-requests')
  list(@Req() request: AuthenticatedRequest, @Query('status') status?: string, @Query('orderId') orderId?: string, @Query('page') page?: string, @Query('pageSize') pageSize?: string) {
    const valid = status && (SALES_CHANGE_STATUSES as readonly string[]).includes(status) ? status : undefined;
    return this.requests.list({ status: valid, orderId }, request, pageRequest(page, pageSize));
  }

  @RequirePermission('sales.change_request', 'sales.change_approve')
  @Get('sales-change-requests/count')
  count(@Req() request: AuthenticatedRequest) {
    return this.requests.pendingCount(request);
  }

  @RequirePermission('sales.change_request', 'sales.change_approve')
  @Get('sales-change-requests/:id')
  get(@Param('id') id: string, @Req() request: AuthenticatedRequest) {
    return this.requests.get(id, request);
  }

  @RequirePermission('sales.change_approve')
  @Post('sales-change-requests/:id/approve')
  approve(@Param('id') id: string, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined, @Req() request: AuthenticatedRequest) {
    return this.requests.approve(id, DecideSalesChangeRequestSchema.parse(body ?? {}).note, request, key);
  }

  @RequirePermission('sales.change_approve')
  @Post('sales-change-requests/:id/reject')
  reject(@Param('id') id: string, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined, @Req() request: AuthenticatedRequest) {
    return this.requests.reject(id, RejectSalesChangeRequestSchema.parse(body).note, request, key);
  }

  @RequirePermission('sales.change_request')
  @Post('sales-change-requests/:id/withdraw')
  withdraw(@Param('id') id: string, @Req() request: AuthenticatedRequest) {
    return this.requests.withdraw(id, request);
  }
}
