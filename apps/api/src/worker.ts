import { config } from 'dotenv';
import { resolve } from 'node:path';
import { Queue, UnrecoverableError, Worker, type Job } from 'bullmq';
import IORedis from 'ioredis';
import { type Document, MongoClient, ObjectId } from 'mongodb';
import { ObjectStorage } from './common/object-storage';
import { runOverdueReview } from './modules/receivables/overdue-review';
import { cleanupPendingEvidence } from './modules/sales/evidence-cleanup';
import { runCrmFollowUpReview } from './modules/crm/follow-up-review';
import { runWarrantySlaReview } from './modules/warranty/warranty-sla';

config({ path: process.env.ENV_FILE ?? resolve(process.cwd(), '../../.env'), quiet: true });

const QUEUE_NAME = 'erp-outbox';
const SCHEDULE_QUEUE = 'erp-scheduled';
const NOTIFICATION_EVENTS = new Set(['APPROVAL_REQUESTED', 'NOTIFICATION_REQUESTED']);
const RELAY_LOCK_MS = 60_000;

interface OutboxDocument extends Document {
  _id: ObjectId;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  status: 'PENDING' | 'PROCESSING' | 'ENQUEUED' | 'SENT' | 'DEAD_LETTER';
  relayAttempts: number;
  availableAt: Date;
  occurredAt: Date;
}

interface OutboxJobData {
  outboxEventId: string;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

async function main(): Promise<void> {
  const mongo = new MongoClient(required('MONGODB_URI'), {
    retryWrites: true,
    readConcern: { level: 'majority' },
    writeConcern: { w: 'majority', journal: true },
    appName: 'inoxpran-erp-worker',
  });
  await mongo.connect();
  const db = mongo.db(process.env.MONGODB_DATABASE ?? 'inoxpran_erp');
  const redisUrl = required('REDIS_URL');
  const queueConnection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
  const workerConnection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
  const queue = new Queue<OutboxJobData>(QUEUE_NAME, { connection: queueConnection });

  const worker = new Worker<OutboxJobData>(
    QUEUE_NAME,
    async (job) => {
      const eventId = new ObjectId(job.data.outboxEventId);
      const event = await db.collection<OutboxDocument>('outbox_events').findOne({ _id: eventId });
      if (!event || event.status === 'SENT') return;
      if (!NOTIFICATION_EVENTS.has(event.eventType)) {
        await db.collection('outbox_events').updateOne(
          { _id: eventId },
          { $set: { status: 'DEAD_LETTER', lastError: `Unsupported event type: ${event.eventType}`, failedAt: new Date() } },
        );
        throw new UnrecoverableError(`Unsupported event type: ${event.eventType}`);
      }

      const targetRoles = stringArray(event.payload.targetRoles);
      const targetUserIds = stringArray(event.payload.targetUserIds).filter((value) => ObjectId.isValid(value)).map((value) => new ObjectId(value));
      const users = await db.collection('users').find({
        status: 'ACTIVE',
        $or: [{ roles: { $in: targetRoles } }, { _id: { $in: targetUserIds } }],
      }).toArray();
      if (users.length === 0) throw new Error('No active notification recipient matches target roles or users');

      const now = new Date();
      await db.collection('notifications').bulkWrite(
        users.map((user) => ({
          updateOne: {
            filter: { outboxEventId: eventId, userId: user._id },
            update: {
              $setOnInsert: {
                _id: new ObjectId(),
                outboxEventId: eventId,
                userId: user._id,
                category: event.payload.category ?? (event.eventType === 'APPROVAL_REQUESTED' ? 'APPROVAL' : 'SYSTEM'),
                level: event.payload.level ?? 'WARNING',
                title: event.payload.title ?? 'Có chứng từ chờ phê duyệt',
                message: event.payload.message ?? `${event.aggregateType} ${event.aggregateId} đang chờ phê duyệt`,
                href: event.payload.href,
                ...(event.payload.template ? { template: event.payload.template, params: event.payload.params ?? {} } : {}),
                entityType: event.aggregateType,
                entityId: event.aggregateId,
                readAt: null,
                createdAt: now,
              },
            },
            upsert: true,
          },
        })),
        { ordered: false },
      );
      await db.collection('outbox_events').updateOne(
        { _id: eventId },
        { $set: { status: 'SENT', sentAt: new Date() }, $unset: { lockedUntil: '', lastError: '' } },
      );
    },
    { connection: workerConnection, concurrency: 5 },
  );

  worker.on('failed', (job: Job<OutboxJobData> | undefined, error: Error) => {
    if (!job) return;
    const attempts = Number(job.opts.attempts ?? 1);
    const terminal = error instanceof UnrecoverableError || job.attemptsMade >= attempts;
    void db.collection('outbox_events').updateOne(
      { _id: new ObjectId(job.data.outboxEventId), status: { $ne: 'SENT' } },
      {
        $set: {
          status: terminal ? 'DEAD_LETTER' : 'ENQUEUED',
          lastError: error.message.slice(0, 1000),
          lastFailedAt: new Date(),
          ...(terminal ? { failedAt: new Date() } : {}),
        },
      },
    );
  });

  let relayRunning = false;
  async function relayBatch(): Promise<void> {
    if (relayRunning) return;
    relayRunning = true;
    try {
      for (let index = 0; index < 50; index += 1) {
        const now = new Date();
        const event = await db.collection<OutboxDocument>('outbox_events').findOneAndUpdate(
          {
            $or: [
              { status: 'PENDING', availableAt: { $lte: now } },
              { status: 'PROCESSING', lockedUntil: { $lte: now } },
            ],
          },
          {
            $set: { status: 'PROCESSING', lockedUntil: new Date(now.getTime() + RELAY_LOCK_MS) },
            $inc: { relayAttempts: 1 },
          },
          { sort: { occurredAt: 1 }, returnDocument: 'after' },
        );
        if (!event) break;
        try {
          await queue.add(
            event.eventType,
            { outboxEventId: event._id.toHexString() },
            {
              jobId: event._id.toHexString(),
              attempts: 5,
              backoff: { type: 'exponential', delay: 2_000 },
              removeOnComplete: { age: 86_400, count: 10_000 },
              removeOnFail: { age: 604_800, count: 10_000 },
            },
          );
          await db.collection('outbox_events').updateOne(
            { _id: event._id, status: 'PROCESSING' },
            { $set: { status: 'ENQUEUED', enqueuedAt: new Date() }, $unset: { lockedUntil: '', lastError: '' } },
          );
        } catch (error) {
          const delaySeconds = Math.min(60, 2 ** Math.min(event.relayAttempts, 6));
          await db.collection('outbox_events').updateOne(
            { _id: event._id, status: 'PROCESSING' },
            {
              $set: {
                status: 'PENDING',
                availableAt: new Date(Date.now() + delaySeconds * 1_000),
                lastError: (error instanceof Error ? error.message : String(error)).slice(0, 1000),
              },
              $unset: { lockedUntil: '' },
            },
          );
        }
      }
    } finally {
      relayRunning = false;
    }
  }

  // Giải thuật 3: rà soát công nợ quá hạn lúc 06:00 giờ Việt Nam mỗi ngày (cùng hàng đợi với tác vụ dọn ảnh chờ).
  const scheduleConnection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
  const scheduleQueue = new Queue(SCHEDULE_QUEUE, { connection: queueConnection });
  await scheduleQueue.upsertJobScheduler(
    'overdue-review-daily',
    { pattern: process.env.OVERDUE_REVIEW_CRON ?? '0 6 * * *', tz: 'Asia/Ho_Chi_Minh' },
    { name: 'overdue-review', opts: { attempts: 3, backoff: { type: 'exponential', delay: 60_000 } } },
  );
  // Dọn ảnh bằng chứng tải lên nhưng không dùng (quá 24 giờ) — mỗi giờ một lần.
  const storage = new ObjectStorage(process.env);
  if (storage.configured) {
    await scheduleQueue.upsertJobScheduler(
      'evidence-cleanup-hourly',
      { pattern: process.env.EVIDENCE_CLEANUP_CRON ?? '15 * * * *', tz: 'Asia/Ho_Chi_Minh' },
      { name: 'evidence-cleanup', opts: { attempts: 3, backoff: { type: 'exponential', delay: 60_000 } } },
    );
  }
  // Nhắc hẹn trả bảo hành: phiếu sang vàng (qua 70% thời gian hẹn) hoặc đỏ (quá hẹn) — mỗi giờ một lần.
  await scheduleQueue.upsertJobScheduler(
    'warranty-sla-hourly',
    { pattern: process.env.WARRANTY_SLA_CRON ?? '5 * * * *', tz: 'Asia/Ho_Chi_Minh' },
    { name: 'warranty-sla', opts: { attempts: 3, backoff: { type: 'exponential', delay: 60_000 } } },
  );
  // Nhắc chăm sóc khách (CRM): 07:30 mỗi sáng, một thông báo gộp cho mỗi người phụ trách.
  await scheduleQueue.upsertJobScheduler(
    'crm-follow-up-daily',
    { pattern: process.env.CRM_FOLLOW_UP_CRON ?? '30 7 * * *', tz: 'Asia/Ho_Chi_Minh' },
    { name: 'crm-follow-up', opts: { attempts: 3, backoff: { type: 'exponential', delay: 60_000 } } },
  );
  const scheduleWorker = new Worker(
    SCHEDULE_QUEUE,
    async (job) => {
      if (job.name === 'crm-follow-up') {
        const review = await runCrmFollowUpReview(db);
        if (review.owners) process.stdout.write(`CRM follow-up: ${review.due} due today, ${review.overdue} overdue, ${review.owners} owners.\n`);
        return review;
      }
      if (job.name === 'evidence-cleanup') {
        const cleanup = await cleanupPendingEvidence(db, storage);
        if (cleanup.removed || cleanup.failed) process.stdout.write(`Evidence cleanup: removed ${cleanup.removed}, failed ${cleanup.failed}.\n`);
        return cleanup;
      }
      if (job.name === 'warranty-sla') {
        const review = await runWarrantySlaReview(db);
        if (review.warning || review.overdue) process.stdout.write(`Warranty SLA: ${review.warning} due soon, ${review.overdue} overdue.\n`);
        return review;
      }
      if (job.name !== 'overdue-review') throw new UnrecoverableError(`Unknown scheduled job: ${job.name}`);
      const result = await runOverdueReview(db);
      process.stdout.write(
        `Overdue review ${result.reviewDate}: ${result.reminder}/${result.warning}/${result.danger}, locked ${result.lockedPartners.length}.\n`,
      );
      return result;
    },
    { connection: scheduleConnection, concurrency: 1 },
  );

  await Promise.all([queue.waitUntilReady(), worker.waitUntilReady(), scheduleQueue.waitUntilReady(), scheduleWorker.waitUntilReady()]);
  await relayBatch();
  const relayTimer = setInterval(() => void relayBatch(), 1_000);
  // Nhịp tim cho màn giám sát hệ thống: quá 3 phút không cập nhật thì báo vàng, quá 10 phút báo đỏ.
  const beat = () => db.collection<{ _id: string } & Document>('settings').updateOne(
    { _id: 'worker-heartbeat' },
    { $set: { at: new Date(), pid: process.pid, version: process.env.APP_VERSION ?? 'dev' } },
    { upsert: true },
  ).catch(() => undefined);
  await beat();
  const heartbeatTimer = setInterval(() => void beat(), 60_000);
  process.stdout.write('INOXPRAN background worker is ready.\n');

  let shuttingDown = false;
  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stdout.write(`Worker received ${signal}; shutting down.\n`);
    clearInterval(relayTimer);
    clearInterval(heartbeatTimer);
    await worker.close();
    await scheduleWorker.close();
    await queue.close();
    await scheduleQueue.close();
    await Promise.all([queueConnection.quit(), workerConnection.quit(), scheduleConnection.quit()]);
    await mongo.close();
  }

  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
