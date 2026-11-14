/**
 * WAR-EXCH-02 (11/11/2026): phiếu bảo hành đổi sản phẩm mới đã được Quản lý kho duyệt nhưng chưa trả khách (còn "Chờ trả khách",
 * chưa xuất hàng đổi) chuyển sang trạng thái mới "Chờ kế toán xuất phiếu" — từ nay kế toán xuất phiếu BH & SWK là đóng phiếu.
 * API vẫn nhận các phiếu cũ này (coi như chờ kế toán) nên chạy script chỉ để danh sách / bộ lọc hiển thị đúng.
 * Mặc định CHẠY THỬ (in danh sách); thêm `--apply` để ghi (ghi lịch sử phiếu + nhật ký WARRANTY_STATUS_MIGRATED).
 *
 *   npx tsx src/scripts/migrate-exchange-awaiting-issue.ts            # chạy thử
 *   npx tsx src/scripts/migrate-exchange-awaiting-issue.ts --apply    # ghi thật
 */
import { config } from 'dotenv';
import { resolve } from 'node:path';
import { MongoClient } from 'mongodb';

config({ path: process.env.ENV_FILE ?? resolve(process.cwd(), '../../.env') });

const ACTOR = 'migrate-exchange-awaiting-issue';

async function main() {
  const apply = process.argv.includes('--apply');
  const client = await MongoClient.connect(String(process.env.MONGODB_URI));
  const db = client.db(process.env.MONGODB_DATABASE);
  const filter = { status: 'READY', 'result.resolution': 'EXCHANGED', stock: { $exists: false } };
  const rows = await db.collection('warranty_tickets').find(filter, { projection: { code: 1, 'customer.name': 1, 'product.sku': 1, version: 1 } }).sort({ code: 1 }).toArray();
  console.log(`${apply ? 'GHI THẬT' : 'CHẠY THỬ'} — ${rows.length} phiếu đổi mới đã duyệt, chưa xuất hàng đổi:`);
  for (const row of rows) console.log(`  ${String(row.code)}  ${String((row.customer as { name?: string })?.name ?? '')}  ${String((row.product as { sku?: string })?.sku ?? '')}`);
  if (!apply || !rows.length) {
    if (!apply) console.log('Chưa ghi gì. Thêm --apply để chuyển sang "Chờ kế toán xuất phiếu".');
    await client.close();
    return;
  }
  const now = new Date();
  let done = 0;
  for (const row of rows) {
    const result = await db.collection('warranty_tickets').updateOne(
      { _id: row._id, version: row.version, ...filter },
      {
        $set: { status: 'AWAITING_ISSUE', updatedAt: now },
        $inc: { version: 1 },
        $push: { history: { at: now, byName: 'Hệ thống', action: 'STATUS_MIGRATED', from: 'READY', to: 'AWAITING_ISSUE', note: 'Quy trình mới: kế toán xuất phiếu BH & SWK đổi bảo hành' } },
      } as never,
    );
    if (result.modifiedCount !== 1) {
      console.log(`  bỏ qua ${String(row.code)} (vừa thay đổi)`);
      continue;
    }
    await db.collection('audit_events').insertOne({ actorEmail: ACTOR, action: 'WARRANTY_STATUS_MIGRATED', entityType: 'WarrantyTicket', entityId: String(row._id), metadata: { rule: 'WAR-EXCH-02', code: row.code, from: 'READY', to: 'AWAITING_ISSUE' }, occurredAt: now });
    done += 1;
  }
  console.log(`Đã chuyển ${done} phiếu.`);
  await client.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
