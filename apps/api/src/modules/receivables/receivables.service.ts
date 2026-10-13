import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { CreatePayment } from '@inoxpran/contracts';
import Decimal from 'decimal.js';
import type { Db, Document } from 'mongodb';
import { ObjectId } from 'mongodb';
import { AuditService } from '../../common/audit.service';
import { decimal, decimalString, serializeDocument, toObjectId } from '../../common/domain';
import { IdempotencyService } from '../../common/idempotency.service';
import type { AuthenticatedRequest } from '../../common/request-context';
import { SequenceService } from '../../common/sequence.service';
import { MONGO_DATABASE } from '../../common/tokens';
import { pageOf, type PageRequest } from '../../common/paging';
import { classifyOverdue, daysOverdue, OPEN_RECEIVABLE_STATUSES, releaseHoldIfCleared, runOverdueReview } from './overdue-review';

@Injectable()
export class ReceivablesService {
  constructor(
    @Inject(MONGO_DATABASE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly sequences: SequenceService,
  ) {}

  /** Mặc định chỉ trả khoản còn dư nợ (sắp theo hạn); includePaid trả cả khoản đã thu, mới nhất trước. */
  /** `hidden`: điều kiện bỏ công nợ ẩn với nhân viên (phiếu quản trị gốc hủy — ROOT-DEL-02). */
  async list(partnerId?: string, overdueOnly = false, includePaid = false, search?: string, paging: PageRequest | null = null, hidden: Document = {}) {
    const filter: Document = { ...(includePaid ? {} : { status: { $in: OPEN_RECEIVABLE_STATUSES } }), ...hidden };
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
      pipeline.push({ $match: { $or: [{ code: pattern }, { salesOrderCode: pattern }, { warrantyCode: pattern }, { openingDocumentNo: pattern }, { payerName: pattern }, { 'partner.name': pattern }, { 'partner.code': pattern }] } });
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
      const open = OPEN_RECEIVABLE_STATUSES.includes(String(row.status));
      return {
        ...serializeDocument(receivable),
        outstandingAmount: new Decimal(decimalString(row.amount)).minus(decimalString(row.paidAmount)).toFixed(2),
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
      creditLimit: Decimal; current: Decimal; d1to30: Decimal; d31to60: Decimal; over60: Decimal; maxDays: number; documents: number;
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
        current: new Decimal(0), d1to30: new Decimal(0), d31to60: new Decimal(0), over60: new Decimal(0), maxDays: 0, documents: 0,
      };
      const outstanding = new Decimal(decimalString(row.amount)).minus(decimalString(row.paidAmount));
      const days = daysOverdue(row.dueDate as Date, now);
      const level = classifyOverdue(days);
      if (!level) entry.current = entry.current.add(outstanding);
      else if (level === 'REMINDER') entry.d1to30 = entry.d1to30.add(outstanding);
      else if (level === 'WARNING') entry.d31to60 = entry.d31to60.add(outstanding);
      else entry.over60 = entry.over60.add(outstanding);
      entry.maxDays = Math.max(entry.maxDays, days);
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
        total: total.toFixed(2),
        maxDays: Math.max(0, entry.maxDays),
        level: classifyOverdue(entry.maxDays),
        documents: entry.documents,
        creditUsage: entry.creditLimit.gt(0) ? total.div(entry.creditLimit).mul(100).toDecimalPlaces(1).toNumber() : null,
      };
    }).sort((a, b) => b.maxDays - a.maxDays || Number(b.total) - Number(a.total));
    const sum = (field: 'current' | 'd1to30' | 'd31to60' | 'over60' | 'total') =>
      partners.reduce((total, entry) => total.add(entry[field]), new Decimal(0)).toFixed(2);
    const lastReview = await this.db.collection<{ _id: string } & Document>('overdue_reviews').find().sort({ ranAt: -1 }).limit(1).next();
    return {
      generatedAt: now.toISOString(),
      totals: { current: sum('current'), d1to30: sum('d1to30'), d31to60: sum('d31to60'), over60: sum('over60'), total: sum('total') },
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

          for (const allocation of input.allocations) {
            const receivableId = toObjectId(allocation.receivableId, 'receivableId');
            const receivable = await this.db.collection('receivables').findOne({ _id: receivableId, partnerId }, { session });
            if (!receivable) throw new NotFoundException({ code: 'RECEIVABLE_NOT_FOUND', message: 'Không tìm thấy khoản phải thu' });
            const outstanding = new Decimal(decimalString(receivable.amount)).minus(decimalString(receivable.paidAmount));
            if (new Decimal(allocation.amount).gt(outstanding)) {
              throw new ConflictException({ code: 'PAYMENT_EXCEEDS_OUTSTANDING', message: 'Số tiền phân bổ vượt dư nợ chứng từ' });
            }
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
            allocations: input.allocations.map((allocation) => ({
              receivableId: toObjectId(allocation.receivableId),
              amount: decimal(allocation.amount),
            })),
            status: 'POSTED',
            postedBy: toObjectId(request.user.sub),
            postedAt: now,
            createdAt: now,
          };
          await this.db.collection('payments').insertOne(payment, { session });
          for (const allocation of input.allocations) {
            const receivableId = toObjectId(allocation.receivableId);
            const receivable = await this.db.collection('receivables').findOne({ _id: receivableId }, { session });
            if (!receivable) throw new NotFoundException();
            const nextPaid = new Decimal(decimalString(receivable.paidAmount)).add(allocation.amount);
            const status = nextPaid.eq(decimalString(receivable.amount)) ? 'PAID' : 'PARTIALLY_PAID';
            await this.db.collection('receivables').updateOne(
              { _id: receivableId, version: receivable.version },
              {
                $inc: { paidAmount: decimal(allocation.amount), version: 1 },
                $set: { status, updatedAt: now },
              },
              { session },
            );
          }
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
}
