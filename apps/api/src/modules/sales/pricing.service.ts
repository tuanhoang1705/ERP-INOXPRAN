import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { allocateLineVat, commonVatRate, isVatRate, SALE_ONLY_FILTER, zeroPriceKindOf, type VatRate, type ZeroPriceKind } from '@inoxpran/contracts';
import Decimal from 'decimal.js';
import type { ClientSession, Db, Document } from 'mongodb';
import { ObjectId } from 'mongodb';
import { decimalString, salesTierWindow, toObjectId } from '../../common/domain';
import { MONGO_DATABASE } from '../../common/tokens';
import { calculatePrice, documentTotals, pickPromotion, resolveSalesTierRate, type PromotionRule, type SalesTierRule } from './pricing.engine';

/**
 * Doanh thu ghi khi giao thành công (AR-DLV-01, 28/10/2026 — trước đây tính từ lúc phát hành phiếu BH theo ngày phiếu):
 * phiếu bán đã giao, theo ngày giao (deliveredAt). Dùng cho báo cáo, tổng quan, doanh số lũy kế xét bậc chiết khấu.
 */
export const REVENUE_STATUSES = ['DELIVERED'];

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
  zeroPriceKind?: ZeroPriceKind | undefined;
  /** Đơn giá chưa VAT sửa tay (đã kiểm tra quyền ở SalesService trước khi gọi). */
  overrideUnitPrice?: string | undefined;
  /** Tên hàng sửa tay trên phiếu (SAL-NAME-01); trống = tên trong danh mục. */
  productName?: string | undefined;
  /** Thuế suất GTGT của dòng — chỉ dùng với mẫu PXK-002 (thuế từng dòng); trống = thuế suất của phiếu / mặc định. */
  vatRate?: VatRate | undefined;
}

/** Cách tính thuế theo mẫu chứng từ: DOCUMENT = PXK-001 (một thuế suất cho cả phiếu), LINE = PXK-002 (thuế từng dòng). */
export type VatMode = 'DOCUMENT' | 'LINE';

/** PXK-002: chia tiền thuế về từng dòng (allocateLineVat) — Σ thuế dòng = tiền thuế, tiền hàng + thuế = tổng, không lệch đồng. */
function applyLineVat<T extends { netAmount: string; vatRate: string; taxAmount: string; lineTotal: string }>(lines: T[]) {
  const allocation = allocateLineVat(lines);
  lines.forEach((line, index) => {
    line.taxAmount = allocation.taxAmounts[index] as string;
    line.lineTotal = new Decimal(line.netAmount).add(line.taxAmount).toFixed(2);
  });
  return allocation;
}

/** Tên in trên dòng phiếu: tên sửa tay nếu có, không thì tên sản phẩm trong danh mục. */
export const lineProductName = (line: { productName?: string | undefined }, product: Document): string => line.productName?.trim() || String(product.name);

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
          { $match: { customerId: customer._id, status: { $in: REVENUE_STATUSES }, ...SALE_ONLY_FILTER, deliveredAt: { $gte: start } } },
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
    options_: { ignoreCustomerPrices?: boolean } = {},
  ): Promise<Map<string, PriceBasis>> {
    const options = session ? { session } : {};
    const now = new Date();
    // Giá riêng của khách (PRI-CUST-01): giá chốt, ưu tiên trước bảng giá cấp, không chiết khấu.
    const customerPrices = new Map<string, string>();
    if (customer._id && !options_.ignoreCustomerPrices) {
      const rows = await this.db.collection('customer_prices')
        .find({ partnerId: customer._id, ...(productIds ? { productId: { $in: productIds } } : {}) }, { projection: { productId: 1, unitPrice: 1 }, ...options })
        .toArray();
      for (const row of rows) customerPrices.set((row.productId as ObjectId).toHexString(), decimalString(row.unitPrice));
    }
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
      const own = customerPrices.get(id);
      if (own) {
        result.set(id, {
          product,
          baseUnitPrice: own,
          pricingSource: 'CUSTOMER_PRICE',
          tierDiscountRate: '0',
          salesTierDiscountRate: '0',
          promotionDiscountRate: '0',
          discountRate: '0',
        });
        continue;
      }
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

  /**
   * Tính giá các dòng phiếu. PXK-001 (DOCUMENT): một thuế suất cho cả phiếu, thuế tính một lần trên Σ thành tiền. PXK-002 (LINE,
   * 27/10/2026): thuế suất từng dòng (dòng không ghi → thuế suất phiếu / mặc định), tiền thuế chia về dòng không lệch đồng.
   */
  async priceLines(lines: PricingLineInput[], customer: Document, session?: ClientSession, vatRate?: string, vatMode: VatMode = 'DOCUMENT') {
    const settings = await this.settings(session);
    const context = await this.customerContext(customer, settings, session);
    const documentRate = vatRate ?? settings.taxRate;
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
      // Loại hàng khác luôn không tính tiền, kể cả client cũ / bên ngoài không gửi cờ gift.
      const zeroPriceKind = zeroPriceKindOf(line);
      const gift = zeroPriceKind !== undefined;
      const tierDiscountRate = gift ? '0' : priced.tierDiscountRate;
      const salesTierDiscountRate = gift ? '0' : priced.salesTierDiscountRate;
      const promotionDiscountRate = gift ? '0' : priced.promotionDiscountRate;
      const taxRate = vatMode === 'LINE' ? line.vatRate ?? documentRate : documentRate;
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
        productName: lineProductName(line, product),
        categoryId: product.categoryId as ObjectId | undefined,
        unit: line.unit,
        quantity: line.quantity,
        gift,
        zeroPriceKind,
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
        vatRate: taxRate,
        taxAmount: result.taxAmount,
        lineTotal: result.grossAmount,
        netAmount: result.netAmount,
        pricingSource: overridden ? 'MANUAL_PRICE' : priced.pricingSource,
        ...(original ? { originalUnitPrice: original.unitPrice } : {}),
        pricingSnapshot: result,
      });
    }

    // PXK-001: tổng chứng từ làm tròn tới đồng như phiếu xuất kho bán hàng (thuế một lần trên Σ thành tiền).
    // PXK-002: tổng mỗi thuế suất như PXK-001, tiền thuế chia về từng dòng.
    const totals = vatMode === 'LINE' ? applyLineVat(pricedLines) : documentTotals(netTotal, documentRate);
    return {
      settings,
      context,
      vatMode,
      vatRate: vatMode === 'LINE' ? commonVatRate(pricedLines.map((line) => line.vatRate), documentRate) : documentRate,
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
  async zeroLines(lines: PricingLineInput[], session?: ClientSession, vatRate?: string, vatMode: VatMode = 'DOCUMENT') {
    const settings = await this.settings(session);
    const documentRate = vatRate ?? settings.taxRate;
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
      const taxRate = vatMode === 'LINE' ? line.vatRate ?? documentRate : documentRate;
      const result = calculatePrice({
        quantity: line.quantity, conversionFactor: decimalString(conversion.factorToBase), baseUnitPrice: '0',
        tierDiscountRate: '0', salesTierDiscountRate: '0', promotionDiscountRate: '0', discountCapRate: settings.discountCapRate,
        taxRate, pricesIncludeTax: settings.pricesIncludeTax, gift: true,
      });
      return {
        productId,
        sku: String(product.sku),
        productName: lineProductName(line, product),
        categoryId: product.categoryId as ObjectId | undefined,
        unit: line.unit,
        quantity: line.quantity,
        gift: false,
        zeroPriceKind: undefined,
        baseQuantity: result.baseQuantity,
        minimumStock: decimalString(product.minimumStock),
        listPrice: result.listPrice,
        listUnitPrice: result.listUnitPrice,
        unitPrice: result.unitPrice,
        discountRate: '0',
        tierDiscountRate: '0',
        salesTierDiscountRate: '0',
        promotionDiscountRate: '0',
        vatRate: taxRate,
        taxAmount: result.taxAmount,
        lineTotal: result.grossAmount,
        netAmount: result.netAmount,
        pricingSource: 'NON_SALE',
        originalUnitPrice: undefined as string | undefined,
        promotionCode: undefined as string | undefined,
        pricingSnapshot: result,
      };
    });
    return { settings, vatMode, vatRate: vatMode === 'LINE' ? commonVatRate(pricedLines.map((line) => line.vatRate), documentRate) : documentRate, lines: pricedLines, subtotal: '0.00', discountTotal: '0.00', netTotal: '0', taxTotal: '0', grandTotal: '0' };
  }
}
