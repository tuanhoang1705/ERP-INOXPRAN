import { randomUUID } from 'node:crypto';
import { MongoClient, type Db } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SequenceService } from '../../common/sequence.service';
import { insertStockReturn, nextReturnCode } from './return-codes';

// Cần MongoDB replica set để kiểm tra giao dịch và xung đột khi cấp số.
const uri = process.env.TEST_MONGODB_URI;
describe.skipIf(!uri)('cấp số phiếu trả hàng trong giao dịch MongoDB', () => {
  let client: MongoClient;
  let db: Db;
  let sequences: SequenceService;
  const date = (month: number) => new Date(Date.UTC(2026, month - 1, 10));

  beforeAll(async () => {
    client = await new MongoClient(uri!).connect();
    db = client.db(`return_codes_test_${randomUUID()}`);
    await db.collection('stock_returns').createIndex({ code: 1 }, { unique: true });
    await db.createCollection('counters');
    await db.createCollection('payments');
    sequences = new SequenceService(db);
  });
  afterAll(async () => {
    if (db) await db.dropDatabase();
    await client?.close();
  });

  function create(month: number, manual?: string, prefix: 'NK' | 'XT' = 'NK') {
    return client.withSession((session) => session.withTransaction(async () => {
      const code = await nextReturnCode(db, sequences, session, prefix, date(month), manual);
      await insertStockReturn(db, { code, status: 'POSTED' }, session);
      return code;
    }));
  }

  it('nhập bù 0040 dưới số mới nhất, chặn trùng cả năm và giữ dãy tự sinh', async () => {
    await db.collection('stock_returns').insertMany([
      { code: 'NK2026110048', status: 'POSTED' },
      { code: 'NK2026100040', legacyCode: 'TH2026100008', status: 'VOIDED' },
    ]);
    expect(await create(10, '0040')).toBe('NK2026100040');
    expect(await db.collection('stock_returns').findOne({ legacyCode: 'TH2026100008' })).toMatchObject({ status: 'VOIDED', originalCode: 'NK2026100040', code: 'NK2026100040-H1' });
    await expect(create(11, '40')).rejects.toMatchObject({ response: { code: 'RETURN_CODE_EXISTS' } });
    expect(await create(11)).toBe('NK2026110049');
    expect(await create(11, '0040', 'XT')).toBe('XT2026110040');
  });

  it('hai giao dịch nhập cùng số khác tháng chỉ ghi được một phiếu', async () => {
    const results = await Promise.allSettled([create(10, '60'), create(11, '0060')]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({ reason: { response: { code: 'RETURN_CODE_EXISTS' } } });
    expect(await create(11)).toBe('NK2026110061');
  });

  it('đối chiếu cả mã cũ, chứng từ sổ cũ và cho dùng lại số đã nhả sau hủy', async () => {
    await db.collection('payments').insertOne({ reference: 'NK2026100030', mode: 'HISTORY' });
    await db.collection('stock_returns').insertOne({ code: 'NK2026100031-H1', originalCode: 'NK2026100031', legacyCode: 'NK2026100032', status: 'VOIDED' });
    await expect(create(11, '30')).rejects.toMatchObject({ response: { code: 'RETURN_CODE_EXISTS' } });
    await expect(create(10, '32')).rejects.toMatchObject({ response: { code: 'RETURN_CODE_EXISTS' } });
    expect(await create(10, '31')).toBe('NK2026100031');
  });
});
