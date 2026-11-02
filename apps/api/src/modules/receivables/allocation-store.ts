import { ConflictException, NotFoundException } from '@nestjs/common';
import Decimal from 'decimal.js';
import type { ClientSession, Db, Document, ObjectId } from 'mongodb';
import { decimal, decimalString } from '../../common/domain';

/**
 * Ghi phân bổ vào chứng từ (cộng paidAmount, cập nhật trạng thái) — dùng chung cho thu theo chứng từ, thu theo khách,
 * bù trừ trả trước, phiếu giảm nợ trả hàng và nhập lịch sử. Phân bổ âm: bù trừ khoản trả trước (phải thu âm) hoặc hoàn
 * lại phân bổ của phiếu bị hủy (không để số đã trả của chứng từ / phần nhóm âm).
 */
export async function applyAllocations(
  db: Db,
  allocations: ReadonlyArray<{ receivableId: ObjectId; amount: string; segment?: string | null | undefined }>,
  session: ClientSession,
  now: Date,
) {
  for (const allocation of allocations) {
    const receivable = await db.collection('receivables').findOne({ _id: allocation.receivableId }, { session });
    if (!receivable) throw new NotFoundException({ code: 'RECEIVABLE_NOT_FOUND', message: 'Không tìm thấy khoản phải thu' });
    const amount = new Decimal(decimalString(receivable.amount));
    const nextPaid = new Decimal(decimalString(receivable.paidAmount)).add(allocation.amount);
    const credit = amount.lt(0);
    if (credit ? nextPaid.lt(amount) || nextPaid.gt(0) : nextPaid.gt(amount) || nextPaid.lt(0)) {
      throw new ConflictException({ code: 'PAYMENT_EXCEEDS_OUTSTANDING', message: `Số tiền phân bổ vượt dư nợ chứng từ ${String(receivable.code)}` });
    }
    // Phần nhóm tách riêng (CN-SEG-01): cộng vào "đã trả" của đúng phần, không vượt phần đó và không âm.
    const part = allocation.segment ? ((receivable.segments as Document[] | undefined) ?? []).find((item) => item.code === allocation.segment) : undefined;
    const partPaid = part ? new Decimal(decimalString(part.paid)).add(allocation.amount) : undefined;
    if (allocation.segment && (!part || !partPaid || partPaid.gt(decimalString(part.amount)) || partPaid.lt(0))) {
      throw new ConflictException({ code: 'PAYMENT_EXCEEDS_OUTSTANDING', message: `Số tiền phân bổ vượt phần nhóm ${allocation.segment} của chứng từ ${String(receivable.code)}` });
    }
    const status = nextPaid.eq(amount) ? 'PAID' : credit ? 'OPEN' : nextPaid.gt(0) ? 'PARTIALLY_PAID' : receivable.status === 'OVERDUE' ? 'OVERDUE' : 'OPEN';
    const result = await db.collection('receivables').updateOne(
      { _id: allocation.receivableId, version: receivable.version },
      {
        $inc: { paidAmount: decimal(allocation.amount), version: 1, ...(allocation.segment ? { 'segments.$[part].paid': decimal(allocation.amount) } : {}) },
        $set: { status, updatedAt: now },
      },
      { session, ...(allocation.segment ? { arrayFilters: [{ 'part.code': allocation.segment }] } : {}) },
    );
    if (result.matchedCount !== 1) throw new ConflictException({ code: 'RECEIVABLE_CHANGED', message: 'Chứng từ vừa được người khác cập nhật — tải lại rồi thử lại' });
  }
}
