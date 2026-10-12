/**
 * Kiểm tra sớm cấu hình giá / CTKM trên giao diện, cùng quy tắc với PricingPolicyInputSchema / PromotionInputSchema
 * (máy chủ vẫn kiểm tra lại). Lỗi trả về theo đường dẫn ô ("salesTiers.1.minimumRevenue") để hiện dưới đúng ô.
 */
import { m } from '$lib/paraglide/messages';

export const MAX_DISCOUNT_CAP_RATE = 50;
const PERCENT = /^\d+(\.\d{1,2})?$/;
const MONEY = /^\d+(\.\d{1,2})?$/;

export interface PolicyDraft {
  discountCapRate: string;
  salesTierPeriod: string;
  salesTiers: Array<{ minimumRevenue: string; discountRate: string }>;
  customerTierDiscounts: Record<'TIER_1' | 'TIER_2' | 'RETAIL', string>;
}

function percentError(value: string): string | null {
  if (!PERCENT.test(value) || Number(value) > 100) return m.pc_loi_ty_le();
  return null;
}

export function validatePolicy(draft: PolicyDraft): Record<string, string> {
  const errors: Record<string, string> = {};
  const capError = percentError(draft.discountCapRate);
  if (capError) errors.discountCapRate = capError;
  else if (Number(draft.discountCapRate) > MAX_DISCOUNT_CAP_RATE) errors.discountCapRate = m.pc_loi_tran_toi_da({ max: MAX_DISCOUNT_CAP_RATE });
  const cap = Number(draft.discountCapRate);
  if (draft.salesTiers.length > 10) errors.salesTiers = m.pc_toi_da_10_bac();
  draft.salesTiers.forEach((tier, index) => {
    const previous = draft.salesTiers[index - 1];
    const revenueKey = `salesTiers.${index}.minimumRevenue`;
    const rateKey = `salesTiers.${index}.discountRate`;
    if (!MONEY.test(tier.minimumRevenue) || Number(tier.minimumRevenue) <= 0) errors[revenueKey] = m.pc_loi_lon_hon_0();
    else if (previous && Number(tier.minimumRevenue) <= Number(previous.minimumRevenue)) errors[revenueKey] = m.pc_loi_tang_dan();
    const rateError = percentError(tier.discountRate);
    if (rateError) errors[rateKey] = rateError;
    else if (!capError && Number(tier.discountRate) > cap) errors[rateKey] = m.pc_loi_vuot_tran();
    else if (previous && Number(tier.discountRate) < Number(previous.discountRate)) errors[rateKey] = m.pc_loi_bac_thap_hon();
  });
  for (const [tier, rate] of Object.entries(draft.customerTierDiscounts)) {
    const key = `customerTierDiscounts.${tier}`;
    const rateError = percentError(rate);
    if (rateError) errors[key] = rateError;
    else if (!capError && Number(rate) > cap) errors[key] = m.pc_loi_vuot_tran();
  }
  return errors;
}

export interface PromotionDraft {
  code: string;
  name: string;
  discountRate: string;
  validFrom: string;
  validTo: string;
  categoryIds: string[];
  productSkus: string;
  customerTiers: string[];
}

export function parseSkus(text: string): string[] {
  return [...new Set(text.split(/[\s,;]+/).map((sku) => sku.trim().toUpperCase()).filter(Boolean))];
}

export function validatePromotion(draft: PromotionDraft, cap: number, creating: boolean): Record<string, string> {
  const errors: Record<string, string> = {};
  if (creating) {
    if (!draft.code.trim()) errors.code = m.kh_bat_buoc_chon();
    else if (!/^[A-Z0-9][A-Z0-9._/-]{1,39}$/.test(draft.code.trim())) errors.code = m.kh_ma_quy_tac();
  }
  if (draft.name.trim().length < 3) errors.name = m.kh_ten_toi_thieu();
  const rateError = percentError(draft.discountRate);
  if (!draft.discountRate || Number(draft.discountRate) <= 0) errors.discountRate = m.pc_loi_lon_hon_0();
  else if (rateError) errors.discountRate = rateError;
  else if (Number(draft.discountRate) > cap) errors.discountRate = m.pc_loi_vuot_tran();
  if (!draft.validFrom) errors.validFrom = m.kh_bat_buoc_chon();
  if (!draft.validTo) errors.validTo = m.kh_bat_buoc_chon();
  else if (draft.validFrom && draft.validTo < draft.validFrom) errors.validTo = m.pc_loi_ngay();
  return errors;
}

/** Ngày (YYYY-MM-DD) theo giờ Việt Nam của một mốc thời gian ISO — để điền ô ngày khi sửa CTKM. */
export function vnDateOnly(iso: string): string {
  return new Date(new Date(iso).getTime() + 7 * 3_600_000).toISOString().slice(0, 10);
}
