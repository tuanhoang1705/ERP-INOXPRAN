import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { type ClientSession, type Db, MongoClient, MongoServerError } from 'mongodb';
import { MONGO_CLIENT, MONGO_DATABASE } from './tokens';

interface IdempotencyRecord {
  _id: string;
  state: 'PROCESSING' | 'COMPLETED';
  requestHash: string;
  response?: unknown;
  createdAt: Date;
  completedAt?: Date;
  expiresAt: Date;
}

function canonicalize(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

export function idempotencyFingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

@Injectable()
export class IdempotencyService {
  constructor(
    @Inject(MONGO_CLIENT) private readonly client: MongoClient,
    @Inject(MONGO_DATABASE) private readonly db: Db,
  ) {}

  async execute<T>(
    scope: string,
    key: string | undefined,
    requestPayload: unknown,
    operation: (session: ClientSession) => Promise<T>,
  ): Promise<T> {
    const normalizedKey = key?.trim();
    if (!normalizedKey) {
      throw new BadRequestException({ code: 'IDEMPOTENCY_KEY_REQUIRED', message: 'Thiếu Idempotency-Key' });
    }
    if (normalizedKey.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(normalizedKey)) {
      throw new BadRequestException({
        code: 'IDEMPOTENCY_KEY_INVALID',
        message: 'Idempotency-Key không đúng định dạng hoặc dài quá 128 ký tự',
      });
    }

    const collection = this.db.collection<IdempotencyRecord>('idempotency_keys');
    const identity = `${scope}:${normalizedKey}`;
    const requestHash = idempotencyFingerprint(requestPayload);

    try {
      const result = await this.client.withSession(async (session) =>
        session.withTransaction(async () => {
          const existing = await collection.findOne({ _id: identity }, { session });
          if (existing) {
            if (existing.requestHash !== requestHash) {
              throw new ConflictException({
                code: 'IDEMPOTENCY_KEY_REUSED',
                message: 'Idempotency-Key đã được dùng cho một nội dung yêu cầu khác',
              });
            }
            if (existing.state === 'COMPLETED') return existing.response as T;
            throw new ConflictException({ code: 'COMMAND_IN_PROGRESS', message: 'Yêu cầu đang được xử lý' });
          }

          const now = new Date();
          await collection.insertOne(
            {
              _id: identity,
              state: 'PROCESSING',
              requestHash,
              createdAt: now,
              expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
            },
            { session },
          );

          const response = await operation(session);
          const completed = await collection.updateOne(
            { _id: identity, state: 'PROCESSING', requestHash },
            { $set: { state: 'COMPLETED', response, completedAt: new Date() } },
            { session },
          );
          if (completed.modifiedCount !== 1) {
            throw new ConflictException({ code: 'IDEMPOTENCY_STATE_CONFLICT', message: 'Không thể hoàn tất khóa idempotency' });
          }
          return response;
        }),
      );
      if (result === undefined) throw new Error('MongoDB transaction returned no result');
      return result;
    } catch (error) {
      // Chỉ xử lý trùng khóa của chính bảng idempotency_keys (hai yêu cầu cùng khóa chạy song song);
      // trùng khóa ở bảng nghiệp vụ (VD số chứng từ) là lỗi khác, không báo nhầm thành "Idempotency-Key đã dùng".
      if (error instanceof MongoServerError && error.code === 11000 && error.message.includes('idempotency_keys')) {
        const existing = await collection.findOne({ _id: identity });
        if (existing?.requestHash !== requestHash) {
          throw new ConflictException({
            code: 'IDEMPOTENCY_KEY_REUSED',
            message: 'Idempotency-Key đã được dùng cho một nội dung yêu cầu khác',
          });
        }
        if (existing?.state === 'COMPLETED') return existing.response as T;
        throw new ConflictException({ code: 'COMMAND_IN_PROGRESS', message: 'Yêu cầu đang được xử lý' });
      }
      throw error;
    }
  }
}
