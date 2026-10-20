import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { pageRequest } from '../../../common/paging';
import type { AuthenticatedRequest } from '../../../common/request-context';
import { Roles, RootOnly } from '../../../common/roles.decorator';
import { importModeOf, ImportService } from './import.service';
import { ArHistoryImportService } from './ar-history.service';

/** Nhập dữ liệu ban đầu: chỉ tài khoản quản trị gốc (root) — ghi, đối chiếu, xác nhận, hoàn tác (09/10/2026). */
const IMPORTERS = ['ADMIN'];
const REVIEWERS = ['ADMIN'];

@ApiTags('Admin')
@RootOnly()
@Controller('admin/import')
export class ImportController {
  constructor(
    private readonly imports: ImportService,
    private readonly arHistory: ArHistoryImportService,
  ) {}

  @Roles(...IMPORTERS)
  @Get('template')
  async template(@Res() reply: FastifyReply) {
    const file = await this.imports.template();
    await reply
      .header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('content-disposition', 'attachment; filename="INOXPRAN-nhap-du-lieu.xlsx"')
      .send(file);
  }

  /** Thân request = file .xlsx; tên file trong header x-file-name. */
  @Roles(...IMPORTERS)
  @Post('dry-run')
  @HttpCode(200)
  dryRun(@Body() body: unknown, @Headers('x-file-name') fileName: string | undefined, @Headers('x-import-mode') mode: string | undefined) {
    return this.imports.dryRun(body, fileName ? decodeURIComponent(fileName) : undefined, importModeOf(mode));
  }

  @Roles(...IMPORTERS)
  @Post('commit')
  commit(@Body() body: unknown, @Headers('x-file-name') fileName: string | undefined, @Headers('x-import-mode') mode: string | undefined, @Req() request: AuthenticatedRequest) {
    return this.imports.commit(body, fileName ? decodeURIComponent(fileName) : undefined, request, importModeOf(mode));
  }

  /** Nhập lịch sử công nợ theo khách (IMP-AR-01): thân request = file .xlsx; ngày chốt trong header x-cutoff (YYYY-MM-DD). */
  @Roles(...IMPORTERS)
  @Post('ar-history/dry-run')
  @HttpCode(200)
  arHistoryDryRun(@Body() body: unknown, @Headers('x-file-name') fileName: string | undefined, @Headers('x-cutoff') cutoff: string | undefined) {
    return this.arHistory.dryRun(body, fileName ? decodeURIComponent(fileName) : undefined, cutoff);
  }

  @Roles(...IMPORTERS)
  @Post('ar-history/commit')
  arHistoryCommit(@Body() body: unknown, @Headers('x-file-name') fileName: string | undefined, @Headers('x-cutoff') cutoff: string | undefined, @Req() request: AuthenticatedRequest) {
    return this.arHistory.commit(body, fileName ? decodeURIComponent(fileName) : undefined, cutoff, request);
  }

  /** Thay lô lịch sử bằng file mới (VD dựng từ Excel gốc, số chính xác): chạy thử so từng khách cũ → mới. */
  @Roles(...IMPORTERS)
  @Post('ar-history/batches/:id/replace/dry-run')
  @HttpCode(200)
  arHistoryReplaceDryRun(@Param('id') id: string, @Body() body: unknown, @Headers('x-file-name') fileName: string | undefined) {
    return this.arHistory.replaceDryRun(id, body, fileName ? decodeURIComponent(fileName) : undefined);
  }

  @Roles(...IMPORTERS)
  @Post('ar-history/batches/:id/replace')
  arHistoryReplace(@Param('id') id: string, @Body() body: unknown, @Headers('x-file-name') fileName: string | undefined, @Req() request: AuthenticatedRequest) {
    return this.arHistory.replace(id, body, fileName ? decodeURIComponent(fileName) : undefined, request);
  }

  /** Lô lịch sử đã ghi trước CN-SEG-01: nạp lại đúng file để bổ sung dòng hàng của phiếu trả hàng (tách phần quạt…). */
  @Roles(...IMPORTERS)
  @Post('ar-history/batches/:id/return-lines')
  @HttpCode(200)
  arHistoryReturnLines(@Param('id') id: string, @Body() body: unknown, @Req() request: AuthenticatedRequest) {
    return this.arHistory.attachReturnLines(id, body, request);
  }

  @Roles(...REVIEWERS)
  @Get('batches')
  list(@Query('page') page?: string, @Query('pageSize') pageSize?: string) {
    return this.imports.list(pageRequest(page ?? '1', pageSize, 20) ?? { page: 1, pageSize: 20, skip: 0 });
  }

  @Roles(...REVIEWERS)
  @Get('batches/:id/report')
  async report(@Param('id') id: string) {
    return (await this.imports.kindOf(id)) === 'AR_HISTORY' ? this.arHistory.report(id) : this.imports.report(id);
  }

  @Roles(...REVIEWERS)
  @Post('batches/:id/confirm')
  confirm(@Param('id') id: string, @Req() request: AuthenticatedRequest) {
    return this.imports.confirm(id, request);
  }

  @Roles(...IMPORTERS)
  @Post('batches/:id/rollback')
  async rollback(@Param('id') id: string, @Req() request: AuthenticatedRequest) {
    return (await this.imports.kindOf(id)) === 'AR_HISTORY' ? this.arHistory.rollback(id, request) : this.imports.rollback(id, request);
  }
}
