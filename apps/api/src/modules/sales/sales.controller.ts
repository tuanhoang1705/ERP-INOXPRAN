import { Body, Controller, Delete, Get, Headers, Param, Patch, Post, Query, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  CreateSalesOrderSchema,
  DiscardSalesOrderSchema,
  CustomerConfirmationSchema,
  SalesPriceSheetRequestSchema,
  SalesQuoteRequestSchema,
  UpdateSalesOrderSchema,
  WarehouseIssueSchema,
} from '@inoxpran/contracts';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { assertWarehouseAccess } from '../../common/access';
import { RootOnly, Roles } from '../../common/roles.decorator';
import type { AuthenticatedRequest } from '../../common/request-context';
import { pageRequest } from '../../common/paging';
import { SalesService } from './sales.service';

const VersionSchema = z.object({ version: z.number().int().positive() });

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
  ) {
    return this.sales.list(request.user, status, search, channel, customerId, confirmation, pageRequest(page, pageSize));
  }

  @Roles('ADMIN', 'SALES', 'SALES_MANAGER', 'ACCOUNTANT', 'DIRECTOR')
  @Post('quote')
  quote(@Body() body: unknown, @Req() request: AuthenticatedRequest) {
    const input = SalesQuoteRequestSchema.parse(body);
    assertWarehouseAccess(request, input.warehouseId);
    return this.sales.quote(input);
  }

  /** Bảng giá của khách tại kho xuất để form phiếu tính tiền tức thời. */
  @Roles('ADMIN', 'SALES', 'SALES_MANAGER', 'ACCOUNTANT', 'DIRECTOR')
  @Get('price-sheet')
  priceSheet(@Query() query: unknown, @Req() request: AuthenticatedRequest) {
    const input = SalesPriceSheetRequestSchema.parse(query);
    assertWarehouseAccess(request, input.warehouseId);
    return this.sales.priceSheet(input.customerId, input.warehouseId);
  }

  /** Tài khoản thủ kho có phạm vi kho xuất, để kế toán chọn người tiếp nhận phiếu. */
  @Roles('ADMIN', 'SALES', 'SALES_MANAGER', 'ACCOUNTANT', 'DIRECTOR')
  @Get('warehouse-keepers')
  warehouseKeepers(@Query('warehouseId') warehouseId: string, @Req() request: AuthenticatedRequest) {
    assertWarehouseAccess(request, warehouseId);
    return this.sales.warehouseKeepers(warehouseId);
  }

  @Get(':id')
  get(@Param('id') id: string, @Req() request: AuthenticatedRequest) {
    return this.sales.get(id, request.user);
  }

  /** Tải ảnh bằng chứng đối chiếu (thân request = dữ liệu ảnh PNG/JPEG/WebP, tên file trong header x-file-name). */
  @Roles('ADMIN', 'ACCOUNTANT', 'SALES', 'SALES_MANAGER')
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

  @Roles('ADMIN', 'ACCOUNTANT', 'SALES', 'SALES_MANAGER')
  @Delete(':id/attachments/:attachmentId')
  deleteEvidence(@Param('id') id: string, @Param('attachmentId') attachmentId: string, @Req() request: AuthenticatedRequest) {
    return this.sales.deletePendingEvidence(id, attachmentId, request);
  }

  /** Kế toán lập phiếu xuất kho bán hàng (BH); kinh doanh có thể lập đề nghị nháp. */
  @Roles('ADMIN', 'ACCOUNTANT', 'SALES', 'SALES_MANAGER')
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

  /** Kế toán sửa phiếu nháp hoặc phiếu bị kinh doanh trả về. */
  @Roles('ADMIN', 'ACCOUNTANT', 'SALES', 'SALES_MANAGER')
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

  /** Quản trị gốc sửa phiếu ở mọi giai đoạn sau khi phát hành (tồn kho / công nợ tự điều chỉnh theo chênh lệch). */
  @RootOnly()
  @Patch(':id/root')
  rootUpdate(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.sales.rootUpdate(id, UpdateSalesOrderSchema.parse(body), request, key);
  }

  /** Quản trị gốc hủy phiếu đã xuất kho / đã giao bằng bút toán đảo (nhập lại kho, công nợ hủy, tiền đã thu thành trả trước). */
  @RootOnly()
  @Post(':id/void')
  rootVoid(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.sales.rootVoid(id, DiscardSalesOrderSchema.parse(body), request, key);
  }

  /** Kế toán xóa hẳn phiếu nháp (kể cả phiếu bị KD trả về) — bắt buộc lý do, nội dung giữ trong nhật ký. */
  @Roles('ADMIN', 'ACCOUNTANT')
  @Delete(':id')
  remove(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.sales.remove(id, DiscardSalesOrderSchema.parse(body), request, key);
  }

  /** Kế toán hủy phiếu đã phát hành nhưng chưa xuất kho — giữ số, trả hàng giữ chỗ, bắt buộc lý do. */
  @Roles('ADMIN', 'ACCOUNTANT')
  @Post(':id/cancel')
  cancel(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.sales.cancel(id, DiscardSalesOrderSchema.parse(body), request, key);
  }

  /** Kế toán phát hành phiếu BH: kiểm tra ngưỡng duyệt, hạn mức và giữ hàng. */
  @Roles('ADMIN', 'ACCOUNTANT')
  @Post(':id/submit')
  submit(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.sales.submit(id, VersionSchema.parse(body).version, request, key);
  }

  @Roles('ADMIN', 'SALES_MANAGER', 'DIRECTOR')
  @Post(':id/approve')
  approve(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.sales.approve(id, VersionSchema.parse(body).version, request, key);
  }

  @Roles('ADMIN', 'WAREHOUSE', 'WAREHOUSE_MANAGER')
  @Post(':id/ship')
  ship(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.sales.ship(id, WarehouseIssueSchema.parse(body), request, key);
  }

  /**
   * Bước "KD đối chiếu với khách" (thuộc phần việc của kế toán / kinh doanh): xác nhận phải kèm ảnh bằng chứng,
   * hoặc yêu cầu sửa (trả phiếu về nháp).
   */
  @Roles('ADMIN', 'ACCOUNTANT', 'SALES', 'SALES_MANAGER')
  @Post(':id/customer-confirmation')
  confirmCustomer(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.sales.confirmCustomer(id, CustomerConfirmationSchema.parse(body), request, key);
  }

  /** Hai bước cuối (lập SWK, xác nhận đã giao) chỉ do thủ kho được giao phiếu thực hiện. */
  @Roles('ADMIN', 'WAREHOUSE', 'WAREHOUSE_MANAGER')
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
