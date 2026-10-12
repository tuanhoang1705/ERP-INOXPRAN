import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { HealthState, SystemCheck, SystemStatus } from '@inoxpran/contracts';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import type { Db, Document } from 'mongodb';
import { errorMetrics } from '../../common/error-metrics';
import { MalwareScannerService } from '../../common/malware-scanner.service';
import { ObjectStorageService } from '../../common/object-storage.service';
import { MONGO_DATABASE } from '../../common/tokens';
import { vnDate } from '@inoxpran/contracts';

/** Tên hàng đợi BullMQ do worker dùng (apps/api/src/worker.ts). */
const QUEUES = ['erp-outbox', 'erp-scheduled'];
const MINUTE = 60_000;
const timeout = <T>(promise: Promise<T>, ms = 3_000): Promise<T> =>
  Promise.race([promise, new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);

/**
 * Giám sát hệ thống cho tài khoản quản trị: trạng thái từng thành phần (xanh / vàng / đỏ), hàng đợi, sao lưu,
 * lỗi 5xx theo ngày và tình hình đăng nhập. Chỉ đọc; cảnh báo qua email do CloudWatch / SNS lo ở hạ tầng.
 */
@Injectable()
export class SystemService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('SystemMonitor');
  private redis: IORedis | null = null;
  private queues: Queue[] = [];
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(MONGO_DATABASE) private readonly db: Db,
    private readonly config: ConfigService,
    private readonly scanner: MalwareScannerService,
    private readonly storage: ObjectStorageService,
  ) {}

  onModuleInit(): void {
    this.flushTimer = setInterval(() => void this.flushErrors(), 30_000);
    this.flushTimer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.flushTimer) clearInterval(this.flushTimer);
    await this.flushErrors();
    await Promise.all(this.queues.map((queue) => queue.close().catch(() => undefined)));
    this.redis?.disconnect();
  }

  /** Ghi dồn số lỗi 5xx trong bộ nhớ xuống DB theo ngày (giờ Việt Nam). */
  async flushErrors(): Promise<void> {
    const count = errorMetrics.drain();
    if (!count) return;
    try {
      await this.db.collection<{ _id: string } & Document>('system_metrics').updateOne(
        { _id: `errors:${vnDate(new Date())}` },
        { $inc: { errors5xx: count }, $set: { updatedAt: new Date() } },
        { upsert: true },
      );
    } catch (error) {
      errorMetrics.restore(count);
      this.logger.warn(`Không ghi được số lỗi 5xx: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private queueClients(): Queue[] {
    if (!this.queues.length) {
      this.redis = new IORedis(this.config.get<string>('REDIS_URL') ?? 'redis://localhost:6379', {
        maxRetriesPerRequest: null,
        lazyConnect: true,
        enableOfflineQueue: true,
        connectTimeout: 2_000,
      });
      this.redis.on('error', () => undefined);
      this.queues = QUEUES.map((name) => new Queue(name, { connection: this.redis as IORedis }));
    }
    return this.queues;
  }

  async status(): Promise<SystemStatus> {
    await this.flushErrors();
    const now = new Date();
    const checks: SystemCheck[] = [];
    const add = (key: string, state: HealthState, detail: string, params?: Record<string, string | number>) => checks.push({ key, state, detail, ...(params ? { params } : {}) });

    // MongoDB
    let database = { dataSizeBytes: 0, storageSizeBytes: 0, collections: 0, objects: 0 };
    try {
      await timeout(this.db.command({ ping: 1 }));
      const stats = await timeout(this.db.command({ dbStats: 1 }));
      database = { dataSizeBytes: Number(stats.dataSize ?? 0), storageSizeBytes: Number(stats.storageSize ?? 0), collections: Number(stats.collections ?? 0), objects: Number(stats.objects ?? 0) };
      add('database', 'ok', 'DB_OK', { objects: database.objects });
      try {
        const replica = await timeout(this.db.admin().command({ replSetGetStatus: 1 }));
        const primary = (replica.members as Array<{ stateStr: string }> | undefined)?.some((member) => member.stateStr === 'PRIMARY');
        add('replica', primary ? 'ok' : 'error', primary ? 'REPLICA_OK' : 'REPLICA_NO_PRIMARY', { set: String(replica.set ?? '') });
      } catch {
        add('replica', 'warning', 'REPLICA_UNKNOWN');
      }
    } catch {
      add('database', 'error', 'DB_DOWN');
    }

    // Redis + hàng đợi BullMQ
    const queues: SystemStatus['queues'] = [];
    try {
      for (const queue of this.queueClients()) {
        const counts = await timeout(queue.getJobCounts('waiting', 'active', 'delayed', 'failed'));
        queues.push({ name: queue.name, waiting: counts.waiting ?? 0, active: counts.active ?? 0, delayed: counts.delayed ?? 0, failed: counts.failed ?? 0 });
      }
      const failed = queues.reduce((sum, row) => sum + row.failed, 0);
      const waiting = queues.reduce((sum, row) => sum + row.waiting, 0);
      add('redis', 'ok', 'REDIS_OK');
      add('queue', failed > 0 || waiting > 100 ? 'warning' : 'ok', failed > 0 ? 'QUEUE_FAILED' : waiting > 100 ? 'QUEUE_BACKLOG' : 'QUEUE_OK', { failed, waiting });
    } catch {
      add('redis', 'error', 'REDIS_DOWN');
    }

    // Worker (heartbeat mỗi phút)
    const settings = this.db.collection<{ _id: string } & Document>('settings');
    const heartbeat = await settings.findOne({ _id: 'worker-heartbeat' }).catch(() => null);
    const beatAt = heartbeat?.at instanceof Date ? heartbeat.at : null;
    const beatAge = beatAt ? Math.round((now.getTime() - beatAt.getTime()) / MINUTE) : null;
    add('worker', beatAge === null ? 'error' : beatAge <= 3 ? 'ok' : beatAge <= 10 ? 'warning' : 'error', beatAge === null ? 'WORKER_NEVER' : beatAge <= 3 ? 'WORKER_OK' : 'WORKER_STALE', beatAge === null ? undefined : { minutes: beatAge });

    // ClamAV
    if (this.scanner.mode === 'off') add('clamav', 'warning', 'CLAMAV_OFF');
    else {
      const version = await timeout(this.scanner.engineVersion(), 4_000).catch(() => null);
      add('clamav', version ? 'ok' : 'error', version ? 'CLAMAV_OK' : 'CLAMAV_DOWN', version ? { version } : undefined);
    }

    // S3
    if (!this.storage.configured) add('storage', 'warning', 'S3_NOT_CONFIGURED');
    else add('storage', (await timeout(this.storage.healthy(), 4_000).catch(() => false)) ? 'ok' : 'error', 'S3_CHECK', { bucket: this.storage.bucket });

    // Outbox
    const outboxCollection = this.db.collection('outbox_events');
    const [pending, deadLetter] = await Promise.all([
      outboxCollection.countDocuments({ status: { $in: ['PENDING', 'PROCESSING'] } }),
      outboxCollection.countDocuments({ status: 'DEAD_LETTER' }),
    ]);
    add('outbox', deadLetter > 0 ? 'warning' : pending > 200 ? 'warning' : 'ok', deadLetter > 0 ? 'OUTBOX_DEAD_LETTER' : pending > 200 ? 'OUTBOX_BACKLOG' : 'OUTBOX_OK', { pending, deadLetter });

    // Sao lưu (script sao lưu trên máy chủ ghi system_jobs)
    const backup = await this.db.collection('system_jobs').find({ type: 'BACKUP' }).sort({ at: -1 }).limit(1).next();
    const environment = this.config.get<string>('APP_ENV') ?? process.env.APP_ENV ?? 'development';
    let lastBackup: SystemStatus['lastBackup'];
    if (backup?.at instanceof Date) {
      const hours = (now.getTime() - backup.at.getTime()) / (60 * MINUTE);
      lastBackup = { at: backup.at.toISOString(), status: String(backup.status ?? 'UNKNOWN'), ...(backup.sizeBytes ? { sizeBytes: Number(backup.sizeBytes) } : {}), ...(backup.location ? { location: String(backup.location) } : {}) };
      const failed = backup.status !== 'SUCCESS';
      add('backup', failed || hours > 6 ? 'error' : hours > 2 ? 'warning' : 'ok', failed ? 'BACKUP_FAILED' : hours > 2 ? 'BACKUP_STALE' : 'BACKUP_OK', { hours: Math.round(hours * 10) / 10 });
    } else {
      add('backup', environment === 'production' ? 'error' : 'unknown', 'BACKUP_NONE');
    }

    // Lỗi 5xx 7 ngày gần nhất
    const days = Array.from({ length: 7 }, (_, index) => vnDate(new Date(now.getTime() - (6 - index) * 24 * 60 * MINUTE)));
    const metricRows = await this.db.collection<{ _id: string } & Document>('system_metrics').find({ _id: { $in: days.map((day) => `errors:${day}`) } }).toArray();
    const errorsByDay = new Map(metricRows.map((row) => [row._id.slice('errors:'.length), Number(row.errors5xx ?? 0)]));
    const errors5xx = days.map((day) => ({ day, count: errorsByDay.get(day) ?? 0 }));
    const today = errors5xx.at(-1)?.count ?? 0;
    add('errors', today > 20 ? 'error' : today > 0 ? 'warning' : 'ok', 'ERRORS_TODAY', { count: today });

    // Đăng nhập
    const dayAgo = new Date(now.getTime() - 24 * 60 * MINUTE);
    const users = this.db.collection('users');
    const [failed24h, lockedAccounts, activeUsers24h, onlineNow, disabledAccounts] = await Promise.all([
      this.db.collection('login_events').countDocuments({ success: false, at: { $gte: dayAgo } }),
      users.countDocuments({ lockedUntil: { $gt: now } }),
      users.countDocuments({ lastSeenAt: { $gte: dayAgo } }),
      users.countDocuments({ lastSeenAt: { $gte: new Date(now.getTime() - 15 * MINUTE) } }),
      users.countDocuments({ status: 'DISABLED' }),
    ]);
    add('logins', failed24h > 20 || lockedAccounts > 0 ? 'warning' : 'ok', 'LOGINS', { failed: failed24h, locked: lockedAccounts });

    return {
      generatedAt: now.toISOString(),
      version: this.config.get<string>('APP_VERSION') ?? process.env.APP_VERSION ?? 'dev',
      environment,
      uptimeSeconds: Math.round(process.uptime()),
      checks,
      database,
      queues,
      outbox: { pending, deadLetter },
      errors5xx,
      logins: { failed24h, lockedAccounts, activeUsers24h, onlineNow, disabledAccounts },
      ...(lastBackup ? { lastBackup } : {}),
    };
  }
}
