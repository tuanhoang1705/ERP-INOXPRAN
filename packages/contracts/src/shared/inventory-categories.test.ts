import { describe, expect, it } from 'vitest';
import { categoryAmount, categoryOf, INVENTORY_CATEGORIES, monthlyBalance, remainingPercent } from './inventory-categories.js';

describe('categoryOf', () => {
  it('ưu tiên loại đã ghi trên phát sinh', () => {
    expect(categoryOf({ movementType: 'SALES_SHIPMENT', direction: 'OUT', category: 'GIFT_OUT' })).toBe('GIFT_OUT');
    expect(categoryOf({ movementType: 'ADJUSTMENT_OUT', direction: 'OUT', category: 'SAMPLE_OUT' })).toBe('SAMPLE_OUT');
  });
  it('suy ra loại cho dữ liệu cũ', () => {
    expect(categoryOf({ movementType: 'SALES_SHIPMENT', direction: 'OUT' })).toBe('SALES_OUT');
    expect(categoryOf({ movementType: 'PURCHASE_RECEIPT', direction: 'IN' })).toBe('PURCHASE_IN');
    expect(categoryOf({ movementType: 'WARRANTY_DEFECT_IN', direction: 'IN' })).toBe('USAGE_DEFECT_IN');
    expect(categoryOf({ movementType: 'ADJUSTMENT_IN', direction: 'IN', category: 'KHONG_CO' })).toBe('ADJUST_IN');
  });
  it('hoàn tác tồn đầu kỳ trừ vào cột tồn đầu kỳ', () => {
    const category = categoryOf({ movementType: 'REVERSAL', direction: 'OUT' });
    expect(category).toBe('OPENING_IN');
    expect(categoryAmount(category, 'OUT', 5)).toBe(-5);
  });
});

describe('monthlyBalance — cách tính của 月库存明细单', () => {
  it('tháng 9, INP6005: 531 + 80 nhập − 76 bán − 5 tặng = 530, xuất tổng hợp 1', () => {
    expect(monthlyBalance(531, { PURCHASE_IN: 80, SALES_OUT: 76, GIFT_OUT: 5 })).toEqual({ netOut: 1, closing: 530 });
  });
  it('tháng 9, INP1001: hàng lỗi do sử dụng nhập lại được cộng vào tồn', () => {
    expect(monthlyBalance(632, { SALES_OUT: 15, USAGE_DEFECT_IN: 1 })).toEqual({ netOut: 14, closing: 618 });
  });
  it('tháng 10, INP6151: mã mới nhập 1.062, bán 2, mẫu 1 → xuất tổng hợp âm', () => {
    expect(monthlyBalance(0, { PURCHASE_IN: 1062, SALES_OUT: 2, SAMPLE_OUT: 1 })).toEqual({ netOut: -1059, closing: 1059 });
  });
});

describe('remainingPercent', () => {
  it('tồn cuối ÷ số nhập ban đầu', () => {
    expect(remainingPercent(1059, 1062)).toBe(99.72);
    expect(remainingPercent(598, 860)).toBe(69.53);
    expect(remainingPercent(10, 0)).toBeNull();
  });
});

describe('INVENTORY_CATEGORIES', () => {
  it('11 cột đầu theo đúng thứ tự file Excel của công ty', () => {
    expect(INVENTORY_CATEGORIES.slice(0, 11).map((item) => item.zh)).toEqual([
      '本月（入库）', '本月（出库）', '本月损耗（出库）', '样品（出库）', '活动赠送·套餐搭配（出库）', '活动赠送·套餐搭配退回（入库）',
      '进口不良（入库）', '使用不良（入库）', '滞销退货（入库）', '样品（入库）', '库存退货（出库返厂）',
    ]);
  });
});
