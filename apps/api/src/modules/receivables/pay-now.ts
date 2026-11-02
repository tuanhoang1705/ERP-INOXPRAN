import Decimal from 'decimal.js';
import { type ClientSession, type Db, type Document, ObjectId } from 'mongodb';
import { decimal, decimalString } from '../../common/domain';
import type { SequenceService } from '../../common/sequence.service';
import { applyAllocations } from './allocation-store';
import { releaseHoldIfCleared } from './overdue-review';

/**
 * Đơn "Thanh toán ngay" (AR-PAYNOW-01, 31/10/2026): hạn thanh toán 0 ngày = khách trả tiền khi nhận hàng. Giao xong, hệ thống tự
 * ghi phiếu thu (payments kind RECEIPT, `autoPayNow`) đúng số phải thu của phiếu, ngày thu = ngày giao, phân bổ đủ vào chứng từ
 * (cả phần nhóm công nợ tách riêng) — công nợ của phiếu PAID, không báo quá hạn, tính vào "Đã thu" của tháng.
 * Hủy phiếu BH / sửa số tiền sau giao: phiếu thu tự động hủy theo (rồi ghi lại theo số mới). Khách thực tế chưa trả: kế toán
 * "Bỏ ghi thu tự động" → hủy phiếu thu, chứng từ mở lại với hạn = ngày giao.
 */

export const PAY_NOW_NOTE = 'Thu ngay khi giao hàng — đơn thanh toán ngay (hệ thống tự ghi)';

export interface PayNowActor { id: ObjectId | null; name: string }

/** Người ghi của phiếu thu tự động. */
export const PAY_NOW_ACTOR: PayNowActor = { id: null, name: 'Hệ thống · thanh toán ngay' };

/** Phân bổ đủ một chứng từ còn nguyên: phần nhóm tách riêng trả đủ từng phần, phần còn lại là nợ thường. */
export function fullAllocations(receivable: Document): Array<{ receivableId: ObjectId; amount: string; segment: string | null }> {
  const amount = new Decimal(decimalString(receivable.amount)).minus(decimalString(receivable.paidAmount ?? '0'));
  const parts = ((receivable.segments as Document[] | undefined) ?? [])
    .map((part) => ({ code: String(part.code), open: new Decimal(decimalString(part.amount)).minus(decimalString(part.paid ?? '0')) }))
    .filter((part) => part.open.gt(0));
  const segmented = parts.reduce((sum, part) => sum.add(part.open), new Decimal(0));
  const normal = amount.minus(segmented);
  return [
    ...(normal.gt(0) ? [{ receivableId: receivable._id as ObjectId, amount: normal.toFixed(2), segment: null }] : []),
    ...parts.map((part) => ({ receivableId: receivable._id as ObjectId, amount: part.open.toFixed(2), segment: part.code })),
  ];
}

/** Ghi phiếu thu tự động cho chứng từ của đơn thanh toán ngay. Bỏ qua chứng từ 0 đ / đã thu đủ. */
export async function postPayNowReceipt(
  db: Db,
  sequences: SequenceService,
  input: { receivable: Document; order: Document; receivedAt: Date; actor: PayNowActor },
  session: ClientSession,
  now = new Date(),
): Promise<Document | null> {
  const allocations = fullAllocations(input.receivable);
  const amount = allocations.reduce((sum, allocation) => sum.add(allocation.amount), new Decimal(0));
  if (amount.lte(0)) return null;
  const payment = {
    _id: new ObjectId(),
    code: await sequences.next('PAY', session),
    partnerId: input.receivable.partnerId as ObjectId,
    amount: decimal(amount.toFixed(2)),
    kind: 'RECEIPT',
    mode: 'DOCUMENT',
    method: String(input.order.payNowMethod ?? 'BANK_TRANSFER'),
    receivedAt: input.receivedAt,
    reference: String(input.order.code),
    note: PAY_NOW_NOTE,
    salesOrderId: input.order._id as ObjectId,
    salesOrderCode: String(input.order.code),
    autoPayNow: true,
    allocations: allocations.map((part) => ({ receivableId: part.receivableId, amount: decimal(part.amount), ...(part.segment ? { segment: part.segment } : {}) })),
    status: 'POSTED',
    ...(input.actor.id ? { postedBy: input.actor.id } : {}),
    postedByName: input.actor.name,
    postedAt: now,
    createdAt: now,
  };
  await db.collection('payments').insertOne(payment, { session });
  await applyAllocations(db, allocations, session, now);
  await releaseHoldIfCleared(db, payment.partnerId, session, now);
  return payment;
}

/** Hủy các phiếu thu tự động còn hiệu lực của một đơn (hoàn lại phân bổ). Trả các phiếu đã hủy. */
export async function voidPayNowReceipts(db: Db, salesOrderId: ObjectId, reason: string, actor: PayNowActor, session: ClientSession, now = new Date()): Promise<Document[]> {
  const payments = await db.collection('payments').find({ salesOrderId, autoPayNow: true, status: 'POSTED' }, { session }).toArray();
  for (const payment of payments) {
    const reverse = ((payment.allocations as Document[] | undefined) ?? []).map((allocation) => ({
      receivableId: allocation.receivableId as ObjectId,
      amount: new Decimal(decimalString(allocation.amount)).neg().toFixed(2),
      segment: (allocation.segment as string | undefined) ?? null,
    }));
    await applyAllocations(db, reverse, session, now);
    await db.collection('payments').updateOne(
      { _id: payment._id, status: 'POSTED' },
      { $set: { status: 'VOIDED', voidReason: reason, voidedAt: now, ...(actor.id ? { voidedBy: actor.id } : {}), voidedByName: actor.name } },
      { session },
    );
  }
  return payments;
}
