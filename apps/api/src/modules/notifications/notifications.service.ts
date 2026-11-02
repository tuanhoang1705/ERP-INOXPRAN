import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Db, Document } from 'mongodb';
import { serializeDocument, toObjectId } from '../../common/domain';
import { MONGO_DATABASE } from '../../common/tokens';

@Injectable()
export class NotificationsService {
  constructor(@Inject(MONGO_DATABASE) private readonly db: Db) {}

  async list(userIdValue: string, unreadOnly: boolean) {
    const filter: Document = { userId: toObjectId(userIdValue, 'userId') };
    if (unreadOnly) filter.readAt = null;
    const rows = await this.db.collection('notifications').find(filter).sort({ createdAt: -1 }).limit(100).toArray();
    return rows.map(serializeDocument);
  }

  /** Xóa mọi thông báo (đã đọc và chưa đọc) của người dùng; worker không tạo lại vì sự kiện gốc đã gửi xong. */
  async clear(userIdValue: string) {
    const result = await this.db.collection('notifications').deleteMany({ userId: toObjectId(userIdValue, 'userId') });
    return { deleted: result.deletedCount };
  }

  async markRead(id: string, userIdValue: string) {
    const notification = await this.db.collection('notifications').findOneAndUpdate(
      { _id: toObjectId(id), userId: toObjectId(userIdValue, 'userId') },
      { $set: { readAt: new Date() } },
      { returnDocument: 'after' },
    );
    if (!notification) {
      throw new NotFoundException({ code: 'NOTIFICATION_NOT_FOUND', message: 'Không tìm thấy thông báo' });
    }
    return serializeDocument(notification);
  }
}
