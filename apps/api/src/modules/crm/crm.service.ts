import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { canLogActivity, type PartnerActivityInput } from '@inoxpran/contracts';
import { ObjectId, type Db, type Document } from 'mongodb';
import { AuditService } from '../../common/audit.service';
import { serializeDocument, toObjectId } from '../../common/domain';
import { pageOf, type PageRequest } from '../../common/paging';
import type { AuthenticatedRequest } from '../../common/request-context';
import { MONGO_DATABASE } from '../../common/tokens';
import { vnToday } from './follow-up-review';

type ActivityPatch = { [Key in keyof PartnerActivityInput]?: PartnerActivityInput[Key] | undefined } & { done?: boolean | undefined };

/** Quản lý xem / sửa nhật ký của mọi người; nhân viên kinh doanh sửa / xóa nhật ký của chính mình. */
const CRM_SUPERVISORS = ['ADMIN', 'DIRECTOR', 'SALES_MANAGER'];

/** Nhật ký chăm sóc khách hàng (collection partner_activities) và danh sách hẹn chăm sóc lại. */
@Injectable()
export class CrmService {
  constructor(
    @Inject(MONGO_DATABASE) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  private async customer(id: string) {
    const partner = await this.db.collection('partners').findOne({ _id: toObjectId(id) }, { projection: { code: 1, name: 1, kind: 1 } });
    if (!partner) throw new NotFoundException({ code: 'PARTNER_NOT_FOUND', message: 'Không tìm thấy đối tác' });
    if (partner.kind === 'SUPPLIER') throw new BadRequestException({ code: 'PARTNER_NOT_CUSTOMER', message: 'Nhật ký chăm sóc chỉ dùng cho khách hàng' });
    return partner;
  }

  private present(row: Document) {
    const document = serializeDocument(row);
    return { ...document, partnerId: String(document.partnerId), ownerId: String(document.ownerId), done: Boolean(row.done) };
  }

  private async record(request: AuthenticatedRequest, action: string, partnerId: string, before?: Document | null, after?: Document | null) {
    await this.audit.record({
      actorId: request.user.sub,
      actorEmail: request.user.email,
      correlationId: request.correlationId,
      action,
      entityType: 'Partner',
      entityId: partnerId,
      metadata: { activityId: String((after ?? before)?._id ?? '') },
      ...(before ? { before: serializeDocument(before) } : {}),
      ...(after ? { after: serializeDocument(after) } : {}),
    });
  }

  async list(partnerId: string, paging: PageRequest) {
    const partner = await this.customer(partnerId);
    const filter = { partnerId: partner._id };
    const [rows, total] = await Promise.all([
      this.db.collection('partner_activities').find(filter).sort({ occurredAt: -1, _id: -1 }).skip(paging.skip).limit(paging.pageSize).toArray(),
      this.db.collection('partner_activities').countDocuments(filter),
    ]);
    return pageOf(rows.map((row) => this.present(row)), total, paging);
  }

  async create(partnerId: string, input: PartnerActivityInput, request: AuthenticatedRequest) {
    if (!canLogActivity(request.user.roles)) throw new ForbiddenException({ code: 'ROLE_FORBIDDEN', message: 'Nhật ký chăm sóc khách do đội kinh doanh ghi' });
    const partner = await this.customer(partnerId);
    const now = new Date();
    const document = {
      _id: new ObjectId(),
      partnerId: partner._id,
      partnerCode: partner.code,
      partnerName: partner.name,
      ...input,
      occurredAt: new Date(input.occurredAt),
      ownerId: toObjectId(request.user.sub),
      ownerName: request.user.displayName,
      done: false,
      createdAt: now,
      updatedAt: now,
    };
    await this.db.collection('partner_activities').insertOne(document);
    await this.record(request, 'PARTNER_ACTIVITY_CREATED', partnerId, null, document);
    return this.present(document);
  }

  private async own(partnerId: string, activityId: string, request: AuthenticatedRequest) {
    const before = await this.db.collection('partner_activities').findOne({ _id: toObjectId(activityId, 'activityId'), partnerId: toObjectId(partnerId) });
    if (!before) throw new NotFoundException({ code: 'ACTIVITY_NOT_FOUND', message: 'Không tìm thấy nhật ký chăm sóc' });
    const supervisor = request.user.roles.some((role) => CRM_SUPERVISORS.includes(role));
    if (!supervisor && !(before.ownerId as ObjectId).equals(toObjectId(request.user.sub))) {
      throw new ForbiddenException({ code: 'ACTIVITY_NOT_OWNER', message: 'Chỉ người ghi (hoặc quản lý kinh doanh) được sửa / xóa nhật ký này' });
    }
    return before;
  }

  async update(partnerId: string, activityId: string, input: ActivityPatch, request: AuthenticatedRequest) {
    const before = await this.own(partnerId, activityId, request);
    const set: Document = { ...input, updatedAt: new Date() };
    if (input.occurredAt) set.occurredAt = new Date(input.occurredAt);
    if (input.done === true && !before.done) Object.assign(set, { doneAt: new Date(), doneBy: toObjectId(request.user.sub) });
    const unset = input.done === false ? { doneAt: '', doneBy: '' } : {};
    const after = await this.db.collection('partner_activities').findOneAndUpdate(
      { _id: before._id },
      { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}) },
      { returnDocument: 'after' },
    );
    await this.record(request, input.done === true && !before.done ? 'PARTNER_FOLLOW_UP_DONE' : 'PARTNER_ACTIVITY_UPDATED', partnerId, before, after);
    return this.present(after ?? before);
  }

  async remove(partnerId: string, activityId: string, request: AuthenticatedRequest) {
    const before = await this.own(partnerId, activityId, request);
    await this.db.collection('partner_activities').deleteOne({ _id: before._id });
    await this.record(request, 'PARTNER_ACTIVITY_DELETED', partnerId, before, null);
    return { id: activityId, deleted: true };
  }

  /**
   * Lịch hẹn chăm sóc chưa xong: due=overdue (quá hẹn), today, week (7 ngày tới), all.
   * Nhân viên kinh doanh thấy lịch của mình; quản lý / Giám đốc thấy tất cả (mine=1 để lọc của mình).
   */
  async followUps(due: string | undefined, mine: boolean, request: AuthenticatedRequest, paging: PageRequest) {
    const today = vnToday();
    const weekEnd = vnToday(new Date(Date.now() + 7 * 86_400_000));
    const range: Document = due === 'overdue' ? { $lt: today } : due === 'today' ? { $eq: today } : due === 'week' ? { $lte: weekEnd } : { $exists: true };
    const supervisor = request.user.roles.some((role) => CRM_SUPERVISORS.includes(role));
    const filter: Document = { done: false, followUpOn: range, ...(!supervisor || mine ? { ownerId: toObjectId(request.user.sub) } : {}) };
    const [rows, total, overdue, todayCount] = await Promise.all([
      this.db.collection('partner_activities').find(filter).sort({ followUpOn: 1, _id: 1 }).skip(paging.skip).limit(paging.pageSize).toArray(),
      this.db.collection('partner_activities').countDocuments(filter),
      this.db.collection('partner_activities').countDocuments({ ...filter, followUpOn: { $lt: today } }),
      this.db.collection('partner_activities').countDocuments({ ...filter, followUpOn: today }),
    ]);
    return pageOf(rows.map((row) => this.present(row)), total, paging, { today, counts: { overdue, today: todayCount } });
  }
}
