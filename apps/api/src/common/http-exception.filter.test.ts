import { HttpStatus, NotFoundException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { ApiExceptionFilter } from './http-exception.filter';

function run(exception: unknown, headers: Record<string, string> = {}) {
  const sent: { status?: number; body?: Record<string, unknown> } = {};
  const reply = {
    getHeader: (name: string) => headers[name],
    status(code: number) { sent.status = code; return this; },
    send(body: Record<string, unknown>) { sent.body = body; return this; },
  };
  const request = { correlationId: 'c-1', log: { error: () => undefined, warn: () => undefined } };
  const host = { switchToHttp: () => ({ getRequest: () => request, getResponse: () => reply }) };
  new ApiExceptionFilter().catch(exception, host as never);
  return sent;
}

describe('ApiExceptionFilter', () => {
  it('giới hạn tần suất trả 429 kèm thời gian chờ (không bị đổi thành 500)', () => {
    const limited = Object.assign(new Error('Rate limit exceeded'), { statusCode: 429 });
    const sent = run(limited, { 'retry-after': '30' });
    expect(sent.status).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect(sent.body).toMatchObject({ code: 'RATE_LIMITED', message: 'Bạn thao tác quá nhanh, vui lòng thử lại sau 30 giây' });
  });

  it('lỗi 4xx khác của Fastify giữ nguyên mã; lỗi không xác định mới là 500', () => {
    expect(run(Object.assign(new Error('Unsupported Media Type'), { statusCode: 415, code: 'FST_ERR_CTP_INVALID_MEDIA_TYPE' }))).toMatchObject({ status: 415, body: { code: 'FST_ERR_CTP_INVALID_MEDIA_TYPE' } });
    expect(run(new NotFoundException({ code: 'X', message: 'Không thấy' }))).toMatchObject({ status: 404, body: { code: 'X' } });
    expect(run(new Error('boom'))).toMatchObject({ status: 500, body: { code: 'INTERNAL_ERROR' } });
  });

  it('trùng khóa MongoDB (11000) trả 409 DUPLICATE_RECORD kèm trường bị trùng', () => {
    const duplicate = Object.assign(new Error('E11000 duplicate key error collection: inoxpran_erp.import_shipments'), { code: 11000, keyValue: { code: 'IS2610-00001' } });
    expect(run(duplicate)).toMatchObject({ status: 409, body: { code: 'DUPLICATE_RECORD', message: 'Dữ liệu trùng với bản ghi đã có (code: IS2610-00001) — tải lại rồi thử lại' } });
  });
});
