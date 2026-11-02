import { isNonSalePurpose } from '@inoxpran/contracts';
import Decimal from 'decimal.js';
import type { ClientSession, Db, ObjectId } from 'mongodb';
import { decimalString } from '../../common/domain';

/**
 * Phiếu bán đã xuất kho (SWK) nhưng chưa xác nhận giao (AR-DLV-01, 28/10/2026): chưa ghi công nợ / doanh thu,
 * vẫn tính vào hạn mức công nợ khi duyệt phiếu mới (như trước khi đổi) và hiện riêng trên trang công nợ khách để đối chiếu.
 * Phiếu SWK lập trước 28/10/2026 đã có khoản phải thu thì không tính lại.
 */
export async function pendingDeliveryOf(db: Db, partnerId: ObjectId, session?: ClientSession): Promise<{ count: number; amount: string; orders: Array<{ id: string; code: string; amount: string; shippedAt: string | null }> }> {
  const options = session ? { session } : {};
  const shipped = (await db.collection('sales_orders')
    .find({ customerId: partnerId, status: 'SHIPPED' }, { ...options, projection: { code: 1, grandTotal: 1, purpose: 1, shippedAt: 1 } })
    .sort({ shippedAt: 1 })
    .toArray())
    .filter((order) => !isNonSalePurpose(order.purpose));
  if (!shipped.length) return { count: 0, amount: '0.00', orders: [] };
  const posted = new Set(
    (await db.collection('receivables').distinct('salesOrderId', { salesOrderId: { $in: shipped.map((order) => order._id) }, sourceType: { $ne: 'SALES_VOID_CREDIT' }, status: { $ne: 'VOIDED' } }, options))
      .map((value) => String(value)),
  );
  const pending = shipped.filter((order) => !posted.has(String(order._id)));
  const amount = pending.reduce((sum, order) => sum.add(decimalString(order.grandTotal)), new Decimal(0));
  return {
    count: pending.length,
    amount: amount.toFixed(2),
    orders: pending.map((order) => ({
      id: String(order._id),
      code: String(order.code),
      amount: new Decimal(decimalString(order.grandTotal)).toFixed(2),
      shippedAt: order.shippedAt instanceof Date ? order.shippedAt.toISOString() : null,
    })),
  };
}
