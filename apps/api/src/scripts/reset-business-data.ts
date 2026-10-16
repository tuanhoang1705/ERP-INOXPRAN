/**
 * Làm sạch dữ liệu dùng thử trước khi chạy thật (RESET-01, 13/10/2026) — quản trị hạ tầng chạy một lần, có bước chạy thử.
 * Xóa chứng từ phát sinh khi dùng thử (phiếu BH / SWK, thẻ kho, giữ chỗ, chuyển kho, kiểm kê, trả hàng, công nợ, phiếu thu,
 * đơn mua / nhập kho / lô nhập khẩu, bảo hành, duyệt, sửa giá, đề nghị sửa / hủy phiếu, thông báo, lô nhập Excel, bộ đếm số chứng từ) và ảnh đính kèm
 * của chúng; tồn kho đưa về 0 để nhập lại tồn đầu kỳ.
 * GIỮ NGUYÊN: nhật ký hệ thống (audit_events — không xóa, thêm một dòng ghi lại lần làm sạch này), tài khoản, cấu hình, kho & vị trí,
 * danh mục sản phẩm, bảng giá, khuyến mãi, khách hàng / NCC, khu vực, NVKD, mã lỗi bảo hành, hoạt động CRM.
 * Giá vốn bị phiếu nhập khẩu thử làm thay đổi được trả về giá trước đó; khách bị khóa vì nợ quá hạn (do công nợ thử) được mở lại.
 *
 * Chạy thử (mặc định, không ghi gì):  node apps/api/dist/scripts/reset-business-data.js
 * Chạy thật:  RESET_CONFIRM=XOA-DU-LIEU-GIAO-DICH node apps/api/dist/scripts/reset-business-data.js --execute
 * Trên máy chủ: cd /opt/inoxpran && docker compose run --rm --no-deps [-e RESET_CONFIRM=…] api node apps/api/dist/scripts/reset-business-data.js [--execute]
 */
import { config } from 'dotenv';
import { resolve } from 'node:path';
import { Decimal128, MongoClient, ObjectId, type Document } from 'mongodb';
import { ObjectStorage } from '../common/object-storage';

config({ path: process.env.ENV_FILE ?? resolve(process.cwd(), '../../.env') });

export const RESET_CONFIRM = 'XOA-DU-LIEU-GIAO-DICH';
/** Chứng từ dùng thử — xóa toàn bộ. */
const WIPE = [
  'sales_orders', 'shipments', 'inventory_movements', 'inventory_reservations', 'inventory_transfers', 'stock_counts', 'stock_returns',
  'receivables', 'payments', 'overdue_reviews', 'purchase_orders', 'goods_receipts', 'import_shipments', 'warranty_tickets',
  'approval_requests', 'price_override_requests', 'sales_change_requests', 'import_batches', 'notifications', 'outbox_events', 'idempotency_keys', 'counters',
];
/** Ảnh đính kèm của chứng từ (ảnh sản phẩm / hồ sơ khách giữ lại). */
const ATTACHMENT_ENTITY_TYPES = ['SalesOrder', 'WarrantyTicket', 'PurchaseOrder', 'ImportShipment'];
/** Hồ sơ nền mang dấu lô nhập Excel (lô bị xóa → bỏ liên kết). */
const MASTER_WITH_BATCH = ['products', 'product_categories', 'partners', 'regions', 'employees', 'price_books'];
const OVERDUE_HOLD_REASON = 'OVERDUE_60';

async function main(): Promise<void> {
  const execute = process.argv.includes('--execute');
  if (execute && process.env.RESET_CONFIRM !== RESET_CONFIRM) throw new Error(`Chạy thật cần RESET_CONFIRM=${RESET_CONFIRM}`);
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('Thiếu MONGODB_URI');
  const client = new MongoClient(uri);
  await client.connect();
  try {
    const db = client.db(process.env.MONGODB_DATABASE ?? 'inoxpran_erp');
    const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((row) => row.name));
    const count = async (collection: string, filter: Document = {}) => (existing.has(collection) ? db.collection(collection).countDocuments(filter) : 0);
    const attachmentFilter: Document = { entityType: { $in: ATTACHMENT_ENTITY_TYPES } };

    // Giá vốn trước phiếu nhập khẩu thử đầu tiên của từng mã (đọc từ nhật ký, nhật ký giữ nguyên).
    const costEvents = existing.has('audit_events')
      ? await db.collection('audit_events').find({ action: 'PRODUCT_COST_UPDATED' }).sort({ occurredAt: 1, _id: 1 }).toArray()
      : [];
    const firstCost = new Map<string, unknown>();
    for (const event of costEvents) if (!firstCost.has(String(event.entityId))) firstCost.set(String(event.entityId), (event.before as Document | undefined)?.standardCost);
    const held = await db.collection('partners').find({ status: 'ON_HOLD', holdReason: OVERDUE_HOLD_REASON }, { projection: { code: 1, name: 1 } }).toArray();
    const balances = await db.collection('inventory_balances').aggregate([
      { $group: { _id: null, rows: { $sum: 1 }, onHand: { $sum: '$onHand' }, reserved: { $sum: '$reserved' } } },
    ]).toArray();
    const salesOrders = existing.has('sales_orders')
      ? await db.collection('sales_orders').find({}, { projection: { code: 1, status: 1 } }).sort({ createdAt: 1 }).toArray()
      : [];

    console.log(`== ${execute ? 'CHẠY THẬT' : 'CHẠY THỬ (không ghi gì)'} — CSDL ${db.databaseName}`);
    console.log('-- Chứng từ dùng thử sẽ xóa:');
    for (const collection of WIPE) {
      const value = await count(collection);
      if (value) console.log(`   ${collection.padEnd(26)} ${value}`);
    }
    console.log(`   ${'attachments (ảnh chứng từ)'.padEnd(26)} ${await count('attachments', attachmentFilter)}`);
    console.log(`-- Tồn kho: ${balances[0]?.rows ?? 0} dòng đưa về 0 (giữ vị trí lưu) — hiện có ${String(balances[0]?.onHand ?? 0)}, đang giữ ${String(balances[0]?.reserved ?? 0)}`);
    const shown = salesOrders.slice(-60).map((row) => `${String(row.code)}[${String(row.status)}]`);
    console.log(`-- Phiếu BH (${salesOrders.length}): ${salesOrders.length > 60 ? `… (${salesOrders.length - 60} phiếu cũ hơn), ` : ''}${shown.join(', ') || '—'}`);
    console.log(`-- Giá vốn trả về trước phiếu nhập khẩu thử: ${firstCost.size} mã`);
    console.log(`-- Mở khóa khách bị khóa do nợ quá hạn: ${held.length ? held.map((row) => String(row.code ?? row.name)).join(', ') : '—'}`);
    console.log('-- Giữ nguyên (số bản ghi):');
    for (const name of ['audit_events', 'users', 'settings', 'warehouses', 'locations', 'products', 'product_categories', 'price_books', 'promotions', 'partners', 'employees']) {
      console.log(`   ${name.padEnd(26)} ${await count(name)}`);
    }

    if (!execute) {
      console.log(`== Chưa thay đổi gì. Kiểm tra danh sách trên rồi chạy thật: thêm --execute và RESET_CONFIRM=${RESET_CONFIRM}.`);
      return;
    }

    const now = new Date();
    for (const [productId, cost] of firstCost) {
      await db.collection('products').updateOne(
        { _id: new ObjectId(productId) },
        cost === undefined || cost === null ? { $unset: { standardCost: '' }, $set: { updatedAt: now } } : { $set: { standardCost: cost, updatedAt: now } },
      );
    }
    if (held.length) {
      await db.collection('partners').updateMany(
        { _id: { $in: held.map((row) => row._id) } },
        { $set: { status: 'ACTIVE', updatedAt: now }, $unset: { holdReason: '', heldAt: '' }, $inc: { version: 1 } },
      );
    }
    const attachments = existing.has('attachments') ? await db.collection('attachments').find(attachmentFilter, { projection: { storage: 1 } }).toArray() : [];
    const removed: Record<string, number> = {};
    for (const collection of WIPE) {
      if (existing.has(collection)) removed[collection] = (await db.collection(collection).deleteMany({})).deletedCount;
    }
    removed.attachments = existing.has('attachments') ? (await db.collection('attachments').deleteMany(attachmentFilter)).deletedCount : 0;
    await db.collection('inventory_balances').updateMany({}, { $set: { onHand: Decimal128.fromString('0'), reserved: Decimal128.fromString('0'), updatedAt: now } });
    for (const collection of MASTER_WITH_BATCH) {
      if (existing.has(collection)) await db.collection(collection).updateMany({ importBatchId: { $exists: true } }, { $unset: { importBatchId: '' } });
    }
    // File ảnh trên kho lưu trữ (ngoài CSDL): xóa sau cùng; lỗi chỉ báo lại (file mồ côi không ảnh hưởng hệ thống).
    let filesRemoved = 0;
    let fileErrors = 0;
    const storage = new ObjectStorage(process.env);
    if (storage.configured) {
      for (const row of attachments) {
        const key = (row.storage as { key?: string } | undefined)?.key;
        if (!key) continue;
        try {
          await storage.delete(key);
          filesRemoved += 1;
        } catch {
          fileErrors += 1;
        }
      }
    }
    await db.collection('audit_events').insertOne({
      _id: new ObjectId(),
      action: 'BUSINESS_DATA_RESET',
      entityType: 'System',
      entityId: 'business-data',
      actorEmail: 'reset-business-data',
      metadata: { removed, productCostsRestored: firstCost.size, partnersReleased: held.length, filesRemoved, fileErrors },
      occurredAt: now,
    });
    console.log('-- Đã xóa:', JSON.stringify(removed));
    console.log(`-- Ảnh trên kho lưu trữ: xóa ${filesRemoved}${fileErrors ? `, lỗi ${fileErrors}` : ''}; giá vốn trả về ${firstCost.size} mã; mở khóa ${held.length} khách`);
    console.log('== Xong. Tiếp theo: nhập file tồn đầu kỳ (Nhập dữ liệu ban đầu), rồi lập lại phiếu BH cần giữ bằng chế độ tự nhập số.');
  } finally {
    await client.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
