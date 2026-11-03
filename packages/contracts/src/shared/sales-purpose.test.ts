import { describe, expect, it } from 'vitest';
import { CreateSalesOrderSchema } from '../index.js';
import { categoryInfo } from './inventory-categories.js';
import { defaultReturnDate, isLoanPurpose, isNonSale, isNonSalePurpose, loanInCategory, nonSaleOutCategory, orderParty, purposeOf, SALE_ONLY_FILTER, slipTypeFilter, slipTypeOf } from './sales-purpose.js';

const ID = '6ad03a72341e3981d6f66b4b';
const line = { productId: ID, unit: 'Cái', quantity: '1' };

describe('loại phiếu (SAL-TYPE-01)', () => {
  it('phiếu cũ không có purpose là phiếu bán; loại hiển thị theo kênh', () => {
    expect(purposeOf({})).toBe('SALE');
    expect(isNonSale({ purpose: undefined })).toBe(false);
    expect(slipTypeOf({ channel: 'B2C' })).toBe('B2C');
    expect(slipTypeOf({})).toBe('B2B');
    expect(slipTypeOf({ purpose: 'SAMPLE', channel: 'B2C' })).toBe('SAMPLE');
    expect(slipTypeOf({ purpose: 'INSPECTION' })).toBe('INSPECTION');
  });

  it('bộ lọc Mongo: B2B / B2C chỉ phiếu bán, hàng mẫu / kiểm định theo purpose', () => {
    expect(slipTypeFilter('SAMPLE')).toEqual({ purpose: 'SAMPLE' });
    expect(slipTypeFilter('GIFT')).toEqual({ purpose: 'GIFT' });
    expect(slipTypeFilter('B2C')).toEqual({ purpose: { $nin: ['SAMPLE', 'INSPECTION', 'GIFT', 'WARRANTY'] }, channel: 'B2C' });
    expect(slipTypeFilter('B2B')).toEqual({ purpose: { $nin: ['SAMPLE', 'INSPECTION', 'GIFT', 'WARRANTY'] }, channel: { $ne: 'B2C' } });
    expect(SALE_ONLY_FILTER).toEqual({ purpose: { $nin: ['SAMPLE', 'INSPECTION', 'GIFT', 'WARRANTY'] } });
  });

  it('phiếu đổi bảo hành (02/11/2026): không tính doanh thu, có khách, thẻ kho "Xuất đổi bảo hành", không lập trên form', () => {
    const order = { purpose: 'WARRANTY', channel: 'B2B', customerName: 'Công ty Bằng Ánh', salesRepName: 'Trần Ngọc Kiên' };
    expect(isNonSalePurpose('WARRANTY')).toBe(true);
    expect(isLoanPurpose('WARRANTY')).toBe(false);
    expect(slipTypeOf(order)).toBe('WARRANTY');
    expect(slipTypeFilter('WARRANTY')).toEqual({ purpose: 'WARRANTY' });
    expect(orderParty(order)).toBe('Công ty Bằng Ánh');
    expect(nonSaleOutCategory('WARRANTY')).toBe('WARRANTY_OUT');
    expect(CreateSalesOrderSchema.safeParse({ purpose: 'WARRANTY', warehouseId: '6ae5f4ebdb3a1121be416088', salesRepId: '6ae5f4ebdb3a1121be416083', lines: [{ productId: '6ae5f4ecdb3a1121be4160a6', unit: 'Bộ', quantity: '1' }] }).success).toBe(false);
  });

  it('thẻ kho: hàng mẫu dùng cột 样品, kiểm định có cột riêng (chỉ hiện khi có)', () => {
    expect(nonSaleOutCategory('SAMPLE')).toBe('SAMPLE_OUT');
    expect(loanInCategory('SAMPLE')).toBe('SAMPLE_IN');
    expect(nonSaleOutCategory('INSPECTION')).toBe('INSPECTION_OUT');
    expect(nonSaleOutCategory('GIFT')).toBe('GIFT_OUT');
    expect(loanInCategory('INSPECTION')).toBe('INSPECTION_IN');
    expect(categoryInfo('INSPECTION_OUT')).toMatchObject({ direction: 'OUT', optional: true });
    expect(categoryInfo('INSPECTION_IN')).toMatchObject({ direction: 'IN', optional: true });
  });

  it('bên nhận: tên khách, hoặc người mượn + nơi gửi', () => {
    expect(orderParty({ customerName: 'Đại lý A' })).toBe('Đại lý A');
    expect(orderParty({ purpose: 'SAMPLE', salesRepName: 'Trần Ngọc Kiên', destination: 'NPP Minh Phát' })).toBe('Hàng mẫu — Trần Ngọc Kiên (gửi NPP Minh Phát)');
    expect(orderParty({ purpose: 'INSPECTION', salesRepName: 'Kiên' })).toBe('Kiểm định — Kiên');
    expect(orderParty({ purpose: 'GIFT', salesRepName: 'Kiên', destination: 'Đại lý Minh Phát' })).toBe('Xuất tặng — Kiên (tặng Đại lý Minh Phát)');
  });

  it('xuất tặng: không phải bán nhưng không có hàng về; hẹn trả mặc định +15 ngày', () => {
    expect(isNonSalePurpose('GIFT')).toBe(true);
    expect(isLoanPurpose('GIFT')).toBe(false);
    expect(isLoanPurpose('SAMPLE') && isLoanPurpose('INSPECTION')).toBe(true);
    expect(defaultReturnDate('2026-10-15')).toBe('2026-10-30');
    expect(defaultReturnDate('2026-12-20')).toBe('2027-01-04');
  });

  it('schema: phiếu bán cần khách; hàng mẫu cần người mượn, không khách / giá sửa tay / hàng tặng', () => {
    const base = { warehouseId: ID, lines: [line] };
    expect(CreateSalesOrderSchema.safeParse({ ...base, customerId: ID }).success).toBe(true);
    expect(CreateSalesOrderSchema.safeParse(base).success).toBe(false);
    expect(CreateSalesOrderSchema.safeParse({ ...base, purpose: 'SAMPLE', salesRepId: ID }).success).toBe(true);
    expect(CreateSalesOrderSchema.safeParse({ ...base, purpose: 'SAMPLE' }).success).toBe(false);
    expect(CreateSalesOrderSchema.safeParse({ ...base, purpose: 'SAMPLE', salesRepId: ID, customerId: ID }).success).toBe(false);
    expect(CreateSalesOrderSchema.safeParse({ ...base, purpose: 'INSPECTION', salesRepId: ID, lines: [{ ...line, overrideUnitPrice: '0' }] }).success).toBe(false);
    expect(CreateSalesOrderSchema.safeParse({ ...base, purpose: 'INSPECTION', salesRepId: ID, lines: [line, { ...line, gift: true }] }).success).toBe(false);
    expect(CreateSalesOrderSchema.safeParse({ ...base, purpose: 'GIFT', salesRepId: ID, destination: 'Đại lý A' }).success).toBe(true);
    expect(CreateSalesOrderSchema.safeParse({ ...base, purpose: 'GIFT', salesRepId: ID, expectedReturnDate: '2026-10-30' }).success).toBe(false);
    expect(CreateSalesOrderSchema.safeParse({ ...base, purpose: 'SAMPLE', salesRepId: ID, expectedReturnDate: '2026-10-30' }).success).toBe(true);
  });
});
