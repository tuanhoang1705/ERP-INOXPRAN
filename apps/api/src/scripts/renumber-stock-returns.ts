/**
 * Đổi mã phiếu trả hàng TH… sang số NK của kho (NK-01, 31/10/2026) — quản trị hạ tầng chạy một lần sau khi lên bản mới, có bước chạy thử.
 * Quy trình kho cũ đánh số phiếu nhập trả hàng là NK; thủ kho đã ghi số NK giấy vào ghi chú phiếu TH (VD "滞销退货入库，入库单号NK2026100037").
 *
 *   - Ghi chú có đúng một số NK → phiếu đổi sang số đó. Nhiều phiếu cùng ghi một số → phiếu lập trước giữ số, phiếu sau thêm đuôi -2, -3.
 *   - Ghi chú có từ 2 số NK → dừng, chốt tay qua RENUMBER_DECISIONS_JSON {"TH2026100012":"NK2026100031"}.
 *   - Ghi chú không có số NK → cấp số NK chưa dùng kế tiếp của tháng nhận hàng (hoặc theo file quyết định).
 *   - Số NK đã có trong công nợ nhập từ sổ cũ của chính khách đó → cảnh báo có thể trừ nợ 2 lần (chỉ báo, không tự sửa).
 * Đổi kèm: thẻ kho (referenceId, extra.correctionOf, lý do), phiếu giảm nợ trả hàng (reference), ghi chú công nợ, phiếu bảo hành
 * (stock.returnSlip.code), nội dung thông báo. Mã cũ lưu ở legacyCode (vẫn tra được). Cuối cùng đẩy bộ đếm NK của từng tháng lên
 * sau số lớn nhất đã dùng.
 *
 * Chạy thử (mặc định, không ghi gì):  node apps/api/dist/scripts/renumber-stock-returns.js
 * Chạy thật:  RENUMBER_CONFIRM=DOI-TH-SANG-NK node apps/api/dist/scripts/renumber-stock-returns.js --execute
 * Trên máy chủ: cd /opt/inoxpran && docker compose run --rm --no-deps [-e RENUMBER_CONFIRM=…] [-e RENUMBER_DECISIONS_JSON=…] api node apps/api/dist/scripts/renumber-stock-returns.js [--execute]
 */
import { config } from 'dotenv';
import { resolve } from 'node:path';
import { MongoClient, ObjectId, type ClientSession, type Db, type Document } from 'mongodb';
import { nkCodesIn, planRenumber, RETURN_IN_PREFIX, type RenumberFlag, type RenumberRow } from '../modules/inventory/return-codes';

config({ path: process.env.ENV_FILE ?? resolve(process.cwd(), '../../.env') });

export const RENUMBER_CONFIRM = 'DOI-TH-SANG-NK';
const ACTOR = 'renumber-stock-returns';

const FLAG_VI: Record<RenumberFlag, string> = {
  NO_NK: 'ghi chú không có số NK → cấp số mới',
  MULTIPLE_NK: 'ghi chú có nhiều số NK → cần chốt tay',
  MONTH_MISMATCH: 'tháng số NK khác tháng nhận hàng',
  DUPLICATE_NK: 'nhiều phiếu cùng số NK → thêm đuôi',
  HISTORY_SAME_CUSTOMER: 'CẢNH BÁO: số NK đã có trong công nợ sổ cũ của chính khách này — có thể trừ nợ 2 lần',
  HISTORY_OTHER_CUSTOMER: 'số NK có trong công nợ sổ cũ của khách khác',
  TARGET_EXISTS: 'mã đích đã có phiếu khác → dừng',
  DECISION: 'theo file quyết định',
};

const when = (value: unknown) => (value instanceof Date ? new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', dateStyle: 'short', timeStyle: 'short' }).format(value) : '—');
const oneLine = (value: unknown, max = 150) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/** Thay chuỗi mã cũ bằng mã mới trong các trường chữ (pipeline update — không đọc về máy). */
const replaceText = (field: string, from: string, to: string) => [{ $set: { [field]: { $replaceAll: { input: `$${field}`, find: from, replacement: to } } } }];

async function renameOne(db: Db, slip: Document, row: RenumberRow, session: ClientSession, now: Date) {
  const from = row.from;
  const to = row.to!;
  const updated = await db.collection('stock_returns').updateOne(
    { _id: slip._id, code: from },
    { $set: { code: to, legacyCode: from, renumberedAt: now } },
    { session },
  );
  if (updated.modifiedCount !== 1) throw new Error(`${from}: phiếu vừa thay đổi — chạy lại`);
  const movements = await db.collection('inventory_movements').updateMany({ referenceType: 'StockReturn', referenceId: from }, { $set: { referenceId: to } }, { session });
  await db.collection('inventory_movements').updateMany({ 'extra.correctionOf': from }, { $set: { 'extra.correctionOf': to } }, { session });
  await db.collection('inventory_movements').updateMany({ reason: { $regex: from } }, replaceText('reason', from, to), { session });
  const credits = await db.collection('payments').updateMany({ stockReturnId: slip._id }, { $set: { reference: to } }, { session });
  await db.collection('payments').updateMany({ stockReturnId: slip._id, note: { $regex: from } }, replaceText('note', from, to), { session });
  await db.collection('receivables').updateMany({ note: { $regex: from } }, replaceText('note', from, to), { session });
  const warranty = await db.collection('warranty_tickets').updateMany({ 'stock.returnSlip.code': from }, { $set: { 'stock.returnSlip.code': to } }, { session });
  const notifications = await db.collection('notifications').find({ $or: [{ title: { $regex: from } }, { message: { $regex: from } }, { 'params.code': from }] }, { session }).toArray();
  for (const notification of notifications) {
    const swap = (value: unknown) => (typeof value === 'string' ? value.split(from).join(to) : value);
    const params = notification.params && typeof notification.params === 'object'
      ? Object.fromEntries(Object.entries(notification.params as Record<string, unknown>).map(([key, value]) => [key, swap(value)]))
      : undefined;
    await db.collection('notifications').updateOne(
      { _id: notification._id },
      { $set: { title: swap(notification.title), message: swap(notification.message), ...(params ? { params } : {}) } },
      { session },
    );
  }
  await db.collection('audit_events').insertOne({
    _id: new ObjectId(),
    action: 'STOCK_RETURN_RENUMBERED',
    entityType: 'StockReturn',
    entityId: (slip._id as ObjectId).toHexString(),
    actorEmail: ACTOR,
    metadata: {
      from, to, rule: 'NK-01', flags: row.flags, note: slip.note,
      updated: { movements: movements.modifiedCount, creditNotes: credits.modifiedCount, warrantyTickets: warranty.modifiedCount, notifications: notifications.length },
    },
    occurredAt: now,
  }, { session });
}

async function main(): Promise<void> {
  const execute = process.argv.includes('--execute');
  if (execute && process.env.RENUMBER_CONFIRM !== RENUMBER_CONFIRM) throw new Error(`Chạy thật cần RENUMBER_CONFIRM=${RENUMBER_CONFIRM}`);
  const decisions = JSON.parse(process.env.RENUMBER_DECISIONS_JSON ?? '{}') as Record<string, string>;
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('Thiếu MONGODB_URI');
  const client = new MongoClient(uri);
  await client.connect();
  try {
    const db = client.db(process.env.MONGODB_DATABASE ?? 'inoxpran_erp');
    const slips = await db.collection('stock_returns').find({ code: /^TH/ }).sort({ createdAt: 1 }).toArray();
    const existing = new Set((await db.collection('stock_returns').distinct('code')).map(String));
    // Số NK trong công nợ nhập từ sổ cũ (phiếu trả hàng / giảm nợ trước khi dùng ERP).
    const history = new Map<string, Set<string>>();
    for (const payment of await db.collection('payments').find({ mode: 'HISTORY', $or: [{ reference: /NK/i }, { historyDocumentNo: /NK/i }] }, { projection: { reference: 1, historyDocumentNo: 1, partnerId: 1 } }).toArray()) {
      for (const code of nkCodesIn(`${String(payment.reference ?? '')} ${String(payment.historyDocumentNo ?? '')}`)) {
        const owners = history.get(code) ?? new Set<string>();
        owners.add(String(payment.partnerId));
        history.set(code, owners);
      }
    }
    const byCode = new Map(slips.map((slip) => [String(slip.code), slip]));
    const plan = planRenumber(
      slips.map((slip) => ({
        code: String(slip.code),
        createdAt: slip.createdAt as Date,
        documentAt: (slip.receivedAt ?? slip.postedAt ?? slip.createdAt) as Date,
        note: String(slip.note ?? ''),
        ...(slip.partnerId ? { partnerId: String(slip.partnerId) } : {}),
      })),
      existing,
      history,
      decisions,
    );

    console.log(`== ${execute ? 'CHẠY THẬT' : 'CHẠY THỬ'} — đổi ${plan.rows.length} phiếu TH sang NK (NK-01)`);
    console.log('Mã cũ | Mã mới | Nhận hàng · lập | Loại | Khách / người mượn | Hàng | Trạng thái | Ghi chú | Lưu ý');
    for (const row of plan.rows) {
      const slip = byCode.get(row.from)!;
      const party = slip.partnerCode ? `${String(slip.partnerCode)} ${oneLine(slip.partnerName, 40)}` : oneLine(slip.partnerName ?? slip.borrowerName, 50);
      const lines = ((slip.lines as Document[] | undefined) ?? []).map((line) => `${String(line.sku)}×${String(line.quantity)}`).join(', ');
      console.log([
        row.from, row.to ?? '??', `${when(slip.receivedAt ?? slip.postedAt)} · ${when(slip.createdAt)}`, `${String(slip.kind)}/${String(slip.category ?? '')}`,
        party, lines, String(slip.status ?? 'POSTED'), oneLine(slip.note), row.flags.map((flag) => FLAG_VI[flag]).join('; ') || '—',
      ].join(' | '));
    }
    const count = (flag: RenumberFlag) => plan.rows.filter((row) => row.flags.includes(flag)).length;
    console.log(`\nTổng: ${plan.rows.length} phiếu · theo ghi chú ${plan.rows.length - count('NO_NK') - count('MULTIPLE_NK')} · cấp số mới ${count('NO_NK')} · trùng số (thêm đuôi) ${count('DUPLICATE_NK')} · lệch tháng ${count('MONTH_MISMATCH')} · trùng công nợ sổ cũ cùng khách ${count('HISTORY_SAME_CUSTOMER')}`);
    console.log('Bộ đếm NK sau khi đổi (tháng → số lớn nhất đã dùng):', JSON.stringify(plan.counters));
    const typedNk = await db.collection('sales_orders').countDocuments({ code: /^NK/ });
    if (typedNk) console.log(`Lưu ý: ${typedNk} phiếu BH có số bắt đầu bằng NK (số tự nhập) — từ bản này NK là mã dành riêng.`);
    if (plan.blocked.length) {
      console.log(`\nDỪNG: ${plan.blocked.length} phiếu cần chốt: ${plan.blocked.map((row) => `${row.from} (${row.flags.map((flag) => FLAG_VI[flag]).join('; ')})`).join(', ')}`);
      if (execute) throw new Error('Còn phiếu cần chốt — bổ sung RENUMBER_DECISIONS_JSON rồi chạy lại');
    }
    if (!execute) {
      console.log(`\nChưa ghi gì. Chạy thật: RENUMBER_CONFIRM=${RENUMBER_CONFIRM} … --execute`);
      return;
    }

    const now = new Date();
    const session = client.startSession();
    try {
      for (const row of plan.rows) {
        await session.withTransaction(() => renameOne(db, byCode.get(row.from)!, row, session, now));
        console.log(`Đã đổi ${row.from} → ${row.to}`);
      }
    } finally {
      await session.endSession();
    }
    for (const [month, value] of Object.entries(plan.counters)) {
      await db.collection<{ _id: string; value: number; createdAt: Date }>('counters').updateOne(
        { _id: `${RETURN_IN_PREFIX}:${month.slice(2)}` },
        { $max: { value }, $setOnInsert: { createdAt: now } },
        { upsert: true },
      );
    }
    await db.collection('audit_events').insertOne({
      _id: new ObjectId(), action: 'STOCK_RETURNS_RENUMBERED', entityType: 'System', entityId: 'stock-returns', actorEmail: ACTOR,
      metadata: { rule: 'NK-01', count: plan.rows.length, mapping: Object.fromEntries(plan.rows.map((row) => [row.from, row.to])), counters: plan.counters }, occurredAt: now,
    });
    console.log(`\nXong: đổi ${plan.rows.length} phiếu; bộ đếm NK đã đẩy lên.`);
  } finally {
    await client.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
