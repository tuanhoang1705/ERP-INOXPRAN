import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { AttachmentMeta } from '@inoxpran/contracts';
import type { Db, Document, ObjectId } from 'mongodb';
import { AuditService } from '../../common/audit.service';
import { toObjectId } from '../../common/domain';
import { seesCancelled } from '../../common/hidden-documents';
import { EvidenceIntakeService } from '../../common/evidence-intake.service';
import type { AuthenticatedRequest } from '../../common/request-context';
import { MONGO_DATABASE } from '../../common/tokens';
import { ATTACHMENT_POLICIES, type AttachmentPolicy } from './attachment-policy';

export type AttachmentRow = AttachmentMeta & { purpose: string; uploadedById: string };

/** Tab "Đính kèm" của cửa sổ chứng từ: ảnh / PDF quét mã độc rồi lưu S3 (EvidenceIntakeService), đọc qua API sau khi kiểm tra quyền. */
@Injectable()
export class AttachmentsService {
  constructor(
    @Inject(MONGO_DATABASE) private readonly db: Db,
    private readonly evidence: EvidenceIntakeService,
    private readonly audit: AuditService,
  ) {}

  private policy(type: string): AttachmentPolicy {
    const policy = ATTACHMENT_POLICIES[type];
    if (!policy) throw new NotFoundException({ code: 'ATTACHMENT_TYPE_UNKNOWN', message: 'Loại hồ sơ không có đính kèm' });
    return policy;
  }

  private async entity(policy: AttachmentPolicy, id: string): Promise<Document> {
    const entity = await this.db.collection(policy.collection).findOne({ _id: toObjectId(id) }, { projection: { [policy.codeField]: 1, kind: 1, primaryImageId: 1, status: 1 } });
    if (!entity) throw new NotFoundException({ code: 'ENTITY_NOT_FOUND', message: 'Không tìm thấy hồ sơ' });
    return entity;
  }

  private assertView(policy: AttachmentPolicy, entity: Document, request: AuthenticatedRequest) {
    // Đơn mua / lô nhập đã hủy chỉ quản trị gốc mở được (DOC-HIDE-01).
    if (entity.status === 'CANCELLED' && !seesCancelled(request.user)) throw new NotFoundException({ code: 'ENTITY_NOT_FOUND', message: 'Không tìm thấy hồ sơ' });
    if (!policy.canView(request.user.roles, entity)) throw new ForbiddenException({ code: 'ROLE_FORBIDDEN', message: 'Bạn không có quyền xem file của hồ sơ này' });
  }

  private assertEdit(policy: AttachmentPolicy, entity: Document, request: AuthenticatedRequest) {
    if (entity.status === 'CANCELLED' && !seesCancelled(request.user)) throw new NotFoundException({ code: 'ENTITY_NOT_FOUND', message: 'Không tìm thấy hồ sơ' });
    if (!policy.canEdit(request.user.roles, entity)) throw new ForbiddenException({ code: 'ROLE_FORBIDDEN', message: 'Bạn không có quyền đính kèm / xóa file của hồ sơ này' });
  }

  private row(document: Document): AttachmentRow {
    return { ...this.evidence.meta(document), purpose: String(document.purpose), uploadedById: (document.uploadedBy as ObjectId).toHexString() };
  }

  async list(type: string, id: string, request: AuthenticatedRequest) {
    const policy = this.policy(type);
    const entity = await this.entity(policy, id);
    this.assertView(policy, entity, request);
    const rows = await this.db.collection('attachments')
      .find({ entityType: policy.entityType, entityId: entity._id, status: 'LINKED' }, { projection: { data: 0 } })
      .sort({ uploadedAt: 1 })
      .toArray();
    return { rows: rows.map((row) => this.row(row)), canEdit: policy.canEdit(request.user.roles, entity), purposes: policy.purposes };
  }

  async upload(type: string, id: string, purposeInput: string | undefined, body: unknown, fileName: string | undefined, request: AuthenticatedRequest) {
    const policy = this.policy(type);
    const purpose = purposeInput || policy.defaultPurpose;
    const rule = policy.purposes[purpose];
    if (!rule) throw new BadRequestException({ code: 'ATTACHMENT_PURPOSE_INVALID', message: 'Loại file đính kèm không hợp lệ' });
    const entity = await this.entity(policy, id);
    this.assertEdit(policy, entity, request);
    const code = String(entity[policy.codeField]);
    const document = await this.evidence.accept(body, fileName, {
      entityType: policy.entityType,
      entityId: entity._id as ObjectId,
      code,
      purpose,
      keyPrefix: policy.keyPrefix,
      auditPrefix: policy.auditPrefix,
      href: policy.href(id, entity),
      fallbackName: `${code}-${purpose.toLowerCase()}`,
      limit: rule.limit,
      countAll: true,
      status: 'LINKED',
      allowPdf: rule.allowPdf,
    }, request);
    // Ảnh sản phẩm đầu tiên thành ảnh đại diện.
    if (policy.entityType === 'Product' && purpose === 'PRODUCT_IMAGE' && !entity.primaryImageId) {
      await this.db.collection('products').updateOne({ _id: entity._id, primaryImageId: { $exists: false } }, { $set: { primaryImageId: document._id } });
    }
    return this.row(document);
  }

  async read(type: string, id: string, attachmentId: string, request: AuthenticatedRequest) {
    const policy = this.policy(type);
    const entity = await this.entity(policy, id);
    this.assertView(policy, entity, request);
    const attachment = await this.db.collection('attachments').findOne({ _id: toObjectId(attachmentId, 'attachmentId'), entityType: policy.entityType, entityId: entity._id });
    if (!attachment) throw new NotFoundException({ code: 'ATTACHMENT_NOT_FOUND', message: 'Không tìm thấy file' });
    return this.evidence.read(attachment);
  }

  async remove(type: string, id: string, attachmentId: string, request: AuthenticatedRequest) {
    const policy = this.policy(type);
    const entity = await this.entity(policy, id);
    this.assertEdit(policy, entity, request);
    const attachment = await this.db.collection('attachments').findOne(
      { _id: toObjectId(attachmentId, 'attachmentId'), entityType: policy.entityType, entityId: entity._id },
      { projection: { storage: 1, fileName: 1, purpose: 1 } },
    );
    if (!attachment) throw new NotFoundException({ code: 'ATTACHMENT_NOT_FOUND', message: 'Không tìm thấy file' });
    await this.evidence.removeStored(attachment);
    await this.db.collection('attachments').deleteOne({ _id: attachment._id });
    if (policy.entityType === 'Product' && (entity.primaryImageId as ObjectId | undefined)?.equals(attachment._id as ObjectId)) {
      const next = await this.db.collection('attachments').findOne({ entityType: 'Product', entityId: entity._id, purpose: 'PRODUCT_IMAGE', status: 'LINKED' }, { sort: { uploadedAt: 1 }, projection: { _id: 1 } });
      await this.db.collection('products').updateOne({ _id: entity._id }, next ? { $set: { primaryImageId: next._id } } : { $unset: { primaryImageId: '' } });
    }
    await this.audit.record({
      actorId: request.user.sub,
      actorEmail: request.user.email,
      correlationId: request.correlationId,
      action: `${policy.auditPrefix}_DELETED`,
      entityType: policy.entityType,
      entityId: id,
      metadata: { attachmentId, fileName: attachment.fileName, purpose: attachment.purpose },
    });
    return { id: attachmentId, deleted: true };
  }
}
