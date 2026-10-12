import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { errorMetrics } from './error-metrics';

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const request = context.getRequest<FastifyRequest & { correlationId?: string }>();
    const reply = context.getResponse<FastifyReply>();

    if (exception instanceof ZodError) {
      void reply.status(HttpStatus.BAD_REQUEST).send({
        statusCode: HttpStatus.BAD_REQUEST,
        code: 'VALIDATION_ERROR',
        // Quy tắc nghiệp vụ viết bằng refine() có câu thông báo riêng (VD: thiếu ảnh bằng chứng) — trả nguyên câu đó.
        message: exception.issues.find((issue) => issue.code === 'custom')?.message ?? 'Dữ liệu gửi lên chưa hợp lệ',
        correlationId: request.correlationId,
        details: exception.issues,
      });
      return;
    }

    if (exception instanceof HttpException) {
      if (exception.getStatus() >= 500) errorMetrics.record();
      const response = exception.getResponse();
      const body = typeof response === 'string' ? { message: response } : response;
      void reply.status(exception.getStatus()).send({
        statusCode: exception.getStatus(),
        code: (body as Record<string, unknown>).code ?? 'HTTP_ERROR',
        message: (body as Record<string, unknown>).message ?? exception.message,
        correlationId: request.correlationId,
        details: (body as Record<string, unknown>).details,
      });
      return;
    }

    // Lỗi do Fastify / plugin sinh ra (không phải HttpException của Nest) nhưng có mã 4xx: giữ nguyên mã lỗi.
    // VD: @fastify/rate-limit (429), body quá lớn (413), Content-Type không hỗ trợ (415).
    const statusCode = (exception as { statusCode?: unknown } | null)?.statusCode;
    if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
      const retryAfter = reply.getHeader('retry-after');
      void reply.status(statusCode).send({
        statusCode,
        code: statusCode === HttpStatus.TOO_MANY_REQUESTS ? 'RATE_LIMITED' : String((exception as { code?: unknown }).code ?? 'HTTP_ERROR'),
        message: statusCode === HttpStatus.TOO_MANY_REQUESTS
          ? `Bạn thao tác quá nhanh, vui lòng thử lại sau ${retryAfter ? `${String(retryAfter)} giây` : 'ít giây'}`
          : exception instanceof Error ? exception.message : 'Yêu cầu không hợp lệ',
        correlationId: request.correlationId,
      });
      return;
    }

    // MongoDB trùng khóa duy nhất (VD số chứng từ / mã đã có): báo 409 rõ ràng thay vì lỗi hệ thống.
    if ((exception as { code?: unknown } | null)?.code === 11000) {
      const keyValue = (exception as { keyValue?: Record<string, unknown> }).keyValue ?? {};
      request.log.warn({ err: exception, correlationId: request.correlationId }, 'Duplicate key');
      void reply.status(HttpStatus.CONFLICT).send({
        statusCode: HttpStatus.CONFLICT,
        code: 'DUPLICATE_RECORD',
        message: `Dữ liệu trùng với bản ghi đã có${Object.keys(keyValue).length ? ` (${Object.entries(keyValue).map(([key, value]) => `${key}: ${String(value)}`).join(', ')})` : ''} — tải lại rồi thử lại`,
        correlationId: request.correlationId,
      });
      return;
    }

    errorMetrics.record();
    request.log.error({ err: exception, correlationId: request.correlationId }, 'Unhandled request error');
    void reply.status(HttpStatus.INTERNAL_SERVER_ERROR).send({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      code: 'INTERNAL_ERROR',
      message: 'Hệ thống gặp lỗi ngoài dự kiến',
      correlationId: request.correlationId,
    });
  }
}
