import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Db, ObjectId } from 'mongodb';
import { decimalString, toObjectId } from '../../common/domain';
import { EvidenceIntakeService } from '../../common/evidence-intake.service';
import { MONGO_DATABASE } from '../../common/tokens';
import { PriceListService } from './price-list.service';

/** Only fields already displayed in the sales price catalog. No customer, cost, stock ledger or employee data. */
@Injectable()
export class PriceCatalogService {
  constructor(
    @Inject(MONGO_DATABASE) private readonly db: Db,
    private readonly prices: PriceListService,
    private readonly evidence: EvidenceIntakeService,
  ) {}

  async priceList() {
    const { rows } = await this.prices.list({}, null);
    return { rows };
  }

  async promotions() {
    const [rows, categories] = await Promise.all([
      this.db.collection('promotions').find({}, { projection: { code: 1, name: 1, discountRate: 1, status: 1, validFrom: 1, validTo: 1, categoryIds: 1, productSkus: 1, customerTiers: 1 } }).sort({ validTo: -1 }).toArray(),
      this.db.collection('product_categories').find({}, { projection: { name: 1 } }).toArray(),
    ]);
    const names = new Map(categories.map(row => [String(row._id), String(row.name)]));
    return rows.map(row => ({
      id: String(row._id), code: String(row.code), name: String(row.name), discountRate: decimalString(row.discountRate),
      status: String(row.status), validFrom: row.validFrom, validTo: row.validTo,
      categoryNames: ((row.categoryIds as ObjectId[] | undefined) ?? []).map(id => names.get(String(id)) ?? '—'),
      productSkus: (row.productSkus as string[] | undefined) ?? [], customerTiers: (row.customerTiers as string[] | undefined) ?? [],
    }));
  }

  async image(productId: string, imageId: string) {
    const product = await this.db.collection('products').findOne({ _id: toObjectId(productId), status: 'ACTIVE', primaryImageId: toObjectId(imageId, 'imageId') }, { projection: { _id: 1 } });
    if (!product) throw new NotFoundException({ code: 'PRODUCT_IMAGE_NOT_FOUND', message: 'Không tìm thấy ảnh sản phẩm.' });
    const attachment = await this.db.collection('attachments').findOne({
      _id: toObjectId(imageId, 'imageId'), entityType: 'Product', entityId: product._id, purpose: 'PRODUCT_IMAGE', status: 'LINKED',
      contentType: { $in: ['image/png', 'image/jpeg', 'image/webp'] },
    });
    if (!attachment) throw new NotFoundException({ code: 'PRODUCT_IMAGE_NOT_FOUND', message: 'Không tìm thấy ảnh sản phẩm.' });
    return this.evidence.read(attachment);
  }
}
