import { Body, Controller, Delete, Get, Headers, Param, Post, Query, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import type { AuthenticatedRequest } from '../../common/request-context';
import { AttachmentsService } from './attachments.service';

/**
 * Tab "Đính kèm" của hồ sơ / chứng từ: /attachments/products/:id, /attachments/partners/:id…
 * Tải lên: thân request = dữ liệu file (ảnh PNG/JPEG/WebP hoặc PDF tùy mục đích), tên file trong header x-file-name,
 * mục đích ở ?purpose=. Quyền xem / sửa kiểm tra trong service theo từng loại hồ sơ.
 */
@ApiTags('Attachments')
@Controller('attachments')
export class AttachmentsController {
  constructor(private readonly attachments: AttachmentsService) {}

  @Get(':type/:id')
  list(@Param('type') type: string, @Param('id') id: string, @Req() request: AuthenticatedRequest) {
    return this.attachments.list(type, id, request);
  }

  @Post(':type/:id')
  upload(
    @Param('type') type: string,
    @Param('id') id: string,
    @Query('purpose') purpose: string | undefined,
    @Headers('x-file-name') fileName: string | undefined,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.attachments.upload(type, id, purpose, body, fileName, request);
  }

  @Get(':type/:id/:attachmentId')
  async read(@Param('type') type: string, @Param('id') id: string, @Param('attachmentId') attachmentId: string, @Req() request: AuthenticatedRequest, @Res() reply: FastifyReply) {
    const file = await this.attachments.read(type, id, attachmentId, request);
    await reply
      .header('content-type', file.contentType)
      .header('content-disposition', `inline; filename*=UTF-8''${encodeURIComponent(file.fileName)}`)
      .header('cache-control', 'private, max-age=86400, immutable')
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'")
      .send(file.data);
  }

  @Delete(':type/:id/:attachmentId')
  remove(@Param('type') type: string, @Param('id') id: string, @Param('attachmentId') attachmentId: string, @Req() request: AuthenticatedRequest) {
    return this.attachments.remove(type, id, attachmentId, request);
  }
}
