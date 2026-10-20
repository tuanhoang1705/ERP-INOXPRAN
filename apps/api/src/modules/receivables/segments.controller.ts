import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { DebtSegmentInputSchema, SetSegmentPartnerSchema, SetSegmentTagSchema, SkuAliasSchema, UpdateDebtSegmentSchema } from '@inoxpran/contracts';
import { Roles } from '../../common/roles.decorator';
import type { AuthenticatedRequest } from '../../common/request-context';
import { ReceivablesService } from './receivables.service';
import { SegmentsService } from './segments.service';

/** Nhóm công nợ tách riêng (CN-SEG-01): cấu hình, ghép mã hàng cũ, áp dụng / hoàn tác, gắn tay theo chứng từ. */
@ApiTags('Receivables')
@Controller()
export class SegmentsController {
  constructor(
    private readonly segments: SegmentsService,
    private readonly receivables: ReceivablesService,
  ) {}

  @Get('receivables/segments')
  list() {
    return this.segments.list();
  }

  @Roles('ADMIN')
  @Post('receivables/segments')
  create(@Body() body: unknown, @Req() request: AuthenticatedRequest) {
    return this.segments.create(DebtSegmentInputSchema.parse(body), request);
  }

  @Roles('ADMIN')
  @Get('receivables/segments/sku-report')
  skuReport() {
    return this.segments.skuReport();
  }

  @Roles('ADMIN')
  @Put('receivables/segments/sku-aliases')
  setAlias(@Body() body: unknown, @Req() request: AuthenticatedRequest) {
    return this.segments.setAlias(SkuAliasSchema.parse(body), request);
  }

  @Roles('ADMIN')
  @Post('receivables/segments/preview')
  preview() {
    return this.segments.preview();
  }

  @Roles('ADMIN')
  @Post('receivables/segments/apply')
  apply(@Req() request: AuthenticatedRequest) {
    return this.segments.apply(request);
  }

  @Roles('ADMIN')
  @Get('receivables/segments/applies')
  applies() {
    return this.segments.applies();
  }

  @Roles('ADMIN')
  @Post('receivables/segments/applies/:id/undo')
  undo(@Param('id') id: string, @Req() request: AuthenticatedRequest) {
    return this.segments.undo(id, request);
  }

  /** Bật / tắt một khách trong nhóm "chọn khách" — phân bổ lại ngay khách đó. */
  @Roles('ADMIN')
  @Put('receivables/segments/:code/partners/:partnerId')
  setPartner(@Param('code') code: string, @Param('partnerId') partnerId: string, @Body() body: unknown, @Req() request: AuthenticatedRequest) {
    return this.segments.setPartner(code.toUpperCase(), partnerId, SetSegmentPartnerSchema.parse(body).enabled, request);
  }

  @Roles('ADMIN')
  @Patch('receivables/segments/:code')
  update(@Param('code') code: string, @Body() body: unknown, @Req() request: AuthenticatedRequest) {
    return this.segments.update(code.toUpperCase(), UpdateDebtSegmentSchema.parse(body), request);
  }

  /** Xóa nhóm: phần nợ nhóm của các khách chuyển về nợ thường, tiền đã thu phân bổ lại (tổng nợ không đổi). */
  @Roles('ADMIN')
  @Delete('receivables/segments/:code')
  remove(@Param('code') code: string, @Req() request: AuthenticatedRequest) {
    return this.segments.remove(code.toUpperCase(), request);
  }

  /** Gắn tay cả chứng từ vào nhóm (VD "Hàng mẫu") hoặc gỡ ra — kế toán / Admin, bắt buộc lý do. */
  @Roles('ADMIN', 'ACCOUNTANT')
  @Patch('receivables/:id/segment-tag')
  tag(@Param('id') id: string, @Body() body: unknown, @Req() request: AuthenticatedRequest) {
    return this.receivables.setSegmentTag(id, SetSegmentTagSchema.parse(body), request);
  }
}
