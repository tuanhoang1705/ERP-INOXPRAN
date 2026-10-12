import type { Db } from 'mongodb';
import type { ObjectStorage } from '../../common/object-storage';

/**
 * Xóa ảnh bằng chứng đã tải lên nhưng không được dùng để xác nhận trong 24 giờ: xóa file trên S3 trước,
 * rồi mới xóa bản ghi (lỗi S3 thì giữ bản ghi để lần sau xóa lại, không để sót file mồ côi).
 * Ảnh đã gắn vào phiếu (LINKED) không bao giờ bị xóa.
 */
export async function cleanupPendingEvidence(db: Db, storage: ObjectStorage, now = new Date(), limit = 500) {
  const expired = await db.collection('attachments')
    .find({ status: 'PENDING', expiresAt: { $lt: now } }, { projection: { storage: 1 } })
    .limit(limit)
    .toArray();
  let removed = 0;
  let failed = 0;
  for (const attachment of expired) {
    const key = (attachment.storage as { key?: string } | undefined)?.key;
    try {
      if (key) await storage.delete(key);
      await db.collection('attachments').deleteOne({ _id: attachment._id, status: 'PENDING' });
      removed += 1;
    } catch {
      failed += 1;
    }
  }
  return { removed, failed };
}
