import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { pageRequest } from '../../../common/paging';
import type { AuthenticatedRequest } from '../../../common/request-context';
import { Roles, RootOnly } from '../../../common/roles.decorator';
import { ImportService } from './import.service';

/** Nhập dữ liệu ban đầu: chỉ tài khoản quản trị gốc (root) — ghi, đối chiếu, xác nhận, hoàn tác (09/10/2026). */
const IMPORTERS = ['ADMIN'];
const REVIEWERS = ['ADMIN'];

@ApiTags('Admin')
@RootOnly()
@Controller('admin/import')
export class ImportController {
  constructor(private readonly imports: ImportService) {}

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
  dryRun(@Body() body: unknown, @Headers('x-file-name') fileName: string | undefined) {
    return this.imports.dryRun(body, fileName ? decodeURIComponent(fileName) : undefined);
  }

  @Roles(...IMPORTERS)
  @Post('commit')
  commit(@Body() body: unknown, @Headers('x-file-name') fileName: string | undefined, @Req() request: AuthenticatedRequest) {
    return this.imports.commit(body, fileName ? decodeURIComponent(fileName) : undefined, request);
  }

  @Roles(...REVIEWERS)
  @Get('batches')
  list(@Query('page') page?: string, @Query('pageSize') pageSize?: string) {
    return this.imports.list(pageRequest(page ?? '1', pageSize, 20) ?? { page: 1, pageSize: 20, skip: 0 });
  }

  @Roles(...REVIEWERS)
  @Get('batches/:id/report')
  report(@Param('id') id: string) {
    return this.imports.report(id);
  }

  @Roles(...REVIEWERS)
  @Post('batches/:id/confirm')
  confirm(@Param('id') id: string, @Req() request: AuthenticatedRequest) {
    return this.imports.confirm(id, request);
  }

  @Roles(...IMPORTERS)
  @Post('batches/:id/rollback')
  rollback(@Param('id') id: string, @Req() request: AuthenticatedRequest) {
    return this.imports.rollback(id, request);
  }
}
