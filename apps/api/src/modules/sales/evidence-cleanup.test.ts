import type { Db } from 'mongodb';
import { describe, expect, it } from 'vitest';
import type { ObjectStorage } from '../../common/object-storage';
import { cleanupPendingEvidence } from './evidence-cleanup';

function fakeDb(rows: Array<{ _id: string; storage?: { key: string } }>) {
  const deleted: string[] = [];
  let lastFilter: unknown;
  const collection = {
    find: (filter: unknown) => {
      lastFilter = filter;
      return { limit: () => ({ toArray: async () => rows }) };
    },
    deleteOne: async (filter: { _id: string }) => {
      deleted.push(filter._id);
      return { deletedCount: 1 };
    },
  };
  return { db: { collection: () => collection } as unknown as Db, deleted, filter: () => lastFilter };
}

describe('cleanupPendingEvidence', () => {
  it('xóa file S3 rồi mới xóa bản ghi ảnh chờ quá hạn; chỉ xét ảnh PENDING đã hết hạn', async () => {
    const removedKeys: string[] = [];
    const storage = { delete: async (key: string) => void removedKeys.push(key) } as unknown as ObjectStorage;
    const { db, deleted, filter } = fakeDb([{ _id: 'a1', storage: { key: 'sales-evidence/o1/a1.png' } }, { _id: 'a2', storage: { key: 'sales-evidence/o1/a2.jpg' } }]);
    const now = new Date('2026-10-02T00:00:00Z');
    const result = await cleanupPendingEvidence(db, storage, now);
    expect(result).toEqual({ removed: 2, failed: 0 });
    expect(removedKeys).toEqual(['sales-evidence/o1/a1.png', 'sales-evidence/o1/a2.jpg']);
    expect(deleted).toEqual(['a1', 'a2']);
    expect(filter()).toEqual({ status: 'PENDING', expiresAt: { $lt: now } });
  });

  it('S3 lỗi thì giữ bản ghi để lần chạy sau xóa lại (không để sót file mồ côi)', async () => {
    const storage = { delete: async (key: string) => { if (key.endsWith('a1.png')) throw new Error('S3 timeout'); } } as unknown as ObjectStorage;
    const { db, deleted } = fakeDb([{ _id: 'a1', storage: { key: 'sales-evidence/o1/a1.png' } }, { _id: 'a2', storage: { key: 'sales-evidence/o1/a2.png' } }]);
    expect(await cleanupPendingEvidence(db, storage)).toEqual({ removed: 1, failed: 1 });
    expect(deleted).toEqual(['a2']);
  });
});
