import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { PricingPolicyInput, PromotionInput, UpdatePromotion } from '@inoxpran/contracts';
import type { Db, Document } from 'mongodb';
import { ObjectId } from 'mongodb';
import { AuditService } from '../../common/audit.service';
import { decimal, decimalString, serializeDocument, toObjectId } from '../../common/domain';
import type { AuthenticatedRequest } from '../../common/request-context';
import { MONGO_DATABASE } from '../../common/tokens';

type Settings = { _id: string } & Document;

const isDuplicate = (error: unknown) => (error as { code?: number }).code === 11000;
/** Bản ghi tạo trước khi có khóa phiên bản (seed) coi như version 0. */
const versionFilter = (version: number) => (version === 0 ? { $or: [{ version: 0 }, { version: { $exists: false } }] } : { version });
/** Ngày hiệu lực theo giờ Việt Nam: từ 00:00 ngày bắt đầu đến hết 23:59:59.999 ngày kết thúc. */
const vnStart = (day: string) => new Date(`${day}T00:00:00.000+07:00`);
const vnEnd = (day: string) => new Date(`${day}T23:59:59.999+07:00`);

/**
 * Cấu hình giá do Giám đốc / kế toán sửa: bậc doanh số, trần chiết khấu, CK theo cấp khách, chương trình khuyến mãi.
 * Phiếu bán chỉ tính giá khi lập / sửa (sales.service → pricing.priceLines) và lưu mức đã tính trên từng dòng,
 * nên thay đổi ở đây chỉ áp dụng cho phiếu lập (hoặc sửa) sau khi lưu; phiếu đã phát hành giữ nguyên.
 */
@Injectable()
export class PricingConfigService {
  constructor(
    @Inject(MONGO_DATABASE) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  private async record(request: AuthenticatedRequest, action: string, entityType: string, entityId: string, before?: Document | null, after?: Document | null) {
    await this.audit.record({
      actorId: request.user.sub,
      actorEmail: request.user.email,
      correlationId: request.correlationId,
      action,
      entityType,
      entityId,
      ...(before ? { before: serializeDocument(before) } : {}),
      ...(after ? { after: serializeDocument(after) } : {}),
    });
  }

  async updatePolicy(input: PricingPolicyInput, request: AuthenticatedRequest) {
    const settings = this.db.collection<Settings>('settings');
    const before = await settings.findOne({ _id: 'pricing' });
    const after = await settings
      .findOneAndUpdate(
        { _id: 'pricing', ...versionFilter(input.version) },
        {
          $set: {
            discountCapRate: input.discountCapRate,
            salesTierPeriod: input.salesTierPeriod,
            salesTiers: input.salesTiers.map((tier) => ({ minimumRevenue: tier.minimumRevenue, discountRate: tier.discountRate })),
            customerTierDiscounts: input.customerTierDiscounts,
            updatedAt: new Date(),
            updatedBy: request.user.email,
          },
          $inc: { version: 1 },
        },
        // Chưa có cấu hình (CSDL mới) thì tạo; đã có mà khác phiên bản → trùng _id → báo tải lại.
        { returnDocument: 'after', upsert: !before },
      )
      .catch((error: unknown) => {
        if (isDuplicate(error)) return null;
        throw error;
      });
    if (!after) throw new ConflictException({ code: 'VERSION_CONFLICT', message: 'Cấu hình giá đã được người khác cập nhật, hãy tải lại rồi sửa' });
    await this.record(request, 'PRICING_POLICY_UPDATED', 'PricingPolicy', 'pricing', before, after);
    return { version: Number(after.version ?? 1) };
  }

  /** Nhóm hàng và mã hàng phải có thật; trả về ObjectId để bộ tính giá so khớp. */
  private async scope(input: { categoryIds: string[]; productSkus: string[] }) {
    const categoryIds = [...new Set(input.categoryIds)].map((id) => toObjectId(id, 'categoryIds'));
    const skus = [...new Set(input.productSkus)];
    const [categories, products] = await Promise.all([
      categoryIds.length ? this.db.collection('product_categories').find({ _id: { $in: categoryIds } }, { projection: { _id: 1 } }).toArray() : [],
      skus.length ? this.db.collection('products').find({ sku: { $in: skus } }, { projection: { _id: 1, sku: 1 } }).toArray() : [],
    ]);
    if (categories.length !== categoryIds.length) {
      throw new BadRequestException({ code: 'CATEGORY_NOT_FOUND', message: 'Có nhóm hàng không tồn tại', details: [{ path: ['categoryIds'] }] });
    }
    const found = new Set(products.map((row) => String(row.sku)));
    const missing = skus.filter((sku) => !found.has(sku));
    if (missing.length) {
      throw new BadRequestException({ code: 'PRODUCT_NOT_FOUND', message: `Không có mã hàng ${missing.join(', ')}`, details: [{ path: ['productSkus'] }] });
    }
    return { categoryIds, productIds: products.map((row) => row._id as ObjectId), productSkus: skus };
  }

  /** CTKM không được giảm quá trần chiết khấu hiện hành (trần vẫn áp cho tổng CK của dòng). */
  private async assertBelowCap(discountRate: string) {
    const pricing = await this.db.collection<Settings>('settings').findOne({ _id: 'pricing' });
    const cap = String(pricing?.discountCapRate ?? '15');
    if (Number(discountRate) > Number(cap)) {
      throw new BadRequestException({ code: 'PROMOTION_ABOVE_CAP', message: `Mức giảm vượt trần chiết khấu ${cap}%`, details: [{ path: ['discountRate'] }] });
    }
  }

  private fields(input: Omit<PromotionInput, 'code'>, scope: Awaited<ReturnType<PricingConfigService['scope']>>) {
    return {
      name: input.name,
      type: 'PERCENT',
      discountRate: decimal(input.discountRate),
      validFrom: vnStart(input.validFrom),
      validTo: vnEnd(input.validTo),
      categoryIds: scope.categoryIds,
      productIds: scope.productIds,
      productSkus: scope.productSkus,
      customerTiers: [...new Set(input.customerTiers)],
    };
  }

  async createPromotion(input: PromotionInput, request: AuthenticatedRequest) {
    await this.assertBelowCap(input.discountRate);
    const scope = await this.scope(input);
    const now = new Date();
    const document = { _id: new ObjectId(), code: input.code, ...this.fields(input, scope), status: 'ACTIVE', version: 1, createdAt: now, createdBy: request.user.email, updatedAt: now };
    try {
      await this.db.collection('promotions').insertOne(document);
    } catch (error) {
      if (isDuplicate(error)) throw new ConflictException({ code: 'PROMOTION_CODE_EXISTS', message: `Mã CTKM ${input.code} đã tồn tại`, details: [{ path: ['code'] }] });
      throw error;
    }
    await this.record(request, 'PROMOTION_CREATED', 'Promotion', document._id.toHexString(), null, document);
    return serializeDocument(document);
  }

  private async load(id: string) {
    const row = await this.db.collection('promotions').findOne({ _id: toObjectId(id) });
    if (!row) throw new NotFoundException({ code: 'PROMOTION_NOT_FOUND', message: 'Không tìm thấy chương trình khuyến mãi' });
    return row;
  }

  async updatePromotion(id: string, input: UpdatePromotion, request: AuthenticatedRequest) {
    const before = await this.load(id);
    await this.assertBelowCap(input.discountRate);
    const scope = await this.scope(input);
    const after = await this.db
      .collection('promotions')
      .findOneAndUpdate(
        { _id: before._id, ...versionFilter(input.version) },
        { $set: { ...this.fields(input, scope), updatedAt: new Date(), updatedBy: request.user.email }, $inc: { version: 1 } },
        { returnDocument: 'after' },
      );
    if (!after) throw new ConflictException({ code: 'VERSION_CONFLICT', message: 'CTKM đã được người khác cập nhật, hãy tải lại rồi sửa' });
    await this.record(request, 'PROMOTION_UPDATED', 'Promotion', id, before, after);
    return serializeDocument(after);
  }

  /** Dừng / chạy lại: CTKM dừng không còn được bộ tính giá chọn cho phiếu lập sau đó. */
  async setPromotionStatus(id: string, status: 'ACTIVE' | 'INACTIVE', request: AuthenticatedRequest) {
    const before = await this.load(id);
    if (before.status === status) return serializeDocument(before);
    if (status === 'ACTIVE') await this.assertBelowCap(decimalString(before.discountRate));
    const after = await this.db
      .collection('promotions')
      .findOneAndUpdate(
        { _id: before._id, status: before.status },
        { $set: { status, updatedAt: new Date(), updatedBy: request.user.email }, $inc: { version: 1 } },
        { returnDocument: 'after' },
      );
    if (!after) throw new ConflictException({ code: 'VERSION_CONFLICT', message: 'CTKM đã được người khác cập nhật, hãy tải lại' });
    await this.record(request, status === 'ACTIVE' ? 'PROMOTION_RESUMED' : 'PROMOTION_STOPPED', 'Promotion', id, before, after);
    return serializeDocument(after);
  }
}
