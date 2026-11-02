/**
 * Điền tên tiếng Trung của khách (AR-XLS-02, 31/10/2026) từ bảng tổng hợp công nợ 收付明细汇总表 của kế toán — tên in dòng thứ 2
 * cột tên khách của file Excel công nợ. Dữ liệu là JSON {mã KH: tên tiếng Trung} dựng sẵn từ cột B/C các sheet T8–T10.
 * Chỉ điền khách đang để trống; khách đã có tên khác thì chỉ liệt kê.
 *
 * Chạy thử (mặc định, không ghi gì):  NAME_ZH_JSON='{"KH068":"仁旺"}' node apps/api/dist/scripts/import-customer-chinese-names.js
 * Chạy thật:  NAME_ZH_CONFIRM=DIEN-TEN-TIENG-TRUNG NAME_ZH_JSON='…' node apps/api/dist/scripts/import-customer-chinese-names.js --execute
 * Trên máy chủ: cd /opt/inoxpran && docker compose run --rm --no-deps -e NAME_ZH_JSON='…' [-e NAME_ZH_CONFIRM=…] api node apps/api/dist/scripts/import-customer-chinese-names.js [--execute]
 */
import { config } from 'dotenv';
import { resolve } from 'node:path';
import { MongoClient, ObjectId } from 'mongodb';

config({ path: process.env.ENV_FILE ?? resolve(process.cwd(), '../../.env') });

export const NAME_ZH_CONFIRM = 'DIEN-TEN-TIENG-TRUNG';

async function main(): Promise<void> {
  const execute = process.argv.includes('--execute');
  if (execute && process.env.NAME_ZH_CONFIRM !== NAME_ZH_CONFIRM) throw new Error(`Chạy thật cần NAME_ZH_CONFIRM=${NAME_ZH_CONFIRM}`);
  const names = JSON.parse(process.env.NAME_ZH_JSON ?? '{}') as Record<string, string>;
  if (!Object.keys(names).length) throw new Error('Thiếu NAME_ZH_JSON');
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('Thiếu MONGODB_URI');
  const client = new MongoClient(uri);
  await client.connect();
  try {
    const db = client.db(process.env.MONGODB_DATABASE ?? 'inoxpran_erp');
    const partners = await db.collection('partners').find({ code: { $in: Object.keys(names) }, kind: { $in: ['CUSTOMER', 'BOTH'] } }, { projection: { code: 1, name: 1, nameZh: 1 } }).toArray();
    const byCode = new Map(partners.map((partner) => [String(partner.code), partner]));
    const fill: Array<{ id: ObjectId; code: string; name: string; nameZh: string }> = [];
    console.log(`== ${execute ? 'CHẠY THẬT' : 'CHẠY THỬ'} — tên tiếng Trung cho ${Object.keys(names).length} mã khách`);
    for (const [code, nameZh] of Object.entries(names).sort()) {
      const partner = byCode.get(code);
      if (!partner) { console.log(`KHÔNG CÓ  ${code} ${nameZh} — mã không có trong ERP`); continue; }
      if (partner.nameZh && partner.nameZh !== nameZh) { console.log(`GIỮ      ${code} ${String(partner.name)} — đã có "${String(partner.nameZh)}", file ghi "${nameZh}"`); continue; }
      if (partner.nameZh) { console.log(`ĐÃ CÓ    ${code} ${String(partner.name)} — ${nameZh}`); continue; }
      console.log(`ĐIỀN     ${code} ${String(partner.name)} → ${nameZh}`);
      fill.push({ id: partner._id as ObjectId, code, name: String(partner.name), nameZh });
    }
    console.log(`\nSẽ điền ${fill.length} khách.`);
    if (!execute) {
      console.log(`Chưa ghi gì. Chạy thật: NAME_ZH_CONFIRM=${NAME_ZH_CONFIRM} … --execute`);
      return;
    }
    const now = new Date();
    for (const row of fill) {
      await db.collection('partners').updateOne({ _id: row.id, nameZh: { $exists: false } }, { $set: { nameZh: row.nameZh, updatedAt: now }, $inc: { version: 1 } });
      await db.collection('audit_events').insertOne({
        _id: new ObjectId(), action: 'PARTNER_UPDATED', entityType: 'Partner', entityId: row.id.toHexString(), actorEmail: 'import-customer-chinese-names',
        after: { nameZh: row.nameZh }, metadata: { code: row.code, rule: 'AR-XLS-02', source: '收付明细汇总表' }, occurredAt: now,
      });
    }
    console.log(`Xong: đã điền ${fill.length} khách.`);
  } finally {
    await client.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
