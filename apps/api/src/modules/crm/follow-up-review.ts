import { ObjectId, type Db } from 'mongodb';
import { vnParts } from '../../common/domain';

/** Ngày hôm nay theo giờ Việt Nam dạng YYYY-MM-DD (so sánh chuỗi được với followUpOn). */
export function vnToday(now = new Date()): string {
  const { year, month, day } = vnParts(now);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Nhắc chăm sóc khách (跟进示警): 07:30 mỗi sáng, mỗi người phụ trách nhận MỘT thông báo gộp các lịch hẹn đến hạn
 * hôm nay và đã quá hẹn mà chưa đánh dấu xong. Mỗi người chỉ nhận một lần mỗi ngày (khóa outbox theo ngày).
 */
export async function runCrmFollowUpReview(db: Db, now = new Date()): Promise<{ owners: number; due: number; overdue: number }> {
  const today = vnToday(now);
  const rows = await db.collection('partner_activities').aggregate([
    { $match: { done: false, followUpOn: { $lte: today } } },
    { $sort: { followUpOn: 1 } },
    {
      $group: {
        _id: '$ownerId',
        due: { $sum: { $cond: [{ $eq: ['$followUpOn', today] }, 1, 0] } },
        overdue: { $sum: { $cond: [{ $lt: ['$followUpOn', today] }, 1, 0] } },
        first: { $first: '$partnerName' },
      },
    },
  ]).toArray();
  let due = 0;
  let overdue = 0;
  for (const row of rows) {
    const ownerId = (row._id as ObjectId).toHexString();
    const total = Number(row.due) + Number(row.overdue);
    due += Number(row.due);
    overdue += Number(row.overdue);
    const aggregateId = `${ownerId}:${today}`;
    // Chạy lại trong ngày (worker khởi động lại, retry) không tạo thông báo trùng.
    if (await db.collection('outbox_events').findOne({ aggregateType: 'CrmFollowUp', aggregateId }, { projection: { _id: 1 } })) continue;
    await db.collection('outbox_events').insertOne({
      _id: new ObjectId(),
      eventType: 'NOTIFICATION_REQUESTED',
      aggregateType: 'CrmFollowUp',
      aggregateId,
      payload: {
        category: 'CRM',
        targetUserIds: [ownerId],
        level: Number(row.overdue) > 0 ? 'WARNING' : 'INFO',
        title: `Hôm nay có ${total} lịch chăm sóc khách`,
        message: `${Number(row.overdue)} lịch đã quá hẹn. Khách đầu tiên: ${String(row.first ?? '')}.`,
        href: '/catalog/dealers?followUp=due',
        template: 'CRM_FOLLOW_UP_DUE',
        params: { count: total, overdue: Number(row.overdue), first: String(row.first ?? '') },
      },
      status: 'PENDING',
      relayAttempts: 0,
      availableAt: now,
      occurredAt: now,
    });
  }
  return { owners: rows.length, due, overdue };
}
