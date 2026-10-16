import { Body, Controller, Delete, Get, Headers, HttpCode, Param, Patch, Post, Query, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CreateWarrantyTicketSchema, isDateOnly, WARRANTY_PHOTO_KINDS, WarrantyActionSchema, WarrantyFaultCodeInputSchema } from '@inoxpran/contracts';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { pageRequest } from '../../common/paging';
import { onlyProvided } from '../../common/patch';
import { Roles } from '../../common/roles.decorator';
import type { AuthenticatedRequest } from '../../common/request-context';
import { WarrantyFaultCodesService } from './warranty-fault-codes.service';
import { WARRANTY_STAFF_ROLES, WARRANTY_VIEWER_ROLES, WarrantyService } from './warranty.service';

const CoveragePreviewSchema = z.object({
  productId: z.string().min(1),
  invoiceNumber: z.string().trim().max(40).optional(),
  invoiceDate: z.string().refine(isDateOnly).optional(),
  receivedDate: z.string().refine(isDateOnly, 'Ngày tiếp nhận phải có dạng YYYY-MM-DD'),
});
const PhotoKindSchema = z.enum(WARRANTY_PHOTO_KINDS).default('OTHER');
const UpdateFaultCodeSchema = WarrantyFaultCodeInputSchema.omit({ code: true }).partial();
/** Danh mục mã lỗi: nhân viên bảo hành và Giám đốc quản lý. */
const FAULT_CODE_EDITORS = ['ADMIN', 'DIRECTOR', 'WARRANTY'];

@ApiTags('Warranty')
@Controller('warranty')
export class WarrantyController {
  constructor(
    private readonly warranty: WarrantyService,
    private readonly faultCodes: WarrantyFaultCodesService,
  ) {}

  @Roles(...WARRANTY_VIEWER_ROLES)
  @Get('settings')
  settings() {
    return this.warranty.settings();
  }

  @Roles(...WARRANTY_VIEWER_ROLES)
  @Get('technicians')
  technicians() {
    return this.warranty.technicians();
  }

  /** Xem trước còn / hết bảo hành cho form tiếp nhận. */
  @Roles(...WARRANTY_STAFF_ROLES)
  @Get('coverage')
  coverage(@Query() query: unknown) {
    const input = CoveragePreviewSchema.parse(query);
    return this.warranty.coveragePreview(input.productId, input.invoiceNumber, input.invoiceDate, input.receivedDate);
  }

  /** Báo cáo: tỉ lệ đúng hẹn, thời gian xử lý, lỗi theo mã hàng / mã lỗi, chi phí, từ chối, sản phẩm bảo hành từ 3 lần. */
  @Roles(...WARRANTY_VIEWER_ROLES)
  @Get('reports')
  report(@Query('from') from?: string, @Query('to') to?: string) {
    return this.warranty.report(from, to);
  }

  // ---------- Mã lỗi ----------

  @Roles(...WARRANTY_VIEWER_ROLES)
  @Get('fault-codes')
  listFaultCodes(@Query('categoryId') categoryId?: string, @Query('all') all?: string) {
    return this.faultCodes.list(categoryId || undefined, all === '1' || all === 'true');
  }

  @Roles(...FAULT_CODE_EDITORS)
  @Post('fault-codes')
  createFaultCode(@Body() body: unknown, @Req() request: AuthenticatedRequest) {
    return this.faultCodes.create(WarrantyFaultCodeInputSchema.parse(body), request);
  }

  @Roles(...FAULT_CODE_EDITORS)
  @Patch('fault-codes/:id')
  updateFaultCode(@Param('id') id: string, @Body() body: unknown, @Req() request: AuthenticatedRequest) {
    return this.faultCodes.update(id, onlyProvided(body, UpdateFaultCodeSchema.parse(body)), request);
  }

  @Roles(...FAULT_CODE_EDITORS)
  @Delete('fault-codes/:id')
  @HttpCode(204)
  deleteFaultCode(@Param('id') id: string, @Req() request: AuthenticatedRequest) {
    return this.faultCodes.remove(id, request);
  }

  // ---------- Phiếu ----------

  @Roles(...WARRANTY_VIEWER_ROLES)
  @Get('tickets')
  list(
    @Query('status') status?: string, @Query('tone') tone?: string, @Query('search') search?: string, @Query('page') page?: string, @Query('pageSize') pageSize?: string,
    @Query('customerId') customerId?: string, @Query('from') from?: string, @Query('to') to?: string,
  ) {
    return this.warranty.list({ status, tone, search, customerId, from, to }, pageRequest(page, pageSize));
  }

  @Roles(...WARRANTY_VIEWER_ROLES)
  @Get('tickets/:id')
  get(@Param('id') id: string) {
    return this.warranty.get(id);
  }

  @Roles(...WARRANTY_STAFF_ROLES)
  @Post('tickets')
  create(@Body() body: unknown, @Req() request: AuthenticatedRequest, @Headers('idempotency-key') key: string | undefined) {
    return this.warranty.create(CreateWarrantyTicketSchema.parse(body), request, key);
  }

  /** Nhân viên bảo hành cập nhật phiếu; Giám đốc duyệt (service kiểm tra quyền theo từng thao tác). */
  @Roles(...WARRANTY_VIEWER_ROLES)
  @Post('tickets/:id/actions')
  act(@Param('id') id: string, @Body() body: unknown, @Req() request: AuthenticatedRequest, @Headers('idempotency-key') key: string | undefined) {
    return this.warranty.act(id, WarrantyActionSchema.parse(body), request, key);
  }

  /** Ảnh khi nhận / phiếu đã ký: thân request = dữ liệu ảnh PNG/JPEG/WebP, tên file trong header x-file-name, loại ảnh ở ?kind=. */
  @Roles(...WARRANTY_STAFF_ROLES)
  @Post('tickets/:id/photos')
  uploadPhoto(@Param('id') id: string, @Body() body: unknown, @Query('kind') kind: string | undefined, @Headers('x-file-name') fileName: string | undefined, @Req() request: AuthenticatedRequest) {
    return this.warranty.uploadPhoto(id, body, fileName, PhotoKindSchema.parse(kind), request);
  }

  @Roles(...WARRANTY_VIEWER_ROLES)
  @Get('tickets/:id/photos/:photoId')
  async readPhoto(@Param('id') id: string, @Param('photoId') photoId: string, @Res() reply: FastifyReply) {
    const file = await this.warranty.readPhoto(id, photoId);
    await reply
      .header('content-type', file.contentType)
      .header('content-disposition', `inline; filename*=UTF-8''${encodeURIComponent(file.fileName)}`)
      .header('cache-control', 'private, max-age=86400, immutable')
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'")
      .send(file.data);
  }

  @Roles(...WARRANTY_STAFF_ROLES)
  @Delete('tickets/:id/photos/:photoId')
  deletePhoto(@Param('id') id: string, @Param('photoId') photoId: string, @Req() request: AuthenticatedRequest) {
    return this.warranty.deletePhoto(id, photoId, request);
  }
}
