import { describe, expect, it } from 'vitest';
import { cartonCbm, cartonSplit, cartonsNeeded, containerPlan, containerPlanLabel, packingLine, packingTotals } from './packing';

describe('đóng gói', () => {
  it('tính CBM một thùng từ kích thước cm', () => {
    expect(cartonCbm(60, 40, 35)).toBe(0.084);
    expect(cartonCbm('52', '38', '30')).toBe(0.0593);
    expect(cartonCbm(60, 40, undefined)).toBeNull();
    expect(cartonCbm(0, 40, 35)).toBeNull();
  });

  it('chia thùng chẵn / cái lẻ và số thùng cần', () => {
    expect(cartonSplit(250, 24)).toEqual({ cartons: 10, loose: 10 });
    expect(cartonsNeeded(250, 24)).toBe(11);
    expect(cartonsNeeded(240, 24)).toBe(10);
    expect(cartonSplit(7, undefined)).toEqual({ cartons: 0, loose: 7 });
    expect(cartonsNeeded(7, undefined)).toBe(0);
  });

  it('cộng thùng / CBM / kg theo dòng và đánh dấu dòng thiếu quy cách', () => {
    const line = packingLine({ quantity: 250, packSize: 24, cartonLengthCm: 60, cartonWidthCm: 40, cartonHeightCm: 35, grossKgPerCarton: '18.5', netKgPerCarton: 17 });
    expect(line).toEqual({ cartons: 11, cbm: 0.924, grossKg: 203.5, netKg: 187, incomplete: false });
    const totals = packingTotals([
      { quantity: 250, packSize: 24, cartonLengthCm: 60, cartonWidthCm: 40, cartonHeightCm: 35, grossKgPerCarton: 18.5 },
      { quantity: 10 },
    ]);
    expect(totals.cartons).toBe(11);
    expect(totals.cbm).toBe(0.924);
    expect(totals.incomplete).toBe(true);
    expect(totals.incompleteLines).toBe(1);
  });

  it('gợi ý container theo thể tích và khối lượng', () => {
    expect(containerPlan(5)).toBeNull();
    expect(containerPlanLabel(containerPlan(5))).toBe('LCL');
    expect(containerPlanLabel(containerPlan(20))).toBe('1 × 20GP');
    expect(containerPlan(20)?.fill).toBe(0.7143);
    expect(containerPlanLabel(containerPlan(50))).toBe('1 × 40GP');
    expect(containerPlanLabel(containerPlan(65))).toBe('1 × 40HQ');
    expect(containerPlanLabel(containerPlan(90))).toBe('1 × 40HQ + 1 × 20GP');
    expect(containerPlanLabel(containerPlan(140))).toBe('2 × 40HQ + 1 × 20GP');
    expect(containerPlanLabel(containerPlan(130))).toBe('2 × 40HQ');
    // Hàng nặng: 25 CBM nhưng 24 tấn không vừa 20GP (21,7 tấn) → 40GP.
    expect(containerPlanLabel(containerPlan(25, 24_000))).toBe('1 × 40GP');
  });
});
