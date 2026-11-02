import { ConflictException, ForbiddenException, HttpException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { CANCELLABLE_SALES_STATUSES, type CreateSalesChangeRequest, type SalesChangeKind, type SalesChangeRequestView, type SalesChangeStatus, orderParty } from '@inoxpran/contracts';
import { ObjectId, type ClientSession, type Db, type Document } from 'mongodb';
import { assertWarehouseAccess } from '../../common/access';
import { AuditService } from '../../common/audit.service';
import { serializeDocument, toObjectId } from '../../common/domain';
import { IdempotencyService } from '../../common/idempotency.service';
import { OutboxService } from '../../common/outbox.service';
import { pageOf, type PageRequest } from '../../common/paging';
import { seesCancelled } from '../../common/hidden-documents';
import { can, userIdsWithPermission } from '../../common/permissions';
import type { AuthenticatedRequest } from '../../common/request-context';
import { SequenceService } from '../../common/sequence.service';
import { MONGO_DATABASE } from '../../common/tokens';
import { salesOrderScope } from './keeper-scope';
import { SalesService, type SalesChangeVia } from './sales.service';

const COLLECTION = 'sales_change_requests';
const SHIPPED = ['SHIPPED', 'PARTIALLY_SHIPPED', 'DELIVERED'];
const KIND_LABEL: Record<SalesChangeKind, string> = { EDIT: 'sửa', VOID: 'hủy (đã giao)', CANCEL: 'hủy', DELETE: 'xóa' };

/**
 * Đề nghị sửa / hủy / xóa phiếu BH (SAL-CHG-01, 14/10/2026): người có quyền `sales.change_request` (mặc định kế toán, thủ kho,
 * quản lý kho) gửi đề nghị kèm lý do — EDIT kèm nội dung sửa (đã tính xem trước). Người có quyền `sales.change_approve`
 * (mặc định Admin) duyệt thì hệ thống thực hiện đúng thao tác như làm trực tiếp (cùng giao dịch, nhật ký ghi kèm số đề nghị);
 * phiếu đã đổi sau khi gửi hoặc thao tác không hợp lệ thì đề nghị chuyển "Không thực hiện được" kèm lý do. Mỗi phiếu chỉ một đề nghị chờ duyệt.
 */
@Injectable()
export class SalesChangeRequestsService {
  constructor(
    @Inject(MONGO_DATABASE) private readonly db: Db,
    private readonly sales: SalesService,
    private readonly idempotency: IdempotencyService,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
    private readonly sequences: SequenceService,
  ) {}

  private present(row: Document): SalesChangeRequestView & { preview?: unknown } {
    const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : undefined);
    return {
      id: (row._id as ObjectId).toHexString(),
      code: String(row.code),
      kind: row.kind as SalesChangeKind,
      status: row.status as SalesChangeStatus,
      orderId: (row.orderId as ObjectId).toHexString(),
      orderCode: String(row.orderCode),
      orderVersion: Number(row.orderVersion),
      ...(row.customerName ? { customerName: String(row.customerName) } : {}),
      reason: String(row.reason),
      ...(row.changes ? { changes: row.changes } : {}),
      ...(row.preview ? { preview: row.preview } : {}),
      requestedById: String(row.requestedBy),
      requestedByName: String(row.requestedByName),
      requestedAt: iso(row.requestedAt) as string,
      ...(row.decidedByName ? { decidedByName: String(row.decidedByName) } : {}),
      ...(iso(row.decidedAt) ? { decidedAt: iso(row.decidedAt) as string } : {}),
      ...(row.decisionNote ? { decisionNote: String(row.decisionNote) } : {}),
      ...(row.error ? { error: String(row.error) } : {}),
    };
  }

  private notifyRequester(row: Document, template: 'SALES_CHANGE_APPROVED' | 'SALES_CHANGE_REJECTED', request: AuthenticatedRequest, session: ClientSession, extra: Record<string, string> = {}) {
    const approved = template === 'SALES_CHANGE_APPROVED';
    return this.outbox.enqueue({
      eventType: 'NOTIFICATION_REQUESTED',
      aggregateType: 'SalesChangeRequest',
      aggregateId: (row._id as ObjectId).toHexString(),
      payload: {
        category: 'SALES_ISSUE',
        targetUserIds: [String(row.requestedBy)],
        level: approved ? 'INFO' : 'WARNING',
        title: approved ? `Đề nghị ${String(row.code)} đã được duyệt` : `Đề nghị ${String(row.code)} không được thực hiện`,
        message: approved
          ? `${request.user.displayName} duyệt đề nghị ${KIND_LABEL[row.kind as SalesChangeKind]} phiếu ${String(row.orderCode)}.`
          : `${request.user.displayName}: ${extra.note ?? ''}`,
        href: `/sales/orders/${(row.orderId as ObjectId).toHexString()}`,
        template,
        params: { code: String(row.code), order: String(row.orderCode), kind: String(row.kind), approver: request.user.displayName, note: extra.note ?? '' },
      },
    }, session);
  }

  /** Gửi đề nghị: kiểm tra phiếu đúng giai đoạn, đúng phiên bản, chưa có đề nghị khác đang chờ. */
  async create(orderIdValue: string, input: CreateSalesChangeRequest, request: AuthenticatedRequest, key: string | undefined) {
    return this.idempotency.execute(`sales-change-request:${orderIdValue}`, key, input, async (session) => {
      const orderId = toObjectId(orderIdValue);
      const order = await this.db.collection('sales_orders').findOne({ _id: orderId, ...salesOrderScope(request.user) }, { session });
      if (!order) throw new NotFoundException({ code: 'SALES_ORDER_NOT_FOUND', message: 'Không tìm thấy phiếu' });
      assertWarehouseAccess(request, (order.warehouseId as ObjectId).toHexString());
      if (order.version !== input.version) throw new ConflictException({ code: 'ORDER_STATE_CONFLICT', message: 'Phiếu đã được người khác cập nhật — tải lại rồi thử lại' });
      const status = String(order.status);
      const allowed = input.kind === 'EDIT' ? !['DRAFT', 'CANCELLED'].includes(status)
        : input.kind === 'VOID' ? SHIPPED.includes(status)
        : input.kind === 'CANCEL' ? (CANCELLABLE_SALES_STATUSES as readonly string[]).includes(status)
        : status === 'DRAFT';
      if (!allowed) {
        const hint = { EDIT: 'chỉ sửa phiếu đã phát hành, chưa hủy', VOID: 'chỉ hủy theo cách này với phiếu đã xuất / đã giao', CANCEL: 'chỉ hủy phiếu đã phát hành chưa xuất kho', DELETE: 'chỉ xóa phiếu nháp' }[input.kind];
        throw new ConflictException({ code: 'SALES_CHANGE_NOT_ALLOWED', message: `Không gửi được đề nghị ${KIND_LABEL[input.kind]}: ${hint}` });
      }
      const pending = await this.db.collection(COLLECTION).findOne({ orderId, status: 'PENDING' }, { session, projection: { code: 1 } });
      if (pending) throw new ConflictException({ code: 'SALES_CHANGE_PENDING_EXISTS', message: `Phiếu đang có đề nghị ${String(pending.code)} chờ duyệt — chờ kết quả hoặc rút đề nghị đó` });
      const changes = input.kind === 'EDIT' && input.changes ? { ...input.changes, version: order.version } : undefined;
      const preview = changes ? await this.sales.previewEdit(changes, session) : undefined;
      const now = new Date();
      const document = {
        _id: new ObjectId(),
        code: await this.sequences.next('YC', session),
        kind: input.kind,
        status: 'PENDING',
        orderId,
        orderCode: String(order.code),
        orderVersion: Number(order.version),
        customerName: orderParty(order) || null,
        reason: input.reason,
        ...(changes ? { changes, preview } : {}),
        requestedBy: toObjectId(request.user.sub),
        requestedByName: request.user.displayName,
        requestedAt: now,
        createdAt: now,
        updatedAt: now,
      };
      await this.db.collection(COLLECTION).insertOne(document, { session });
      const approvers = (await userIdsWithPermission(this.db, 'sales.change_approve', session)).filter((id) => id !== request.user.sub);
      if (approvers.length) {
        await this.outbox.enqueue({
          eventType: 'NOTIFICATION_REQUESTED',
          aggregateType: 'SalesChangeRequest',
          aggregateId: document._id.toHexString(),
          payload: {
            category: 'SALES_ISSUE',
            targetUserIds: approvers,
            level: 'WARNING',
            title: `${request.user.displayName} đề nghị ${KIND_LABEL[input.kind]} phiếu ${String(order.code)}`,
            message: input.reason,
            href: `/sales/orders/${orderIdValue}`,
            template: 'SALES_CHANGE_REQUESTED',
            params: { code: document.code, order: String(order.code), kind: input.kind, requester: request.user.displayName, reason: input.reason },
          },
        }, session);
      }
      await this.audit.record({
        actorId: request.user.sub, actorEmail: request.user.email, correlationId: request.correlationId,
        action: 'SALES_CHANGE_REQUESTED', entityType: 'SalesOrder', entityId: orderIdValue,
        metadata: { code: document.code, kind: input.kind, reason: input.reason },
      }, session);
      return this.present(document);
    });
  }

  /**
   * Đề nghị của phiếu đã hủy / đã xóa (gồm đề nghị hủy / xóa đã duyệt) chỉ quản trị gốc thấy (DOC-HIDE-01).
   * Trả bộ lọc thêm cho người xem, `null` khi không cần lọc.
   */
  private async hiddenFilter(request: AuthenticatedRequest): Promise<Document | null> {
    if (seesCancelled(request.user)) return null;
    const orderIds = (await this.db.collection(COLLECTION).distinct('orderId')) as ObjectId[];
    const live = new Set((await this.db.collection('sales_orders').distinct('_id', { _id: { $in: orderIds }, status: { $ne: 'CANCELLED' } })).map(String));
    const hidden = orderIds.filter((id) => !live.has(String(id)));
    return hidden.length ? { orderId: { $nin: hidden } } : null;
  }

  /** Người duyệt thấy mọi đề nghị; người khác thấy đề nghị của mình (hoặc của một phiếu cụ thể khi mở phiếu). */
  async list(filter: { status?: string | undefined; orderId?: string | undefined }, request: AuthenticatedRequest, paging: PageRequest | null) {
    const own: Document = {};
    if (filter.status) own.status = filter.status;
    if (filter.orderId) own.orderId = toObjectId(filter.orderId, 'orderId');
    else if (!can(request.user, 'sales.change_approve')) own.requestedBy = toObjectId(request.user.sub);
    const hidden = await this.hiddenFilter(request);
    const query: Document = hidden ? { $and: [own, hidden] } : own;
    const cursor = this.db.collection(COLLECTION).find(query).sort({ requestedAt: -1, _id: -1 });
    if (!paging) return (await cursor.limit(200).toArray()).map((row) => this.present(row));
    const [rows, total] = await Promise.all([cursor.skip(paging.skip).limit(paging.pageSize).toArray(), this.db.collection(COLLECTION).countDocuments(query)]);
    return pageOf(rows.map((row) => this.present(row)), total, paging);
  }

  async pendingCount(request: AuthenticatedRequest) {
    const own: Document = { status: 'PENDING', ...(can(request.user, 'sales.change_approve') ? {} : { requestedBy: toObjectId(request.user.sub) }) };
    const hidden = await this.hiddenFilter(request);
    return { pending: await this.db.collection(COLLECTION).countDocuments(hidden ? { $and: [own, hidden] } : own) };
  }

  /** Duyệt: thực hiện thao tác bằng tài khoản người duyệt; phiếu đã đổi / thao tác không hợp lệ → "Không thực hiện được". */
  async approve(id: string, note: string | undefined, request: AuthenticatedRequest, key: string | undefined) {
    try {
      return await this.idempotency.execute(`sales-change-approve:${id}`, key, { id, note }, async (session) => {
        const row = await this.db.collection(COLLECTION).findOne({ _id: toObjectId(id), status: 'PENDING' }, { session });
        if (!row) throw new ConflictException({ code: 'SALES_CHANGE_STATE', message: 'Đề nghị không còn chờ duyệt' });
        const orderId = row.orderId as ObjectId;
        const order = await this.db.collection('sales_orders').findOne({ _id: orderId }, { session });
        const now = new Date();
        const decided = { decidedBy: toObjectId(request.user.sub), decidedByName: request.user.displayName, decidedAt: now, updatedAt: now, ...(note ? { decisionNote: note } : {}) };
        if (!order || order.version !== row.orderVersion) {
          const error = !order ? 'Phiếu không còn trong hệ thống' : 'Phiếu đã thay đổi sau khi gửi đề nghị — mở phiếu và gửi lại đề nghị';
          const failed = await this.db.collection(COLLECTION).findOneAndUpdate({ _id: row._id, status: 'PENDING' }, { $set: { status: 'FAILED', error, ...decided } }, { session, returnDocument: 'after' });
          await this.notifyRequester(row, 'SALES_CHANGE_REJECTED', request, session, { note: error });
          return this.present(failed as Document);
        }
        const via: SalesChangeVia = { code: String(row.code), requestedBy: String(row.requestedBy), requestedByName: String(row.requestedByName) };
        const discard = { version: Number(order.version), reason: `${String(row.reason)} (đề nghị ${String(row.code)} của ${String(row.requestedByName)})` };
        const orderIdValue = orderId.toHexString();
        const kind = row.kind as SalesChangeKind;
        if (kind === 'EDIT') await this.sales.editIssuedInSession(orderIdValue, { ...(row.changes as Document), version: Number(order.version) } as never, request, session, via);
        else if (kind === 'VOID') await this.sales.voidInSession(orderIdValue, discard, request, session, via);
        else if (kind === 'CANCEL') await this.sales.cancelInSession(orderIdValue, discard, request, session, via);
        else await this.sales.removeInSession(orderIdValue, discard, request, session, via);
        const applied = await this.db.collection(COLLECTION).findOneAndUpdate({ _id: row._id, status: 'PENDING' }, { $set: { status: 'APPLIED', ...decided } }, { session, returnDocument: 'after' });
        await this.notifyRequester(row, 'SALES_CHANGE_APPROVED', request, session, { note: note ?? '' });
        await this.audit.record({
          actorId: request.user.sub, actorEmail: request.user.email, correlationId: request.correlationId,
          action: 'SALES_CHANGE_APPROVED', entityType: 'SalesOrder', entityId: orderIdValue,
          metadata: { code: String(row.code), kind, requestedBy: String(row.requestedByName), ...(note ? { note } : {}) },
        }, session);
        return this.present(applied as Document);
      });
    } catch (error) {
      // Thao tác không hợp lệ (VD tồn không đủ, đã thu nhiều hơn tổng mới) → không thực hiện, báo người đề nghị lý do.
      if (!(error instanceof HttpException) || error.getStatus() >= 500 || (error.getResponse() as { code?: string })?.code === 'SALES_CHANGE_STATE') throw error;
      const message = String((error.getResponse() as { message?: string })?.message ?? error.message);
      return this.idempotency.execute(`sales-change-fail:${id}`, undefined, { id }, async (session) => {
        const row = await this.db.collection(COLLECTION).findOne({ _id: toObjectId(id), status: 'PENDING' }, { session });
        if (!row) throw error;
        const now = new Date();
        const failed = await this.db.collection(COLLECTION).findOneAndUpdate(
          { _id: row._id, status: 'PENDING' },
          { $set: { status: 'FAILED', error: message, decidedBy: toObjectId(request.user.sub), decidedByName: request.user.displayName, decidedAt: now, updatedAt: now } },
          { session, returnDocument: 'after' },
        );
        await this.notifyRequester(row, 'SALES_CHANGE_REJECTED', request, session, { note: message });
        return this.present(failed as Document);
      });
    }
  }

  async reject(id: string, note: string, request: AuthenticatedRequest, key: string | undefined) {
    return this.idempotency.execute(`sales-change-reject:${id}`, key, { id, note }, async (session) => {
      const now = new Date();
      const row = await this.db.collection(COLLECTION).findOneAndUpdate(
        { _id: toObjectId(id), status: 'PENDING' },
        { $set: { status: 'REJECTED', decisionNote: note, decidedBy: toObjectId(request.user.sub), decidedByName: request.user.displayName, decidedAt: now, updatedAt: now } },
        { session, returnDocument: 'after' },
      );
      if (!row) throw new ConflictException({ code: 'SALES_CHANGE_STATE', message: 'Đề nghị không còn chờ duyệt' });
      await this.notifyRequester(row, 'SALES_CHANGE_REJECTED', request, session, { note });
      await this.audit.record({
        actorId: request.user.sub, actorEmail: request.user.email, correlationId: request.correlationId,
        action: 'SALES_CHANGE_REJECTED', entityType: 'SalesOrder', entityId: (row.orderId as ObjectId).toHexString(),
        metadata: { code: String(row.code), kind: String(row.kind), note },
      }, session);
      return this.present(row);
    });
  }

  /** Người gửi rút đề nghị đang chờ. */
  async withdraw(id: string, request: AuthenticatedRequest) {
    const row = await this.db.collection(COLLECTION).findOne({ _id: toObjectId(id) });
    if (!row) throw new NotFoundException({ code: 'SALES_CHANGE_NOT_FOUND', message: 'Không tìm thấy đề nghị' });
    if (String(row.requestedBy) !== request.user.sub) throw new ForbiddenException({ code: 'SALES_CHANGE_NOT_OWNER', message: 'Chỉ người gửi được rút đề nghị' });
    const now = new Date();
    const updated = await this.db.collection(COLLECTION).findOneAndUpdate(
      { _id: row._id, status: 'PENDING' },
      { $set: { status: 'WITHDRAWN', decidedAt: now, decidedByName: request.user.displayName, updatedAt: now } },
      { returnDocument: 'after' },
    );
    if (!updated) throw new ConflictException({ code: 'SALES_CHANGE_STATE', message: 'Đề nghị không còn chờ duyệt' });
    await this.audit.record({
      actorId: request.user.sub, actorEmail: request.user.email, correlationId: request.correlationId,
      action: 'SALES_CHANGE_WITHDRAWN', entityType: 'SalesOrder', entityId: (row.orderId as ObjectId).toHexString(), metadata: { code: String(row.code) },
    });
    return this.present(updated);
  }

  async get(id: string, request: AuthenticatedRequest) {
    const row = await this.db.collection(COLLECTION).findOne({ _id: toObjectId(id) });
    if (!row) throw new NotFoundException({ code: 'SALES_CHANGE_NOT_FOUND', message: 'Không tìm thấy đề nghị' });
    const order = await this.db.collection('sales_orders').findOne({ _id: row.orderId as ObjectId });
    // Phiếu đã hủy / đã xóa: đề nghị chỉ quản trị gốc mở được (DOC-HIDE-01).
    if (!seesCancelled(request.user) && (!order || order.status === 'CANCELLED')) throw new NotFoundException({ code: 'SALES_CHANGE_NOT_FOUND', message: 'Không tìm thấy đề nghị' });
    return { ...this.present(row), order: serializeDocument(order ?? {}) };
  }
}
