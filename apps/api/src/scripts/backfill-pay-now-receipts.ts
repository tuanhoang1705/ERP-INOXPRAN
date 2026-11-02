/**
 * Ghi phiếu thu cho các đơn "Thanh toán ngay" đã giao trước bản AR-PAYNOW-01 (31/10/2026) — quản trị hạ tầng chạy một lần, có bước
 * chạy thử để kế toán duyệt danh sách. Từ bản này, giao xong đơn thanh toán ngay là hệ thống tự ghi thu; đơn cũ thì chưa.
 *
 *   - GHI THU: đơn đã giao, hạn 0 ngày, **đã chọn hình thức thu**, chứng từ chưa thu đồng nào, khách không có phiếu thu theo khách
 *     sau ngày giao → ghi phiếu thu tự động (ngày thu = ngày giao, hình thức theo phiếu). Phiếu cũ chưa có hình thức thu: bỏ qua.
 *   - CẦN XEM: chứng từ chưa thu nhưng khách có phiếu thu theo khách / theo chứng từ khác sau ngày giao (có thể tiền đơn này đã
 *     nằm trong đó) → chỉ liệt kê, kế toán tự xử lý.
 *   - ĐÃ THU: đã thu một phần / đủ → bỏ qua.
 *
 * Chạy thử (mặc định, không ghi gì):  node apps/api/dist/scripts/backfill-pay-now-receipts.js
 * Chạy thật:  PAYNOW_CONFIRM=GHI-THU-THANH-TOAN-NGAY node apps/api/dist/scripts/backfill-pay-now-receipts.js --execute
 * Trên máy chủ: cd /opt/inoxpran && docker compose run --rm --no-deps [-e PAYNOW_CONFIRM=…] api node apps/api/dist/scripts/backfill-pay-now-receipts.js [--execute]
 */
import { config } from 'dotenv';
import { resolve } from 'node:path';
import { isNonSalePurpose } from '@inoxpran/contracts';
import Decimal from 'decimal.js';
import { MongoClient, ObjectId, type Document } from 'mongodb';
import { SequenceService } from '../common/sequence.service';
import { PAY_NOW_ACTOR, postPayNowReceipt } from '../modules/receivables/pay-now';

config({ path: process.env.ENV_FILE ?? resolve(process.cwd(), '../../.env') });

export const PAYNOW_CONFIRM = 'GHI-THU-THANH-TOAN-NGAY';

const money = (value: unknown) => new Decimal(String(value ?? '0'));
const vnd = (value: Decimal) => `${value.toDecimalPlaces(0).toNumber().toLocaleString('vi-VN')} đ`;
const day = (value: unknown) => (value instanceof Date ? new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', dateStyle: 'short' }).format(value) : '—');

async function main(): Promise<void> {
  const execute = process.argv.includes('--execute');
  if (execute && process.env.PAYNOW_CONFIRM !== PAYNOW_CONFIRM) throw new Error(`Chạy thật cần PAYNOW_CONFIRM=${PAYNOW_CONFIRM}`);
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('Thiếu MONGODB_URI');
  const client = new MongoClient(uri);
  await client.connect();
  try {
    const db = client.db(process.env.MONGODB_DATABASE ?? 'inoxpran_erp');
    const orders = (await db.collection('sales_orders')
      // Chỉ phiếu đã chọn hình thức thu (31/10/2026: hạn 0 ngày không có hình thức thu = chưa thu, ghi công nợ).
      .find({ status: 'DELIVERED', paymentTermDays: 0, payNowMethod: { $exists: true }, payNowUndone: { $exists: false } }, { projection: { code: 1, customerId: 1, customerCode: 1, customerName: 1, grandTotal: 1, purpose: 1, deliveredAt: 1, payNowMethod: 1 } })
      .sort({ deliveredAt: 1 })
      .toArray())
      .filter((order) => !isNonSalePurpose(order.purpose) && order.customerId);
    const record: Array<{ order: Document; receivable: Document }> = [];
    const review: string[] = [];
    let paid = 0;
    for (const order of orders) {
      const receivable = await db.collection('receivables').findOne({ salesOrderId: order._id, sourceType: { $ne: 'SALES_VOID_CREDIT' }, status: { $ne: 'VOIDED' } });
      if (!receivable || money(receivable.amount).lte(0)) continue;
      if (await db.collection('payments').countDocuments({ salesOrderId: order._id, autoPayNow: true, status: 'POSTED' }, { limit: 1 })) continue;
      const line = `${String(order.code)} | ${String(order.customerCode ?? '')} ${String(order.customerName ?? '')} | giao ${day(order.deliveredAt)} | ${vnd(money(receivable.amount))} | đã thu ${vnd(money(receivable.paidAmount))}`;
      if (!money(receivable.paidAmount).isZero()) {
        paid += 1;
        console.log(`ĐÃ THU   ${line}`);
        continue;
      }
      const later = await db.collection('payments')
        .find({ partnerId: order.customerId, status: 'POSTED', kind: { $nin: ['FREIGHT', 'RETURN', 'OFFSET'] }, receivedAt: { $gte: order.deliveredAt } }, { projection: { code: 1, amount: 1, receivedAt: 1, mode: 1 } })
        .toArray();
      if (later.length) {
        review.push(`${line} | khách có phiếu thu sau ngày giao: ${later.map((payment) => `${String(payment.code)} ${vnd(money(payment.amount))} ngày ${day(payment.receivedAt)}`).join(', ')}`);
        continue;
      }
      record.push({ order, receivable });
      console.log(`GHI THU  ${line} | ${order.payNowMethod === 'CASH' ? 'tiền mặt' : 'chuyển khoản'}`);
    }
    for (const line of review) console.log(`CẦN XEM  ${line}`);
    const total = record.reduce((sum, row) => sum.add(money(row.receivable.amount)), new Decimal(0));
    console.log(`\n== ${execute ? 'CHẠY THẬT' : 'CHẠY THỬ'} — ${orders.length} đơn thanh toán ngay đã giao · ghi thu ${record.length} đơn (${vnd(total)}) · cần xem ${review.length} · đã thu ${paid}`);
    if (!execute) {
      console.log(`Chưa ghi gì. Chạy thật: PAYNOW_CONFIRM=${PAYNOW_CONFIRM} … --execute`);
      return;
    }
    const sequences = new SequenceService(db);
    const session = client.startSession();
    try {
      for (const { order, receivable } of record) {
        await session.withTransaction(async () => {
          const payment = await postPayNowReceipt(db, sequences, { receivable, order, receivedAt: order.deliveredAt as Date, actor: PAY_NOW_ACTOR }, session);
          await db.collection('audit_events').insertOne({
            _id: new ObjectId(), action: 'PAY_NOW_RECEIPT_BACKFILLED', entityType: 'SalesOrder', entityId: (order._id as ObjectId).toHexString(), actorEmail: 'backfill-pay-now-receipts',
            metadata: { rule: 'AR-PAYNOW-01', salesOrderCode: order.code, payment: payment?.code, amount: String(receivable.amount) }, occurredAt: new Date(),
          }, { session });
          console.log(`Đã ghi ${String(payment?.code)} cho ${String(order.code)}`);
        });
      }
    } finally {
      await session.endSession();
    }
    console.log(`Xong: ghi thu ${record.length} đơn.`);
  } finally {
    await client.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
