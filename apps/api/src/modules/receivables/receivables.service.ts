import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { CreateCustomerPayment, CreatePayment } from '@inoxpran/contracts';
import Decimal from 'decimal.js';
import type { ClientSession, Db, Document } from 'mongodb';
import { ObjectId } from 'mongodb';
import { dateBounds, dateRangeFilter } from '../../common/date-range';
import { seesCancelled, type Viewer } from '../../common/hidden-documents';
import { AuditService } from '../../common/audit.service';
import { decimal, decimalString, serializeDocument, toObjectId, vnMonthStart, vnParts } from '../../common/domain';
import { IdempotencyService } from '../../common/idempotency.service';
import type { AuthenticatedRequest } from '../../common/request-context';
import { SequenceService } from '../../common/sequence.service';
import { addBodyRow, brandSheet, brandWorkbook, exportedAt, finalize, FORMATS, kpiStrip, signatureBlock, tableHeader, titleBlock, toBuffer, totalRow, type BrandColumn } from '../../common/excel-brand';
import { MONGO_DATABASE } from '../../common/tokens';
import { pageOf, type PageRequest } from '../../common/paging';
import { applyAllocations } from './allocation-store';
import { classifyOverdue, daysOverdue, OPEN_RECEIVABLE_STATUSES, OVERDUE_HOLD_REASON, releaseHoldIfCleared, runOverdueReview } from './overdue-review';
import { buildLedger, type LedgerPayment, type LedgerReceivable } from './ledger';
import { buildSummaryWorkbook, type SummaryCustomer, type SummaryMonth } from './summary-workbook';
import { pendingDeliveryOf } from './pending-delivery';
import { loadSegmentItems } from './segment-items';
import { loadSegmentRules, reallocatePartner } from './segment-store';
import { normalOutstanding, openParts, planPartsAllocation, segmentOutstanding, type OpenPart } from './segments';

@Injectable()
export class ReceivablesService {
  constructor(
    @Inject(MONGO_DATABASE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly sequences: SequenceService,
  ) {}

  /**
   * Mặc định chỉ trả khoản còn dư nợ (sắp theo hạn); includePaid trả cả khoản đã thu, mới nhất trước — chứng từ đã hủy chỉ
   * quản trị gốc thấy (DOC-HIDE-01).
   */
  async list(partnerId?: string, overdueOnly = false, includePaid = false, search?: string, paging: PageRequest | null = null, from?: string, to?: string, viewer?: Viewer) {
    // Lọc theo ngày phát sinh công nợ (LIST-DATE-01); "quá hạn" vẫn lọc riêng theo hạn trả.
    const shown = seesCancelled(viewer) ? {} : { status: { $ne: 'VOIDED' } };
    const filter: Document = { ...(includePaid ? shown : { status: { $in: OPEN_RECEIVABLE_STATUSES } }), ...dateRangeFilter('createdAt', from, to) };
    if (partnerId) filter.partnerId = toObjectId(partnerId, 'partnerId');
    if (overdueOnly) {
      filter.dueDate = { $lt: new Date() };
      filter.status = { $in: OPEN_RECEIVABLE_STATUSES };
    }
    const pipeline: Document[] = [
      { $match: filter },
      { $lookup: { from: 'partners', localField: 'partnerId', foreignField: '_id', as: 'partner' } },
      { $unwind: '$partner' },
    ];
    if (search) {
      const pattern = { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
      pipeline.push({ $match: { $or: [{ code: pattern }, { salesOrderCode: pattern }, { warrantyCode: pattern }, { openingDocumentNo: pattern }, { historyInvoiceNo: pattern }, { historyDocumentNo: pattern }, { payerName: pattern }, { 'partner.name': pattern }, { 'partner.code': pattern }] } });
    }
    pipeline.push({ $sort: includePaid ? { createdAt: -1, _id: -1 } : { dueDate: 1, _id: 1 } });
    let rows: Document[];
    let summary: { total: number; outstanding: string } | null = null;
    if (paging) {
      const [facet] = await this.db.collection('receivables').aggregate([
        ...pipeline,
        {
          $facet: {
            rows: [{ $skip: paging.skip }, { $limit: paging.pageSize }],
            summary: [{ $group: { _id: null, total: { $sum: 1 }, outstanding: { $sum: { $subtract: ['$amount', '$paidAmount'] } } } }],
          },
        },
      ]).toArray();
      rows = (facet?.rows as Document[] | undefined) ?? [];
      const group = (facet?.summary as Document[] | undefined)?.[0];
      summary = { total: Number(group?.total ?? 0), outstanding: new Decimal(decimalString(group?.outstanding ?? '0')).toFixed(2) };
    } else {
      rows = await this.db.collection('receivables').aggregate([...pipeline, { $limit: 1000 }]).toArray();
    }
    const now = new Date();
    const mapped = rows.map((row) => {
      const { partner, ...receivable } = row;
      const days = Math.max(0, daysOverdue(row.dueDate as Date, now));
      // Quá hạn chỉ xét phần nợ thường (CN-SEG-01): chứng từ chỉ còn phần nhóm tách riêng (VD quạt) không báo quá hạn.
      const normal = normalOutstanding(row as never);
      const open = OPEN_RECEIVABLE_STATUSES.includes(String(row.status)) && normal.gt(0);
      return {
        ...serializeDocument(receivable),
        outstandingAmount: new Decimal(decimalString(row.amount)).minus(decimalString(row.paidAmount)).toFixed(2),
        normalOutstanding: normal.toFixed(2),
        segmentOutstanding: segmentOutstanding(row as never).toFixed(2),
        partnerName: partner.name,
        partnerCode: partner.code,
        partnerStatus: partner.status,
        province: partner.province,
        salesRepName: partner.salesRepName,
        daysOverdue: open ? days : 0,
        overdueLevel: open ? classifyOverdue(days) : null,
      };
    });
    return paging && summary ? pageOf(mapped, summary.total, paging, { totalOutstanding: summary.outstanding }) : mapped;
  }

  /** Bảng tuổi nợ theo đại lý: trong hạn / 1–30 / 31–60 / trên 60 ngày, đối chiếu với hạn mức. */
  async aging() {
    const now = new Date();
    const rows = await this.db.collection('receivables').aggregate([
      { $match: { status: { $in: OPEN_RECEIVABLE_STATUSES } } },
      { $lookup: { from: 'partners', localField: 'partnerId', foreignField: '_id', as: 'partner' } },
      { $unwind: '$partner' },
    ]).toArray();
    const byPartner = new Map<string, {
      partnerId: string; code: string; name: string; province: string | undefined; salesRepName: string | undefined; status: string; holdReason: string | undefined;
      creditLimit: Decimal; current: Decimal; d1to30: Decimal; d31to60: Decimal; over60: Decimal; segment: Decimal; maxDays: number; documents: number;
    }>();
    for (const row of rows) {
      const key = (row.partnerId as { toHexString(): string }).toHexString();
      const entry = byPartner.get(key) ?? {
        partnerId: key,
        code: String(row.partner.code),
        name: String(row.partner.name),
        province: row.partner.province as string | undefined,
        salesRepName: row.partner.salesRepName as string | undefined,
        status: String(row.partner.status),
        holdReason: row.partner.holdReason as string | undefined,
        creditLimit: new Decimal(decimalString(row.partner.creditLimit)),
        current: new Decimal(0), d1to30: new Decimal(0), d31to60: new Decimal(0), over60: new Decimal(0), segment: new Decimal(0), maxDays: 0, documents: 0,
      };
      // Tuổi nợ chỉ tính phần nợ thường; phần nhóm công nợ tách riêng (CN-SEG-01) để riêng một cột, không xếp tuổi.
      const outstanding = normalOutstanding(row as never);
      const segment = segmentOutstanding(row as never);
      entry.segment = entry.segment.add(segment);
      const days = daysOverdue(row.dueDate as Date, now);
      const level = outstanding.gt(0) ? classifyOverdue(days) : null;
      if (!level) entry.current = entry.current.add(outstanding);
      else if (level === 'REMINDER') entry.d1to30 = entry.d1to30.add(outstanding);
      else if (level === 'WARNING') entry.d31to60 = entry.d31to60.add(outstanding);
      else entry.over60 = entry.over60.add(outstanding);
      if (outstanding.gt(0)) entry.maxDays = Math.max(entry.maxDays, days);
      entry.documents += 1;
      byPartner.set(key, entry);
    }
    const partners = [...byPartner.values()].map((entry) => {
      const total = entry.current.add(entry.d1to30).add(entry.d31to60).add(entry.over60);
      return {
        partnerId: entry.partnerId,
        code: entry.code,
        name: entry.name,
        province: entry.province,
        salesRepName: entry.salesRepName,
        status: entry.status,
        holdReason: entry.holdReason,
        creditLimit: entry.creditLimit.toFixed(2),
        current: entry.current.toFixed(2),
        d1to30: entry.d1to30.toFixed(2),
        d31to60: entry.d31to60.toFixed(2),
        over60: entry.over60.toFixed(2),
        segment: entry.segment.toFixed(2),
        total: total.toFixed(2),
        maxDays: Math.max(0, entry.maxDays),
        level: classifyOverdue(entry.maxDays),
        documents: entry.documents,
        // Hạn mức tính cả phần nợ nhóm tách riêng (vẫn là tiền khách nợ), tuổi nợ thì không.
        creditUsage: entry.creditLimit.gt(0) ? total.add(entry.segment).div(entry.creditLimit).mul(100).toDecimalPlaces(1).toNumber() : null,
      };
    }).sort((a, b) => b.maxDays - a.maxDays || Number(b.total) - Number(a.total));
    const sum = (field: 'current' | 'd1to30' | 'd31to60' | 'over60' | 'segment' | 'total') =>
      partners.reduce((total, entry) => total.add(entry[field]), new Decimal(0)).toFixed(2);
    const lastReview = await this.db.collection<{ _id: string } & Document>('overdue_reviews').find().sort({ ranAt: -1 }).limit(1).next();
    return {
      generatedAt: now.toISOString(),
      totals: { current: sum('current'), d1to30: sum('d1to30'), d31to60: sum('d31to60'), over60: sum('over60'), segment: sum('segment'), total: sum('total') },
      partners,
      lastReview: lastReview ? serializeDocument(lastReview) : null,
    };
  }

  async runReview(request: AuthenticatedRequest) {
    const result = await runOverdueReview(this.db);
    await this.audit.record({
      actorId: request.user.sub,
      actorEmail: request.user.email,
      correlationId: request.correlationId,
      action: 'OVERDUE_REVIEW_RUN',
      entityType: 'OverdueReview',
      entityId: result.reviewDate,
      metadata: { ...result },
    });
    return result;
  }

  async recordPayment(input: CreatePayment, request: AuthenticatedRequest, key: string | undefined) {
    return this.idempotency.execute(
      `payment-create:${request.user.sub}`,
      key,
      input,
      async (session) => {
          const allocationTotal = input.allocations.reduce((sum, allocation) => sum.add(allocation.amount), new Decimal(0));
          if (!allocationTotal.eq(input.amount)) {
            throw new ConflictException({ code: 'PAYMENT_ALLOCATION_MISMATCH', message: 'Tổng phân bổ phải bằng số tiền thu' });
          }
          const partnerId = toObjectId(input.partnerId, 'partnerId');
          const partner = await this.db.collection('partners').findOne({ _id: partnerId }, { session });
          if (!partner) throw new NotFoundException({ code: 'PARTNER_NOT_FOUND', message: 'Không tìm thấy khách hàng' });

          // Thu theo từng chứng từ: trong chứng từ, trả phần nợ thường trước rồi tới phần nhóm tách riêng (CN-SEG-01).
          const parts: Array<{ receivableId: ObjectId; amount: string; segment: string | null }> = [];
          for (const allocation of input.allocations) {
            const receivableId = toObjectId(allocation.receivableId, 'receivableId');
            const receivable = await this.db.collection('receivables').findOne({ _id: receivableId, partnerId }, { session });
            if (!receivable) throw new NotFoundException({ code: 'RECEIVABLE_NOT_FOUND', message: 'Không tìm thấy khoản phải thu' });
            const outstanding = new Decimal(decimalString(receivable.amount)).minus(decimalString(receivable.paidAmount));
            if (new Decimal(allocation.amount).gt(outstanding)) {
              throw new ConflictException({ code: 'PAYMENT_EXCEEDS_OUTSTANDING', message: 'Số tiền phân bổ vượt dư nợ chứng từ' });
            }
            const plan = planPartsAllocation(openParts({ ...receivable, id: receivableId.toHexString(), code: String(receivable.code), dueDate: receivable.dueDate as Date, createdAt: receivable.createdAt as Date } as never), allocation.amount);
            if (new Decimal(plan.leftover).gt(0)) parts.push({ receivableId, amount: plan.leftover, segment: null });
            for (const part of plan.allocations) parts.push({ receivableId, amount: part.amount, segment: part.segment });
          }

          const now = new Date();
          const payment = {
            _id: new ObjectId(),
            code: await this.sequences.next('PAY', session),
            partnerId,
            amount: decimal(input.amount),
            method: input.method,
            receivedAt: new Date(input.receivedAt),
            reference: input.reference,
            allocations: parts.map((part) => ({ receivableId: part.receivableId, amount: decimal(part.amount), ...(part.segment ? { segment: part.segment } : {}) })),
            status: 'POSTED',
            postedBy: toObjectId(request.user.sub),
            postedAt: now,
            createdAt: now,
          };
          await this.db.collection('payments').insertOne({ ...payment, kind: 'RECEIPT', mode: 'DOCUMENT' }, { session });
          await this.applyAllocations(parts, session, now);
          const released = await releaseHoldIfCleared(this.db, partnerId, session, now);
          await this.audit.record(
            {
              actorId: request.user.sub,
              actorEmail: request.user.email,
              correlationId: request.correlationId,
              metadata: { partnerHoldReleased: released },
              action: 'PAYMENT_POSTED',
              entityType: 'Payment',
              entityId: payment._id.toHexString(),
              after: serializeDocument(payment),
            },
            session,
          );
          return serializeDocument(payment);
      },
    );
  }

  /** Ghi phân bổ vào chứng từ (allocation-store.ts). */
  async applyAllocations(allocations: ReadonlyArray<{ receivableId: ObjectId; amount: string; segment?: string | null }>, session: ClientSession, now: Date) {
    await applyAllocations(this.db, allocations, session, now);
  }

  private async customer(partnerId: ObjectId, session?: ClientSession) {
    const partner = await this.db.collection('partners').findOne({ _id: partnerId, kind: { $in: ['CUSTOMER', 'BOTH'] } }, session ? { session } : {});
    if (!partner) throw new NotFoundException({ code: 'PARTNER_NOT_FOUND', message: 'Không tìm thấy khách hàng' });
    return partner;
  }

  /** Chứng từ chưa tất toán của khách (cả khoản trả trước âm). */
  private async openItems(partnerId: ObjectId, session?: ClientSession) {
    const rows = await this.db.collection('receivables').find({ partnerId, status: { $in: OPEN_RECEIVABLE_STATUSES } }, session ? { session } : {}).toArray();
    return rows.map((row) => ({
      id: (row._id as ObjectId).toHexString(),
      code: String(row.code),
      amount: new Decimal(decimalString(row.amount)),
      outstanding: new Decimal(decimalString(row.amount)).minus(decimalString(row.paidAmount)),
      normal: normalOutstanding(row as never),
      segment: segmentOutstanding(row as never),
      dueDate: row.dueDate as Date,
      createdAt: row.createdAt as Date,
      document: row,
    }));
  }

  /** Các phần còn nợ (nợ thường / từng nhóm) của chứng từ chưa tất toán — dùng để phân bổ tiền thu theo khách. */
  private static partsOf(open: Awaited<ReturnType<ReceivablesService['openItems']>>): OpenPart[] {
    return open.filter((item) => item.outstanding.gt(0)).flatMap((item) => openParts({ ...item.document, id: item.id, code: item.code, dueDate: item.dueDate, createdAt: item.createdAt } as never));
  }

  /** Nhóm công nợ tách riêng đang dùng (CN-SEG-01); kiểm tra mã nhóm khi kế toán chọn "Thu cho nhóm". */
  private async segmentRule(code: string | null | undefined, session?: ClientSession) {
    if (!code) return null;
    const rule = (await loadSegmentRules(this.db, session)).find((item) => item.code === code && item.active);
    if (!rule) throw new ConflictException({ code: 'SEGMENT_NOT_FOUND', message: `Không có nhóm công nợ ${code}` });
    return rule;
  }

  private static documentNo(row: Document | undefined, fallback: string): string {
    return String(row?.salesOrderCode ?? row?.historyInvoiceNo ?? row?.historyDocumentNo ?? row?.openingDocumentNo ?? row?.warrantyCode ?? fallback);
  }

  /** Công nợ theo khách hàng (CN-KH-01): phát sinh, đã thu, phí vận chuyển, trả hàng / giảm, khách trả trước, còn nợ. */
  async customers(search?: string, onlyOpen = false, paging: PageRequest | null = null) {
    const now = new Date();
    const open = { $in: ['$status', OPEN_RECEIVABLE_STATUSES] };
    const outstanding = { $subtract: ['$amount', '$paidAmount'] };
    // Phần nhóm công nợ tách riêng còn nợ của chứng từ (CN-SEG-01); quá hạn chỉ xét phần nợ thường.
    const segmentLeft = { $reduce: { input: { $ifNull: ['$segments', []] }, initialValue: decimal('0'), in: { $add: ['$$value', { $subtract: ['$$this.amount', '$$this.paid'] }] } } };
    const [receivableGroups, paymentGroups, segmentGroups, rules] = await Promise.all([
      this.db.collection('receivables').aggregate([
        { $addFields: { segmentLeft } },
        {
          $group: {
            _id: '$partnerId',
            debit: { $sum: { $cond: [{ $gt: ['$amount', 0] }, '$amount', 0] } },
            voided: { $sum: { $cond: [{ $and: [{ $eq: ['$status', 'VOIDED'] }, { $gt: ['$amount', 0] }] }, '$amount', 0] } },
            openDebt: { $sum: { $cond: [{ $and: [open, { $gt: [outstanding, 0] }] }, outstanding, 0] } },
            segment: { $sum: { $cond: [{ $and: [open, { $gt: [outstanding, 0] }] }, '$segmentLeft', 0] } },
            prepayment: { $sum: { $cond: [{ $and: [open, { $lt: [outstanding, 0] }] }, { $subtract: ['$paidAmount', '$amount'] }, 0] } },
            oldestDue: { $min: { $cond: [{ $and: [open, { $gt: [{ $subtract: [outstanding, '$segmentLeft'] }, 0] }] }, '$dueDate', null] } },
            openDocuments: { $sum: { $cond: [{ $and: [open, { $gt: [outstanding, 0] }] }, 1, 0] } },
            lastActivity: { $max: '$createdAt' },
          },
        },
      ]).toArray(),
      this.db.collection('payments').aggregate([
        { $match: { status: 'POSTED' } },
        { $group: { _id: { partnerId: '$partnerId', kind: { $ifNull: ['$kind', 'RECEIPT'] } }, total: { $sum: '$amount' }, last: { $max: '$receivedAt' } } },
      ]).toArray(),
      this.db.collection('receivables').aggregate([
        { $match: { status: { $in: OPEN_RECEIVABLE_STATUSES }, 'segments.0': { $exists: true } } },
        { $unwind: '$segments' },
        { $group: { _id: { partnerId: '$partnerId', code: '$segments.code' }, outstanding: { $sum: { $subtract: ['$segments.amount', '$segments.paid'] } } } },
      ]).toArray(),
      loadSegmentRules(this.db),
    ]);
    type Entry = { debit: Decimal; receipt: Decimal; freight: Decimal; returns: Decimal; openDebt: Decimal; segment: Decimal; segments: Array<{ code: string; outstanding: string }>; prepayment: Decimal; oldestDue: Date | null; openDocuments: number; lastActivity: Date | null };
    const byPartner = new Map<string, Entry>();
    const entry = (id: string): Entry => {
      let value = byPartner.get(id);
      if (!value) {
        value = { debit: new Decimal(0), receipt: new Decimal(0), freight: new Decimal(0), returns: new Decimal(0), openDebt: new Decimal(0), segment: new Decimal(0), segments: [], prepayment: new Decimal(0), oldestDue: null, openDocuments: 0, lastActivity: null };
        byPartner.set(id, value);
      }
      return value;
    };
    const rank = new Map(rules.map((rule) => [rule.code, rule.sortOrder]));
    for (const row of segmentGroups) {
      const key = row._id as { partnerId?: ObjectId; code: string };
      const left = new Decimal(decimalString(row.outstanding));
      if (!key.partnerId || left.lte(0)) continue;
      entry(key.partnerId.toHexString()).segments.push({ code: key.code, outstanding: left.toFixed(2) });
    }
    for (const value of byPartner.values()) value.segments.sort((a, b) => (rank.get(a.code) ?? 99) - (rank.get(b.code) ?? 99) || a.code.localeCompare(b.code));
    for (const row of receivableGroups) {
      if (!row._id) continue;
      const value = entry((row._id as ObjectId).toHexString());
      value.debit = new Decimal(decimalString(row.debit)).minus(decimalString(row.voided));
      value.openDebt = new Decimal(decimalString(row.openDebt));
      value.segment = new Decimal(decimalString(row.segment));
      value.prepayment = new Decimal(decimalString(row.prepayment));
      value.oldestDue = (row.oldestDue as Date | null) ?? null;
      value.openDocuments = Number(row.openDocuments ?? 0);
      value.lastActivity = (row.lastActivity as Date | null) ?? null;
    }
    for (const row of paymentGroups) {
      const key = row._id as { partnerId?: ObjectId; kind: string };
      if (!key.partnerId) continue;
      const value = entry(key.partnerId.toHexString());
      const total = new Decimal(decimalString(row.total));
      if (key.kind === 'RECEIPT') value.receipt = value.receipt.add(total);
      else if (key.kind === 'FREIGHT') value.freight = value.freight.add(total);
      else if (key.kind === 'RETURN') value.returns = value.returns.add(total);
      const last = row.last as Date | null;
      if (last && (!value.lastActivity || last > value.lastActivity)) value.lastActivity = last;
    }
    const partnerFilter: Document = { _id: { $in: [...byPartner.keys()].map((id) => new ObjectId(id)) } };
    if (search?.trim()) {
      const pattern = { $regex: search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
      partnerFilter.$or = [{ name: pattern }, { code: pattern }, { shortName: pattern }, { nameZh: pattern }, { phone: pattern }];
    }
    const partners = await this.db.collection('partners').find(partnerFilter, { projection: { code: 1, name: 1, province: 1, salesRepName: 1, status: 1, holdReason: 1, autoHoldExempt: 1 } }).toArray();
    let rows = partners.map((partner) => {
      const id = (partner._id as ObjectId).toHexString();
      const value = byPartner.get(id) as Entry;
      const balance = value.debit.minus(value.receipt).minus(value.freight).minus(value.returns);
      const days = value.oldestDue ? Math.max(0, daysOverdue(value.oldestDue, now)) : 0;
      return {
        partnerId: id,
        code: String(partner.code),
        name: String(partner.name),
        province: partner.province as string | undefined,
        salesRepName: partner.salesRepName as string | undefined,
        status: String(partner.status),
        holdReason: partner.holdReason as string | undefined,
        autoHoldExempt: partner.autoHoldExempt === true,
        debit: value.debit.toFixed(2),
        receipt: value.receipt.toFixed(2),
        freight: value.freight.toFixed(2),
        returns: value.returns.toFixed(2),
        openDebt: value.openDebt.toFixed(2),
        prepayment: value.prepayment.toFixed(2),
        balance: balance.toFixed(2),
        segmentOutstanding: value.segment.toFixed(2),
        normalBalance: balance.minus(value.segment).toFixed(2),
        segments: value.segments,
        openDocuments: value.openDocuments,
        maxDaysOverdue: days,
        overdueLevel: classifyOverdue(days),
        lastActivity: value.lastActivity?.toISOString(),
      };
    });
    if (onlyOpen) rows = rows.filter((row) => !new Decimal(row.balance).isZero() || new Decimal(row.openDebt).gt(0));
    rows.sort((a, b) => new Decimal(b.balance).comparedTo(a.balance) || a.code.localeCompare(b.code));
    const sum = (field: 'debit' | 'receipt' | 'freight' | 'returns' | 'balance' | 'prepayment' | 'segmentOutstanding' | 'normalBalance') => rows.reduce((total, row) => total.add(row[field]), new Decimal(0)).toFixed(2);
    const totals = { debit: sum('debit'), receipt: sum('receipt'), freight: sum('freight'), returns: sum('returns'), balance: sum('balance'), prepayment: sum('prepayment'), segmentOutstanding: sum('segmentOutstanding'), normalBalance: sum('normalBalance') };
    const segmentNames = rules.map((rule) => ({ code: rule.code, name: rule.name }));
    if (!paging) return { rows, totals, segmentNames };
    return pageOf(rows.slice(paging.skip, paging.skip + paging.pageSize), rows.length, paging, { totals, segmentNames });
  }

  /**
   * Chứng từ đã hủy chỉ quản trị gốc thấy (DOC-HIDE-01): người khác không có dòng phát sinh + dòng "Hủy chứng từ" của nó
   * (hai dòng bù nhau nên số dư cuối kỳ không đổi).
   */
  private async ledgerSources(partnerId: ObjectId, viewer?: Viewer) {
    const [receivables, payments] = await Promise.all([
      this.db.collection('receivables').find(seesCancelled(viewer) ? { partnerId } : { partnerId, status: { $ne: 'VOIDED' } }).toArray(),
      this.db.collection('payments').find({ partnerId, status: 'POSTED' }).toArray(),
    ]);
    return this.toLedger(receivables, payments);
  }

  /** Chứng từ / phiếu thu (bản ghi Mongo) → dữ liệu dựng sổ chi tiết (ledger.ts). */
  private toLedger(receivables: Document[], payments: Document[]) {
    const optional = (value: unknown) => (value === undefined || value === null || value === '' ? undefined : String(value));
    const ledgerReceivables: LedgerReceivable[] = receivables.map((row) => ({
      id: (row._id as ObjectId).toHexString(),
      code: String(row.code),
      amount: decimalString(row.amount),
      status: String(row.status),
      createdAt: row.createdAt as Date,
      voidedAt: row.voidedAt as Date | undefined,
      updatedAt: row.updatedAt as Date | undefined,
      sourceType: optional(row.sourceType),
      salesOrderId: row.salesOrderId ? String(row.salesOrderId) : undefined,
      salesOrderCode: optional(row.salesOrderCode),
      warrantyTicketId: row.warrantyTicketId ? String(row.warrantyTicketId) : undefined,
      warrantyCode: optional(row.warrantyCode),
      openingDocumentNo: optional(row.openingDocumentNo),
      historyDocumentNo: optional(row.historyDocumentNo),
      historyInvoiceNo: optional(row.historyInvoiceNo),
      note: optional(row.note),
      voidReason: optional(row.voidReason),
      segments: ((row.segments as Document[] | undefined) ?? []).map((part) => ({ code: String(part.code), amount: decimalString(part.amount) })),
    }));
    const ledgerPayments: LedgerPayment[] = payments.map((row) => ({
      id: (row._id as ObjectId).toHexString(),
      code: String(row.code),
      amount: decimalString(row.amount),
      kind: String(row.kind ?? 'RECEIPT'),
      status: String(row.status),
      receivedAt: row.receivedAt as Date,
      method: optional(row.method),
      reference: optional(row.reference),
      note: optional(row.note),
      mode: optional(row.mode),
      documentNo: optional(row.historyDocumentNo),
    }));
    return { ledgerReceivables, ledgerPayments };
  }

  /**
   * Bảng tổng hợp công nợ theo tháng giống mẫu 收付明细汇总表 của kế toán (AR-XLS-02, 31/10/2026): mỗi tháng một sheet, khách đã
   * chọn (bỏ trống = mọi khách có phát sinh / số dư). Số liệu cùng quy tắc sổ chi tiết (buildLedger): đầu kỳ, phí vận chuyển khách
   * trả hộ, bán hàng, trả hàng / điều chỉnh giảm, thu tiền, cuối kỳ. Cột 备注: hàng khách trả trong tháng; tháng hiện tại thêm phần
   * nợ nhóm tách riêng còn lại.
   */
  async summaryWorkbook(fromMonth: string, toMonth: string, customerIds: readonly string[]) {
    const parse = (value: string, field: string) => {
      const match = /^(\d{4})-(\d{2})$/.exec(value);
      const month = match ? Number(match[2]) : 0;
      if (!match || month < 1 || month > 12) throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'Tháng không hợp lệ (yyyy-mm)', details: [{ path: [field] }] });
      return { year: Number(match[1]), month };
    };
    const from = parse(fromMonth, 'fromMonth');
    const to = parse(toMonth, 'toMonth');
    const index = (period: SummaryMonth) => period.year * 12 + period.month - 1;
    const today = vnParts(new Date());
    const current = today.year * 12 + today.month - 1;
    if (index(to) < index(from)) throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'Đến tháng phải sau hoặc bằng từ tháng', details: [{ path: ['toMonth'] }] });
    if (index(to) > current) throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'Chưa tới tháng đã chọn', details: [{ path: ['toMonth'] }] });
    if (index(to) - index(from) >= 12) throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'Xuất tối đa 12 tháng mỗi lần', details: [{ path: ['fromMonth'] }] });
    const months: SummaryMonth[] = Array.from({ length: index(to) - index(from) + 1 }, (_, offset) => ({ year: Math.floor((index(from) + offset) / 12), month: ((index(from) + offset) % 12) + 1 }));
    const starts = [...months.map((period) => vnMonthStart(period.year, period.month)), vnMonthStart(to.year, to.month + 1)];
    const rangeStart = starts[0]!;
    const rangeEnd = starts[starts.length - 1]!;

    const chosen = customerIds.map((id) => toObjectId(id, 'customerIds'));
    const partnerIds = chosen.length
      ? chosen
      : [...new Set([
          ...(await this.db.collection('receivables').distinct('partnerId', { status: { $ne: 'VOIDED' } })),
          ...(await this.db.collection('payments').distinct('partnerId', { status: 'POSTED' })),
        ].map(String))].map((id) => new ObjectId(id));
    const [partners, receivables, payments, returns, rules] = await Promise.all([
      this.db.collection('partners').find({ _id: { $in: partnerIds }, kind: { $in: ['CUSTOMER', 'BOTH'] } }, { projection: { code: 1, name: 1, nameZh: 1, salesRepName: 1 } }).toArray(),
      this.db.collection('receivables').find({ partnerId: { $in: partnerIds }, status: { $ne: 'VOIDED' } }).toArray(),
      this.db.collection('payments').find({ partnerId: { $in: partnerIds }, status: 'POSTED' }).toArray(),
      this.db.collection('stock_returns').find(
        { kind: 'CUSTOMER', partnerId: { $in: partnerIds }, status: { $ne: 'VOIDED' }, $or: [{ receivedAt: { $gte: rangeStart, $lt: rangeEnd } }, { receivedAt: { $exists: false }, createdAt: { $gte: rangeStart, $lt: rangeEnd } }] },
        { projection: { partnerId: 1, receivedAt: 1, createdAt: 1, lines: 1, code: 1 } },
      ).toArray(),
      loadSegmentRules(this.db),
    ]);
    if (chosen.length && partners.length !== new Set(chosen.map(String)).size) {
      throw new NotFoundException({ code: 'CUSTOMER_NOT_FOUND', message: 'Có khách hàng không tồn tại', details: [{ path: ['customerIds'] }] });
    }
    const group = (rows: Document[]) => {
      const map = new Map<string, Document[]>();
      for (const row of rows) map.set(String(row.partnerId), [...(map.get(String(row.partnerId)) ?? []), row]);
      return map;
    };
    const receivablesOf = group(receivables);
    const paymentsOf = group(payments);
    const returnsOf = group(returns);
    const segmentName = new Map(rules.map((rule) => [rule.code, rule.name]));
    const vnd = (value: number) => Math.round(value).toLocaleString('vi-VN');
    const customers: SummaryCustomer[] = partners.map((partner) => {
      const id = String(partner._id);
      const { ledgerReceivables, ledgerPayments } = this.toLedger(receivablesOf.get(id) ?? [], paymentsOf.get(id) ?? []);
      const figures = months.map((_, at) => {
        const ledger = buildLedger(ledgerReceivables, ledgerPayments, starts[at], starts[at + 1]);
        return {
          opening: Number(ledger.opening), freight: Number(ledger.totals.freight), sales: Number(ledger.totals.debit),
          returns: Number(ledger.totals.returns), receipt: Number(ledger.totals.receipt), closing: Number(ledger.closing),
        };
      });
      const notes = months.map((_, at) => (returnsOf.get(id) ?? [])
        .filter((slip) => {
          const when = (slip.receivedAt ?? slip.createdAt) as Date;
          return when >= starts[at]! && when < starts[at + 1]!;
        })
        .map((slip) => {
          const lines = ((slip.lines as Document[] | undefined) ?? []).map((line) => `${new Decimal(decimalString(line.quantity)).toString()} ${String(line.unit ?? 'cái')} ${String(line.sku)}`);
          return `trả lại ${lines.join(', ')} (${String(slip.code)})`;
        }));
      // Tháng hiện tại: phần nợ nhóm tách riêng còn lại (CN-SEG-01) của các chứng từ đang mở.
      if (index(to) === current) {
        const segments = new Map<string, Decimal>();
        for (const row of receivablesOf.get(id) ?? []) {
          if (!(OPEN_RECEIVABLE_STATUSES as readonly string[]).includes(String(row.status))) continue;
          for (const part of (row.segments as Document[] | undefined) ?? []) {
            const left = new Decimal(decimalString(part.amount)).minus(decimalString(part.paid ?? '0'));
            if (left.gt(0)) segments.set(String(part.code), (segments.get(String(part.code)) ?? new Decimal(0)).add(left));
          }
        }
        if (segments.size) notes[notes.length - 1]!.push(`Nợ nhóm tách riêng: ${[...segments].map(([code, amount]) => `${segmentName.get(code) ?? code} ${vnd(amount.toNumber())}`).join(', ')}`);
      }
      return {
        id,
        ...(partner.code ? { code: String(partner.code) } : {}),
        name: String(partner.name),
        ...(partner.nameZh ? { nameZh: String(partner.nameZh) } : {}),
        ...(partner.salesRepName ? { salesRepName: String(partner.salesRepName) } : {}),
        figures,
        notes,
      };
    });
    const workbook = buildSummaryWorkbook(months, customers, { includeZero: chosen.length > 0 });
    const tag = (period: SummaryMonth) => `${period.year}-${String(period.month).padStart(2, '0')}`;
    return { buffer: await toBuffer(workbook), fileName: `CongNo_TongHop_${tag(from)}_${tag(to)}.xlsx`, displayName: `收付明细汇总表_${tag(from)}_${tag(to)}.xlsx` };
  }

  /** Sổ chi tiết công nợ của một khách trong kỳ (CN-KH-01). */
  async statement(partnerId: string, from?: string, to?: string, viewer?: Viewer) {
    const id = toObjectId(partnerId, 'partnerId');
    const partner = await this.customer(id);
    const bounds = dateBounds(from, to);
    const { ledgerReceivables, ledgerPayments } = await this.ledgerSources(id, viewer);
    const ledger = buildLedger(ledgerReceivables, ledgerPayments, bounds?.$gte, bounds?.$lt);
    const [open, rules, holdings, pendingDelivery] = await Promise.all([this.openItems(id), loadSegmentRules(this.db), loadSegmentItems(this.db, { partnerId: id }), pendingDeliveryOf(this.db, id)]);
    const itemsOf = new Map(holdings.map((holding) => [holding.code, holding]));
    const now = new Date();
    const openDocuments = open
      .filter((item) => item.outstanding.gt(0))
      .sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime() || a.createdAt.getTime() - b.createdAt.getTime())
      .map((item) => ({
        id: item.id,
        code: item.code,
        amount: item.amount.toFixed(2),
        outstanding: item.outstanding.toFixed(2),
        normalOutstanding: item.normal.toFixed(2),
        segmentOutstanding: item.segment.toFixed(2),
        segments: ((item.document.segments as Document[] | undefined) ?? [])
          .map((part) => ({ code: String(part.code), outstanding: new Decimal(decimalString(part.amount)).minus(decimalString(part.paid)).toFixed(2) }))
          .filter((part) => new Decimal(part.outstanding).gt(0)),
        dueDate: item.dueDate.toISOString(),
        createdAt: item.createdAt.toISOString(),
        documentNo: ReceivablesService.documentNo(item.document, item.code),
        salesOrderId: item.document.salesOrderId ? String(item.document.salesOrderId) : undefined,
        sourceType: item.document.sourceType ? String(item.document.sourceType) : undefined,
        segmentTag: item.document.segmentTag ? String(item.document.segmentTag.code) : undefined,
        // Quá hạn chỉ tính trên phần nợ thường (CN-SEG-01).
        daysOverdue: item.normal.gt(0) ? Math.max(0, daysOverdue(item.dueDate, now)) : 0,
      }));
    const prepayment = open.filter((item) => item.outstanding.lt(0)).reduce((sum, item) => sum.minus(item.outstanding), new Decimal(0));
    // Nhóm công nợ tách riêng (hiện tại, không theo kỳ): còn nợ từng nhóm, còn lại trừ nhóm.
    const bySegment = new Map<string, Decimal>();
    for (const item of open) {
      if (item.outstanding.lte(0)) continue;
      for (const part of (item.document.segments as Document[] | undefined) ?? []) {
        const left = new Decimal(decimalString(part.amount)).minus(decimalString(part.paid));
        if (left.gt(0)) bySegment.set(String(part.code), (bySegment.get(String(part.code)) ?? new Decimal(0)).add(left));
      }
    }
    const currentBalance = open.reduce((sum, item) => sum.add(item.outstanding), new Decimal(0));
    const segmentTotal = [...bySegment.values()].reduce((sum, value) => sum.add(value), new Decimal(0));
    const segments = rules
      .filter((rule) => bySegment.has(rule.code) || rule.active)
      .sort((a, b) => a.sortOrder - b.sortOrder || a.code.localeCompare(b.code))
      .map((rule) => ({
        code: rule.code, name: rule.name, active: rule.active, manualOnly: rule.manualOnly, outstanding: (bySegment.get(rule.code) ?? new Decimal(0)).toFixed(2),
        scope: rule.scope ?? 'ALL',
        // Nhóm "chọn khách": khách này có được nợ riêng nhóm không.
        enabled: rule.manualOnly || rule.scope !== 'SELECTED' || (rule.partnerIds ?? []).includes(partnerId),
        // Hàng khách đang nợ của nhóm (mã + số lượng), theo chứng từ còn nợ.
        ...(itemsOf.has(rule.code) ? { holding: itemsOf.get(rule.code) } : {}),
      }));
    return {
      partner: {
        id: partnerId,
        code: String(partner.code),
        name: String(partner.name),
        province: partner.province as string | undefined,
        salesRepName: partner.salesRepName as string | undefined,
        status: String(partner.status),
        holdReason: partner.holdReason as string | undefined,
        autoHoldExempt: partner.autoHoldExempt === true,
        paymentTermDays: Number(partner.paymentTermDays ?? 0),
        creditLimit: decimalString(partner.creditLimit ?? '0'),
      },
      period: { from: from ?? null, to: to ?? null },
      ...ledger,
      openDebt: openDocuments.reduce((sum, item) => sum.add(item.outstanding), new Decimal(0)).toFixed(2),
      prepayment: prepayment.toFixed(2),
      openDocuments,
      segments,
      current: { balance: currentBalance.toFixed(2), segment: segmentTotal.toFixed(2), normal: currentBalance.minus(segmentTotal).toFixed(2) },
      // Đã xuất kho, chờ giao: chưa vào công nợ (AR-DLV-01) — để kế toán đối chiếu.
      pendingDelivery,
    };
  }

  /** Sổ chi tiết công nợ khách theo bộ chuẩn Excel thương hiệu (XLS-01): khối chỉ số, bảng phát sinh, phần tổng như sheet đối chiếu, ký tên. */
  async statementWorkbook(partnerId: string, from: string | undefined, to: string | undefined, preparedBy: string, viewer?: Viewer): Promise<{ buffer: Buffer; fileName: string }> {
    const statement = await this.statement(partnerId, from, to, viewer);
    const workbook = brandWorkbook();
    const day = (value: Date) => new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', year: 'numeric' }).format(value);
    const dayOf = (value: string | undefined) => (value ? day(new Date(`${value}T12:00:00+07:00`)) : '');
    const period = from || to ? `Từ ${from ? dayOf(from) : 'đầu'} đến ${to ? dayOf(to) : 'nay'}` : 'Toàn bộ';
    const columns: BrandColumn[] = [
      { key: 'stt', header: 'STT', width: 6, type: 'int' },
      { key: 'date', header: 'Ngày', width: 12, type: 'date' },
      { key: 'doc', header: 'Chứng từ', width: 18, type: 'code' },
      { key: 'text', header: 'Diễn giải', width: 44, wrap: true },
      { key: 'debit', header: 'Phát sinh nợ (đ)', width: 17, type: 'money' },
      { key: 'receipt', header: 'Đã thu (đ)', width: 17, type: 'money', tint: 'in' },
      { key: 'freight', header: 'Phí vận chuyển (đ)', width: 16, type: 'money' },
      { key: 'returns', header: 'Trả hàng / giảm (đ)', width: 17, type: 'money' },
      { key: 'balance', header: 'Còn nợ lũy kế (đ)', width: 19, type: 'money', emphasis: true },
    ];
    const sheet = brandSheet(workbook, 'Sổ công nợ', columns);
    let rowNo = titleBlock(sheet, columns.length, 'Sổ chi tiết công nợ khách hàng', [
      `Khách hàng: ${statement.partner.code} — ${statement.partner.name}`,
      `Kỳ: ${period} · Người lập: ${preparedBy} · Xuất lúc ${exportedAt()}`,
    ]);
    rowNo = kpiStrip(sheet, rowNo, columns.length, [
      { label: 'SỐ DƯ ĐẦU KỲ (Đ)', value: Number(statement.opening), format: FORMATS.money },
      { label: 'PHÁT SINH NỢ (Đ)', value: Number(statement.totals.debit), format: FORMATS.money },
      { label: 'ĐÃ THU (Đ)', value: Number(statement.totals.receipt), format: FORMATS.money, tone: 'good' },
      { label: 'CÒN NỢ CUỐI KỲ (Đ)', value: Number(statement.closing), format: FORMATS.money, tone: Number(statement.closing) > 0 ? 'danger' : 'good' },
    ]);
    const header = rowNo;
    tableHeader(sheet, header, columns);
    statement.rows.forEach((row, index) => {
      addBodyRow(sheet, columns, {
        stt: index + 1, date: new Date(new Date(row.date).getTime() + 7 * 3_600_000), doc: row.documentNo, text: row.description,
        debit: Number(row.debit) || null, receipt: Number(row.receipt) || null, freight: Number(row.freight) || null, returns: Number(row.returns) || null, balance: Number(row.balance),
      }, index, { cells: Number(row.balance) < 0 ? { balance: { color: 'green' } } : {} });
    });
    totalRow(sheet, columns, {
      text: 'CỘNG PHÁT SINH TRONG KỲ', debit: Number(statement.totals.debit), receipt: Number(statement.totals.receipt),
      freight: Number(statement.totals.freight), returns: Number(statement.totals.returns), balance: Number(statement.closing),
    });
    finalize(sheet, header, header + statement.rows.length, columns.length);
    // Phần tổng giống sheet đối chiếu của kế toán: thêm công nợ từng nhóm tách riêng và còn lại trừ nhóm (CN-SEG-01).
    const groups = statement.segments.filter((segment) => new Decimal(segment.outstanding).gt(0));
    const summary: Array<[string, string]> = [
      ['Còn nợ cuối kỳ', statement.closing],
      ['Chứng từ còn nợ (hiện tại)', statement.openDebt],
      ['Khách trả trước chưa bù trừ (hiện tại)', statement.prepayment],
      ...groups.map((segment): [string, string] => [`Công nợ ${segment.name} (hiện tại)`, segment.outstanding]),
      ...(groups.length ? [[`Còn lại trừ ${groups.map((segment) => segment.name).join(', ')} (hiện tại)`, statement.current.normal] as [string, string]] : []),
    ];
    sheet.addRow([]);
    summary.forEach(([label, value], index) => addBodyRow(sheet, columns, { text: label, balance: Number(value) }, index, index === 0 ? { cells: { text: { bold: true }, balance: { bold: true } } } : {}));
    signatureBlock(sheet, columns.length, preparedBy, ['Người lập biểu', 'Kế toán trưởng', 'Xác nhận của khách hàng']);
    const buffer = await toBuffer(workbook);
    const safe = statement.partner.code.replace(/[^A-Za-z0-9_-]/g, '');
    return { buffer, fileName: `SoCongNo_${safe}_${from ?? 'dau'}_${to ?? 'nay'}.xlsx` };
  }

  /** Xem trước cách phân bổ một khoản thu theo khách (chứng từ cũ nhất trước, phần dư thành trả trước). */
  async previewCustomerPayment(partnerId: string, amount: string, segment?: string) {
    const id = toObjectId(partnerId, 'partnerId');
    await this.customer(id);
    if (!/^\d+(\.\d{1,2})?$/.test(amount) || new Decimal(amount).lte(0)) throw new ConflictException({ code: 'AMOUNT_INVALID', message: 'Số tiền phải lớn hơn 0' });
    await this.segmentRule(segment);
    const open = await this.openItems(id);
    // Nợ thường trước rồi tới phần nhóm tách riêng; "thu cho nhóm" thì phần nhóm đó trước (CN-SEG-01).
    const parts = ReceivablesService.partsOf(open);
    const plan = planPartsAllocation(parts, amount, segment || null);
    const byId = new Map(open.map((item) => [item.id, item]));
    return {
      allocations: plan.allocations.map((allocation) => {
        const item = byId.get(allocation.receivableId);
        const part = parts.find((row) => row.receivableId === allocation.receivableId && row.segment === allocation.segment);
        return {
          receivableId: allocation.receivableId,
          segment: allocation.segment,
          code: item?.code ?? '',
          amount: allocation.amount,
          outstanding: part?.outstanding ?? item?.outstanding.toFixed(2) ?? '0.00',
          documentNo: ReceivablesService.documentNo(item?.document, item?.code ?? ''),
          dueDate: item?.dueDate.toISOString(),
          createdAt: item?.createdAt.toISOString(),
        };
      }),
      leftover: plan.leftover,
      openDebt: open.filter((item) => item.outstanding.gt(0)).reduce((sum, item) => sum.add(item.outstanding), new Decimal(0)).toFixed(2),
    };
  }

  /**
   * Thu theo khách (CN-KH-01): NPP trả gối đầu một số tiền — tự phân bổ vào chứng từ còn nợ cũ nhất trước; thu dư thành
   * khoản khách trả trước (phải thu âm, bù trừ sau). kind FREIGHT = phí vận chuyển khách trả thay công ty (trừ nợ, cột riêng).
   */
  async recordCustomerPayment(input: CreateCustomerPayment, request: AuthenticatedRequest, key: string | undefined) {
    return this.idempotency.execute(`customer-payment:${request.user.sub}`, key, input, async (session) => {
      const partnerId = toObjectId(input.partnerId, 'partnerId');
      const partner = await this.customer(partnerId, session);
      const now = new Date();
      const receivedAt = new Date(input.receivedAt);
      await this.segmentRule(input.segment, session);
      const open = await this.openItems(partnerId, session);
      const plan = planPartsAllocation(ReceivablesService.partsOf(open), input.amount, input.segment || null);
      const paymentId = new ObjectId();
      const code = await this.sequences.next('PAY', session);
      let prepaymentId: ObjectId | undefined;
      if (new Decimal(plan.leftover).gt(0)) {
        prepaymentId = new ObjectId();
        const farFuture = new Date(now);
        farFuture.setUTCFullYear(farFuture.getUTCFullYear() + 10);
        await this.db.collection('receivables').insertOne({
          _id: prepaymentId,
          code: await this.sequences.next('AR', session),
          partnerId,
          sourceType: 'CUSTOMER_PREPAYMENT',
          paymentId,
          paymentCode: code,
          amount: decimal(`-${plan.leftover}`),
          paidAmount: decimal('0'),
          status: 'OPEN',
          dueDate: farFuture,
          note: `${input.kind === 'FREIGHT' ? 'Phí vận chuyển' : 'Phiếu thu'} ${code} vượt số còn nợ — khách trả trước`,
          version: 1,
          createdAt: receivedAt,
          updatedAt: now,
        }, { session });
      }
      const payment = {
        _id: paymentId,
        code,
        partnerId,
        amount: decimal(input.amount),
        kind: input.kind,
        mode: 'CUSTOMER',
        method: input.method,
        receivedAt,
        ...(input.reference ? { reference: input.reference } : {}),
        ...(input.note ? { note: input.note } : {}),
        ...(input.segment ? { segment: input.segment } : {}),
        allocations: plan.allocations.map((allocation) => ({ receivableId: new ObjectId(allocation.receivableId), amount: decimal(allocation.amount), ...(allocation.segment ? { segment: allocation.segment } : {}) })),
        ...(prepaymentId ? { prepaymentReceivableId: prepaymentId, unappliedAmount: decimal(plan.leftover) } : {}),
        status: 'POSTED',
        postedBy: toObjectId(request.user.sub),
        postedAt: now,
        createdAt: now,
      };
      await this.db.collection('payments').insertOne(payment, { session });
      await this.applyAllocations(plan.allocations.map((allocation) => ({ receivableId: new ObjectId(allocation.receivableId), amount: allocation.amount, segment: allocation.segment })), session, now);
      const released = await releaseHoldIfCleared(this.db, partnerId, session, now);
      await this.audit.record(
        {
          actorId: request.user.sub,
          actorEmail: request.user.email,
          correlationId: request.correlationId,
          action: input.kind === 'FREIGHT' ? 'CUSTOMER_FREIGHT_POSTED' : 'CUSTOMER_PAYMENT_POSTED',
          entityType: 'Payment',
          entityId: paymentId.toHexString(),
          after: serializeDocument(payment),
          metadata: { partnerCode: partner.code, allocations: plan.allocations.length, prepayment: plan.leftover, partnerHoldReleased: released },
        },
        session,
      );
      return { ...serializeDocument(payment), prepayment: plan.leftover, partnerHoldReleased: released };
    });
  }

  /** Bù trừ khoản khách trả trước (phải thu âm) vào chứng từ còn nợ, cũ nhất trước — phiếu OFFSET, không đổi số dư. */
  async applyCredit(partnerId: string, request: AuthenticatedRequest, key: string | undefined) {
    return this.idempotency.execute(`customer-offset:${request.user.sub}`, key, { partnerId }, async (session) => {
      const id = toObjectId(partnerId, 'partnerId');
      const partner = await this.customer(id, session);
      const open = await this.openItems(id, session);
      const credits = open.filter((item) => item.outstanding.lt(0)).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      const available = credits.reduce((sum, item) => sum.minus(item.outstanding), new Decimal(0));
      const plan = planPartsAllocation(ReceivablesService.partsOf(open), available.toFixed(2));
      const applied = available.minus(plan.leftover);
      if (applied.lte(0)) throw new ConflictException({ code: 'NOTHING_TO_OFFSET', message: 'Không có khoản trả trước hoặc chứng từ còn nợ để bù trừ' });
      let remaining = applied;
      const creditAllocations: Array<{ id: string; amount: string }> = [];
      for (const credit of credits) {
        if (remaining.lte(0)) break;
        const take = Decimal.min(remaining, credit.outstanding.neg());
        creditAllocations.push({ id: credit.id, amount: take.neg().toFixed(2) });
        remaining = remaining.minus(take);
      }
      const now = new Date();
      const allocations = [
        ...plan.allocations.map((allocation) => ({ id: allocation.receivableId, amount: allocation.amount, segment: allocation.segment })),
        ...creditAllocations.map((allocation) => ({ ...allocation, segment: null })),
      ];
      const payment = {
        _id: new ObjectId(),
        code: await this.sequences.next('PAY', session),
        partnerId: id,
        amount: decimal(applied.toFixed(2)),
        kind: 'OFFSET',
        mode: 'CUSTOMER',
        method: 'OTHER',
        receivedAt: now,
        note: 'Bù trừ khoản khách trả trước vào chứng từ còn nợ',
        allocations: allocations.map((allocation) => ({ receivableId: new ObjectId(allocation.id), amount: decimal(allocation.amount), ...(allocation.segment ? { segment: allocation.segment } : {}) })),
        status: 'POSTED',
        postedBy: toObjectId(request.user.sub),
        postedAt: now,
        createdAt: now,
      };
      await this.db.collection('payments').insertOne(payment, { session });
      await this.applyAllocations(allocations.map((allocation) => ({ receivableId: new ObjectId(allocation.id), amount: allocation.amount, segment: allocation.segment })), session, now);
      const released = await releaseHoldIfCleared(this.db, id, session, now);
      await this.audit.record(
        {
          actorId: request.user.sub,
          actorEmail: request.user.email,
          correlationId: request.correlationId,
          action: 'CUSTOMER_CREDIT_OFFSET',
          entityType: 'Payment',
          entityId: payment._id.toHexString(),
          after: serializeDocument(payment),
          metadata: { partnerCode: partner.code, applied: applied.toFixed(2), partnerHoldReleased: released },
        },
        session,
      );
      return { ...serializeDocument(payment), applied: applied.toFixed(2) };
    });
  }

  /**
   * Gắn tay cả chứng từ vào một nhóm công nợ tách riêng (CN-SEG-01 — VD "Hàng mẫu", "Đơn 2025") hoặc gỡ ra (segment null).
   * Tính lại phần nhóm và phân bổ lại tiền đã thu của khách ngay trong giao dịch; có nhật ký.
   */
  async setSegmentTag(receivableId: string, input: { segment: string | null; reason: string }, request: AuthenticatedRequest) {
    const id = toObjectId(receivableId, 'receivableId');
    const session = this.db.client.startSession();
    try {
      let result: Record<string, unknown> = {};
      await session.withTransaction(async () => {
        const receivable = await this.db.collection('receivables').findOne({ _id: id }, { session });
        if (!receivable) throw new NotFoundException({ code: 'RECEIVABLE_NOT_FOUND', message: 'Không tìm thấy khoản phải thu' });
        if (receivable.status === 'VOIDED' || new Decimal(decimalString(receivable.amount)).lte(0)) {
          throw new ConflictException({ code: 'RECEIVABLE_NOT_TAGGABLE', message: 'Chỉ gắn nhóm cho chứng từ phải thu còn hiệu lực' });
        }
        if (input.segment) await this.segmentRule(input.segment, session);
        const now = new Date();
        const before = receivable.segmentTag ?? null;
        await this.db.collection('receivables').updateOne(
          { _id: id, version: receivable.version },
          input.segment
            ? { $set: { segmentTag: { code: input.segment, reason: input.reason, by: request.user.displayName, byId: toObjectId(request.user.sub), at: now }, updatedAt: now }, $inc: { version: 1 } }
            : { $unset: { segmentTag: '' }, $set: { updatedAt: now }, $inc: { version: 1 } },
          { session },
        );
        const { plan } = await reallocatePartner(this.db, receivable.partnerId as ObjectId, session, now);
        const released = await releaseHoldIfCleared(this.db, receivable.partnerId as ObjectId, session, now);
        await this.audit.record({
          actorId: request.user.sub, actorEmail: request.user.email, correlationId: request.correlationId,
          action: 'RECEIVABLE_SEGMENT_TAGGED', entityType: 'Receivable', entityId: receivableId,
          before: { segmentTag: before ? serializeDocument(before) : null },
          after: { segment: input.segment, reason: input.reason },
          metadata: { code: receivable.code, partnerHoldReleased: released, before: plan.before, after: plan.after },
        }, session);
        result = { receivableId, segment: input.segment, summary: plan.after, partnerHoldReleased: released };
      });
      return result;
    } finally {
      await session.endSession();
    }
  }

  /** Cờ "Không tự khóa" (CN-KH-01): NPP trả gối đầu không bị khóa lập phiếu khi nợ quá hạn > 60 ngày. Bật thì mở khóa ngay nếu đang bị khóa do quá hạn. */
  async setAutoHoldExempt(partnerId: string, exempt: boolean, request: AuthenticatedRequest) {
    const id = toObjectId(partnerId, 'partnerId');
    const before = await this.customer(id);
    const now = new Date();
    const releasing = exempt && before.status === 'ON_HOLD' && before.holdReason === OVERDUE_HOLD_REASON;
    await this.db.collection('partners').updateOne(
      { _id: id },
      {
        $set: { autoHoldExempt: exempt, autoHoldExemptBy: request.user.displayName, autoHoldExemptAt: now, updatedAt: now, ...(releasing ? { status: 'ACTIVE' } : {}) },
        ...(releasing ? { $unset: { holdReason: '', heldAt: '' } } : {}),
        $inc: { version: 1 },
      },
    );
    await this.audit.record({
      actorId: request.user.sub,
      actorEmail: request.user.email,
      correlationId: request.correlationId,
      action: 'PARTNER_AUTO_HOLD_EXEMPT_CHANGED',
      entityType: 'Partner',
      entityId: partnerId,
      before: { autoHoldExempt: before.autoHoldExempt === true },
      after: { autoHoldExempt: exempt },
      metadata: { partnerCode: before.code, released: releasing },
    });
    return { partnerId, autoHoldExempt: exempt, released: releasing };
  }
}
