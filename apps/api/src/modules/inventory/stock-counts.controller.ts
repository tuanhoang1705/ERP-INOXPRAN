import { Body, Controller, Get, Headers, HttpCode, Param, Post, Put, Query, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CreateStockCountSchema, SaveStockCountEntriesSchema, StockCountCheckSchema, StockCountConfirmSchema, StockCountErpFixSchema } from '@inoxpran/contracts';
import { z } from 'zod';
import { pageRequest } from '../../common/paging';
import type { AuthenticatedRequest } from '../../common/request-context';
import { Roles } from '../../common/roles.decorator';
import { WAREHOUSE_EDITOR_ROLES } from '../catalog/partner-access';
import { StockCountsService } from './stock-counts.service';

const VersionSchema = z.object({ version: z.number().int().min(0) });
/** Thủ kho, quản lý kho (và Admin) kiểm kê / sửa tồn ERP; kế toán, kiểm soát nội bộ, Giám đốc chỉ xem. */
const VIEWERS = [...WAREHOUSE_EDITOR_ROLES, 'ACCOUNTANT', 'AUDITOR', 'DIRECTOR'];

/** Kiểm kê kho 2 bước (STK-01): kiểm tồn sản phẩm → kiểm tồn số lượng → chốt. */
@ApiTags('Inventory')
@Controller('inventory/stock-counts')
export class StockCountsController {
  constructor(private readonly counts: StockCountsService) {}

  @Roles(...VIEWERS)
  @Get()
  list(@Req() request: AuthenticatedRequest, @Query('warehouseId') warehouseId?: string, @Query('status') status?: string, @Query('period') period?: string, @Query('page') page?: string, @Query('pageSize') pageSize?: string) {
    return this.counts.list({ warehouseId, status, period }, pageRequest(page ?? '1', pageSize, 20) ?? { page: 1, pageSize: 20, skip: 0 }, request);
  }

  @Roles(...VIEWERS)
  @Get(':id')
  get(@Param('id') id: string, @Req() request: AuthenticatedRequest) {
    return this.counts.get(id, request);
  }

  @Roles(...WAREHOUSE_EDITOR_ROLES)
  @Post()
  create(@Body() body: unknown, @Headers('idempotency-key') idempotencyKey: string | undefined, @Req() request: AuthenticatedRequest) {
    // KK-ALL-01: phiếu gộp mọi kho; quyền kho kiểm tra trong service (ít nhất một kho).
    CreateStockCountSchema.parse(body ?? {});
    return this.counts.create(request, idempotencyKey);
  }

  @Roles(...WAREHOUSE_EDITOR_ROLES)
  @Put(':id/entries')
  saveEntries(@Param('id') id: string, @Body() body: unknown, @Req() request: AuthenticatedRequest) {
    return this.counts.saveEntries(id, SaveStockCountEntriesSchema.parse(body), request);
  }

  @Roles(...WAREHOUSE_EDITOR_ROLES)
  @Post(':id/check')
  @HttpCode(200)
  check(@Param('id') id: string, @Body() body: unknown, @Req() request: AuthenticatedRequest) {
    return this.counts.runCheck(id, StockCountCheckSchema.parse(body), request);
  }

  @Roles(...WAREHOUSE_EDITOR_ROLES)
  @Post(':id/erp-fix')
  erpFix(@Param('id') id: string, @Body() body: unknown, @Headers('idempotency-key') idempotencyKey: string | undefined, @Req() request: AuthenticatedRequest) {
    return this.counts.erpFix(id, StockCountErpFixSchema.parse(body), request, idempotencyKey);
  }

  @Roles(...WAREHOUSE_EDITOR_ROLES)
  @Post(':id/lock-skus')
  @HttpCode(200)
  lockSkus(@Param('id') id: string, @Body() body: unknown, @Req() request: AuthenticatedRequest) {
    return this.counts.lockSkus(id, StockCountConfirmSchema.parse(body), request);
  }

  @Roles(...WAREHOUSE_EDITOR_ROLES)
  @Post(':id/back')
  @HttpCode(200)
  back(@Param('id') id: string, @Body() body: unknown, @Req() request: AuthenticatedRequest) {
    return this.counts.back(id, VersionSchema.parse(body), request);
  }

  @Roles(...WAREHOUSE_EDITOR_ROLES)
  @Post(':id/close')
  @HttpCode(200)
  close(@Param('id') id: string, @Body() body: unknown, @Headers('idempotency-key') idempotencyKey: string | undefined, @Req() request: AuthenticatedRequest) {
    return this.counts.close(id, StockCountConfirmSchema.parse(body), request, idempotencyKey);
  }

  @Roles(...WAREHOUSE_EDITOR_ROLES)
  @Post(':id/cancel')
  @HttpCode(200)
  cancel(@Param('id') id: string, @Body() body: unknown, @Req() request: AuthenticatedRequest) {
    return this.counts.cancel(id, VersionSchema.parse(body), request);
  }
}
