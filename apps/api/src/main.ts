import 'reflect-metadata';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { DOCUMENT_CONTENT_TYPES, MAX_EVIDENCE_BYTES } from '@inoxpran/contracts';
import { randomUUID } from 'node:crypto';
import { AppModule } from './app.module';
import { ApiExceptionFilter } from './common/http-exception.filter';
import { rateLimitKey, rateLimitMax } from './common/rate-limit-key';

async function bootstrap(): Promise<void> {
  const adapter = new FastifyAdapter({
    logger: {
      level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
      redact: ['req.headers.authorization', 'req.headers.cookie', 'password', '*.password'],
    },
    trustProxy: true,
  });
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, { bufferLogs: true });
  const fastify = app.getHttpAdapter().getInstance();

  await fastify.register(cookie);
  await fastify.register(helmet, { contentSecurityPolicy: false });
  await fastify.register(cors, {
    origin: process.env.WEB_ORIGIN ?? 'http://localhost:5173',
    credentials: true,
    allowedHeaders: ['content-type', 'idempotency-key', 'x-csrf-token', 'x-correlation-id', 'x-file-name'],
  });
  // Ảnh / PDF tải lên dạng nhị phân thô; máy chủ còn kiểm tra chữ ký file trước khi lưu.
  fastify.addContentTypeParser([...DOCUMENT_CONTENT_TYPES], { parseAs: 'buffer', bodyLimit: MAX_EVIDENCE_BYTES }, (_request, body, done) => done(null, body));
  // File Excel nhập dữ liệu ban đầu (/admin/import), tối đa 10 MB.
  fastify.addContentTypeParser('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', { parseAs: 'buffer', bodyLimit: 10 * 1024 * 1024 }, (_request, body, done) => done(null, body));
  // Health check (ALB, ECS) không bao giờ bị giới hạn tần suất. Đã đăng nhập: hạn mức theo tài khoản (cả văn phòng chung
  // một IP công cộng); chưa đăng nhập / cookie không hợp lệ: theo IP — common/rate-limit-key.ts.
  const jwt = app.get(JwtService, { strict: false });
  await fastify.register(rateLimit, {
    max: (_request, key) => rateLimitMax(key),
    timeWindow: '1 minute',
    keyGenerator: (request) => rateLimitKey(request, (token) => jwt.verify<{ sub?: unknown }>(token)),
    allowList: (request) => request.url.startsWith('/api/v1/health'),
  });
  fastify.addHook('onRequest', async (request, reply) => {
    const incoming = request.headers['x-correlation-id'];
    const correlationId = typeof incoming === 'string' && incoming.length <= 100 ? incoming : randomUUID();
    (request as typeof request & { correlationId: string }).correlationId = correlationId;
    reply.header('x-correlation-id', correlationId);
  });

  app.setGlobalPrefix('api/v1');
  app.useGlobalFilters(new ApiExceptionFilter());
  app.enableShutdownHooks();

  const swaggerConfig = new DocumentBuilder()
    .setTitle('INOXPRAN ERP API')
    .setDescription('API vận hành nội bộ mua hàng, kho, bán B2B và công nợ')
    .setVersion('1.0')
    .addCookieAuth('erp_session')
    .addApiKey({ type: 'apiKey', name: 'Idempotency-Key', in: 'header' }, 'idempotency')
    .build();
  SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, swaggerConfig));

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port, '0.0.0.0');
  Logger.log(`INOXPRAN ERP API listening on ${port}`, 'Bootstrap');
}

void bootstrap();
