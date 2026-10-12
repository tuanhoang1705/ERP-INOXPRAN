import Decimal from 'decimal.js';
import { type ClientSession, type Db, ObjectId } from 'mongodb';
import type { NotificationTemplate, TextParams } from '@inoxpran/contracts';
import { decimalString, vnDayStart, vnParts } from '../../common/domain';

/** Giải thuật 3 của đồ án: phân mức cảnh báo theo số ngày quá hạn. */
export type OverdueLevel = 'REMINDER' | 'WARNING' | 'DANGER';

const DAY_MS = 86_400_000;
export const OPEN_RECEIVABLE_STATUSES = ['OPEN', 'PARTIALLY_PAID', 'OVERDUE'];
export const OVERDUE_HOLD_REASON = 'OVERDUE_60';

export function classifyOverdue(daysOverdue: number): OverdueLevel | null {
  if (daysOverdue <= 0) return null;
  if (daysOverdue <= 30) return 'REMINDER';
  if (daysOverdue <= 60) return 'WARNING';
  return 'DANGER';
}

export function daysOverdue(dueDate: Date, now: Date): number {
  return Math.floor((vnDayStart(now).getTime() - vnDayStart(dueDate).getTime()) / DAY_MS);
}

export interface OverdueReviewResult {
  reviewDate: string;
  reviewed: number;
  reminder: number;
  warning: number;
  danger: number;
  overdueAmount: string;
  lockedPartners: string[];
  releasedPartners: string[];
  notified: boolean;
}

function enqueueNotification(
  db: Db,
  input: { aggregateId: string; targetRoles: string[]; level: string; title: string; message: string; href: string; template: NotificationTemplate; params: TextParams },
) {
  const now = new Date();
  return db.collection('outbox_events').insertOne({
    _id: new ObjectId(),
    eventType: 'NOTIFICATION_REQUESTED',
    aggregateType: 'OverdueReview',
    aggregateId: input.aggregateId,
    payload: {
      category: 'RECEIVABLE',
      targetRoles: input.targetRoles,
      level: input.level,
      title: input.title,
      message: input.message,
      href: input.href,
      template: input.template,
      params: input.params,
    },
    status: 'PENDING',
    relayAttempts: 0,
    availableAt: now,
    occurredAt: now,
  });
}

/**
 * Rà soát toàn bộ khoản phải thu chưa thanh toán, gắn mức cảnh báo, tạm khóa đại lý có nợ quá 60 ngày
 * và mở khóa tự động khi đại lý đã hết khoản nợ nguy hiểm. Chạy lặp lại trong ngày không gửi trùng thông báo.
 */
export async function runOverdueReview(db: Db, now = new Date()): Promise<OverdueReviewResult> {
  const { year, month, day } = vnParts(now);
  const reviewDate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const receivables = await db
    .collection('receivables')
    .find({ status: { $in: OPEN_RECEIVABLE_STATUSES } })
    .toArray();

  const counts = { REMINDER: 0, WARNING: 0, DANGER: 0 };
  let overdueAmount = new Decimal(0);
  const dangerPartners = new Set<string>();
  const updates = receivables.map((row) => {
    const days = daysOverdue(row.dueDate as Date, now);
    const level = classifyOverdue(days);
    if (level) {
      counts[level] += 1;
      overdueAmount = overdueAmount.add(new Decimal(decimalString(row.amount)).minus(decimalString(row.paidAmount)));
      if (level === 'DANGER') dangerPartners.add((row.partnerId as ObjectId).toHexString());
    }
    return {
      updateOne: {
        filter: { _id: row._id },
        update: level
          ? { $set: { overdueLevel: level, overdueDays: days, overdueReviewedAt: now } }
          : { $unset: { overdueLevel: '', overdueDays: '' }, $set: { overdueReviewedAt: now } },
      },
    };
  });
  if (updates.length) await db.collection('receivables').bulkWrite(updates, { ordered: false });

  const lockedPartners: string[] = [];
  for (const partnerId of dangerPartners) {
    const locked = await db.collection('partners').findOneAndUpdate(
      { _id: new ObjectId(partnerId), status: 'ACTIVE' },
      { $set: { status: 'ON_HOLD', holdReason: OVERDUE_HOLD_REASON, heldAt: now, updatedAt: now }, $inc: { version: 1 } },
      { returnDocument: 'after' },
    );
    if (locked) lockedPartners.push(String(locked.name));
  }
  const releasable = await db
    .collection('partners')
    .find({ status: 'ON_HOLD', holdReason: OVERDUE_HOLD_REASON })
    .toArray();
  const releasedPartners: string[] = [];
  for (const partner of releasable) {
    if (dangerPartners.has((partner._id as ObjectId).toHexString())) continue;
    await db.collection('partners').updateOne(
      { _id: partner._id, status: 'ON_HOLD', holdReason: OVERDUE_HOLD_REASON },
      { $set: { status: 'ACTIVE', updatedAt: now }, $unset: { holdReason: '', heldAt: '' }, $inc: { version: 1 } },
    );
    releasedPartners.push(String(partner.name));
  }

  const previous = await db.collection<{ _id: string } & Record<string, unknown>>('overdue_reviews').findOne({ _id: reviewDate });
  const notify = !previous?.notified && counts.REMINDER + counts.WARNING + counts.DANGER > 0;
  if (notify) {
    const summary = `${counts.REMINDER} khoản nhắc nợ, ${counts.WARNING} khoản cảnh báo, ${counts.DANGER} khoản nguy hiểm`;
    await enqueueNotification(db, {
      aggregateId: reviewDate,
      targetRoles: ['ADMIN', 'DIRECTOR', 'ACCOUNTANT', 'SALES_MANAGER'],
      level: counts.DANGER ? 'CRITICAL' : 'WARNING',
      title: `Rà soát công nợ ngày ${day}/${month}/${year}`,
      message: `${summary}. Tổng nợ quá hạn ${overdueAmount.toDecimalPlaces(0).toNumber().toLocaleString('vi-VN')} đ.`,
      href: '/receivables/overdue',
      template: 'OVERDUE_REVIEW',
      params: { date: reviewDate, reminder: counts.REMINDER, warning: counts.WARNING, danger: counts.DANGER, overdue: overdueAmount.toFixed(0) },
    });
    if (lockedPartners.length) {
      await enqueueNotification(db, {
        aggregateId: `${reviewDate}:locked`,
        targetRoles: ['ADMIN', 'DIRECTOR', 'SALES', 'SALES_MANAGER', 'ACCOUNTANT'],
        level: 'CRITICAL',
        title: 'Tạm khóa đặt hàng do nợ quá hạn trên 60 ngày',
        message: lockedPartners.join(', '),
        href: '/receivables/overdue',
        template: 'ORDERING_LOCKED_OVERDUE',
        params: { partners: lockedPartners.join(', ') },
      });
    }
  }

  const result: OverdueReviewResult = {
    reviewDate,
    reviewed: receivables.length,
    reminder: counts.REMINDER,
    warning: counts.WARNING,
    danger: counts.DANGER,
    overdueAmount: overdueAmount.toFixed(2),
    lockedPartners,
    releasedPartners,
    notified: notify || Boolean(previous?.notified),
  };
  await db.collection<{ _id: string } & Record<string, unknown>>('overdue_reviews').updateOne(
    { _id: reviewDate },
    { $set: { ...result, ranAt: now }, $setOnInsert: { createdAt: now } },
    { upsert: true },
  );
  return result;
}

/** Mở khóa đại lý ngay khi thanh toán xóa hết khoản nợ quá 60 ngày, không cần chờ lần rà soát kế tiếp. */
export async function releaseHoldIfCleared(db: Db, partnerId: ObjectId, session: ClientSession, now = new Date()): Promise<boolean> {
  const partner = await db.collection('partners').findOne({ _id: partnerId }, { session });
  if (partner?.status !== 'ON_HOLD' || partner.holdReason !== OVERDUE_HOLD_REASON) return false;
  const threshold = new Date(vnDayStart(now).getTime() - 60 * DAY_MS);
  const stillDangerous = await db.collection('receivables').countDocuments(
    { partnerId, status: { $in: OPEN_RECEIVABLE_STATUSES }, dueDate: { $lt: threshold } },
    { session },
  );
  if (stillDangerous > 0) return false;
  await db.collection('partners').updateOne(
    { _id: partnerId },
    { $set: { status: 'ACTIVE', updatedAt: now }, $unset: { holdReason: '', heldAt: '' }, $inc: { version: 1 } },
    { session },
  );
  return true;
}
