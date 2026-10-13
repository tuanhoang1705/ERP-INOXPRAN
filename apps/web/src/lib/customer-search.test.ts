import { describe, expect, it } from 'vitest';
import { customerLabel, phoneDigits, searchCustomers } from './customer-search';

const customers = [
  { id: '1', code: 'KH001', name: 'Công ty TNHH Thương mại Cảnh Cường', province: 'Thanh Hóa', phone: '0912 100 200' },
  { id: '2', code: 'KH002', name: 'Đại lý Kinh Bắc', province: 'Bắc Ninh', phone: '+84 988.123.456' },
  { id: '3', code: 'KH010', name: 'Siêu thị Hùng Vương', province: 'Hà Nội', phone: '024 3333 1010', taxCode: '0101234567' },
];

describe('tìm người mua trên phiếu BH', () => {
  it('gõ số điện thoại (có hoặc không khoảng trắng, +84 ≈ 0) → ra đúng khách', () => {
    expect(searchCustomers(customers, '0912100200').map((row) => row.id)).toEqual(['1']);
    expect(searchCustomers(customers, '0988 123').map((row) => row.id)).toEqual(['2']);
    expect(searchCustomers(customers, '123456')[0]?.id).toBe('2');
    expect(phoneDigits('+84 988.123.456')).toBe('0988123456');
  });
  it('gõ tên không dấu, mã khách, tỉnh hoặc mã số thuế', () => {
    expect(searchCustomers(customers, 'canh cuong').map((row) => row.id)).toEqual(['1']);
    expect(searchCustomers(customers, 'kh010')[0]?.id).toBe('3');
    expect(searchCustomers(customers, 'bac ninh').map((row) => row.id)).toEqual(['2']);
    expect(searchCustomers(customers, '0101234567').map((row) => row.id)).toEqual(['3']);
  });
  it('mã trùng khớp xếp trước; ô trống trả về cả danh sách; nhãn hiển thị có tỉnh', () => {
    expect(searchCustomers(customers, 'KH00').map((row) => row.id)).toEqual(['1', '2']);
    expect(searchCustomers(customers, '')).toHaveLength(3);
    expect(searchCustomers(customers, 'không có ai')).toHaveLength(0);
    expect(customerLabel(customers[1]!)).toBe('KH002 — Đại lý Kinh Bắc (Bắc Ninh)');
  });
});
