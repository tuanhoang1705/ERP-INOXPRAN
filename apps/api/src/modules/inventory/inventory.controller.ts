import { Body, Controller, Get, Headers, Param, Post, Query, Req, StreamableFile } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ADJUSTMENT_CATEGORIES, CreateInventoryTransferSchema, CreateSampleReturnSchema, CreateStockReturnSchema, isInventoryCategory, StockReturnAccountingSchema } from '@inoxpran/contracts';
import { z } from 'zod';
import { assertWarehouseAccess } from '../../common/access';
import { Roles } from '../../common/roles.decorator';
import type { AuthenticatedRequest } from '../../common/request-context';
import { pageRequest } from '../../common/paging';
import { WAREHOUSE_EDITOR_ROLES } from '../catalog/partner-access';
import { InventoryService } from './inventory.service';
import { InventoryReportsService } from './inventory-reports.service';
import { StockReturnsService } from './stock-returns.service';

const AdjustmentSchema = z.object({
  warehouseId: z.string().min(1),
  reason: z.string().trim().min(3).max(500),
  direction: z.enum(['IN', 'OUT']),
  /** Loại phát sinh (hao hụt, hàng mẫu, kiểm kê…); phải cùng chiều tăng / giảm. */
  category: z.enum([...ADJUSTMENT_CATEGORIES.IN, ...ADJUSTMENT_CATEGORIES.OUT]).optional(),
  lines: z
    .array(
      z.object({
        productId: z.string().min(1),
        quantity: z.string().regex(/^\d+(\.\d{1,4})?$/).refine((value) => Number(value) > 0),
        locationCode: z.string().trim().max(40).optional(),
      }),
    )
    .min(1)
    .max(200),
}).refine((value) => !value.category || (ADJUSTMENT_CATEGORIES[value.direction] as readonly string[]).includes(value.category), {
  path: ['category'],
  message: 'Loại phát sinh không khớp chiều điều chỉnh',
});

@ApiTags('Inventory')
@Controller('inventory')
export class InventoryController {
  constructor(
    private readonly inventory: InventoryService,
    private readonly reports: InventoryReportsService,
    private readonly returns: StockReturnsService,
  ) {}

  @Get('balances')
  balances(
    @Query('warehouseId') warehouseId?: string,
    @Query('search') search?: string,
    @Query('low') low?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('asOf') asOf?: string,
  ) {
    return this.inventory.listBalances(warehouseId, search, low === '1' || low === 'true', pageRequest(page, pageSize), asOf);
  }

  @Get('movements')
  movements(@Query('productId') productId?: string, @Query('warehouseId') warehouseId?: string, @Query('page') page?: string, @Query('pageSize') pageSize?: string) {
    return this.inventory.listMovements(productId, warehouseId, pageRequest(page, pageSize));
  }

  @Roles(...WAREHOUSE_EDITOR_ROLES)
  @Post('adjustments')
  adjustment(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    const input = AdjustmentSchema.parse(body);
    assertWarehouseAccess(request, input.warehouseId);
    return this.inventory.applyAdjustment(input, request, idempotencyKey);
  }

  @Roles(...WAREHOUSE_EDITOR_ROLES)
  @Post('transfers')
  transfer(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    const input = CreateInventoryTransferSchema.parse(body);
    assertWarehouseAccess(request, input.fromWarehouseId);
    assertWarehouseAccess(request, input.toWarehouseId);
    return this.inventory.transfer(input, request, idempotencyKey);
  }

  // ---- Báo cáo kho theo mẫu công ty (月库存明细单 / 出库汇总) ----

  @Get('reports/monthly')
  monthly(@Query('month') month: string, @Query('warehouseId') warehouseId?: string) {
    return this.reports.monthly(month, warehouseId || undefined);
  }

  @Get('reports/monthly/export')
  async monthlyExport(@Query('month') month: string, @Query('warehouseId') warehouseId: string | undefined, @Req() request: AuthenticatedRequest) {
    const buffer = await this.reports.monthlyWorkbook(month, warehouseId || undefined, request.user.displayName || request.user.email);
    return new StreamableFile(buffer, {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      disposition: `attachment; filename="TonKhoThang_${month}.xlsx"`,
      length: buffer.length,
    });
  }

  private journalOptions(warehouseId?: string, category?: string, search?: string) {
    return { warehouseId: warehouseId || undefined, category: isInventoryCategory(category) ? category : undefined, search: search?.trim().slice(0, 80) || undefined };
  }

  /** Nhật ký xuất nhập theo tháng (`month`) hoặc khoảng ngày (`from` / `to`, LIST-DATE-01). */
  @Get('reports/journal')
  journal(
    @Query('month') month?: string,
    @Query('warehouseId') warehouseId?: string,
    @Query('category') category?: string,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.reports.journal({ month, from, to }, this.journalOptions(warehouseId, category, search), pageRequest(page ?? '1', pageSize, 50));
  }

  @Get('reports/journal/export')
  async journalExport(
    @Req() request: AuthenticatedRequest,
    @Query('month') month?: string,
    @Query('warehouseId') warehouseId?: string,
    @Query('category') category?: string,
    @Query('search') search?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const buffer = await this.reports.journalWorkbook({ month, from, to }, this.journalOptions(warehouseId, category, search), request.user.displayName || request.user.email);
    const tag = from || to ? `${from ?? ''}_${to ?? ''}` : month ?? '';
    return new StreamableFile(buffer, {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      disposition: `attachment; filename="NhatKyXuatNhap_${tag.replace(/[^0-9_-]/g, '')}.xlsx"`,
      length: buffer.length,
    });
  }

  // ---- Phiếu trả hàng: khách trả (nhập) / trả nhà máy (xuất) ----

  @Get('returns')
  listReturns(@Query('kind') kind?: string, @Query('page') page?: string, @Query('pageSize') pageSize?: string) {
    return this.returns.list(kind, pageRequest(page ?? '1', pageSize, 20) ?? { page: 1, pageSize: 20, skip: 0 });
  }

  @Get('returns/:id')
  getReturn(@Param('id') id: string) {
    return this.returns.get(id);
  }

  /** Kế toán xác nhận đã giảm công nợ / xuất hóa đơn điều chỉnh cho phiếu khách trả. */
  @Roles('ADMIN', 'ACCOUNTANT', 'DIRECTOR')
  @Post('returns/:id/accounting')
  accountReturn(@Param('id') id: string, @Body() body: unknown, @Req() request: AuthenticatedRequest) {
    return this.returns.markAccounted(id, StockReturnAccountingSchema.parse(body).note, request);
  }

  @Roles(...WAREHOUSE_EDITOR_ROLES)
  @Post('returns')
  createReturn(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    const input = CreateStockReturnSchema.parse(body);
    assertWarehouseAccess(request, input.warehouseId);
    return this.returns.create(input, request, idempotencyKey);
  }

  /** Nhập lại hàng mẫu không có phiếu xuất mẫu trên ERP (NVKD mượn trước khi dùng ERP) — thẻ kho SAMPLE_IN, không qua kế toán. */
  @Roles(...WAREHOUSE_EDITOR_ROLES)
  @Post('returns/samples')
  createSampleReturn(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    const input = CreateSampleReturnSchema.parse(body);
    assertWarehouseAccess(request, input.warehouseId);
    return this.returns.createSample(input, request, idempotencyKey);
  }
}
