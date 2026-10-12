import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { calculatePrice, documentTotals, pickPromotion, resolveSalesTierRate } from './pricing.engine';

describe('calculatePrice', () => {
  it('combines discounts and applies the configured cap', () => {
    const result = calculatePrice({
      quantity: '10',
      conversionFactor: '1',
      baseUnitPrice: '100000',
      tierDiscountRate: '8',
      salesTierDiscountRate: '5',
      promotionDiscountRate: '10',
      discountCapRate: '18',
      taxRate: '10',
    });
    expect(result.discountRate).toBe('18');
    expect(result.subtotal).toBe('1000000.00');
    expect(result.discountAmount).toBe('180000.00');
    expect(result.grossAmount).toBe('902000.00');
  });

  it('prices alternate units from the base unit without floating point drift', () => {
    const result = calculatePrice({
      quantity: '2',
      conversionFactor: '6',
      baseUnitPrice: '19999.99',
      tierDiscountRate: '0',
      salesTierDiscountRate: '0',
      promotionDiscountRate: '0',
      discountCapRate: '18',
      taxRate: '10',
    });
    expect(result.baseQuantity).toBe('12');
    expect(result.unitPrice).toBe('119999.94');
    expect(result.grossAmount).toBe('263999.87');
  });
});

describe('resolveSalesTierRate', () => {
  const tiers = [
    { minimumRevenue: '50000000', discountRate: '1' },
    { minimumRevenue: '300000000', discountRate: '3' },
    { minimumRevenue: '150000000', discountRate: '2' },
  ];

  it('trả về 0 khi chưa đạt bậc nào', () => {
    expect(resolveSalesTierRate('49999999', tiers)).toBe('0');
  });

  it('lấy bậc cao nhất đã đạt, kể cả khi cấu hình không sắp xếp', () => {
    expect(resolveSalesTierRate('150000000', tiers)).toBe('2');
    expect(resolveSalesTierRate('900000000', tiers)).toBe('3');
  });
});

describe('pickPromotion', () => {
  const at = new Date('2026-10-01T03:00:00.000Z');
  const base = { validFrom: new Date('2026-09-01T00:00:00.000Z'), validTo: new Date('2026-10-31T00:00:00.000Z'), status: 'ACTIVE' };

  it('chọn chương trình có mức giảm cao nhất áp dụng cho nhóm hàng', () => {
    const promotion = pickPromotion(
      [
        { ...base, code: 'KM-A', discountRate: '3' },
        { ...base, code: 'KM-B', discountRate: '5', categoryIds: ['cat-noi'] },
        { ...base, code: 'KM-C', discountRate: '8', categoryIds: ['cat-quat'] },
      ],
      { productId: 'p-1', categoryId: 'cat-noi', customerTier: 'TIER_2', at },
    );
    expect(promotion?.code).toBe('KM-B');
  });

  it('bỏ qua chương trình hết hạn hoặc không dành cho cấp khách', () => {
    const promotion = pickPromotion(
      [
        { ...base, code: 'KM-OLD', discountRate: '9', validTo: new Date('2026-09-30T00:00:00.000Z') },
        { ...base, code: 'KM-NPP', discountRate: '7', customerTiers: ['TIER_1'] },
      ],
      { productId: 'p-1', customerTier: 'TIER_2', at },
    );
    expect(promotion).toBeUndefined();
  });
});

describe('giá đã gồm VAT như phiếu xuất kho bán hàng INOXPRAN', () => {
  const base = { conversionFactor: '1', tierDiscountRate: '0', salesTierDiscountRate: '0', promotionDiscountRate: '0', discountCapRate: '10', taxRate: '8', pricesIncludeTax: true };
  // Phiếu BH ngày 12/08/2026 – CÔNG TY TNHH TM GIANG CHÂU (giá gồm VAT 8%).
  const slip: Array<[string, string]> = [
    ['15', '586000'], ['15', '696000'], ['15', '570000'], ['15', '680000'], ['15', '620000'],
    ['15', '750000'], ['15', '520000'], ['15', '620000'], ['8', '650000'],
  ];

  it('tính ngược đơn giá chưa thuế và thành tiền đúng từng dòng', () => {
    const first = calculatePrice({ ...base, quantity: '15', baseUnitPrice: '586000' });
    expect(first.unitPrice).toBe('542592.59');
    expect(Math.round(Number(first.netAmount))).toBe(8_138_889);
    const last = calculatePrice({ ...base, quantity: '8', baseUnitPrice: '650000' });
    expect(last.unitPrice).toBe('601851.85');
  });

  it('cộng tiền hàng, thuế 8% và tổng thanh toán khớp phiếu giấy', () => {
    const net = slip.reduce((sum, [quantity, price]) => sum + Number(calculatePrice({ ...base, quantity, baseUnitPrice: price }).netAmount), 0);
    expect(documentTotals(net.toFixed(2), '8')).toEqual({ netTotal: '74842592', taxTotal: '5987407', grandTotal: '80830000' });
  });

  it('phiếu SWK 29/09/2026: 12 ấm INP1503 giá 160.000 → 1.920.000 đ', () => {
    const line = calculatePrice({ ...base, quantity: '12', baseUnitPrice: '160000' });
    expect(line.unitPrice).toBe('148148.15');
    expect(documentTotals(line.netAmount, '8')).toEqual({ netTotal: '1777778', taxTotal: '142222', grandTotal: '1920000' });
  });

  it('hàng tặng có đơn giá 0 nhưng vẫn tính số lượng xuất kho', () => {
    const gift = calculatePrice({ ...base, quantity: '1', baseUnitPrice: '586000', gift: true });
    expect(gift.unitPrice).toBe('0.00');
    expect(gift.grossAmount).toBe('0.00');
    expect(gift.baseQuantity).toBe('1');
  });
});

/** Công thức Decimal trước khi chuyển sang priceLine() dùng chung — giữ lại để đối chiếu ngẫu nhiên. */
function legacyCalculate(input: { quantity: string; factor: string; price: string; discount: string; tax: string; included: boolean }) {
  const quantity = new Decimal(input.quantity);
  const taxFactor = new Decimal(1).add(new Decimal(input.tax).div(100));
  const priceUnit = new Decimal(input.price).mul(input.factor);
  const discounted = priceUnit.mul(new Decimal(1).minus(new Decimal(input.discount).div(100)));
  const listUnit = (input.included ? priceUnit.div(taxFactor) : priceUnit).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  const unit = (input.included ? discounted.div(taxFactor) : discounted).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  const net = quantity.mul(unit);
  const tax = net.mul(input.tax).div(100);
  const money = (value: Decimal) => value.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
  return { listUnitPrice: money(listUnit), unitPrice: money(unit), subtotal: money(quantity.mul(listUnit)), netAmount: money(net), taxAmount: money(tax), grossAmount: money(net.add(tax)) };
}

describe('calculatePrice — đối chiếu với công thức Decimal cũ', () => {
  it('5.000 ca ngẫu nhiên (giá, quy đổi, CK, 5 mức thuế, số lượng lẻ) cho kết quả giống hệt', () => {
    let seed = 20261001;
    const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const pick = <T,>(items: readonly T[]) => items[Math.floor(random() * items.length)] as T;
    for (let index = 0; index < 5000; index += 1) {
      const price = String(Math.round(random() * 5_000_000) * (random() < 0.2 ? 1 : 1000) / (random() < 0.1 ? 100 : 1));
      const factor = pick(['1', '2', '4', '6', '12', '24', '0.5']);
      const quantity = random() < 0.15 ? (Math.round(random() * 400) / 4).toString() : String(1 + Math.floor(random() * 300));
      const discount = pick(['0', '1', '2', '2.5', '3', '4', '6', '7', '10', '12.75']);
      const rate = pick(['10', '8', '5', '3', 'KCT'] as const);
      const included = random() < 0.8;
      const result = calculatePrice({
        quantity, conversionFactor: factor, baseUnitPrice: price,
        tierDiscountRate: discount, salesTierDiscountRate: '0', promotionDiscountRate: '0', discountCapRate: '15',
        taxRate: rate, pricesIncludeTax: included,
      });
      const expected = legacyCalculate({ quantity, factor, price, discount, tax: rate === 'KCT' ? '0' : rate, included });
      expect({ ...result, case: index }).toMatchObject({ ...expected, case: index });
      const totals = documentTotals(result.netAmount, rate);
      const net = new Decimal(result.netAmount);
      const taxRate = rate === 'KCT' ? 0 : Number(rate);
      expect(totals.taxTotal).toBe(net.mul(taxRate).div(100).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toFixed(0));
      expect(totals.grandTotal).toBe(net.mul(100 + taxRate).div(100).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toFixed(0));
    }
  });

  it('KCT: không tính thuế, tổng thanh toán = thành tiền', () => {
    const result = calculatePrice({
      quantity: '15', conversionFactor: '1', baseUnitPrice: '586000', tierDiscountRate: '0', salesTierDiscountRate: '0',
      promotionDiscountRate: '0', discountCapRate: '10', taxRate: 'KCT', pricesIncludeTax: true,
    });
    expect(result.unitPrice).toBe('586000.00');
    expect(result.taxAmount).toBe('0.00');
    expect(documentTotals(result.netAmount, 'KCT')).toEqual({ netTotal: '8790000', taxTotal: '0', grandTotal: '8790000' });
  });
});
