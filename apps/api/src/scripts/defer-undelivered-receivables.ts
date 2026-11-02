/**
 * Chuyển công nợ sang ghi khi giao thành công (AR-DLV-01, 28/10/2026) — quản trị hạ tầng chạy một lần sau khi lên bản mới, có bước chạy thử.
 * Trước bản này, lập SWK là ghi công nợ ngay; nay công nợ / doanh thu chỉ ghi khi xác nhận đã giao.
 *
 * Phiếu bán đang "Đã xuất kho · chờ giao" (SHIPPED) có khoản phải thu do lúc lập SWK tạo ra:
 *   - chưa thu đồng nào và không phiếu thu / bù trừ / trả hàng nào phân bổ vào → RÚT khỏi công nợ (xóa khoản phải thu, ghi nhật ký
 *     kèm bản chụp); khi xác nhận đã giao, hệ thống ghi lại khoản phải thu mới, hạn thanh toán tính từ ngày giao;
 *   - đã có thu / phân bổ → GIỮ NGUYÊN (khi giao không ghi thêm).
 * Phiếu "Đã giao" thiếu ngày giao (deliveredAt) — doanh thu tính theo ngày giao — được điền theo phiếu kho, không có thì theo ngày xuất.
 * Phiếu đã giao trước đây giữ nguyên khoản phải thu và hạn thanh toán.
 *
 * Chạy thử (mặc định, không ghi gì):  node apps/api/dist/scripts/defer-undelivered-receivables.js
 * Chạy thật:  DEFER_CONFIRM=RUT-CONG-NO-CHUA-GIAO node apps/api/dist/scripts/defer-undelivered-receivables.js --execute
 * Trên máy chủ: cd /opt/inoxpran && docker compose run --rm --no-deps [-e DEFER_CONFIRM=…] api node apps/api/dist/scripts/defer-undelivered-receivables.js [--execute]
 */
import { config } from 'dotenv';
import { resolve } from 'node:path';
import { isNonSalePurpose } from '@inoxpran/contracts';
import Decimal from 'decimal.js';
import { MongoClient, ObjectId, type Document } from 'mongodb';

config({ path: process.env.ENV_FILE ?? resolve(process.cwd(), '../../.env') });

export const DEFER_CONFIRM = 'RUT-CONG-NO-CHUA-GIAO';

const money = (value: unknown) => new Decimal(String(value ?? '0'));
const vnd = (value: Decimal) => `${value.toDecimalPlaces(0).toNumber().toLocaleString('vi-VN')} đ`;
const day = (value: unknown) => (value instanceof Date ? new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', dateStyle: 'short' }).format(value) : '—');

async function main(): Promise<void> {
  const execute = process.argv.includes('--execute');
  if (execute && process.env.DEFER_CONFIRM !== DEFER_CONFIRM) throw new Error(`Chạy thật cần DEFER_CONFIRM=${DEFER_CONFIRM}`);
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('Thiếu MONGODB_URI');
  const client = new MongoClient(uri);
  await client.connect();
  try {
    const db = client.db(process.env.MONGODB_DATABASE ?? 'inoxpran_erp');
    const shipped = (await db.collection('sales_orders')
      .find({ status: 'SHIPPED' }, { projection: { code: 1, customerId: 1, customerName: 1, grandTotal: 1, purpose: 1, shippedAt: 1 } })
      .sort({ shippedAt: 1 })
      .toArray())
      .filter((order) => !isNonSalePurpose(order.purpose));
    const orderById = new Map(shipped.map((order) => [String(order._id), order]));
    // Khoản phải thu gốc do lập SWK tạo (không có sourceType), chưa hủy.
    const receivables = shipped.length
      ? await db.collection('receivables').find({ salesOrderId: { $in: shipped.map((order) => order._id) }, sourceType: { $exists: false }, status: { $ne: 'VOIDED' } }).toArray()
      : [];
    const referenced = new Set(
      receivables.length
        ? (await db.collection('payments').distinct('allocations.receivableId', { 'allocations.receivableId': { $in: receivables.map((row) => row._id) } })).map((value) => String(value))
        : [],
    );
    const defer: Document[] = [];
    const keep: Document[] = [];
    for (const receivable of receivables) {
      if (money(receivable.paidAmount).isZero() && !referenced.has(String(receivable._id))) defer.push(receivable);
      else keep.push(receivable);
    }
    const partners = new Map(
      (await db.collection('partners').find({ _id: { $in: [...new Set(receivables.map((row) => String(row.partnerId)))].map((id) => new ObjectId(id)) } }, { projection: { code: 1, name: 1 } }).toArray())
        .map((partner) => [String(partner._id), partner]),
    );
    const describe = (receivable: Document) => {
      const order = orderById.get(String(receivable.salesOrderId));
      const partner = partners.get(String(receivable.partnerId));
      return `${String(order?.code ?? receivable.salesOrderCode)} · ${String(partner?.code ?? '')} ${String(partner?.name ?? order?.customerName ?? '')} · ${vnd(money(receivable.amount))} · xuất ${day(order?.shippedAt)} · ${String(receivable.code)}`;
    };
    const missingDeliveredAt = await db.collection('sales_orders').find({ status: 'DELIVERED', deliveredAt: { $exists: false } }, { projection: { code: 1, shippedAt: 1 } }).toArray();

    console.log(`== ${execute ? 'CHẠY THẬT' : 'CHẠY THỬ (không ghi gì)'} — ${new Date().toISOString()}`);
    console.log(`Phiếu bán đã xuất kho, chưa giao: ${shipped.length}; có khoản phải thu từ lúc lập SWK: ${receivables.length}`);
    console.log(`-- Rút khỏi công nợ (chưa thu, chưa phân bổ): ${defer.length} phiếu · ${vnd(defer.reduce<Decimal>((sum, row) => sum.add(money(row.amount)), new Decimal(0)))}`);
    for (const row of defer) console.log(`   ${describe(row)}`);
    console.log(`-- Giữ nguyên (đã có thu / phân bổ): ${keep.length} phiếu`);
    for (const row of keep) console.log(`   ${describe(row)} · đã thu ${vnd(money(row.paidAmount))}`);
    console.log(`-- Phiếu đã giao thiếu ngày giao (điền theo phiếu kho / ngày xuất): ${missingDeliveredAt.length}`);
    if (!execute) {
      console.log('== Chạy thử xong. Chạy thật: thêm --execute và DEFER_CONFIRM.');
      return;
    }

    const now = new Date();
    for (const receivable of defer) {
      const removed = await db.collection('receivables').deleteOne({ _id: receivable._id, version: receivable.version, paidAmount: receivable.paidAmount });
      if (removed.deletedCount !== 1) {
        console.log(`   BỎ QUA (vừa thay đổi): ${describe(receivable)}`);
        continue;
      }
      await db.collection('audit_events').insertOne({
        _id: new ObjectId(),
        action: 'RECEIVABLE_DEFERRED_TO_DELIVERY',
        entityType: 'SalesOrder',
        entityId: String(receivable.salesOrderId),
        actorEmail: 'defer-undelivered-receivables',
        before: receivable,
        metadata: { receivableCode: receivable.code, salesOrderCode: receivable.salesOrderCode, amount: String(receivable.amount), rule: 'AR-DLV-01' },
        occurredAt: now,
      });
    }
    let filled = 0;
    for (const order of missingDeliveredAt) {
      const shipment = await db.collection('shipments').findOne({ salesOrderId: order._id }, { projection: { deliveredAt: 1 } });
      const deliveredAt = (shipment?.deliveredAt as Date | undefined) ?? (order.shippedAt as Date | undefined);
      if (!deliveredAt) continue;
      await db.collection('sales_orders').updateOne({ _id: order._id, deliveredAt: { $exists: false } }, { $set: { deliveredAt } });
      filled += 1;
    }
    await db.collection('audit_events').insertOne({
      _id: new ObjectId(),
      action: 'RECEIVABLES_DEFERRED_TO_DELIVERY',
      entityType: 'System',
      entityId: 'receivables',
      actorEmail: 'defer-undelivered-receivables',
      metadata: { deferred: defer.length, kept: keep.length, deliveredAtFilled: filled, rule: 'AR-DLV-01' },
      occurredAt: now,
    });
    console.log(`== Xong: rút ${defer.length} khoản phải thu, giữ ${keep.length}, điền ngày giao ${filled} phiếu.`);
  } finally {
    await client.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
