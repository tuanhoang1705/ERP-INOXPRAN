import { Body, Controller, Get, Headers, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CreateSampleIssueSchema, SampleSaleCancelSchema, SampleSaleRequestSchema, UpdateSampleIssueSchema, VoidSampleIssueSchema } from '@inoxpran/contracts';
import { assertWarehouseAccess } from '../../common/access';
import { pageRequest } from '../../common/paging';
import type { AuthenticatedRequest } from '../../common/request-context';
import { Area, Roles } from '../../common/roles.decorator';
import { WAREHOUSE_EDITOR_ROLES } from '../catalog/partner-access';
import { SalesService } from './sales.service';

/**
 * Phiếu xuất hàng mẫu do thủ kho lập (SWK-M — SAMPLE-ISSUE-01, 12/11/2026): không qua phiếu BH / 5 bước, xuất kho ngay khi lưu.
 * Khách mua luôn hàng mẫu (SAMPLE-SALE-01): thủ kho gửi yêu cầu lập phiếu bán cho kế toán đã chọn.
 */
@ApiTags('Sample issues')
@Controller('sample-issues')
export class SampleIssuesController {
  constructor(private readonly sales: SalesService) {}

  @Area('inventory.sampleIssues')
  @Get()
  list(@Req() request: AuthenticatedRequest, @Query('search') search?: string, @Query('loan') loan?: string, @Query('page') page?: string, @Query('pageSize') pageSize?: string) {
    return this.sales.list(request.user, undefined, search, undefined, undefined, undefined, pageRequest(page ?? '1', pageSize, 20), { warehouseIssued: true, loan });
  }

  /** Kế toán được phân công phát hành phiếu BH — để chọn người nhận yêu cầu bán hàng mẫu. */
  @Roles(...WAREHOUSE_EDITOR_ROLES)
  @Get('issuers')
  issuers() {
    return this.sales.issuers();
  }

  @Area('inventory.sampleIssues')
  @Get(':id')
  get(@Param('id') id: string, @Req() request: AuthenticatedRequest) {
    return this.sales.get(id, request.user);
  }

  @Roles(...WAREHOUSE_EDITOR_ROLES)
  @Post()
  create(@Body() body: unknown, @Headers('idempotency-key') key: string | undefined, @Req() request: AuthenticatedRequest) {
    const input = CreateSampleIssueSchema.parse(body);
    assertWarehouseAccess(request, input.warehouseId);
    return this.sales.issueSample(input, request, key);
  }

  @Roles(...WAREHOUSE_EDITOR_ROLES)
  @Patch(':id')
  update(@Param('id') id: string, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined, @Req() request: AuthenticatedRequest) {
    const input = UpdateSampleIssueSchema.parse(body);
    assertWarehouseAccess(request, input.warehouseId);
    return this.sales.updateSampleIssue(id, input, request, key);
  }

  @Roles(...WAREHOUSE_EDITOR_ROLES)
  @Post(':id/void')
  void(@Param('id') id: string, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined, @Req() request: AuthenticatedRequest) {
    return this.sales.voidSampleIssue(id, VoidSampleIssueSchema.parse(body), request, key);
  }

  @Roles(...WAREHOUSE_EDITOR_ROLES)
  @Post(':id/sale-requests')
  requestSale(@Param('id') id: string, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined, @Req() request: AuthenticatedRequest) {
    return this.sales.requestSampleSale(id, SampleSaleRequestSchema.parse(body), request, key);
  }

  @Roles(...WAREHOUSE_EDITOR_ROLES)
  @Post(':id/sale-requests/:requestId/cancel')
  cancelSale(@Param('id') id: string, @Param('requestId') requestId: string, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined, @Req() request: AuthenticatedRequest) {
    return this.sales.cancelSampleSale(id, requestId, SampleSaleCancelSchema.parse(body), request, key);
  }
}
