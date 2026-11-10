/**
 * NUM-02 (09/11/2026): đổi số các phiếu ĐÃ HỦY từ trước sang dạng `…-H1` (quy chuẩn mới: phiếu hủy thêm -H sau số phiếu, không
 * tính số). Phiếu hủy từ nay tự đổi khi hủy; script này chỉ dọn phiếu cũ. Mặc định CHẠY THỬ (in bảng, không ghi gì);
 * thêm `--apply` để ghi (mỗi phiếu một giao dịch, ghi nhật ký NUMBER_RELEASED).
 *
 *   npx tsx src/scripts/release-cancelled-numbers.ts            # chạy thử
 *   npx tsx src/scripts/release-cancelled-numbers.ts --apply    # ghi thật
 *
 * Gồm: phiếu bảo hành SC, kiểm kê KK, đơn mua PO, phiếu thu PAY, công nợ AR, xin sửa giá SG (đổi theo các chỗ chép số —
 * NUMBERED_DOCUMENTS) và phiếu trả hàng NK / XT (releaseReturnNumber). Phiếu BH hủy đã có quy tắc riêng từ trước.
 */
import { config } from 'dotenv';
import { resolve } from 'node:path';
import { MongoClient, type Document } from 'mongodb';
import { NUMBERED_DOCUMENTS, releaseDocumentNumber } from '../common/document-numbers';
import { releaseReturnNumber } from '../modules/inventory/return-codes';

config({ path: process.env.ENV_FILE ?? resolve(process.cwd(), '../../.env') });

const ACTOR = 'release-cancelled-numbers';

async function main() {
  const apply = process.argv.includes('--apply');
  const client = await MongoClient.connect(String(process.env.MONGODB_URI));
  const db = client.db(process.env.MONGODB_DATABASE);
  const plan: Array<{ prefix: string; collection: string; row: Document }> = [];
  for (const [prefix, source] of Object.entries(NUMBERED_DOCUMENTS)) {
    const rows = await db.collection(source.collection)
      .find({ status: { $in: source.inactive }, code: { $regex: `^${prefix}`, $not: /-H\d+$/ } }, { projection: { code: 1, status: 1 } })
      .sort({ code: 1 })
      .toArray();
    for (const row of rows) plan.push({ prefix, collection: source.collection, row });
  }
  const returns = await db.collection('stock_returns')
    .find({ status: 'VOIDED', code: { $regex: '^(NK|XT)20\\d{2}(0[1-9]|1[0-2])\\d{4,5}$' } }, { projection: { code: 1, status: 1 } })
    .sort({ code: 1 })
    .toArray();
  for (const row of returns) plan.push({ prefix: String(row.code).slice(0, 2), collection: 'stock_returns', row });

  console.log(`${apply ? 'GHI THẬT' : 'CHẠY THỬ'} — ${plan.length} phiếu đã hủy chưa có đuôi -H:`);
  for (const item of plan) console.log(`  ${item.collection.padEnd(24)} ${String(item.row.code).padEnd(16)} (${String(item.row.status)})`);
  if (!apply) {
    console.log('\nChưa ghi gì. Thêm --apply để đổi số.');
    await client.close();
    return;
  }
  let done = 0;
  for (const item of plan) {
    const session = client.startSession();
    try {
      await session.withTransaction(async () => {
        const fresh = await db.collection(item.collection).findOne({ _id: item.row._id }, { session });
        if (!fresh || String(fresh.code) !== String(item.row.code)) return;
        const released = item.collection === 'stock_returns'
          ? await releaseReturnNumber(db, fresh, session)
          : await releaseDocumentNumber(db, item.prefix, fresh, session);
        if (!released || released.code === fresh.code) return;
        await db.collection('audit_events').insertOne({
          actorEmail: ACTOR, action: 'NUMBER_RELEASED', entityType: item.collection, entityId: String(fresh._id),
          metadata: { rule: 'NUM-02', from: fresh.code, to: released.code }, occurredAt: new Date(),
        }, { session });
        done += 1;
        console.log(`  ${String(fresh.code)} → ${String(released.code)}`);
      });
    } finally {
      await session.endSession();
    }
  }
  console.log(`\nĐã đổi ${done} / ${plan.length} phiếu.`);
  await client.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
