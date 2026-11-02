import { Body, Controller, Get, Headers, Param, Patch, Post, Query, Req, StreamableFile } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ADJUSTMENT_CATEGORIES, CreateInventoryTransferSchema, CreateSampleReturnSchema, CreateStockReturnSchema, isInventoryCategory, parseStockReturnAccounting, StockReturnCreditInputSchema, StockReturnCreditTargetSchema, UpdateStockReturnSchema, VoidStockReturnSchema } from '@inoxpran/contracts';
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
  movements(@Req() request: AuthenticatedRequest, @Query('productId') productId?: string, @Query('warehouseId') warehouseId?: string, @Query('page') page?: string, @Query('pageSize') pageSize?: string) {
    return this.inventory.listMovements(productId, warehouseId, pageRequest(page, pageSize), request.user);
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
  async monthlyExport(@Query('month') month: string, @Query('warehouseId') warehouseId: string | undefined) {
    const buffer = await this.reports.monthlyWorkbook(month, warehouseId || undefined);
    return new StreamableFile(buffer, {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      disposition: `attachment; filename="TonKhoThang_${month}.xlsx"`,
      length: buffer.length,
    });
  }

  private journalOptions(request: AuthenticatedRequest, warehouseId?: string, category?: string, search?: string) {
    return { warehouseId: warehouseId || undefined, category: isInventoryCategory(category) ? category : undefined, search: search?.trim().slice(0, 80) || undefined, viewer: request.user };
  }

  /** Nhật ký xuất nhập theo tháng (`month`) hoặc khoảng ngày (`from` / `to`, LIST-DATE-01). */
  @Get('reports/journal')
  journal(
    @Req() request: AuthenticatedRequest,
    @Query('month') month?: string,
    @Query('warehouseId') warehouseId?: string,
    @Query('category') category?: string,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.reports.journal({ month, from, to }, this.journalOptions(request, warehouseId, category, search), pageRequest(page ?? '1', pageSize, 50));
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
    const buffer = await this.reports.journalWorkbook({ month, from, to }, this.journalOptions(request, warehouseId, category, search), request.user.displayName || request.user.email);
    const tag = from || to ? `${from ?? ''}_${to ?? ''}` : month ?? '';
    return new StreamableFile(buffer, {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      disposition: `attachment; filename="NhatKyXuatNhap_${tag.replace(/[^0-9_-]/g, '')}.xlsx"`,
      length: buffer.length,
    });
  }

  // ---- Phiếu trả hàng: khách trả (nhập) / trả nhà máy (xuất) ----

  @Get('returns')
  listReturns(@Req() request: AuthenticatedRequest, @Query('kind') kind?: string, @Query('page') page?: string, @Query('pageSize') pageSize?: string) {
    return this.returns.list(kind, pageRequest(page ?? '1', pageSize, 20) ?? { page: 1, pageSize: 20, skip: 0 }, request.user);
  }

  /** Phiếu đã hủy: chỉ quản trị gốc mở được (người khác nhận "không tìm thấy"). */
  @Get('returns/:id')
  getReturn(@Param('id') id: string, @Req() request: AuthenticatedRequest) {
    return this.returns.get(id, request.user);
  }

  /** Gợi ý đơn giá / nhóm công nợ / dư nợ cho hộp thoại "Xử lý công nợ" của phiếu khách trả (D1). */
  @Roles('ADMIN', 'ACCOUNTANT')
  @Get('returns/:id/accounting-draft')
  returnAccountingDraft(@Param('id') id: string) {
    return this.returns.accountingDraft(id);
  }

  /** Xem trước phiếu giảm nợ trả hàng (không ghi). */
  @Roles('ADMIN', 'ACCOUNTANT')
  @Post('returns/:id/accounting-preview')
  returnAccountingPreview(@Param('id') id: string, @Body() body: unknown) {
    return this.returns.accountingPreview(id, StockReturnCreditInputSchema.parse(body));
  }

  /** Kế toán xử lý công nợ phiếu khách trả: lập phiếu giảm nợ "Trả hàng" hoặc xác nhận không giảm công nợ (D1, 22/10/2026). */
  @Roles('ADMIN', 'ACCOUNTANT')
  @Post('returns/:id/accounting')
  accountReturn(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.returns.markAccounted(id, parseStockReturnAccounting(body), request, idempotencyKey);
  }

  /** Xem trước "Đổi nơi trừ" phiếu giảm nợ trả hàng đã ghi: tổng công nợ hoặc một nhóm công nợ riêng (AR-RET-01). */
  @Roles('ADMIN', 'ACCOUNTANT')
  @Get('returns/:id/credit-target-preview')
  returnCreditTargetPreview(@Param('id') id: string, @Query('segment') segment?: string) {
    return this.returns.creditTargetPreview(id, segment?.trim() || null);
  }

  /** Đổi nơi trừ phiếu giảm nợ trả hàng đã ghi (kế toán "thực hiện sau" — 27/10/2026). */
  @Roles('ADMIN', 'ACCOUNTANT')
  @Post('returns/:id/credit-target')
  retargetReturnCredit(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.returns.retargetCredit(id, StockReturnCreditTargetSchema.parse(body), request, idempotencyKey);
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

  /**
   * Sửa phiếu trả hàng đã lưu (20/10/2026): đảo thẻ kho cũ, ghi lại theo nội dung mới, giữ lịch sử sửa. Phải có quyền với
   * cả kho cũ lẫn kho mới.
   */
  @Roles(...WAREHOUSE_EDITOR_ROLES)
  @Patch('returns/:id')
  async updateReturn(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    const input = UpdateStockReturnSchema.parse(body);
    assertWarehouseAccess(request, input.warehouseId);
    assertWarehouseAccess(request, await this.returns.warehouseOf(id));
    return this.returns.update(id, input, request, idempotencyKey);
  }

  /** Hủy phiếu trả hàng nhập nhầm: đảo thẻ kho, phiếu giữ lại với trạng thái "Đã hủy". */
  @Roles(...WAREHOUSE_EDITOR_ROLES)
  @Post('returns/:id/void')
  async voidReturn(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    const input = VoidStockReturnSchema.parse(body);
    assertWarehouseAccess(request, await this.returns.warehouseOf(id));
    return this.returns.void(id, input, request, idempotencyKey);
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
