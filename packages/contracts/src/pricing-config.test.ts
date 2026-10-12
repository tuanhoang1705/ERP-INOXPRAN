import { describe, expect, it } from 'vitest';
import { canEditPricing, PricingPolicyInputSchema, PromotionInputSchema, UpdatePromotionSchema } from './index.js';

const policy = {
  version: 0,
  discountCapRate: '10',
  salesTierPeriod: 'ROLLING_90D' as const,
  salesTiers: [
    { minimumRevenue: '150000000', discountRate: '1' },
    { minimumRevenue: '400000000', discountRate: '2' },
  ],
  customerTierDiscounts: { TIER_1: '0', TIER_2: '0', RETAIL: '0' },
};
const paths = (result: { success: boolean; error?: { issues: Array<{ path: PropertyKey[] }> } }) => (result.error?.issues ?? []).map((issue) => issue.path.join('.'));

describe('PricingPolicyInputSchema', () => {
  it('nhận cấu hình hợp lệ', () => {
    expect(PricingPolicyInputSchema.safeParse(policy).success).toBe(true);
    expect(PricingPolicyInputSchema.safeParse({ ...policy, salesTiers: [] }).success).toBe(true);
  });
  it('mốc doanh số phải tăng dần, chiết khấu bậc sau không thấp hơn bậc trước', () => {
    const result = PricingPolicyInputSchema.safeParse({ ...policy, salesTiers: [{ minimumRevenue: '400000000', discountRate: '2' }, { minimumRevenue: '150000000', discountRate: '1' }] });
    expect(paths(result)).toEqual(['salesTiers.1.minimumRevenue', 'salesTiers.1.discountRate']);
  });
  it('không vượt trần chiết khấu', () => {
    const result = PricingPolicyInputSchema.safeParse({ ...policy, discountCapRate: '1.5', customerTierDiscounts: { TIER_1: '3', TIER_2: '0', RETAIL: '0' } });
    expect(paths(result)).toEqual(['salesTiers.1.discountRate', 'customerTierDiscounts.TIER_1']);
    expect(PricingPolicyInputSchema.safeParse({ ...policy, discountCapRate: '60' }).success).toBe(false);
  });
});

describe('PromotionInputSchema', () => {
  const promotion = { code: 'KM-TET-2027', name: 'Chào Tết 2027', discountRate: '5', validFrom: '2026-12-15', validTo: '2027-02-10' };
  it('mặc định áp dụng mọi sản phẩm, mọi cấp khách; mã hàng viết hoa', () => {
    const parsed = PromotionInputSchema.parse({ ...promotion, productSkus: ['inp6001'] });
    expect(parsed).toMatchObject({ categoryIds: [], customerTiers: [], productSkus: ['INP6001'] });
  });
  it('ngày kết thúc không trước ngày bắt đầu, mức giảm lớn hơn 0', () => {
    expect(paths(PromotionInputSchema.safeParse({ ...promotion, validTo: '2026-12-01' }))).toEqual(['validTo']);
    expect(PromotionInputSchema.safeParse({ ...promotion, discountRate: '0' }).success).toBe(false);
    expect(UpdatePromotionSchema.safeParse({ version: 1, ...promotion, code: undefined }).success).toBe(true);
  });
});

describe('canEditPricing', () => {
  it('chỉ Giám đốc, kế toán, quản trị', () => {
    expect(canEditPricing(['DIRECTOR'])).toBe(true);
    expect(canEditPricing(['ACCOUNTANT'])).toBe(true);
    expect(canEditPricing(['SALES_MANAGER'])).toBe(false);
    expect(canEditPricing(['SALES'])).toBe(false);
  });
});
