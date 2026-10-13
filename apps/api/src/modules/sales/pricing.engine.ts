import { documentTotals as computeDocumentTotals, priceLine } from '@inoxpran/contracts';
import Decimal from 'decimal.js';

/**
 * Giải thuật 2 của đồ án: đơn giá = G × (1 − MIN(CK_cấp + CK_bậc + CK_KM, CK_trần)).
 * G là giá theo cấp khách hàng (Net NPP / đại lý / bán lẻ) lấy từ bảng giá đang hiệu lực.
 *
 * Khi bảng giá là giá đã gồm VAT (như bảng báo giá INOXPRAN), đơn giá chưa thuế được tính ngược
 * và làm tròn 2 chữ số thập phân giống phiếu xuất kho bán hàng: 586.000 / 1,08 = 542.592,59.
 * Phần tính tiền dùng priceLine() của @inoxpran/contracts — cùng hàm form dùng để tính tức thời.
 */
export interface PricingInput {
  quantity: string;
  conversionFactor: string;
  baseUnitPrice: string;
  tierDiscountRate: string;
  salesTierDiscountRate: string;
  promotionDiscountRate: string;
  discountCapRate: string;
  /** Thuế suất GTGT: "10", "8", "5", "3" hoặc "KCT". */
  taxRate: string;
  pricesIncludeTax?: boolean;
  gift?: boolean;
  /** Đơn giá chưa VAT sửa tay (đã được cấp quyền) — bỏ chiết khấu, dùng đúng giá này. */
  unitPriceOverride?: string | undefined;
}

export interface PricingResult {
  baseQuantity: string;
  /** Giá niêm yết của 1 đơn vị bán (trước CK). */
  listPrice: string;
  /** Đơn giá chưa VAT trước chiết khấu. */
  listUnitPrice: string;
  /** Đơn giá chưa VAT sau chiết khấu (cột Đơn giá trên phiếu). */
  unitPrice: string;
  discountRate: string;
  subtotal: string;
  discountAmount: string;
  netAmount: string;
  taxAmount: string;
  grossAmount: string;
}

export interface SalesTierRule {
  minimumRevenue: string;
  discountRate: string;
}

export interface PromotionRule {
  code: string;
  discountRate: string;
  validFrom: Date;
  validTo: Date;
  status: string;
  categoryIds?: string[];
  productIds?: string[];
  customerTiers?: string[];
}

export function calculatePrice(input: PricingInput): PricingResult {
  const discountRate = input.gift || input.unitPriceOverride
    ? new Decimal(0)
    : Decimal.min(
        new Decimal(input.tierDiscountRate).add(input.salesTierDiscountRate).add(input.promotionDiscountRate),
        new Decimal(input.discountCapRate),
      ).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  const amounts = priceLine(
    {
      quantity: input.quantity,
      conversionFactor: input.conversionFactor,
      baseUnitPrice: input.baseUnitPrice,
      discountRate: discountRate.toFixed(),
      gift: input.gift,
      unitPriceOverride: input.gift ? undefined : input.unitPriceOverride,
    },
    { vatRate: input.taxRate, pricesIncludeTax: Boolean(input.pricesIncludeTax) },
  );
  return { ...amounts, discountRate: discountRate.toString() };
}

/**
 * Tổng chứng từ làm tròn tới đồng như phiếu xuất kho: cộng tiền hàng và tiền thuế tính trên tổng chưa làm tròn,
 * tổng thanh toán = làm tròn(cộng tiền hàng + thuế). Ví dụ 74.842.592,30 + 5.987.407,38 → 80.830.000.
 */
export function documentTotals(netTotal: Decimal.Value, taxRate: string) {
  return computeDocumentTotals(new Decimal(netTotal).toFixed(), taxRate);
}

/** Bước 4 của Giải thuật 2: lấy mức chiết khấu của bậc cao nhất mà doanh số lũy kế đạt tới. */
export function resolveSalesTierRate(periodRevenue: string, tiers: SalesTierRule[]): string {
  const revenue = new Decimal(periodRevenue);
  let rate = new Decimal(0);
  let reached = new Decimal(-1);
  for (const tier of tiers) {
    const threshold = new Decimal(tier.minimumRevenue);
    if (revenue.gte(threshold) && threshold.gt(reached)) {
      reached = threshold;
      rate = new Decimal(tier.discountRate);
    }
  }
  return rate.toString();
}

/** Bước 5 của Giải thuật 2: chương trình khuyến mãi còn hiệu lực có mức giảm cao nhất cho sản phẩm và cấp khách. */
export function pickPromotion(
  promotions: PromotionRule[],
  target: { productId: string; categoryId?: string; customerTier: string; at: Date },
): PromotionRule | undefined {
  return promotions
    .filter((promotion) => promotion.status === 'ACTIVE')
    .filter((promotion) => promotion.validFrom <= target.at && promotion.validTo >= target.at)
    .filter((promotion) => !promotion.customerTiers?.length || promotion.customerTiers.includes(target.customerTier))
    .filter((promotion) => {
      const scoped = Boolean(promotion.productIds?.length || promotion.categoryIds?.length);
      if (!scoped) return true;
      return Boolean(
        promotion.productIds?.includes(target.productId) ||
          (target.categoryId && promotion.categoryIds?.includes(target.categoryId)),
      );
    })
    .sort((a, b) => new Decimal(b.discountRate).comparedTo(a.discountRate))[0];
}
