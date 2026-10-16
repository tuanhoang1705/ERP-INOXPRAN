import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { PriceOverrideDecision, PriceOverrideRequestInput, PriceOverrideRequestView } from '@inoxpran/contracts';
import { can, userIdsWithPermission } from '../../common/permissions';
import type { ClientSession, Db, Document } from 'mongodb';
import { ObjectId } from 'mongodb';
import { AuditService } from '../../common/audit.service';
import { toObjectId } from '../../common/domain';
import { IdempotencyService } from '../../common/idempotency.service';
import { OutboxService } from '../../common/outbox.service';
import type { AuthenticatedRequest } from '../../common/request-context';
import { SequenceService } from '../../common/sequence.service';
import { MONGO_DATABASE } from '../../common/tokens';

const COLLECTION = 'price_override_requests';
/** Quyền đã duyệt mà chưa gắn vào phiếu nào thì hết hạn sau 12 giờ (một ca làm việc). */
const GRANT_TTL_MS = 12 * 3_600_000;
const isApprover = (user: AuthenticatedRequest['user']) => can(user, 'sales.price_override_approve');

/**
 * Quyền sửa đơn giá trên phiếu BH (12/10/2026): kế toán xin kèm lý do → Admin / Giám đốc duyệt từ xa → quyền chỉ dùng
 * cho đúng một phiếu (phiên lập phiếu đã xin, hoặc phiếu nháp đang sửa). Lập phiếu khác phải xin lại.
 */
@Injectable()
export class PriceOverridesService {
  constructor(
    @Inject(MONGO_DATABASE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly sequences: SequenceService,
    private readonly idempotency: IdempotencyService,
    private readonly outbox: OutboxService,
  ) {}

  view(row: Document): PriceOverrideRequestView {
    const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : undefined);
    return {
      id: (row._id as ObjectId).toHexString(),
      code: String(row.code),
      status: row.status,
      reason: String(row.reason),
      requestedByName: String(row.requestedByName),
      requestedAt: (row.requestedAt as Date).toISOString(),
      ...(row.customerName ? { customerName: String(row.customerName) } : {}),
      ...(row.salesOrderId ? { salesOrderId: (row.salesOrderId as ObjectId).toHexString() } : {}),
      ...(row.salesOrderCode ? { salesOrderCode: String(row.salesOrderCode) } : {}),
      ...(row.decidedByName ? { decidedByName: String(row.decidedByName) } : {}),
      ...(iso(row.decidedAt) ? { decidedAt: iso(row.decidedAt) as string } : {}),
      ...(row.decisionNote ? { decisionNote: String(row.decisionNote) } : {}),
      ...(iso(row.expiresAt) && !row.salesOrderId ? { expiresAt: iso(row.expiresAt) as string } : {}),
    };
  }

  async create(input: PriceOverrideRequestInput, request: AuthenticatedRequest, idempotencyKey: string | undefined) {
    return this.idempotency.execute(`price-override-request:${request.user.sub}`, idempotencyKey, input, async (session) => {
      // Đang có yêu cầu chờ duyệt cho cùng phiên lập phiếu → dùng lại, không gửi trùng.
      const waiting = await this.db.collection(COLLECTION).findOne({ formSessionId: input.formSessionId, requestedBy: toObjectId(request.user.sub), status: 'PENDING' }, { session });
      if (waiting) return this.view(waiting);
      const [customer, order] = await Promise.all([
        input.customerId ? this.db.collection('partners').findOne({ _id: toObjectId(input.customerId, 'customerId') }, { session, projection: { name: 1, code: 1 } }) : null,
        input.salesOrderId ? this.db.collection('sales_orders').findOne({ _id: toObjectId(input.salesOrderId, 'salesOrderId') }, { session, projection: { code: 1, status: 1, customerName: 1 } }) : null,
      ]);
      if (input.salesOrderId && (!order || order.status !== 'DRAFT')) {
        throw new ConflictException({ code: 'ORDER_STATE_CONFLICT', message: 'Chỉ xin sửa giá cho phiếu đang nháp' });
      }
      const now = new Date();
      // Admin / Giám đốc tự lập phiếu thì đã có thẩm quyền: quyền được duyệt ngay.
      const selfApproved = isApprover(request.user);
      const document: Document = {
        _id: new ObjectId(),
        code: await this.sequences.next('SG', session),
        status: selfApproved ? 'APPROVED' : 'PENDING',
        reason: input.reason,
        formSessionId: input.formSessionId,
        requestedBy: toObjectId(request.user.sub),
        requestedByName: request.user.displayName,
        requestedAt: now,
        ...(customer ? { customerId: customer._id, customerName: `${String(customer.code)} — ${String(customer.name)}` } : order ? { customerName: String(order.customerName) } : {}),
        ...(order ? { salesOrderId: order._id, salesOrderCode: String(order.code) } : {}),
        ...(selfApproved ? { decidedBy: toObjectId(request.user.sub), decidedByName: request.user.displayName, decidedAt: now, decisionNote: 'Tự cấp (Admin / Giám đốc lập phiếu)', expiresAt: new Date(now.getTime() + GRANT_TTL_MS) } : {}),
        createdAt: now,
        updatedAt: now,
      };
      await this.db.collection(COLLECTION).insertOne(document, { session });
      if (!selfApproved) {
        await this.outbox.enqueue({
          eventType: 'NOTIFICATION_REQUESTED',
          aggregateType: 'PriceOverrideRequest',
          aggregateId: (document._id as ObjectId).toHexString(),
          payload: {
            category: 'SALES_ISSUE',
            targetUserIds: await userIdsWithPermission(this.db, 'sales.price_override_approve', session),
            level: 'WARNING',
            title: `${request.user.displayName} xin quyền sửa đơn giá phiếu BH`,
            message: `${document.customerName ? `${String(document.customerName)}: ` : ''}${input.reason}`,
            href: '/sales/price-approvals',
            template: 'PRICE_OVERRIDE_REQUESTED',
            params: { code: String(document.code), requester: request.user.displayName, customer: String(document.customerName ?? ''), reason: input.reason, order: String(document.salesOrderCode ?? '') },
          },
        }, session);
      }
      await this.audit.record({
        actorId: request.user.sub, actorEmail: request.user.email, correlationId: request.correlationId,
        action: selfApproved ? 'PRICE_OVERRIDE_SELF_GRANTED' : 'PRICE_OVERRIDE_REQUESTED',
        entityType: 'PriceOverrideRequest', entityId: (document._id as ObjectId).toHexString(),
        metadata: { code: document.code, reason: input.reason, customer: document.customerName, order: document.salesOrderCode },
      }, session);
      return this.view(document);
    });
  }

  async list(status: string | undefined) {
    const filter: Document = status ? { status } : {};
    const rows = await this.db.collection(COLLECTION).find(filter).sort({ requestedAt: -1 }).limit(200).toArray();
    return rows.map((row) => this.view(row));
  }

  async get(id: string, request: AuthenticatedRequest) {
    const row = await this.db.collection(COLLECTION).findOne({ _id: toObjectId(id) });
    if (!row) throw new NotFoundException({ code: 'PRICE_OVERRIDE_NOT_FOUND', message: 'Không tìm thấy yêu cầu sửa giá' });
    if (!isApprover(request.user) && String(row.requestedBy) !== request.user.sub) {
      throw new NotFoundException({ code: 'PRICE_OVERRIDE_NOT_FOUND', message: 'Không tìm thấy yêu cầu sửa giá' });
    }
    return this.view(row);
  }

  async decide(id: string, input: PriceOverrideDecision, request: AuthenticatedRequest, idempotencyKey: string | undefined) {
    return this.idempotency.execute(`price-override-decision:${id}`, idempotencyKey, input, async (session) => {
      if (input.decision === 'REJECT' && !input.note) {
        throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'Ghi lý do từ chối', details: [{ path: ['note'] }] });
      }
      const now = new Date();
      const updated = await this.db.collection(COLLECTION).findOneAndUpdate(
        { _id: toObjectId(id), status: 'PENDING' },
        {
          $set: {
            status: input.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED',
            decidedBy: toObjectId(request.user.sub), decidedByName: request.user.displayName, decidedAt: now,
            ...(input.note ? { decisionNote: input.note } : {}),
            ...(input.decision === 'APPROVE' ? { expiresAt: new Date(now.getTime() + GRANT_TTL_MS) } : {}),
            updatedAt: now,
          },
        },
        { session, returnDocument: 'after' },
      );
      if (!updated) throw new ConflictException({ code: 'PRICE_OVERRIDE_STATE_CONFLICT', message: 'Yêu cầu đã được xử lý hoặc đã hủy' });
      const approved = input.decision === 'APPROVE';
      await this.outbox.enqueue({
        eventType: 'NOTIFICATION_REQUESTED',
        aggregateType: 'PriceOverrideRequest',
        aggregateId: id,
        payload: {
          category: 'SALES_ISSUE',
          targetUserIds: [(updated.requestedBy as ObjectId).toHexString()],
          level: approved ? 'INFO' : 'WARNING',
          title: approved ? `${request.user.displayName} đã cấp quyền sửa đơn giá` : `${request.user.displayName} từ chối quyền sửa đơn giá`,
          message: input.note ?? String(updated.reason),
          href: updated.salesOrderId ? `/sales/orders/${(updated.salesOrderId as ObjectId).toHexString()}/edit` : '/sales/orders/new',
          template: 'PRICE_OVERRIDE_DECIDED',
          params: { code: String(updated.code), approver: request.user.displayName, decision: input.decision, note: input.note ?? '' },
        },
      }, session);
      await this.audit.record({
        actorId: request.user.sub, actorEmail: request.user.email, correlationId: request.correlationId,
        action: approved ? 'PRICE_OVERRIDE_APPROVED' : 'PRICE_OVERRIDE_REJECTED',
        entityType: 'PriceOverrideRequest', entityId: id,
        metadata: { code: updated.code, requester: updated.requestedByName, reason: updated.reason, note: input.note },
      }, session);
      return this.view(updated);
    });
  }

  async cancel(id: string, request: AuthenticatedRequest) {
    const updated = await this.db.collection(COLLECTION).findOneAndUpdate(
      { _id: toObjectId(id), status: 'PENDING', requestedBy: toObjectId(request.user.sub) },
      { $set: { status: 'CANCELLED', updatedAt: new Date() } },
      { returnDocument: 'after' },
    );
    if (!updated) throw new ConflictException({ code: 'PRICE_OVERRIDE_STATE_CONFLICT', message: 'Yêu cầu đã được xử lý hoặc không phải của bạn' });
    return this.view(updated);
  }

  /**
   * Kiểm tra quyền khi lưu phiếu có dòng sửa giá. Quyền đã gắn phiếu chỉ dùng cho đúng phiếu đó (ai sửa phiếu nháp
   * cũng giữ được giá đã duyệt); quyền chưa gắn phiếu chỉ dùng trong đúng phiên lập phiếu của người xin, trong 12 giờ.
   */
  async assertUsable(grantId: string | undefined, formSessionId: string | undefined, orderId: ObjectId | null, request: AuthenticatedRequest, session: ClientSession): Promise<Document> {
    const denied = (message: string) => new ForbiddenException({ code: 'PRICE_OVERRIDE_NOT_GRANTED', message });
    if (!grantId) throw denied('Sửa đơn giá cần Admin / Giám đốc cấp quyền cho phiếu này');
    const grant = await this.db.collection(COLLECTION).findOne({ _id: toObjectId(grantId, 'priceOverrideRequestId') }, { session });
    if (!grant || grant.status !== 'APPROVED') throw denied('Quyền sửa đơn giá chưa được duyệt');
    if (grant.salesOrderId) {
      if (!orderId || !(grant.salesOrderId as ObjectId).equals(orderId)) throw denied('Quyền sửa giá này đã dùng cho phiếu khác — xin cấp quyền lại');
      return grant;
    }
    if (String(grant.requestedBy) !== request.user.sub || grant.formSessionId !== formSessionId) {
      throw denied('Quyền sửa giá chỉ dùng cho phiên lập phiếu đã xin — xin cấp quyền lại');
    }
    if ((grant.expiresAt as Date) < new Date()) throw denied('Quyền sửa giá đã hết hạn (12 giờ) — xin cấp quyền lại');
    return grant;
  }

  /** Gắn quyền vào phiếu vừa lưu — từ đây quyền chỉ dùng cho phiếu này. */
  async bind(grant: Document, order: { _id: ObjectId; code: string }, session: ClientSession) {
    if (grant.salesOrderId) return;
    await this.db.collection(COLLECTION).updateOne(
      { _id: grant._id, salesOrderId: { $exists: false } },
      { $set: { salesOrderId: order._id, salesOrderCode: order.code, boundAt: new Date(), updatedAt: new Date() } },
      { session },
    );
  }
}
