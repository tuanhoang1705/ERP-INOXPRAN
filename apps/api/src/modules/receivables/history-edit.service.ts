import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { HistoryDocumentCreate, HistoryDocumentEdit, HistoryPaymentCreate, HistoryPaymentEdit, HistoryRowDelete } from '@inoxpran/contracts';
import Decimal from 'decimal.js';
import { ObjectId, type ClientSession, type Db, type Document, type WithId } from 'mongodb';
import { AuditService } from '../../common/audit.service';
import { assertNotFutureDay } from '../../common/future-date';
import { decimal, decimalString, serializeDocument, toObjectId } from '../../common/domain';
import { IdempotencyService } from '../../common/idempotency.service';
import type { AuthenticatedRequest } from '../../common/request-context';
import { SequenceService } from '../../common/sequence.service';
import { MONGO_DATABASE } from '../../common/tokens';
import { planHistoryCredits, receivableStatus } from './history-edit';
import { releaseHoldIfCleared } from './overdue-review';
import { DOCUMENT_MODES } from './reallocate';
import { reallocatePartner } from './segment-store';

const DAY_MS = 86_400_000;
const vnNoon = (day: string) => new Date(`${day}T12:00:00+07:00`);
const addDays = (day: string, days: number) => new Date(new Date(`${day}T00:00:00+07:00`).getTime() + days * DAY_MS);
const vnDay = (value: Date) => new Date(value.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);
const KIND_LABEL: Record<string, string> = { RECEIPT: 'Thu tiền', FREIGHT: 'Phí vận chuyển khách trả', RETURN: 'Trả hàng / điều chỉnh giảm' };
const LEDGER_KINDS = ['RECEIPT', 'FREIGHT', 'RETURN'];
/** Phiếu xếp lại được theo ngày: sổ cũ, thu theo khách (không phải giảm nợ từ Phiếu trả hàng). */
const flexiblePayment = (row: Document) => row.mode === 'HISTORY' || (row.mode === 'CUSTOMER' && LEDGER_KINDS.includes(String(row.kind ?? 'RECEIPT')) && !row.stockReturnId);
/** Khoản phải thu âm do hệ thống sinh (trả trước, hủy phiếu đã thu) — không phải dòng sổ, không sửa tay. */
const DERIVED_SOURCES = ['CUSTOMER_PREPAYMENT', 'SALES_VOID_CREDIT'];
/** Chứng từ có số chứng từ / số HĐ do kế toán ghi (sổ cũ, dòng thêm tay); phiếu BH / phí bảo hành giữ số gốc. */
const NUMBERED_SOURCES = ['HISTORY_IMPORT', 'MANUAL', 'OPENING_BALANCE'];

/**
 * Thêm / sửa / xóa dòng sổ công nợ của khách (CN-HIST-EDIT-01 — 02/11/2026 dòng sổ cũ; 03/11/2026 mọi dòng, yêu cầu của
 * người dùng) trên sổ chi tiết công nợ khách. Mỗi thay đổi tính lại phân bổ của khách: phiếu sổ cũ (`mode: HISTORY`) và phiếu
 * thu theo khách (`mode: CUSTOMER`) lấy lại phần chứng từ còn chỗ theo ngày, phần dư → khoản khách trả trước (sổ cũ: một khoản
 * chung; phiếu thu theo khách: khoản của chính phiếu); phiếu thu theo đúng chứng từ / bù trừ / phiếu giảm nợ trả hàng giữ nguyên.
 * Phiếu thu tự động của đơn thanh toán ngay và phiếu giảm nợ từ Phiếu trả hàng sửa ở chứng từ gốc.
 */
@Injectable()
export class HistoryEditService {
  constructor(
    @Inject(MONGO_DATABASE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly sequences: SequenceService,
  ) {}

  /** Thêm phát sinh nợ (điều chỉnh tăng / chứng từ sổ cũ bị thiếu) — khoản phải thu `MANUAL`. */
  async createDocument(input: HistoryDocumentCreate, request: AuthenticatedRequest, key: string | undefined) {
    assertNotFutureDay(input.date, 'date', 'Ngày chứng từ');
    return this.idempotency.execute(`history-edit:${request.user.sub}`, key, { create: 'DOCUMENT', ...input }, async (session) => {
      const partner = await this.customer(input.partnerId, session);
      const now = new Date();
      const doc: Document = {
        _id: new ObjectId(),
        code: await this.sequences.next('AR', session, vnNoon(input.date)),
        partnerId: partner._id,
        sourceType: 'MANUAL',
        ...(input.documentNo ? { historyDocumentNo: input.documentNo } : {}),
        ...(input.invoiceNo ? { historyInvoiceNo: input.invoiceNo } : {}),
        documentDate: input.date,
        ...(input.note ? { note: input.note } : {}),
        amount: decimal(new Decimal(input.amount).toFixed(2)),
        paidAmount: decimal('0'),
        status: 'OPEN',
        dueDate: addDays(input.date, Number(partner.paymentTermDays ?? 0)),
        createdAt: vnNoon(input.date),
        updatedAt: now,
        version: 1,
        ...this.addedStamp(request, input.reason, now),
      };
      await this.db.collection('receivables').insertOne(doc, { session });
      return this.finish({ action: 'CREATED', kind: 'DOCUMENT', record: doc, after: doc, partnerCode: String(partner.code), reason: input.reason, request, session, now });
    });
  }

  /** Thêm phiếu thu / phí vận chuyển / trả hàng – giảm giá — như thu theo khách (phân bổ chứng từ cũ trước, dư → trả trước). */
  async createPayment(input: HistoryPaymentCreate, request: AuthenticatedRequest, key: string | undefined) {
    assertNotFutureDay(input.date, 'date', 'Ngày chứng từ');
    return this.idempotency.execute(`history-edit:${request.user.sub}`, key, { create: 'PAYMENT', ...input }, async (session) => {
      const partner = await this.customer(input.partnerId, session);
      const now = new Date();
      const payment: Document = {
        _id: new ObjectId(),
        code: await this.sequences.next('PAY', session, vnNoon(input.date)),
        partnerId: partner._id,
        amount: decimal(new Decimal(input.amount).toFixed(2)),
        kind: input.kind,
        mode: 'CUSTOMER',
        method: 'OTHER',
        receivedAt: vnNoon(input.date),
        ...(input.reference ? { reference: input.reference } : {}),
        note: input.note || KIND_LABEL[input.kind],
        allocations: [],
        status: 'POSTED',
        postedBy: toObjectId(request.user.sub),
        postedAt: now,
        createdAt: now,
        ...this.addedStamp(request, input.reason, now),
      };
      await this.db.collection('payments').insertOne(payment, { session });
      return this.finish({ action: 'CREATED', kind: 'PAYMENT', record: payment, after: payment, partnerCode: String(partner.code), reason: input.reason, request, session, now });
    });
  }

  async editDocument(id: string, input: HistoryDocumentEdit, request: AuthenticatedRequest, key: string | undefined) {
    assertNotFutureDay(input.date, 'date', 'Ngày chứng từ');
    return this.idempotency.execute(`history-edit:${request.user.sub}`, key, { id, ...input }, async (session) => {
      const doc = await this.ledgerDocument(id, session);
      if (doc.version !== input.version) throw new ConflictException({ code: 'VERSION_CONFLICT', message: 'Chứng từ đã được người khác cập nhật — tải lại rồi thử lại' });
      const pinned = await this.documentPins(doc._id as ObjectId, session);
      if (pinned.total.gt(input.amount)) {
        throw new ConflictException({
          code: 'HISTORY_EDIT_ERP_PAID',
          message: `Chứng từ đã được thu ${pinned.total.toFixed(0)} đ bằng phiếu thu theo chứng từ (${pinned.codes.join(', ')}) — số tiền mới không được nhỏ hơn`,
          details: { paid: pinned.total.toFixed(2), payments: pinned.codes },
        });
      }
      const partner = await this.db.collection('partners').findOne({ _id: doc.partnerId as ObjectId }, { session, projection: { code: 1 } });
      const now = new Date();
      const numbered = NUMBERED_SOURCES.includes(String(doc.sourceType ?? ''));
      // Đổi ngày: hạn trả dời theo cùng số ngày (giữ số ngày nợ của chứng từ).
      const shift = new Date(`${input.date}T00:00:00+07:00`).getTime() - new Date(`${vnDay(doc.createdAt as Date)}T00:00:00+07:00`).getTime();
      const set: Document = {
        amount: decimal(new Decimal(input.amount).toFixed(2)),
        createdAt: vnNoon(input.date),
        dueDate: new Date((doc.dueDate as Date).getTime() + shift),
        ...(numbered ? { documentDate: input.date } : {}),
        ...(numbered && input.documentNo ? { historyDocumentNo: input.documentNo } : {}),
        ...(numbered && input.invoiceNo ? { historyInvoiceNo: input.invoiceNo } : {}),
        ...(input.note ? { note: input.note } : {}),
        manualEditedAt: now,
        manualEditedByName: request.user.displayName,
        manualEditReason: input.reason,
        updatedAt: now,
      };
      const unset: Document = {
        ...(numbered && !input.documentNo ? { historyDocumentNo: '' } : {}),
        ...(numbered && !input.invoiceNo ? { historyInvoiceNo: '' } : {}),
        ...(input.note ? {} : { note: '' }),
        // Số đã sửa tay thay số "giữ theo phiếu thu" lúc thay lô.
        historyFileAmount: '',
      };
      await this.db.collection('receivables').updateOne({ _id: doc._id }, { $set: set, $unset: unset, $inc: { version: 1 } }, { session });
      const after = await this.db.collection('receivables').findOne({ _id: doc._id }, { session });
      return this.finish({ action: 'UPDATED', kind: 'DOCUMENT', record: doc, after, partnerCode: String(partner?.code ?? ''), reason: input.reason, request, session, now });
    });
  }

  async deleteDocument(id: string, input: HistoryRowDelete, request: AuthenticatedRequest, key: string | undefined) {
    return this.idempotency.execute(`history-edit:${request.user.sub}`, key, { id, delete: 'DOCUMENT', ...input }, async (session) => {
      const doc = await this.ledgerDocument(id, session);
      if (input.version !== undefined && doc.version !== input.version) throw new ConflictException({ code: 'VERSION_CONFLICT', message: 'Chứng từ đã được người khác cập nhật — tải lại rồi thử lại' });
      const pinned = await this.documentPins(doc._id as ObjectId, session);
      if (pinned.total.gt(0)) {
        throw new ConflictException({
          code: 'HISTORY_EDIT_ERP_PAID',
          message: `Chứng từ đã được thu ${pinned.total.toFixed(0)} đ bằng phiếu thu theo chứng từ (${pinned.codes.join(', ')}) — không xóa được`,
          details: { paid: pinned.total.toFixed(2), payments: pinned.codes },
        });
      }
      const partner = await this.db.collection('partners').findOne({ _id: doc.partnerId as ObjectId }, { session, projection: { code: 1 } });
      const now = new Date();
      await this.db.collection('receivables').deleteOne({ _id: doc._id }, { session });
      if (doc.importBatchId) await this.db.collection('import_batches').updateOne({ _id: doc.importBatchId as ObjectId }, { $pull: { receivableIds: doc._id } } as Document, { session });
      return this.finish({ action: 'DELETED', kind: 'DOCUMENT', record: doc, after: null, partnerCode: String(partner?.code ?? ''), reason: input.reason, request, session, now });
    });
  }

  async editPayment(id: string, input: HistoryPaymentEdit, request: AuthenticatedRequest, key: string | undefined) {
    assertNotFutureDay(input.date, 'date', 'Ngày chứng từ');
    return this.idempotency.execute(`history-edit:${request.user.sub}`, key, { id, ...input }, async (session) => {
      const payment = await this.ledgerPayment(id, session);
      const partner = await this.db.collection('partners').findOne({ _id: payment.partnerId as ObjectId }, { session, projection: { code: 1 } });
      const now = new Date();
      // Phiếu thu theo đúng chứng từ: phân bổ lại trong chính các chứng từ đó, không vượt số còn nợ.
      const documentAllocations = DOCUMENT_MODES.has(String(payment.mode ?? '')) ? await this.documentAllocations(payment, input.amount, session) : null;
      const history = payment.mode === 'HISTORY';
      const set: Document = {
        amount: decimal(new Decimal(input.amount).toFixed(2)),
        kind: input.kind,
        receivedAt: vnNoon(input.date),
        ...(input.reference ? { reference: input.reference, ...(history ? { historyDocumentNo: input.reference } : {}) } : {}),
        ...(input.note ? { note: input.note } : history ? { note: KIND_LABEL[input.kind] } : {}),
        ...(documentAllocations ? { allocations: documentAllocations } : {}),
        manualEditedAt: now,
        manualEditedByName: request.user.displayName,
        manualEditReason: input.reason,
        updatedAt: now,
      };
      const unset: Document = {
        ...(input.reference ? {} : { reference: '', ...(history ? { historyDocumentNo: '' } : {}) }),
        ...(input.note || history ? {} : { note: '' }),
      };
      await this.db.collection('payments').updateOne({ _id: payment._id }, { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}) }, { session });
      const after = await this.db.collection('payments').findOne({ _id: payment._id }, { session });
      return this.finish({ action: 'UPDATED', kind: 'PAYMENT', record: payment, after, partnerCode: String(partner?.code ?? ''), reason: input.reason, request, session, now });
    });
  }

  async deletePayment(id: string, input: HistoryRowDelete, request: AuthenticatedRequest, key: string | undefined) {
    return this.idempotency.execute(`history-edit:${request.user.sub}`, key, { id, delete: 'PAYMENT', ...input }, async (session) => {
      const payment = await this.ledgerPayment(id, session);
      const partner = await this.db.collection('partners').findOne({ _id: payment.partnerId as ObjectId }, { session, projection: { code: 1 } });
      const now = new Date();
      await this.db.collection('payments').deleteOne({ _id: payment._id }, { session });
      if (payment.importBatchId) await this.db.collection('import_batches').updateOne({ _id: payment.importBatchId as ObjectId }, { $pull: { paymentIds: payment._id } } as Document, { session });
      return this.finish({ action: 'DELETED', kind: 'PAYMENT', record: payment, after: null, partnerCode: String(partner?.code ?? ''), reason: input.reason, request, session, now, deletedPaymentId: payment._id as ObjectId });
    });
  }

  /** Dấu dòng thêm tay: hiện "Thêm tay · người · ngày" trên sổ. */
  private addedStamp(request: AuthenticatedRequest, reason: string, now: Date) {
    return { manualAdded: true, manualEditedAt: now, manualEditedByName: request.user.displayName, manualEditReason: reason };
  }

  private async customer(partnerIdValue: string, session: ClientSession) {
    const partner = await this.db.collection('partners').findOne({ _id: toObjectId(partnerIdValue, 'partnerId'), kind: { $in: ['CUSTOMER', 'BOTH'] } }, { session });
    if (!partner) throw new NotFoundException({ code: 'CUSTOMER_NOT_FOUND', message: 'Không tìm thấy khách hàng' });
    return partner;
  }

  /** Dòng phát sinh nợ sửa / xóa được: khoản phải thu dương còn hiệu lực (không phải khoản âm hệ thống sinh). */
  private async ledgerDocument(id: string, session: ClientSession) {
    const doc = await this.db.collection('receivables').findOne({ _id: toObjectId(id) }, { session });
    if (!doc || DERIVED_SOURCES.includes(String(doc.sourceType ?? '')) || new Decimal(decimalString(doc.amount)).lte(0)) {
      throw new NotFoundException({ code: 'HISTORY_ROW_NOT_FOUND', message: 'Không tìm thấy chứng từ trên sổ công nợ' });
    }
    if (doc.status === 'VOIDED') throw new ConflictException({ code: 'HISTORY_ROW_VOIDED', message: 'Chứng từ đã hủy — không sửa / xóa được' });
    return doc;
  }

  /** Dòng thu tiền / phí vận chuyển / trả hàng sửa / xóa được; phiếu gắn chứng từ khác thì sửa ở chứng từ đó. */
  private async ledgerPayment(id: string, session: ClientSession) {
    const payment = await this.db.collection('payments').findOne({ _id: toObjectId(id), status: 'POSTED' }, { session });
    if (!payment || !LEDGER_KINDS.includes(String(payment.kind ?? 'RECEIPT'))) throw new NotFoundException({ code: 'HISTORY_ROW_NOT_FOUND', message: 'Không tìm thấy phiếu trên sổ công nợ' });
    if (payment.autoPayNow) {
      throw new ConflictException({ code: 'PAYMENT_LOCKED_PAY_NOW', message: `Phiếu thu ${String(payment.code)} tự ghi cho đơn thanh toán ngay — dùng "Bỏ ghi thu" trên phiếu BH` });
    }
    if (payment.stockReturnId) {
      throw new ConflictException({ code: 'PAYMENT_LOCKED_STOCK_RETURN', message: `Phiếu giảm nợ ${String(payment.code)} sinh từ Phiếu trả hàng — sửa / hủy trên Phiếu trả hàng` });
    }
    return payment;
  }

  /** Phiếu thu theo đúng chứng từ (phân bổ cố định) đã trả vào chứng từ — phần này không dời sang chứng từ khác được. */
  /**
   * Sửa chứng từ gốc làm số tiền nhỏ hơn số đã thu (SAL-EDIT-GRANT-01 phiếu BH, WAR-EDIT-01 phí bảo hành — 06/11/2026):
   * phần đã thu bằng phiếu cố định (thu theo đúng chứng từ, bù trừ, giảm nợ trả hàng, thu ngay…) không tự chuyển đi được.
   * Trả tổng phần cố định đó + số phiếu để báo người dùng; phần thu theo khách / sổ cũ sẽ được xếp lại bằng `rebuildPartner`.
   */
  async fixedPaidOn(receivableId: ObjectId, session?: ClientSession) {
    const payments = await this.db.collection('payments').find({ status: 'POSTED', 'allocations.receivableId': receivableId }, { ...(session ? { session } : {}), projection: { code: 1, mode: 1, kind: 1, stockReturnId: 1, allocations: 1 } }).toArray();
    let total = new Decimal(0);
    const codes: string[] = [];
    for (const payment of payments) {
      if (flexiblePayment(payment)) continue;
      for (const allocation of (payment.allocations as Document[] | undefined) ?? []) {
        if (!(allocation.receivableId as ObjectId).equals(receivableId)) continue;
        total = total.add(decimalString(allocation.amount));
        if (!codes.includes(String(payment.code))) codes.push(String(payment.code));
      }
    }
    return { total, codes };
  }

  /**
   * Xếp lại tiền đã thu của khách sau khi số tiền một chứng từ đổi ở nơi khác (sửa phiếu BH / phí bảo hành): phiếu thu theo khách
   * và sổ cũ lấy lại phần chứng từ còn chỗ, phần dư → khoản khách trả trước. Gọi trong giao dịch của thao tác sửa.
   */
  async rebuildPartner(partnerId: ObjectId, session: ClientSession, now: Date): Promise<string> {
    return this.rebuild(partnerId, undefined, session, now);
  }

  private async documentPins(receivableId: ObjectId, session: ClientSession) {
    const payments = await this.db.collection('payments').find({ status: 'POSTED', mode: { $ne: 'HISTORY' }, 'allocations.receivableId': receivableId }, { session, projection: { code: 1, mode: 1, allocations: 1 } }).toArray();
    let total = new Decimal(0);
    const codes: string[] = [];
    for (const payment of payments) {
      if (!DOCUMENT_MODES.has(String(payment.mode ?? ''))) continue;
      for (const allocation of (payment.allocations as Document[] | undefined) ?? []) {
        if (!(allocation.receivableId as ObjectId).equals(receivableId)) continue;
        total = total.add(decimalString(allocation.amount));
        if (!codes.includes(String(payment.code))) codes.push(String(payment.code));
      }
    }
    return { total, codes };
  }

  /** Phiếu thu theo đúng chứng từ đổi số tiền: chia lại vào đúng các chứng từ cũ theo thứ tự, mỗi chứng từ tối đa phần còn nợ. */
  private async documentAllocations(payment: Document, amount: string, session: ClientSession) {
    const targets = ((payment.allocations as Document[] | undefined) ?? []).filter((row) => new Decimal(decimalString(row.amount)).gt(0));
    const ids = targets.map((row) => row.receivableId as ObjectId);
    const [docs, others] = await Promise.all([
      this.db.collection('receivables').find({ _id: { $in: ids } }, { session }).toArray(),
      this.db.collection('payments').find({ _id: { $ne: payment._id }, status: 'POSTED', 'allocations.receivableId': { $in: ids } }, { session, projection: { allocations: 1 } }).toArray(),
    ]);
    let remaining = new Decimal(amount);
    let room = new Decimal(0);
    const allocations: Document[] = [];
    for (const target of targets) {
      const doc = docs.find((row) => (row._id as ObjectId).equals(target.receivableId as ObjectId));
      if (!doc || doc.status === 'VOIDED') continue;
      const taken = others.reduce<Decimal>((sum, row) => sum.add(((row.allocations as Document[] | undefined) ?? []).filter((item) => (item.receivableId as ObjectId).equals(doc._id as ObjectId)).reduce<Decimal>((part, item) => part.add(decimalString(item.amount)), new Decimal(0))), new Decimal(0));
      const free = Decimal.max(new Decimal(decimalString(doc.amount)).minus(taken), 0);
      room = room.add(free);
      const piece = Decimal.min(free, remaining);
      if (piece.gt(0)) {
        allocations.push({ receivableId: doc._id, amount: decimal(piece.toFixed(2)) });
        remaining = remaining.minus(piece);
      }
    }
    if (remaining.gt(0)) {
      throw new ConflictException({ code: 'PAYMENT_EXCEEDS_DOCUMENT', message: `Phiếu ${String(payment.code)} thu theo đúng chứng từ: số mới vượt số còn nợ của chứng từ (tối đa ${room.toFixed(0)} đ)` });
    }
    return allocations;
  }

  /** Tính lại khách, ghi dấu lô, nhật ký; trả số còn nợ mới của khách. */
  private async finish(input: {
    action: 'CREATED' | 'UPDATED' | 'DELETED'; kind: 'DOCUMENT' | 'PAYMENT'; record: Document; after: Document | null; partnerCode: string; reason: string;
    request: AuthenticatedRequest; session: ClientSession; now: Date; deletedPaymentId?: ObjectId;
  }) {
    const { record, request, session, now } = input;
    const partnerId = record.partnerId as ObjectId;
    const balance = await this.rebuild(partnerId, record.importBatchId as ObjectId | undefined, session, now, input.deletedPaymentId);
    const code = String(record.code);
    // Số kế toán quen dùng trên sổ: số HĐ / số chứng từ, phiếu BH, phiếu thu theo số tham chiếu.
    const label = String(input.kind === 'DOCUMENT' ? record.historyInvoiceNo || record.historyDocumentNo || record.salesOrderCode || record.warrantyCode || code : record.reference || code);
    if (record.importBatchId) {
      await this.db.collection('import_batches').updateOne(
        { _id: record.importBatchId as ObjectId },
        { $push: { manualEdits: { at: now, byName: request.user.displayName, action: input.action, kind: input.kind, code, partnerCode: input.partnerCode, reason: input.reason } } } as Document,
        { session },
      );
    }
    await this.audit.record({
      actorId: request.user.sub, actorEmail: request.user.email, correlationId: request.correlationId,
      action: `AR_HISTORY_ROW_${input.action}`,
      entityType: input.kind === 'DOCUMENT' ? 'Receivable' : 'Payment', entityId: (record._id as ObjectId).toHexString(),
      ...(input.action === 'CREATED' ? {} : { before: serializeDocument(record) }), ...(input.after ? { after: serializeDocument(input.after) } : {}),
      metadata: { reason: input.reason, partnerCode: input.partnerCode, balance },
    }, session);
    return { action: input.action, kind: input.kind, code: label, partnerId: partnerId.toHexString(), balance };
  }

  /**
   * Phân bổ lại các phiếu linh hoạt của khách (sổ cũ + thu theo khách) theo ngày vào phần chứng từ còn chỗ, cập nhật các khoản
   * trả trước tương ứng, ghi số đã thu từng chứng từ cho khớp tổng phân bổ, rồi xếp lại theo nhóm công nợ tách riêng
   * (reallocatePartner). Lỗi → hủy cả giao dịch.
   */
  private async rebuild(partnerId: ObjectId, batchId: ObjectId | undefined, session: ClientSession, now: Date, deletedPaymentId?: ObjectId): Promise<string> {
    const [receivables, payments] = await Promise.all([
      this.db.collection('receivables').find({ partnerId }, { session }).toArray(),
      this.db.collection('payments').find({ partnerId, status: 'POSTED' }, { session }).toArray(),
    ]);
    const movable = payments.filter(flexiblePayment);
    const fixed = payments.filter((row) => !flexiblePayment(row));
    const amountOf = (row: Document) => new Decimal(decimalString(row.amount));
    const pooled = receivables.filter((row) => row.status !== 'VOIDED' && amountOf(row).gt(0));
    const pooledIds = new Set(pooled.map((row) => (row._id as ObjectId).toHexString()));
    const existingIds = new Set(receivables.map((row) => (row._id as ObjectId).toHexString()));
    // Phần phiếu cố định đã chiếm: vào chứng từ còn hiệu lực, hoặc vào chứng từ vừa xóa (phiếu không theo chứng từ được xếp lại).
    const fixedTo = new Map<string, Decimal>();
    let fixedTotal = new Decimal(0);
    for (const payment of fixed) {
      for (const allocation of (payment.allocations as Document[] | undefined) ?? []) {
        const amount = new Decimal(decimalString(allocation.amount));
        if (amount.lte(0)) continue;
        const target = String(allocation.receivableId);
        if (pooledIds.has(target)) {
          fixedTo.set(target, (fixedTo.get(target) ?? new Decimal(0)).add(amount));
          fixedTotal = fixedTotal.add(amount);
        } else if (!existingIds.has(target)) {
          fixedTotal = fixedTotal.add(amount);
        }
      }
    }
    const capacity = pooled.reduce((sum, row) => sum.add(amountOf(row)), new Decimal(0)).minus(fixedTotal);
    const plan = planHistoryCredits(
      pooled.map((row) => ({
        id: (row._id as ObjectId).toHexString(), code: String(row.code), room: amountOf(row).minus(fixedTo.get((row._id as ObjectId).toHexString()) ?? 0).toFixed(2),
        dueDate: row.dueDate as Date, createdAt: row.createdAt as Date,
      })),
      movable.map((row) => ({ id: (row._id as ObjectId).toHexString(), code: String(row.code), amount: decimalString(row.amount), receivedAt: row.receivedAt as Date, createdAt: (row.createdAt as Date | undefined) ?? (row.receivedAt as Date) })),
      capacity,
    );
    for (const payment of movable) {
      const next = plan.credits.get((payment._id as ObjectId).toHexString());
      if (!next) continue;
      const allocations = next.allocations.map((row) => ({ receivableId: new ObjectId(row.receivableId), amount: decimal(row.amount) }));
      payment.allocations = allocations;
      payment.unapplied = new Decimal(next.unapplied);
      const unapplied = payment.unapplied as Decimal;
      await this.db.collection('payments').updateOne(
        { _id: payment._id },
        unapplied.gt(0) ? { $set: { allocations, unappliedAmount: decimal(unapplied.toFixed(2)) } } : { $set: { allocations }, $unset: { unappliedAmount: '' } },
        { session },
      );
    }

    // Phần bù trừ (phiếu OFFSET) đã dùng của một khoản trả trước (số âm).
    const consumed = (target: ObjectId) => fixed.reduce<Decimal>((sum, payment) => sum.add(
      ((payment.allocations as Document[] | undefined) ?? []).filter((row) => (row.receivableId as ObjectId).equals(target)).reduce<Decimal>((part, row) => part.add(decimalString(row.amount)), new Decimal(0)),
    ), new Decimal(0));
    const farFuture = new Date(now);
    farFuture.setUTCFullYear(farFuture.getUTCFullYear() + 10);
    const removePrepayment = async (row: Document) => {
      await this.db.collection('receivables').deleteOne({ _id: row._id }, { session });
      if (row.importBatchId) await this.db.collection('import_batches').updateOne({ _id: row.importBatchId as ObjectId }, { $pull: { receivableIds: row._id } } as Document, { session });
      receivables.splice(receivables.indexOf(row as WithId<Document>), 1);
    };
    /** Đặt khoản trả trước = −phần dư; 0 thì xóa; đã bù trừ nhiều hơn số mới thì chặn. */
    const settle = async (row: Document | undefined, leftover: Decimal, create: () => Promise<WithId<Document>>) => {
      if (row) {
        const used = consumed(row._id as ObjectId);
        if (used.lt(leftover.neg())) {
          throw new ConflictException({
            code: 'HISTORY_EDIT_PREPAYMENT_USED',
            message: `Khoản khách trả trước ${String(row.code)} đã bù trừ ${used.neg().toFixed(0)} đ, nhiều hơn số trả trước sau khi sửa ${leftover.toFixed(0)} đ`,
          });
        }
        if (leftover.isZero() && used.isZero()) return removePrepayment(row);
        row.amount = decimal(leftover.neg().toFixed(2));
        await this.db.collection('receivables').updateOne({ _id: row._id }, { $set: { amount: row.amount, updatedAt: now }, $inc: { version: 1 } }, { session });
        return undefined;
      }
      if (leftover.gt(0)) receivables.push(await create());
      return undefined;
    };

    // Sổ cũ: một khoản trả trước chung của khách = phần dư của các phiếu sổ cũ.
    const historyPayments = movable.filter((row) => row.mode === 'HISTORY');
    const historyLeftover = historyPayments.reduce((sum, row) => sum.add(row.unapplied as Decimal), new Decimal(0));
    const historyPrepayment = receivables.find((row) => row.historyPrepayment === true && row.status !== 'VOIDED');
    await settle(historyPrepayment, historyLeftover, async () => {
      const lastCredit = historyPayments.reduce<Date | null>((last, row) => (!last || (row.receivedAt as Date) > last ? (row.receivedAt as Date) : last), null);
      const owner = batchId ?? (historyPayments.find((row) => row.importBatchId)?.importBatchId as ObjectId | undefined);
      const created: WithId<Document> = {
        _id: new ObjectId(), code: await this.sequences.next('AR', session), partnerId, sourceType: 'CUSTOMER_PREPAYMENT', historyPrepayment: true,
        amount: decimal(historyLeftover.neg().toFixed(2)), paidAmount: decimal('0'), status: 'OPEN', dueDate: farFuture,
        note: `Sổ công nợ cũ: đã thu / giảm nợ vượt số phát sinh — khách trả trước (sửa tay ${vnDay(now).split('-').reverse().join('/')})`,
        createdAt: lastCredit ? new Date(lastCredit.getTime()) : now, importedAt: now, updatedAt: now, version: 1, ...(owner ? { importBatchId: owner } : {}),
      };
      await this.db.collection('receivables').insertOne(created, { session });
      if (owner) await this.db.collection('import_batches').updateOne({ _id: owner }, { $push: { receivableIds: created._id } } as Document, { session });
      return created;
    });

    // Thu theo khách: mỗi phiếu một khoản trả trước của chính phiếu (`paymentId`).
    for (const payment of movable.filter((row) => row.mode === 'CUSTOMER')) {
      const leftover = payment.unapplied as Decimal;
      const own = receivables.find((row) => row.sourceType === 'CUSTOMER_PREPAYMENT' && !row.historyPrepayment && String(row.paymentId) === String(payment._id) && row.status !== 'VOIDED');
      let createdId: ObjectId | null = null;
      await settle(own, leftover, async () => {
        const created: WithId<Document> = {
          _id: new ObjectId(), code: await this.sequences.next('AR', session), partnerId, sourceType: 'CUSTOMER_PREPAYMENT', paymentId: payment._id, paymentCode: payment.code,
          amount: decimal(leftover.neg().toFixed(2)), paidAmount: decimal('0'), status: 'OPEN', dueDate: farFuture,
          note: `${payment.kind === 'FREIGHT' ? 'Phí vận chuyển' : 'Phiếu thu'} ${String(payment.code)} vượt số còn nợ — khách trả trước`,
          version: 1, createdAt: payment.receivedAt as Date, updatedAt: now,
        };
        await this.db.collection('receivables').insertOne(created, { session });
        createdId = created._id;
        return created;
      });
      const stillThere = own && receivables.includes(own as WithId<Document>);
      if (createdId) await this.db.collection('payments').updateOne({ _id: payment._id }, { $set: { prepaymentReceivableId: createdId } }, { session });
      else if (own && !stillThere) await this.db.collection('payments').updateOne({ _id: payment._id }, { $unset: { prepaymentReceivableId: '' } }, { session });
    }
    // Phiếu vừa xóa: bỏ khoản trả trước của phiếu đó (chặn nếu đã bù trừ).
    if (deletedPaymentId) {
      const orphan = receivables.find((row) => row.sourceType === 'CUSTOMER_PREPAYMENT' && !row.historyPrepayment && String(row.paymentId) === String(deletedPaymentId));
      if (orphan) await settle(orphan, new Decimal(0), async () => orphan as WithId<Document>);
    }

    // Số đã thu từng chứng từ = tổng phân bổ của các phiếu (đã gồm phân bổ mới).
    const paid = new Map<string, Decimal>();
    for (const payment of payments) {
      for (const allocation of (payment.allocations as Document[] | undefined) ?? []) {
        const target = String(allocation.receivableId);
        paid.set(target, (paid.get(target) ?? new Decimal(0)).add(decimalString(allocation.amount)));
      }
    }
    for (const row of receivables) {
      const id = (row._id as ObjectId).toHexString();
      const total = paid.get(id) ?? new Decimal(0);
      const status = row.status === 'VOIDED' ? 'VOIDED' : receivableStatus(amountOf(row), total);
      if (total.eq(decimalString(row.paidAmount ?? '0')) && status === row.status) continue;
      await this.db.collection('receivables').updateOne({ _id: row._id }, { $set: { paidAmount: decimal(total.toFixed(2)), status, updatedAt: now }, $inc: { version: 1 } }, { session });
    }

    try {
      await reallocatePartner(this.db, partnerId, session, now);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ConflictException({ code: 'HISTORY_EDIT_BLOCKED', message: `Không phân bổ lại được công nợ của khách sau khi sửa: ${message}` });
    }
    await releaseHoldIfCleared(this.db, partnerId, session, now);
    const open = await this.db.collection('receivables').find({ partnerId, status: { $ne: 'VOIDED' } }, { session, projection: { amount: 1, paidAmount: 1 } }).toArray();
    return open.reduce((sum, row) => sum.add(decimalString(row.amount)).minus(decimalString(row.paidAmount ?? '0')), new Decimal(0)).toFixed(2);
  }
}
