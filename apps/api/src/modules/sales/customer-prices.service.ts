import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { CustomerPriceRow, UpdateCustomerPrices } from '@inoxpran/contracts';
import Decimal from 'decimal.js';
import type { AnyBulkWriteOperation, Db, Document } from 'mongodb';
import { ObjectId } from 'mongodb';
import { AuditService } from '../../common/audit.service';
import { decimal, decimalString, toObjectId } from '../../common/domain';
import type { AuthenticatedRequest } from '../../common/request-context';
import { MONGO_DATABASE } from '../../common/tokens';
import { PricingService } from './pricing.service';

/**
 * Giá riêng từng khách (PRI-CUST-01, 31/10/2026 — yêu cầu của kế toán): mỗi đại lý / khách lẻ / NPP có giá riêng cho từng mã, gồm
 * VAT như bảng giá, theo đơn vị cơ bản (thùng tự nhân hệ số). Lập phiếu BH cho khách tự lấy giá này làm giá chốt (pricing.service
 * `basis`), không chiết khấu cấp / bậc doanh số / CTKM, không cần quyền sửa giá. Kế toán / Admin sửa; mỗi lần lưu ghi nhật ký.
 */
@Injectable()
export class CustomerPricesService {
  constructor(
    @Inject(MONGO_DATABASE) private readonly db: Db,
    private readonly pricing: PricingService,
    private readonly audit: AuditService,
  ) {}

  private async customer(partnerId: string) {
    const partner = await this.db.collection('partners').findOne({ _id: toObjectId(partnerId, 'partnerId'), kind: { $in: ['CUSTOMER', 'BOTH'] } });
    if (!partner) throw new NotFoundException({ code: 'CUSTOMER_NOT_FOUND', message: 'Không tìm thấy khách hàng' });
    return partner;
  }

  async list(partnerId: string): Promise<CustomerPriceRow[]> {
    const partner = await this.customer(partnerId);
    const rows = await this.db.collection('customer_prices').find({ partnerId: partner._id }).toArray();
    if (!rows.length) return [];
    const productIds = rows.map((row) => row.productId as ObjectId);
    const [products, settings] = await Promise.all([
      this.db.collection('products').find({ _id: { $in: productIds } }, { projection: { sku: 1, name: 1, baseUnit: 1 } }).toArray(),
      this.pricing.settings(),
    ]);
    // Tham khảo: giá theo cấp + chiết khấu nếu khách không có giá riêng (mã ngừng kinh doanh thì không có).
    const context = await this.pricing.customerContext(partner, settings);
    const tier = await this.pricing.basis(partner, settings, context, productIds, undefined, { ignoreCustomerPrices: true });
    const byId = new Map(products.map((product) => [(product._id as ObjectId).toHexString(), product]));
    return rows
      .map((row) => {
        const id = (row.productId as ObjectId).toHexString();
        const product = byId.get(id);
        const reference = tier.get(id);
        return {
          productId: id,
          sku: String(product?.sku ?? row.sku),
          productName: String(product?.name ?? ''),
          unit: String(product?.baseUnit ?? ''),
          unitPrice: decimalString(row.unitPrice),
          tierPrice: reference?.baseUnitPrice ?? '0',
          tierDiscountRate: reference?.discountRate ?? '0',
          updatedAt: (row.updatedAt as Date).toISOString(),
          updatedByName: String(row.updatedByName ?? ''),
        };
      })
      .sort((a, b) => a.sku.localeCompare(b.sku));
  }

  /** Lưu giá riêng: thêm / sửa theo mã (productId hoặc mã SP — dán từ Excel), xóa theo productId. Mã sai → 400 kèm danh sách. */
  async update(partnerId: string, input: UpdateCustomerPrices, request: AuthenticatedRequest): Promise<CustomerPriceRow[]> {
    const partner = await this.customer(partnerId);
    const skus = [...new Set(input.upsert.filter((row) => !row.productId && row.sku).map((row) => String(row.sku).trim().toUpperCase()))];
    const ids = [...new Set(input.upsert.filter((row) => row.productId).map((row) => String(row.productId)))];
    const products = await this.db.collection('products')
      .find({ $or: [{ sku: { $in: skus } }, { _id: { $in: ids.map((id) => toObjectId(id, 'productId')) } }] }, { projection: { sku: 1 } })
      .toArray();
    const bySku = new Map(products.map((product) => [String(product.sku).toUpperCase(), product]));
    const byId = new Map(products.map((product) => [(product._id as ObjectId).toHexString(), product]));
    const unknown = [
      ...skus.filter((sku) => !bySku.has(sku)),
      ...ids.filter((id) => !byId.has(id)),
    ];
    if (unknown.length) {
      throw new BadRequestException({ code: 'CUSTOMER_PRICE_UNKNOWN_PRODUCT', message: `Không có mã sản phẩm: ${unknown.slice(0, 20).join(', ')}${unknown.length > 20 ? '…' : ''}`, details: { unknown } });
    }
    // Trùng mã trong cùng lần dán: dòng sau cùng thắng.
    const wanted = new Map<string, { product: Document; unitPrice: string }>();
    for (const row of input.upsert) {
      const product = row.productId ? byId.get(String(row.productId)) : bySku.get(String(row.sku).trim().toUpperCase());
      if (product) wanted.set((product._id as ObjectId).toHexString(), { product, unitPrice: new Decimal(row.unitPrice).toFixed(2) });
    }
    const removeIds = input.remove.map((id) => toObjectId(id, 'productId')).filter((id) => !wanted.has(id.toHexString()));
    const touched = [...[...wanted.keys()].map((id) => new ObjectId(id)), ...removeIds];
    const before = new Map(
      (await this.db.collection('customer_prices').find({ partnerId: partner._id, productId: { $in: touched } }).toArray())
        .map((row) => [(row.productId as ObjectId).toHexString(), decimalString(row.unitPrice)]),
    );
    const now = new Date();
    const actor = { updatedBy: toObjectId(request.user.sub), updatedByName: request.user.displayName };
    const operations: AnyBulkWriteOperation[] = [];
    const changes: Array<{ sku: string; before: string | null; after: string | null }> = [];
    for (const [id, { product, unitPrice }] of wanted) {
      if (before.get(id) && new Decimal(before.get(id)!).eq(unitPrice)) continue;
      operations.push({
        updateOne: {
          filter: { partnerId: partner._id, productId: product._id },
          update: { $set: { sku: String(product.sku), unitPrice: decimal(unitPrice), updatedAt: now, ...actor }, $setOnInsert: { createdAt: now } },
          upsert: true,
        },
      });
      changes.push({ sku: String(product.sku), before: before.get(id) ?? null, after: unitPrice });
    }
    for (const id of removeIds) {
      if (!before.has(id.toHexString())) continue;
      operations.push({ deleteOne: { filter: { partnerId: partner._id, productId: id } } });
      changes.push({ sku: String((await this.db.collection('customer_prices').findOne({ partnerId: partner._id, productId: id }, { projection: { sku: 1 } }))?.sku ?? id.toHexString()), before: before.get(id.toHexString()) ?? null, after: null });
    }
    if (operations.length) {
      await this.db.collection('customer_prices').bulkWrite(operations);
      await this.audit.record({
        actorId: request.user.sub, actorEmail: request.user.email, correlationId: request.correlationId,
        action: 'PARTNER_PRICES_UPDATED', entityType: 'Partner', entityId: (partner._id as ObjectId).toHexString(),
        metadata: { code: partner.code, changes: changes.slice(0, 500), rule: 'PRI-CUST-01' },
      });
    }
    return this.list(partnerId);
  }
}
