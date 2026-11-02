import { Body, Controller, Delete, Get, Headers, Param, Patch, Post, Query, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  CreateSalesOrderSchema,
  DiscardSalesOrderSchema,
  CustomerConfirmationSchema,
  LoanCloseSchema,
  LoanReturnSchema,
  SalesPriceSheetRequestSchema,
  SalesQuoteRequestSchema,
  UpdateSalesOrderSchema,
  WarehouseIssueSchema,
} from '@inoxpran/contracts';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { assertWarehouseAccess } from '../../common/access';
import { AllowReadOnly, RequirePermission, Roles } from '../../common/roles.decorator';
import type { AuthenticatedRequest } from '../../common/request-context';
import { pageRequest } from '../../common/paging';
import { SalesService } from './sales.service';

const VersionSchema = z.object({ version: z.number().int().positive() });
const UndoPayNowSchema = z.object({ reason: z.string().trim().min(3, 'Ghi lý do bỏ ghi thu').max(300) });

@ApiTags('Sales')
@Controller('sales-orders')
export class SalesController {
  constructor(private readonly sales: SalesService) {}

  /** Thủ kho chỉ thấy phiếu kế toán đã chọn mình; các vai trò khác thấy toàn bộ. */
  @Get()
  list(
    @Req() request: AuthenticatedRequest,
    @Query('status') status?: string,
    @Query('search') search?: string,
    @Query('channel') channel?: string,
    @Query('customerId') customerId?: string,
    @Query('confirmation') confirmation?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('type') type?: string,
    @Query('loan') loan?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.sales.list(request.user, status, search, channel, customerId, confirmation, pageRequest(page, pageSize), { type, loan, from, to });
  }

  @Roles('ADMIN', 'SALES', 'SALES_MANAGER', 'ACCOUNTANT')
  @RequirePermission('sales.change_request', 'sales.step.create', 'sales.step.issue')
  @Post('quote')
  quote(@Body() body: unknown, @Req() request: AuthenticatedRequest) {
    const input = SalesQuoteRequestSchema.parse(body);
    assertWarehouseAccess(request, input.warehouseId);
    return this.sales.quote(input);
  }

  /** Bảng giá của khách tại kho xuất để form phiếu tính tiền tức thời. */
  @Roles('ADMIN', 'SALES', 'SALES_MANAGER', 'ACCOUNTANT', 'DIRECTOR')
  @RequirePermission('sales.change_request', 'sales.step.create', 'sales.step.issue')
  @Get('price-sheet')
  priceSheet(@Query() query: unknown, @Req() request: AuthenticatedRequest) {
    const input = SalesPriceSheetRequestSchema.parse(query);
    assertWarehouseAccess(request, input.warehouseId);
    return this.sales.priceSheet(input.customerId, input.warehouseId);
  }

  /** Tài khoản thủ kho có phạm vi kho xuất, để kế toán chọn người tiếp nhận phiếu. */
  @Roles('ADMIN', 'SALES', 'SALES_MANAGER', 'ACCOUNTANT', 'DIRECTOR')
  @RequirePermission('sales.change_request', 'sales.step.create', 'sales.step.issue')
  @Get('warehouse-keepers')
  warehouseKeepers(@Query('warehouseId') warehouseId: string, @Req() request: AuthenticatedRequest) {
    assertWarehouseAccess(request, warehouseId);
    return this.sales.warehouseKeepers(warehouseId);
  }

  @Get(':id')
  get(@Param('id') id: string, @Req() request: AuthenticatedRequest) {
    return this.sales.get(id, request.user);
  }

  /** Bước đang chờ của phiếu và người được phân công (SAL-STEP-01) — hiện trên dòng thời gian của phiếu. */
  @Get(':id/step-owners')
  stepOwners(@Param('id') id: string, @Req() request: AuthenticatedRequest) {
    return this.sales.stepOwners(id, request.user);
  }

  /** Tải ảnh bằng chứng đối chiếu (thân request = dữ liệu ảnh PNG/JPEG/WebP, tên file trong header x-file-name) — bước 3. */
  @RequirePermission('sales.step.confirm')
  @Post(':id/attachments')
  uploadEvidence(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('x-file-name') fileName: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.sales.uploadEvidence(id, body, fileName, request);
  }

  @Get(':id/attachments/:attachmentId')
  async readEvidence(
    @Param('id') id: string,
    @Param('attachmentId') attachmentId: string,
    @Req() request: AuthenticatedRequest,
    @Res() reply: FastifyReply,
  ) {
    const file = await this.sales.readEvidence(id, attachmentId, request.user);
    await reply
      .header('content-type', file.contentType)
      .header('content-disposition', `inline; filename*=UTF-8''${encodeURIComponent(file.fileName)}`)
      .header('cache-control', 'private, max-age=86400, immutable')
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'")
      .send(file.data);
  }

  @RequirePermission('sales.step.confirm')
  @Delete(':id/attachments/:attachmentId')
  deleteEvidence(@Param('id') id: string, @Param('attachmentId') attachmentId: string, @Req() request: AuthenticatedRequest) {
    return this.sales.deletePendingEvidence(id, attachmentId, request);
  }

  /**
   * Bước 1 — lập phiếu (SAL-STEP-01): người được phân bước 2 lập phiếu nháp để phát hành; người chỉ có bước 1 lập đề nghị xuất bán.
   * Chỉ dùng quyền (không kèm vai trò) để Admin bỏ tích là chặn được ngay.
   */
  @RequirePermission('sales.step.create')
  @Post()
  create(
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    const input = CreateSalesOrderSchema.parse(body);
    assertWarehouseAccess(request, input.warehouseId);
    return this.sales.create(input, request, key);
  }

  /** Sửa phiếu nháp hoặc phiếu bị kinh doanh trả về — người được phân bước 1 hoặc bước 2. */
  @RequirePermission('sales.step.create', 'sales.step.issue')
  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    const input = UpdateSalesOrderSchema.parse(body);
    assertWarehouseAccess(request, input.warehouseId);
    return this.sales.update(id, input, request, key);
  }

  /** Sửa phiếu ở mọi giai đoạn sau khi phát hành (quyền `sales.edit_issued`, mặc định Admin) — tồn kho / công nợ tự điều chỉnh theo chênh lệch. */
  @RequirePermission('sales.edit_issued')
  @Patch(':id/root')
  rootUpdate(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.sales.rootUpdate(id, UpdateSalesOrderSchema.parse(body), request, key);
  }

  /** Hủy phiếu đã xuất kho / đã giao bằng bút toán đảo (quyền `sales.void_shipped`, mặc định Admin): nhập lại kho, công nợ hủy, tiền đã thu thành trả trước. */
  @RequirePermission('sales.void_shipped')
  @Post(':id/void')
  rootVoid(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.sales.rootVoid(id, DiscardSalesOrderSchema.parse(body), request, key);
  }

  /** Xóa hẳn phiếu nháp (quyền `sales.discard`, mặc định kế toán / Admin) — bắt buộc lý do, nội dung giữ trong nhật ký. */
  @RequirePermission('sales.discard')
  @Delete(':id')
  remove(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.sales.remove(id, DiscardSalesOrderSchema.parse(body), request, key);
  }

  /** Hủy phiếu đã phát hành nhưng chưa xuất kho (quyền `sales.discard`) — trả hàng giữ chỗ, bắt buộc lý do. */
  @RequirePermission('sales.discard')
  @Post(':id/cancel')
  cancel(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.sales.cancel(id, DiscardSalesOrderSchema.parse(body), request, key);
  }

  /** Bước 2 — phát hành phiếu BH: kiểm tra ngưỡng duyệt, hạn mức và giữ hàng. */
  @RequirePermission('sales.step.issue')
  @Post(':id/submit')
  submit(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.sales.submit(id, VersionSchema.parse(body).version, request, key);
  }

  // Giám đốc chỉ xem nhưng vẫn duyệt phiếu ngoại lệ (ROLE-DIR-01).
  @Roles('ADMIN', 'SALES_MANAGER', 'DIRECTOR')
  @AllowReadOnly()
  @Post(':id/approve')
  approve(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.sales.approve(id, VersionSchema.parse(body).version, request, key);
  }

  /** Bước 4 — lập SWK & xuất kho: người được phân bước 4 và là thủ kho kế toán chọn trên phiếu (kiểm tra trong service). */
  @RequirePermission('sales.step.ship')
  @Post(':id/ship')
  ship(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.sales.ship(id, WarehouseIssueSchema.parse(body), request, key);
  }

  /** Nhập lại hàng mẫu / hàng kiểm định NVKD mang về theo phiếu (SAL-TYPE-01) — thủ kho, quản lý kho. */
  @Roles('ADMIN', 'WAREHOUSE', 'WAREHOUSE_MANAGER')
  @Post(':id/loan-returns')
  loanReturn(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.sales.loanReturn(id, LoanReturnSchema.parse(body), request, key);
  }

  /** Đơn thanh toán ngay: kế toán bỏ phiếu thu tự động khi khách thực tế chưa trả (AR-PAYNOW-01). */
  @Roles('ADMIN', 'ACCOUNTANT')
  @Post(':id/pay-now/undo')
  undoPayNow(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.sales.undoPayNow(id, UndoPayNowSchema.parse(body).reason, request, key);
  }

  /** Chốt phần hàng mẫu / kiểm định chưa về: hỏng / tiêu hao / tặng, hoặc đại lý mua luôn (SAL-TYPE-01) — kế toán, quản lý kho. */
  @Roles('ADMIN', 'ACCOUNTANT', 'WAREHOUSE_MANAGER')
  @Post(':id/loan-close')
  loanClose(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.sales.loanClose(id, LoanCloseSchema.parse(body), request, key);
  }

  /**
   * Bước 3 — "KD đối chiếu với khách": xác nhận phải kèm ảnh bằng chứng, hoặc yêu cầu sửa (trả phiếu về nháp).
   */
  @RequirePermission('sales.step.confirm')
  @Post(':id/customer-confirmation')
  confirmCustomer(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.sales.confirmCustomer(id, CustomerConfirmationSchema.parse(body), request, key);
  }

  /**
   * Bước 5 — xác nhận giao hàng thành công: người được phân bước 5; người có vai trò kho chỉ phiếu mình là thủ kho, người khác
   * xác nhận mọi phiếu đã xuất (kiểm tra trong service).
   */
  @RequirePermission('sales.step.deliver')
  @Post(':id/deliver')
  deliver(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.sales.deliver(id, VersionSchema.parse(body).version, request, key);
  }
}
