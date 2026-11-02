import { BadRequestException, ConflictException } from '@nestjs/common';
import Decimal from 'decimal.js';
import { type ClientSession, type Db, type Document, ObjectId } from 'mongodb';
import { decimal, decimalString } from '../../common/domain';
import type { SequenceService } from '../../common/sequence.service';
import { applyAllocations } from './allocation-store';
import { OPEN_RECEIVABLE_STATUSES, releaseHoldIfCleared } from './overdue-review';
import { openParts, partRank, planPartsAllocation, type OpenPart } from './segments';

/**
 * Phiếu giảm nợ "Trả hàng" (D1, 22/10/2026): kế toán xác nhận phiếu khách trả (TH…) → phiếu payments kind RETURN.
 * Trừ vào TỔNG công nợ (27/10/2026, theo kế toán — AR-RET-01), không tự trừ vào nhóm công nợ tách riêng (CN-SEG-01):
 * - Có phiếu BH gốc: nợ thường của chứng từ phiếu BH trước (mode DOCUMENT — giữ trên chứng từ đó khi phân bổ lại), phần dư trừ
 *   nợ thường còn lại cũ nhất; không có: trừ như thu theo khách (mode CUSTOMER — hạn trả cũ nhất trước).
 * - Kế toán chọn "Trừ vào nhóm X" (lúc ghi, hoặc "Đổi nơi trừ" sau — retargetReturnCredit): phần nhóm X trước rồi nợ thường,
 *   như phiếu thu "Thu cho nhóm". Chỉ khi đó hàng trả mới được trừ khỏi "hàng đang nợ theo nhóm" (segment-items.ts).
 * - Dòng hàng lưu ở `historyLines` (đối chiếu); khác phiếu trả hàng nhập từ sổ cũ, không tự chia phần nhóm theo dòng hàng
 *   (segment-store.returnSegments bỏ qua phiếu có `stockReturnId`).
 * - Vượt phần được trừ: phần dư thành khoản khách trả trước (phải thu âm), bù trừ sau như tiền thu dư.
 * - Phiếu TH sửa tiền / hủy, hoặc phiếu BH gốc bị hủy: phiếu giảm nợ tự hủy (hoàn lại phân bổ) — xem voidReturnCredit.
 */

export interface ReturnCreditLine {
  productId: ObjectId;
  sku: string;
  productName: string;
  unit: string;
  quantity: string;
  /** Đơn giá đã gồm VAT (thành tiền ÷ số lượng). */
  unitPrice: string;
  /** Thành tiền đã gồm VAT. */
  amount: string;
  /** Thuế dòng (27/10/2026): đơn giá chưa thuế kế toán nhập, thuế suất, tiền hàng, tiền thuế. */
  netUnitPrice?: string | undefined;
  vatRate?: string | undefined;
  netAmount?: string | undefined;
  taxAmount?: string | undefined;
}

export interface ReturnCreditTarget {
  partnerId: ObjectId;
  /** Phiếu BH gốc (nếu phiếu TH có số phiếu BH). */
  salesOrderId?: ObjectId | undefined;
  lines: readonly ReturnCreditLine[];
}

export interface ReturnCreditAllocation {
  receivableId: string;
  code: string;
  documentNo: string;
  segment: string | null;
  amount: string;
  /** Trừ vào chứng từ của phiếu BH gốc. */
  original: boolean;
  dueDate?: string;
}

export interface ReturnCreditPlan {
  amount: string;
  /** Nhóm kế toán chọn để trừ (null = tổng công nợ). */
  segment: string | null;
  documentMode: boolean;
  allocations: ReturnCreditAllocation[];
  /** Phần vượt số còn nợ → khoản khách trả trước. */
  credit: string;
}

const opts = (session?: ClientSession) => (session ? { session } : {});

/** Thành tiền một dòng: số lượng × đơn giá (gồm VAT), làm tròn đồng. */
export function returnLineAmount(quantity: Decimal.Value, unitPrice: Decimal.Value): string {
  return new Decimal(quantity).mul(unitPrice).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toFixed(2);
}

export function historyLinesOf(lines: readonly ReturnCreditLine[]) {
  return lines.map((line) => ({
    productId: line.productId,
    sku: line.sku,
    productName: line.productName,
    unit: line.unit,
    quantity: decimal(line.quantity),
    unitPrice: decimal(line.unitPrice),
    amount: decimal(line.amount),
    ...(line.vatRate !== undefined ? {
      netUnitPrice: decimal(line.netUnitPrice ?? '0'),
      vatRate: line.vatRate,
      netAmount: decimal(line.netAmount ?? '0'),
      taxAmount: decimal(line.taxAmount ?? '0'),
    } : {}),
  }));
}

function documentNo(row: Document): string {
  return String(row.salesOrderCode ?? row.historyInvoiceNo ?? row.historyDocumentNo ?? row.openingDocumentNo ?? row.warrantyCode ?? row.code);
}

/** Tính phiếu giảm nợ (không ghi): trừ vào chứng từ nào, phần dư thành khách trả trước. `segment` = nhóm kế toán chọn (null = tổng nợ). */
export async function planReturnCredit(db: Db, target: ReturnCreditTarget, session?: ClientSession, segment: string | null = null): Promise<ReturnCreditPlan> {
  const amount = target.lines.reduce((sum, line) => sum.add(line.amount), new Decimal(0));
  if (amount.lte(0)) return { amount: '0.00', segment, documentMode: false, allocations: [], credit: '0.00' };
  const rows = await db.collection('receivables').find({ partnerId: target.partnerId, status: { $in: OPEN_RECEIVABLE_STATUSES } }, opts(session)).toArray();
  // Chỉ trừ vào nợ thường (+ phần nhóm kế toán chọn); không bao giờ tự trừ vào nhóm công nợ riêng khác.
  const allowed = (part: OpenPart) => part.segment === null || part.segment === segment;
  const docs = rows
    .map((row) => ({ row, parts: openParts({ ...row, id: (row._id as ObjectId).toHexString(), code: String(row.code), dueDate: row.dueDate as Date, createdAt: row.createdAt as Date } as never).filter(allowed) }))
    .filter((doc) => doc.parts.length);
  const original = target.salesOrderId
    ? docs.find((doc) => (doc.row.salesOrderId as ObjectId | undefined)?.equals(target.salesOrderId as ObjectId) && doc.row.sourceType !== 'SALES_VOID_CREDIT')
    : undefined;
  const taken = new Map<string, Decimal>();
  let remaining = amount;
  const take = (part: { receivableId: string; segment: string | null; outstanding: string }) => {
    const piece = Decimal.min(part.outstanding, remaining);
    if (piece.lte(0)) return;
    const key = `${part.receivableId}|${part.segment ?? ''}`;
    taken.set(key, (taken.get(key) ?? new Decimal(0)).add(piece));
    remaining = remaining.minus(piece);
  };

  // 1) Theo đơn: chứng từ của phiếu BH gốc — phần nhóm đã chọn (nếu có) rồi nợ thường.
  if (original) for (const part of [...original.parts].sort((a, b) => partRank(a.segment, segment) - partRank(b.segment, segment))) take(part);
  // 2) Theo khách: chứng từ khác còn nợ (sổ cũ + phiếu BH trên ERP chung một hàng) — nhóm đã chọn trước, rồi hạn trả cũ nhất.
  const others = docs.filter((doc) => doc !== original).flatMap((doc) => doc.parts);
  for (const step of planPartsAllocation(others, remaining.toFixed(2), segment).allocations) take({ ...step, outstanding: step.amount });

  const byId = new Map(docs.map((doc) => [(doc.row._id as ObjectId).toHexString(), doc.row]));
  const allocations: ReturnCreditAllocation[] = [...taken]
    .filter(([, value]) => value.gt(0))
    .map(([key, value]) => {
      const [receivableId, part] = key.split('|') as [string, string];
      return allocationView(byId.get(receivableId) as Document, part || null, value.toFixed(2), byId.get(receivableId) === original?.row);
    });
  return { amount: amount.toFixed(2), segment, documentMode: Boolean(original), allocations, credit: remaining.toFixed(2) };
}

export function allocationView(row: Document, segment: string | null, amount: string, original = false): ReturnCreditAllocation {
  return {
    receivableId: (row._id as ObjectId).toHexString(),
    code: String(row.code),
    documentNo: documentNo(row),
    segment,
    amount,
    original,
    ...(row.dueDate instanceof Date ? { dueDate: (row.dueDate as Date).toISOString() } : {}),
  };
}

export interface ReturnCreditPosting extends ReturnCreditTarget {
  postedAt: Date;
  segment?: string | null | undefined;
  stockReturnId: ObjectId;
  stockReturnCode: string;
  salesOrderCode?: string | undefined;
  note: string;
  actorId: ObjectId;
  actorName: string;
}

/** Ghi phiếu giảm nợ trả hàng trong giao dịch có sẵn; trả phiếu, kế hoạch phân bổ và việc tự mở khóa khách (nếu hết nợ quá hạn). */
export async function postReturnCredit(db: Db, sequences: SequenceService, input: ReturnCreditPosting, session: ClientSession, now = new Date()) {
  const plan = await planReturnCredit(db, input, session, input.segment ?? null);
  if (new Decimal(plan.amount).lte(0)) throw new BadRequestException({ code: 'RETURN_CREDIT_ZERO', message: 'Giá trị hàng trả phải lớn hơn 0 — nhập đơn giá từng dòng, hoặc chọn "Không giảm công nợ"', details: [{ path: ['lines'] }] });
  const paymentId = new ObjectId();
  const code = await sequences.next('PAY', session);
  let prepaymentId: ObjectId | undefined;
  if (new Decimal(plan.credit).gt(0)) {
    prepaymentId = new ObjectId();
    const farFuture = new Date(now);
    farFuture.setUTCFullYear(farFuture.getUTCFullYear() + 10);
    await db.collection('receivables').insertOne({
      _id: prepaymentId,
      code: await sequences.next('AR', session),
      partnerId: input.partnerId,
      sourceType: 'CUSTOMER_PREPAYMENT',
      paymentId,
      paymentCode: code,
      amount: decimal(`-${plan.credit}`),
      paidAmount: decimal('0'),
      status: 'OPEN',
      dueDate: farFuture,
      note: `Trả hàng ${input.stockReturnCode} vượt số còn nợ — khách được trừ vào lần sau`,
      version: 1,
      createdAt: input.postedAt,
      updatedAt: now,
    }, { session });
  }
  const payment = {
    _id: paymentId,
    code,
    partnerId: input.partnerId,
    amount: decimal(plan.amount),
    kind: 'RETURN',
    mode: plan.documentMode ? 'DOCUMENT' : 'CUSTOMER',
    method: 'OTHER',
    receivedAt: input.postedAt,
    reference: input.stockReturnCode,
    note: `${input.salesOrderCode ? `theo ${input.salesOrderCode} — ` : ''}${input.note}`,
    stockReturnId: input.stockReturnId,
    ...(input.salesOrderId ? { salesOrderId: input.salesOrderId } : {}),
    ...(plan.segment ? { segment: plan.segment } : {}),
    historyLines: historyLinesOf(input.lines),
    allocations: plan.allocations.map((allocation) => ({ receivableId: new ObjectId(allocation.receivableId), amount: decimal(allocation.amount), ...(allocation.segment ? { segment: allocation.segment } : {}) })),
    ...(prepaymentId ? { prepaymentReceivableId: prepaymentId, unappliedAmount: decimal(plan.credit) } : {}),
    status: 'POSTED',
    postedBy: input.actorId,
    postedByName: input.actorName,
    postedAt: now,
    createdAt: now,
  };
  await db.collection('payments').insertOne(payment, { session });
  await applyAllocations(db, plan.allocations.map((allocation) => ({ receivableId: new ObjectId(allocation.receivableId), amount: allocation.amount, segment: allocation.segment })), session, now);
  const released = await releaseHoldIfCleared(db, input.partnerId, session, now);
  return { payment, plan, released };
}

/**
 * Hủy phiếu giảm nợ trả hàng (phiếu TH sửa tiền / hủy, phiếu BH gốc bị hủy): hoàn lại phân bổ theo phân bổ hiện tại của phiếu,
 * hủy khoản khách trả trước sinh ra từ phiếu. Khoản trả trước đó đã được bù trừ vào chứng từ khác thì dừng — kế toán xử lý tay.
 */
export async function voidReturnCredit(db: Db, paymentId: ObjectId, reason: string, actor: { id: ObjectId; name: string }, session: ClientSession, now = new Date()) {
  const payment = await db.collection('payments').findOne({ _id: paymentId, kind: 'RETURN' }, { session });
  if (!payment || payment.status !== 'POSTED') return null;
  if (payment.prepaymentReceivableId) {
    const credit = await db.collection('receivables').findOne({ _id: payment.prepaymentReceivableId as ObjectId }, { session });
    if (credit && !new Decimal(decimalString(credit.paidAmount)).isZero()) {
      throw new ConflictException({
        code: 'RETURN_CREDIT_OFFSET',
        message: `Khoản khách trả trước ${String(credit.code)} sinh từ phiếu giảm nợ ${String(payment.code)} đã được bù trừ vào chứng từ khác — báo kế toán xử lý trước khi sửa / hủy`,
      });
    }
    if (credit && credit.status !== 'VOIDED') {
      await db.collection('receivables').updateOne(
        { _id: credit._id },
        { $set: { status: 'VOIDED', statusBeforeVoid: credit.status, voidedAt: now, voidReason: reason, updatedAt: now }, $inc: { version: 1 } },
        { session },
      );
    }
  }
  const reverse = ((payment.allocations as Document[] | undefined) ?? []).map((allocation) => ({
    receivableId: allocation.receivableId as ObjectId,
    amount: new Decimal(decimalString(allocation.amount)).neg().toFixed(2),
    segment: (allocation.segment as string | undefined) ?? null,
  }));
  await applyAllocations(db, reverse, session, now);
  const updated = await db.collection('payments').updateOne(
    { _id: payment._id, status: 'POSTED' },
    { $set: { status: 'VOIDED', voidReason: reason, voidedAt: now, voidedBy: actor.id, voidedByName: actor.name } },
    { session },
  );
  if (updated.matchedCount !== 1) throw new ConflictException({ code: 'PAYMENT_CHANGED', message: `Phiếu ${String(payment.code)} vừa được cập nhật — tải lại rồi thử lại` });
  return payment;
}

/**
 * Phiếu BH bị hủy sau khi giao (sales voidInSession): hủy các phiếu giảm nợ trả hàng của phiếu — đang trừ vào chứng từ của phiếu,
 * hoặc lập theo phiếu này nhưng trừ vào nợ khác (trừ vào tổng nợ — 27/10/2026); tiền hàng trả không còn gì để trừ; phiếu TH ghi
 * "không giảm công nợ" kèm lý do. Trả số phiếu TH đã đổi.
 */
export async function voidReturnCreditsOf(db: Db, receivableIds: readonly ObjectId[], orderCode: string, actor: { id: ObjectId; name: string }, session: ClientSession, now = new Date(), salesOrderId?: ObjectId) {
  const match = [
    ...(receivableIds.length ? [{ 'allocations.receivableId': { $in: [...receivableIds] } }] : []),
    ...(salesOrderId ? [{ salesOrderId }] : []),
  ];
  if (!match.length) return [];
  const payments = await db.collection('payments').find({ kind: 'RETURN', status: 'POSTED', $or: match }, { session }).toArray();
  const codes: string[] = [];
  for (const payment of payments) {
    const reason = `Phiếu bán ${orderCode} đã hủy`;
    await voidReturnCredit(db, payment._id as ObjectId, reason, actor, session, now);
    const slip = await db.collection('stock_returns').findOneAndUpdate(
      { 'creditNote.paymentId': payment._id },
      {
        $set: { accountingStatus: 'DONE', accountingMode: 'NONE', accountingNote: `${reason} — phiếu giảm nợ ${String(payment.code)} tự hủy, không còn công nợ để giảm`, accountingByName: actor.name, accountingAt: now, updatedAt: now },
        $unset: { creditNote: '' },
      },
      { session, returnDocument: 'after' },
    );
    if (slip) codes.push(String(slip.code));
  }
  return codes;
}
