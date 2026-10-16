import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { isVatRate, SALE_ONLY_FILTER } from '@inoxpran/contracts';
import Decimal from 'decimal.js';
import type { ClientSession, Db, Document } from 'mongodb';
import { ObjectId } from 'mongodb';
import { decimalString, salesTierWindow, toObjectId } from '../../common/domain';
import { MONGO_DATABASE } from '../../common/tokens';
import { calculatePrice, documentTotals, pickPromotion, resolveSalesTierRate, type PromotionRule, type SalesTierRule } from './pricing.engine';

/** Trạng thái đơn được tính vào doanh số lũy kế của đại lý (đã phát hành phiếu BH và giữ hàng trở đi). */
export const REVENUE_STATUSES = ['RESERVED', 'PARTIALLY_SHIPPED', 'SHIPPED', 'DELIVERED'];

export interface PricingSettings {
  taxRate: string;
  pricesIncludeTax: boolean;
  discountCapRate: string;
  tierRates: Record<string, string>;
  salesTiers: SalesTierRule[];
  salesTierPeriod: string;
}

interface PricingLineInput {
  productId: string;
  quantity: string;
  unit: string;
  gift?: boolean | undefined;
  /** Đơn giá chưa VAT sửa tay (đã kiểm tra quyền ở SalesService trước khi gọi). */
  overrideUnitPrice?: string | undefined;
}

export interface CustomerPricingContext {
  tier: string;
  periodRevenue: string;
  periodLabel: string;
  salesTierRate: string;
}

/** Cơ sở tính giá của một mã hàng cho một khách: giá niêm yết theo cấp và các mức chiết khấu. */
export interface PriceBasis {
  product: Document;
  baseUnitPrice: string;
  pricingSource: string;
  tierDiscountRate: string;
  salesTierDiscountRate: string;
  promotionDiscountRate: string;
  promotionCode?: string;
  /** CK tổng của dòng hàng bán, đã áp trần. */
  discountRate: string;
}

@Injectable()
export class PricingService {
  constructor(@Inject(MONGO_DATABASE) private readonly db: Db) {}

  async settings(session?: ClientSession): Promise<PricingSettings> {
    const settings = await this.db
      .collection<{ _id: string } & Document>('settings')
      .findOne({ _id: 'pricing' }, session ? { session } : {});
    const taxRate = String(settings?.defaultTaxRate ?? '8');
    return {
      taxRate: isVatRate(taxRate) ? taxRate : '8',
      pricesIncludeTax: Boolean(settings?.pricesIncludeTax ?? true),
      discountCapRate: String(settings?.discountCapRate ?? '15'),
      tierRates: (settings?.customerTierDiscounts as Record<string, string> | undefined) ?? { TIER_1: '0', TIER_2: '0', RETAIL: '0' },
      salesTiers: (settings?.salesTiers as SalesTierRule[] | undefined) ?? [],
      salesTierPeriod: String(settings?.salesTierPeriod ?? 'QUARTER'),
    };
  }

  /** Doanh số lũy kế (sau chiết khấu, chưa VAT) của khách trong kỳ cấu hình (quý hoặc 90 ngày gần nhất). */
  async customerContext(customer: Document, settings: PricingSettings, session?: ClientSession): Promise<CustomerPricingContext> {
    const { start, label } = salesTierWindow(settings.salesTierPeriod);
    const rows = await this.db
      .collection('sales_orders')
      .aggregate(
        [
          { $match: { customerId: customer._id, status: { $in: REVENUE_STATUSES }, ...SALE_ONLY_FILTER, orderDate: { $gte: start } } },
          { $group: { _id: null, total: { $sum: { $ifNull: ['$netTotal', { $subtract: ['$subtotal', '$discountTotal'] }] } } } },
        ],
        session ? { session } : {},
      )
      .toArray();
    const periodRevenue = decimalString(rows[0]?.total ?? '0');
    return {
      tier: String(customer.customerTier ?? 'RETAIL'),
      periodRevenue,
      periodLabel: label,
      salesTierRate: resolveSalesTierRate(periodRevenue, settings.salesTiers),
    };
  }

  private async activePromotions(at: Date, session?: ClientSession): Promise<PromotionRule[]> {
    const rows = await this.db
      .collection('promotions')
      .find({ status: 'ACTIVE', validFrom: { $lte: at }, validTo: { $gte: at } }, session ? { session } : {})
      .toArray();
    return rows.map((row) => ({
      code: String(row.code),
      discountRate: decimalString(row.discountRate),
      validFrom: row.validFrom as Date,
      validTo: row.validTo as Date,
      status: String(row.status),
      categoryIds: ((row.categoryIds as ObjectId[] | undefined) ?? []).map((id) => id.toHexString()),
      productIds: ((row.productIds as ObjectId[] | undefined) ?? []).map((id) => id.toHexString()),
      customerTiers: (row.customerTiers as string[] | undefined) ?? [],
    }));
  }

  /**
   * Giá niêm yết theo cấp khách và chiết khấu (Giải thuật 2) cho các mã hàng đang kinh doanh.
   * `productIds` bỏ trống = toàn bộ danh mục (dùng cho bảng giá của khách trên form).
   */
  async basis(
    customer: Document,
    settings: PricingSettings,
    context: CustomerPricingContext,
    productIds?: ObjectId[],
    session?: ClientSession,
  ): Promise<Map<string, PriceBasis>> {
    const options = session ? { session } : {};
    const now = new Date();
    const [products, priceBooks, promotions] = await Promise.all([
      this.db.collection('products').find({ status: 'ACTIVE', ...(productIds ? { _id: { $in: productIds } } : {}) }, options).toArray(),
      this.db
        .collection('price_books')
        .find(
          {
            status: 'PUBLISHED',
            validFrom: { $lte: now },
            $or: [{ validTo: null }, { validTo: { $gte: now } }],
            customerTier: { $in: [context.tier, 'ALL'] },
          },
          options,
        )
        .sort({ priority: -1, version: -1 })
        .toArray(),
      this.activePromotions(now, session),
    ]);
    // Bảng giá ưu tiên cao nhất có chứa mã hàng sẽ được dùng.
    const bookPrice = new Map<string, { price: string; source: string }>();
    for (const book of priceBooks) {
      for (const line of (book.lines as Array<{ productId: ObjectId; baseUnitPrice: unknown }> | undefined) ?? []) {
        const key = line.productId.toHexString();
        if (!bookPrice.has(key)) bookPrice.set(key, { price: decimalString(line.baseUnitPrice), source: `PRICE_BOOK:${String(book.code)}:v${String(book.version)}` });
      }
    }
    const tierDiscountRate = settings.tierRates[context.tier] ?? '0';
    const result = new Map<string, PriceBasis>();
    for (const product of products) {
      const id = (product._id as ObjectId).toHexString();
      const promotion = pickPromotion(promotions, {
        productId: id,
        ...(product.categoryId ? { categoryId: (product.categoryId as ObjectId).toHexString() } : {}),
        customerTier: context.tier,
        at: now,
      });
      const promotionDiscountRate = promotion?.discountRate ?? '0';
      const discountRate = Decimal.min(
        new Decimal(tierDiscountRate).add(context.salesTierRate).add(promotionDiscountRate),
        new Decimal(settings.discountCapRate),
      ).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
      const fromBook = bookPrice.get(id);
      result.set(id, {
        product,
        baseUnitPrice: fromBook?.price ?? decimalString(product.listPrice),
        pricingSource: fromBook?.source ?? 'PRODUCT_LIST_PRICE',
        tierDiscountRate,
        salesTierDiscountRate: context.salesTierRate,
        promotionDiscountRate,
        ...(promotion ? { promotionCode: promotion.code } : {}),
        discountRate: discountRate.toString(),
      });
    }
    return result;
  }

  /** Tính giá các dòng phiếu với thuế suất đã chọn (bỏ trống = thuế suất mặc định). */
  async priceLines(lines: PricingLineInput[], customer: Document, session?: ClientSession, vatRate?: string) {
    const settings = await this.settings(session);
    const context = await this.customerContext(customer, settings, session);
    const taxRate = vatRate ?? settings.taxRate;
    const ids = [...new Set(lines.map((line) => line.productId))].map((id) => toObjectId(id, 'productId'));
    const basis = await this.basis(customer, settings, context, ids, session);

    const pricedLines = [];
    let subtotal = new Decimal(0);
    let discountTotal = new Decimal(0);
    let netTotal = new Decimal(0);

    for (const line of lines) {
      const productId = toObjectId(line.productId, 'productId');
      const priced = basis.get(productId.toHexString());
      if (!priced) throw new NotFoundException({ code: 'PRODUCT_NOT_FOUND', message: 'Không tìm thấy sản phẩm' });
      const { product } = priced;
      const conversion = line.unit === product.baseUnit
        ? { factorToBase: '1' }
        : (product.unitConversions as Array<{ unit: string; factorToBase: unknown }>).find((item) => item.unit === line.unit);
      if (!conversion) {
        throw new NotFoundException({ code: 'UNIT_NOT_CONFIGURED', message: `Đơn vị ${line.unit} chưa được cấu hình cho ${String(product.sku)}` });
      }
      const gift = Boolean(line.gift);
      const tierDiscountRate = gift ? '0' : priced.tierDiscountRate;
      const salesTierDiscountRate = gift ? '0' : priced.salesTierDiscountRate;
      const promotionDiscountRate = gift ? '0' : priced.promotionDiscountRate;
      const pricingInput = {
        quantity: line.quantity,
        conversionFactor: decimalString(conversion.factorToBase),
        baseUnitPrice: priced.baseUnitPrice,
        tierDiscountRate,
        salesTierDiscountRate,
        promotionDiscountRate,
        discountCapRate: settings.discountCapRate,
        taxRate,
        pricesIncludeTax: settings.pricesIncludeTax,
        gift,
      };
      const overridden = Boolean(line.overrideUnitPrice) && !gift;
      const result = calculatePrice({ ...pricingInput, ...(overridden ? { unitPriceOverride: line.overrideUnitPrice } : {}) });
      const original = overridden ? calculatePrice(pricingInput) : null;

      subtotal = subtotal.add(result.subtotal);
      discountTotal = discountTotal.add(result.discountAmount);
      netTotal = netTotal.add(result.netAmount);
      pricedLines.push({
        productId,
        sku: String(product.sku),
        productName: String(product.name),
        categoryId: product.categoryId as ObjectId | undefined,
        unit: line.unit,
        quantity: line.quantity,
        gift,
        baseQuantity: result.baseQuantity,
        minimumStock: decimalString(product.minimumStock),
        listPrice: result.listPrice,
        listUnitPrice: result.listUnitPrice,
        unitPrice: result.unitPrice,
        discountRate: result.discountRate,
        tierDiscountRate: overridden ? '0' : tierDiscountRate,
        salesTierDiscountRate: overridden ? '0' : salesTierDiscountRate,
        promotionDiscountRate: overridden ? '0' : promotionDiscountRate,
        ...(priced.promotionCode && !gift && !overridden ? { promotionCode: priced.promotionCode } : {}),
        lineTotal: result.grossAmount,
        netAmount: result.netAmount,
        pricingSource: overridden ? 'MANUAL_PRICE' : priced.pricingSource,
        ...(original ? { originalUnitPrice: original.unitPrice } : {}),
        pricingSnapshot: result,
      });
    }

    // Tổng chứng từ làm tròn tới đồng đúng như phiếu xuất kho bán hàng (cộng tiền hàng, tiền thuế, tổng thanh toán).
    const totals = documentTotals(netTotal, taxRate);
    return {
      settings,
      context,
      vatRate: taxRate,
      lines: pricedLines,
      subtotal: subtotal.toFixed(2),
      discountTotal: discountTotal.toFixed(2),
      netTotal: totals.netTotal,
      taxTotal: totals.taxTotal,
      grandTotal: totals.grandTotal,
    };
  }

  /**
   * Phiếu xuất hàng mẫu / kiểm định (SAL-TYPE-01): không bán nên không có khách, không bảng giá — kiểm mã đang kinh doanh và
   * đơn vị như phiếu bán, mọi dòng đơn giá 0, tổng 0.
   */
  async zeroLines(lines: PricingLineInput[], session?: ClientSession, vatRate?: string) {
    const settings = await this.settings(session);
    const taxRate = vatRate ?? settings.taxRate;
    const ids = [...new Set(lines.map((line) => line.productId))].map((id) => toObjectId(id, 'productId'));
    const products = await this.db.collection('products').find({ _id: { $in: ids }, status: 'ACTIVE' }, session ? { session } : {}).toArray();
    const byId = new Map(products.map((product) => [(product._id as ObjectId).toHexString(), product]));
    const pricedLines = lines.map((line) => {
      const productId = toObjectId(line.productId, 'productId');
      const product = byId.get(productId.toHexString());
      if (!product) throw new NotFoundException({ code: 'PRODUCT_NOT_FOUND', message: 'Không tìm thấy sản phẩm' });
      const conversion = line.unit === product.baseUnit
        ? { factorToBase: '1' }
        : (product.unitConversions as Array<{ unit: string; factorToBase: unknown }>).find((item) => item.unit === line.unit);
      if (!conversion) {
        throw new NotFoundException({ code: 'UNIT_NOT_CONFIGURED', message: `Đơn vị ${line.unit} chưa được cấu hình cho ${String(product.sku)}` });
      }
      // gift = true chỉ để tính: số lượng quy đổi đúng, mọi khoản tiền 0 (dòng phiếu vẫn là dòng thường).
      const result = calculatePrice({
        quantity: line.quantity, conversionFactor: decimalString(conversion.factorToBase), baseUnitPrice: '0',
        tierDiscountRate: '0', salesTierDiscountRate: '0', promotionDiscountRate: '0', discountCapRate: settings.discountCapRate,
        taxRate, pricesIncludeTax: settings.pricesIncludeTax, gift: true,
      });
      return {
        productId,
        sku: String(product.sku),
        productName: String(product.name),
        categoryId: product.categoryId as ObjectId | undefined,
        unit: line.unit,
        quantity: line.quantity,
        gift: false,
        baseQuantity: result.baseQuantity,
        minimumStock: decimalString(product.minimumStock),
        listPrice: result.listPrice,
        listUnitPrice: result.listUnitPrice,
        unitPrice: result.unitPrice,
        discountRate: '0',
        tierDiscountRate: '0',
        salesTierDiscountRate: '0',
        promotionDiscountRate: '0',
        lineTotal: result.grossAmount,
        netAmount: result.netAmount,
        pricingSource: 'NON_SALE',
        originalUnitPrice: undefined as string | undefined,
        promotionCode: undefined as string | undefined,
        pricingSnapshot: result,
      };
    });
    return { settings, vatRate: taxRate, lines: pricedLines, subtotal: '0.00', discountTotal: '0.00', netTotal: '0', taxTotal: '0', grandTotal: '0' };
  }
}
