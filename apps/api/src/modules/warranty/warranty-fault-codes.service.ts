import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { WarrantyFaultCode, WarrantyFaultCodeInput } from '@inoxpran/contracts';
import { type Db, type Document, ObjectId } from 'mongodb';
import { AuditService } from '../../common/audit.service';
import { serializeDocument, toObjectId } from '../../common/domain';
import type { AuthenticatedRequest } from '../../common/request-context';
import { MONGO_DATABASE } from '../../common/tokens';
import { WARRANTY_TICKETS } from './warranty-sla';

export const FAULT_CODES = 'warranty_fault_codes';

/**
 * Danh mục mã lỗi bảo hành theo nhóm hàng (VD CHAO-01 bong lớp chống dính, QUAT-02 động cơ không quay).
 * Kỹ thuật chọn mã lỗi khi chẩn đoán để báo cáo "lỗi theo mã hàng / mã lỗi" thống kê được.
 * Mã đã dùng trên phiếu không xóa được (chỉ ngừng) để báo cáo cũ giữ nguyên.
 */
@Injectable()
export class WarrantyFaultCodesService {
  constructor(
    @Inject(MONGO_DATABASE) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  async list(categoryId?: string, includeInactive = false): Promise<WarrantyFaultCode[]> {
    const filter: Document = includeInactive ? {} : { active: true };
    if (categoryId) {
      // Mã của nhóm này + mã dùng chung (không gắn nhóm).
      filter.$or = [{ categoryIds: toObjectId(categoryId, 'categoryId') }, { categoryIds: { $size: 0 } }];
    }
    const [codes, categories, usage] = await Promise.all([
      this.db.collection(FAULT_CODES).find(filter).sort({ code: 1 }).toArray(),
      this.db.collection('product_categories').find({}, { projection: { name: 1 } }).toArray(),
      this.db.collection(WARRANTY_TICKETS).aggregate([
        { $unwind: '$lines' },
        { $match: { 'lines.faultCode': { $type: 'string' } } },
        { $group: { _id: '$lines.faultCode', count: { $sum: 1 } } },
      ]).toArray(),
    ]);
    const categoryName = new Map(categories.map((row) => [(row._id as ObjectId).toHexString(), String(row.name)]));
    const usageByCode = new Map(usage.map((row) => [String(row._id), Number(row.count)]));
    return codes.map((row) => {
      const ids = ((row.categoryIds as ObjectId[] | undefined) ?? []).map((id) => id.toHexString());
      return {
        id: (row._id as ObjectId).toHexString(),
        code: String(row.code),
        name: String(row.name),
        categoryIds: ids,
        categoryNames: ids.map((id) => categoryName.get(id) ?? '—'),
        active: row.active !== false,
        usageCount: usageByCode.get(String(row.code)) ?? 0,
      };
    });
  }

  /** Tên mã lỗi cho báo cáo (cả mã đã ngừng). */
  async names(): Promise<Map<string, string>> {
    const rows = await this.db.collection(FAULT_CODES).find({}, { projection: { code: 1, name: 1 } }).toArray();
    return new Map(rows.map((row) => [String(row.code), String(row.name)]));
  }

  /** Kiểm tra mã lỗi trên các dòng chẩn đoán: phải có trong danh mục và đang dùng. */
  async assertKnown(codes: string[]): Promise<void> {
    const unique = [...new Set(codes.filter(Boolean))];
    if (!unique.length) return;
    const found = await this.db.collection(FAULT_CODES).find({ code: { $in: unique }, active: true }, { projection: { code: 1 } }).toArray();
    const known = new Set(found.map((row) => String(row.code)));
    const missing = unique.filter((code) => !known.has(code));
    if (missing.length) {
      throw new BadRequestException({ code: 'FAULT_CODE_UNKNOWN', message: `Mã lỗi ${missing.join(', ')} chưa có trong danh mục mã lỗi (hoặc đã ngừng)` });
    }
  }

  private async categoryIds(ids: string[]): Promise<ObjectId[]> {
    const objectIds = [...new Set(ids)].map((id) => toObjectId(id, 'categoryIds'));
    if (objectIds.length && (await this.db.collection('product_categories').countDocuments({ _id: { $in: objectIds } })) !== objectIds.length) {
      throw new BadRequestException({ code: 'CATEGORY_NOT_FOUND', message: 'Có nhóm hàng không tồn tại' });
    }
    return objectIds;
  }

  async create(input: WarrantyFaultCodeInput, request: AuthenticatedRequest) {
    const now = new Date();
    const document = { _id: new ObjectId(), code: input.code, name: input.name, categoryIds: await this.categoryIds(input.categoryIds), active: input.active, createdAt: now, updatedAt: now };
    try {
      await this.db.collection(FAULT_CODES).insertOne(document);
    } catch (error) {
      if ((error as { code?: number }).code === 11000) throw new ConflictException({ code: 'FAULT_CODE_EXISTS', message: `Mã lỗi ${input.code} đã tồn tại` });
      throw error;
    }
    await this.record(request, 'WARRANTY_FAULT_CODE_CREATED', document._id.toHexString(), null, document);
    return serializeDocument(document);
  }

  /** Mã lỗi không đổi sau khi tạo (phiếu cũ lưu theo mã); sửa tên, nhóm hàng, trạng thái. */
  async update(id: string, input: { name?: string | undefined; categoryIds?: string[] | undefined; active?: boolean | undefined }, request: AuthenticatedRequest) {
    const before = await this.db.collection(FAULT_CODES).findOne({ _id: toObjectId(id) });
    if (!before) throw new NotFoundException({ code: 'FAULT_CODE_NOT_FOUND', message: 'Không tìm thấy mã lỗi' });
    const set: Document = { updatedAt: new Date() };
    if (input.name !== undefined) set.name = input.name;
    if (input.active !== undefined) set.active = input.active;
    if (input.categoryIds !== undefined) set.categoryIds = await this.categoryIds(input.categoryIds);
    const after = await this.db.collection(FAULT_CODES).findOneAndUpdate({ _id: before._id }, { $set: set }, { returnDocument: 'after' });
    await this.record(request, 'WARRANTY_FAULT_CODE_UPDATED', id, before, after);
    return serializeDocument(after as Document);
  }

  async remove(id: string, request: AuthenticatedRequest) {
    const before = await this.db.collection(FAULT_CODES).findOne({ _id: toObjectId(id) });
    if (!before) throw new NotFoundException({ code: 'FAULT_CODE_NOT_FOUND', message: 'Không tìm thấy mã lỗi' });
    if (await this.db.collection(WARRANTY_TICKETS).findOne({ 'lines.faultCode': before.code }, { projection: { _id: 1 } })) {
      throw new ConflictException({ code: 'FAULT_CODE_IN_USE', message: `Mã lỗi ${String(before.code)} đã dùng trên phiếu bảo hành nên không xóa được; hãy chuyển Ngừng để giữ báo cáo.` });
    }
    await this.db.collection(FAULT_CODES).deleteOne({ _id: before._id });
    await this.record(request, 'WARRANTY_FAULT_CODE_DELETED', id, before, null);
  }

  private async record(request: AuthenticatedRequest, action: string, entityId: string, before: Document | null, after: Document | null) {
    await this.audit.record({
      actorId: request.user.sub,
      actorEmail: request.user.email,
      correlationId: request.correlationId,
      action,
      entityType: 'WarrantyFaultCode',
      entityId,
      ...(before ? { before: serializeDocument(before) } : {}),
      ...(after ? { after: serializeDocument(after) } : {}),
    });
  }
}
