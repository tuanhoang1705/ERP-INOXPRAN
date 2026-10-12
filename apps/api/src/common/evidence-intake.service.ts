import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  PayloadTooLargeException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { MAX_EVIDENCE_BYTES, type AttachmentMeta } from '@inoxpran/contracts';
import { createHash } from 'node:crypto';
import { Binary, type Db, type Document, ObjectId } from 'mongodb';
import { AuditService } from './audit.service';
import { toObjectId } from './domain';
import { detectFileType, safeFileName } from './image-signature';
import { MalwareScanUnavailableError } from './malware-scanner';
import { MalwareScannerService } from './malware-scanner.service';
import { attachmentObjectKey } from './object-storage';
import { ObjectStorageService } from './object-storage.service';
import { OutboxService } from './outbox.service';
import type { AuthenticatedRequest } from './request-context';
import { MONGO_DATABASE } from './tokens';

/**
 * Chứng từ nhận file: phiếu bán (ảnh đối chiếu Zalo), phiếu bảo hành (ảnh khi nhận, phiếu đã ký),
 * tab "Đính kèm" của cửa sổ chứng từ (ảnh sản phẩm, tài liệu đối tác, chứng từ mua hàng — có PDF).
 */
export interface EvidenceTarget {
  entityType: 'SalesOrder' | 'WarrantyTicket' | 'Product' | 'Partner' | 'PurchaseOrder' | 'ImportShipment';
  /** Nhận thêm PDF (mặc định chỉ ảnh). */
  allowPdf?: boolean;
  entityId: ObjectId;
  /** Số phiếu hiển thị trong thông báo / metadata S3. */
  code: string;
  purpose: string;
  /** Thư mục trên S3, VD sales-evidence, warranty-photos, product-files (phải có trong IAM / GuardDuty). */
  keyPrefix: string;
  /** Tiền tố hành động nhật ký, VD SALES_ORDER_EVIDENCE → *_UPLOADED, *_MALWARE_BLOCKED. */
  auditPrefix: string;
  href: string;
  fallbackName: string;
  /** Giới hạn số ảnh cùng mục đích trên một phiếu (đếm cả ảnh chờ và đã gắn nếu `countAll`). */
  limit: number;
  countAll?: boolean;
  status: 'PENDING' | 'LINKED';
  expiresAt?: Date;
  /** Trường bổ sung lưu trên bản ghi (VD loại ảnh bảo hành). */
  extra?: Document;
}

/**
 * Nhận một ảnh tải lên cho chứng từ, theo đúng chuỗi kiểm tra đã dùng cho ảnh đối chiếu phiếu bán:
 * 1) quét mã độc trên dữ liệu gốc (ClamAV; không quét được thì không nhận — fail closed),
 * 2) chỉ nhận ảnh thật theo chữ ký file (PNG / JPEG / WebP, tối đa 8 MB),
 * 3) lưu S3 (mã hóa, chặn công khai), ghi bản ghi `attachments` và nhật ký.
 * Trình duyệt không đọc S3 trực tiếp: API đọc rồi trả sau khi kiểm tra quyền xem chứng từ.
 */
@Injectable()
export class EvidenceIntakeService {
  constructor(
    @Inject(MONGO_DATABASE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly scanner: MalwareScannerService,
    private readonly storage: ObjectStorageService,
  ) {}

  async accept(body: unknown, fileNameHeader: string | undefined, target: EvidenceTarget, request: AuthenticatedRequest): Promise<Document> {
    if (!Buffer.isBuffer(body) || body.length === 0) {
      throw new BadRequestException({ code: 'EVIDENCE_EMPTY', message: 'Không nhận được dữ liệu ảnh' });
    }
    if (body.length > MAX_EVIDENCE_BYTES) {
      throw new PayloadTooLargeException({ code: 'EVIDENCE_TOO_LARGE', message: target.allowPdf ? 'File vượt quá 8 MB' : 'Ảnh vượt quá 8 MB' });
    }
    const fileName = safeFileName(fileNameHeader, target.fallbackName);
    const sha256 = createHash('sha256').update(body).digest('hex');
    const entityId = target.entityId.toHexString();
    let verdict: Awaited<ReturnType<MalwareScannerService['scan']>>;
    try {
      verdict = await this.scanner.scan(body);
    } catch (error) {
      if (error instanceof MalwareScanUnavailableError) {
        throw new ServiceUnavailableException({
          code: 'MALWARE_SCAN_UNAVAILABLE',
          message: 'Dịch vụ quét mã độc tạm thời chưa sẵn sàng nên chưa nhận file — vui lòng thử lại sau ít phút',
        });
      }
      throw error;
    }
    if (verdict.status === 'INFECTED') {
      await this.audit.record({
        actorId: request.user.sub,
        actorEmail: request.user.email,
        correlationId: request.correlationId,
        action: `${target.auditPrefix}_MALWARE_BLOCKED`,
        entityType: target.entityType,
        entityId,
        metadata: { fileName, size: body.length, sha256, signature: verdict.signature, engine: verdict.engine },
      });
      await this.outbox.enqueue({
        eventType: 'NOTIFICATION_REQUESTED',
        aggregateType: target.entityType,
        aggregateId: entityId,
        payload: {
          category: 'SECURITY',
          targetRoles: ['ADMIN', 'DIRECTOR'],
          level: 'CRITICAL',
          title: `Đã chặn file chứa mã độc trên phiếu ${target.code}`,
          message: `${request.user.displayName} tải lên "${fileName}" — ClamAV phát hiện ${verdict.signature}. File không được lưu.`,
          href: target.href,
          template: 'EVIDENCE_MALWARE_BLOCKED',
          params: { code: target.code, actor: request.user.displayName, fileName, signature: verdict.signature },
        },
      });
      throw new UnprocessableEntityException({
        code: 'EVIDENCE_MALWARE',
        message: `File bị chặn vì phát hiện mã độc (${verdict.signature}). Hệ thống đã ghi nhận và báo quản trị.`,
      });
    }
    const contentType = detectFileType(body, target.allowPdf);
    if (!contentType) {
      throw new BadRequestException(target.allowPdf
        ? { code: 'EVIDENCE_NOT_DOCUMENT', message: 'Chỉ nhận ảnh PNG, JPEG, WebP hoặc file PDF' }
        : { code: 'EVIDENCE_NOT_IMAGE', message: 'Chỉ nhận ảnh dạng PNG, JPEG hoặc WebP (ảnh chụp màn hình hoặc ảnh chụp bằng điện thoại)' });
    }
    const counted = await this.db.collection('attachments').countDocuments({
      entityId: target.entityId,
      purpose: target.purpose,
      status: target.countAll ? { $in: ['PENDING', 'LINKED'] } : 'PENDING',
    });
    if (counted >= target.limit) {
      throw new ConflictException({ code: 'EVIDENCE_LIMIT', message: `Phiếu đã có ${counted} ảnh — tối đa ${target.limit}, hãy xóa bớt` });
    }
    if (!this.storage.configured) {
      throw new ServiceUnavailableException({ code: 'STORAGE_NOT_CONFIGURED', message: 'Chưa cấu hình kho lưu trữ S3 cho ảnh chứng từ' });
    }
    const now = new Date();
    const extension = contentType === 'image/jpeg' ? 'jpg' : contentType === 'application/pdf' ? 'pdf' : contentType.slice('image/'.length);
    const attachmentId = new ObjectId();
    const key = attachmentObjectKey(target.keyPrefix, entityId, attachmentId.toHexString(), contentType);
    try {
      await this.storage.put(key, body, contentType, { sha256, 'entity-code': target.code, 'uploaded-by': request.user.sub });
    } catch (error) {
      throw new ServiceUnavailableException({
        code: 'STORAGE_UNAVAILABLE',
        message: 'Không lưu được ảnh lên kho lưu trữ S3, vui lòng thử lại',
        details: error instanceof Error ? error.name : undefined,
      });
    }
    const document: Document = {
      _id: attachmentId,
      entityType: target.entityType,
      entityId: target.entityId,
      purpose: target.purpose,
      ...(target.extra ?? {}),
      fileName: /\.[a-z0-9]{2,5}$/i.test(fileName) ? fileName : `${fileName}.${extension}`,
      contentType,
      size: body.length,
      sha256,
      storage: { provider: 's3', bucket: this.storage.bucket, key },
      scan: verdict.status === 'CLEAN'
        ? { result: 'CLEAN', engine: verdict.engine, scannedAt: now }
        : { result: 'SKIPPED', engine: 'none', scannedAt: now, reason: 'MALWARE_SCAN_MODE=off' },
      status: target.status,
      uploadedBy: toObjectId(request.user.sub),
      uploadedByName: request.user.displayName,
      uploadedAt: now,
      ...(target.status === 'LINKED' ? { linkedAt: now } : {}),
      ...(target.expiresAt ? { expiresAt: target.expiresAt } : {}),
    };
    try {
      await this.db.collection('attachments').insertOne(document);
    } catch (error) {
      await this.storage.delete(key).catch(() => undefined);
      throw error;
    }
    await this.audit.record({
      actorId: request.user.sub,
      actorEmail: request.user.email,
      correlationId: request.correlationId,
      action: `${target.auditPrefix}_UPLOADED`,
      entityType: target.entityType,
      entityId,
      metadata: { attachmentId: attachmentId.toHexString(), fileName: document.fileName, size: document.size, sha256, storageKey: key, scan: document.scan, ...(target.extra ?? {}) },
    });
    return document;
  }

  /** Đọc dữ liệu ảnh (S3; bản cũ lưu trong Mongo). Người gọi đã kiểm tra quyền xem chứng từ. */
  async read(attachment: Document): Promise<{ contentType: string; fileName: string; data: Buffer }> {
    const storage = attachment.storage as { key: string } | undefined;
    let data: Buffer;
    if (storage) {
      data = await this.storage.get(storage.key).catch((error: unknown) => {
        // Bucket policy chặn đọc file bị GuardDuty gắn THREATS_FOUND (lớp quét thứ hai trên S3).
        if (error instanceof Error && error.name === 'AccessDenied') {
          throw new ForbiddenException({ code: 'EVIDENCE_BLOCKED', message: 'Ảnh đang bị chặn truy cập (lớp quét AWS GuardDuty có thể đã phát hiện mã độc) — liên hệ quản trị hệ thống' });
        }
        throw new ServiceUnavailableException({ code: 'STORAGE_UNAVAILABLE', message: 'Không đọc được ảnh từ kho lưu trữ S3' });
      });
    } else {
      const legacy = attachment.data as Binary;
      data = Buffer.from(legacy.read(0, legacy.length()));
    }
    return { contentType: String(attachment.contentType), fileName: String(attachment.fileName), data };
  }

  /** Xóa file trên S3 (khi xóa bản ghi ảnh chưa dùng). Bucket chỉ cho xóa trong thư mục được phép (IAM). */
  async removeStored(attachment: Document): Promise<void> {
    const key = (attachment.storage as { key?: string } | undefined)?.key;
    if (!key) return;
    await this.storage.delete(key).catch((error: unknown) => {
      throw new ServiceUnavailableException({
        code: 'STORAGE_UNAVAILABLE',
        message: 'Không xóa được ảnh trên kho lưu trữ S3 — liên hệ quản trị hệ thống',
        details: error instanceof Error ? error.name : undefined,
      });
    });
  }

  /** Xóa mọi file đính kèm của một hồ sơ (khi xóa hồ sơ chưa phát sinh chứng từ). */
  async removeAllFor(entityType: EvidenceTarget['entityType'], entityId: ObjectId): Promise<number> {
    const rows = await this.db.collection('attachments').find({ entityType, entityId }, { projection: { storage: 1 } }).toArray();
    for (const row of rows) await this.removeStored(row);
    if (rows.length) await this.db.collection('attachments').deleteMany({ entityType, entityId });
    return rows.length;
  }

  meta(row: Document): AttachmentMeta {
    return {
      id: (row._id as ObjectId).toHexString(),
      fileName: String(row.fileName),
      contentType: String(row.contentType),
      size: Number(row.size),
      sha256: String(row.sha256),
      uploadedAt: (row.uploadedAt as Date).toISOString(),
      uploadedByName: String(row.uploadedByName),
      ...(row.scan
        ? { scan: { result: String(row.scan.result) as 'CLEAN' | 'SKIPPED', engine: String(row.scan.engine), scannedAt: (row.scan.scannedAt as Date).toISOString() } }
        : {}),
    };
  }
}
