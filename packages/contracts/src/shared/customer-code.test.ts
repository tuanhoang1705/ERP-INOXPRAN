import { describe, expect, it } from 'vitest';
import { customerCodeNumber, nextFreeCustomerCode } from './customer-code.js';

describe('nextFreeCustomerCode (CUS-CODE-01)', () => {
  it('chưa có khách: KH001; KH000 (khách lẻ) không tính, không cấp', () => {
    expect(nextFreeCustomerCode([])).toEqual({ code: 'KH001', highest: null, fillsGap: false });
    expect(nextFreeCustomerCode(['KH000'])).toEqual({ code: 'KH001', highest: null, fillsGap: false });
  });

  it('dãy liền: số kế tiếp sau mã lớn nhất', () => {
    expect(nextFreeCustomerCode(['KH000', 'KH001', 'KH002', 'KH003'])).toEqual({ code: 'KH004', highest: 'KH003', fillsGap: false });
  });

  it('có số trống (khách đã xóa): lấp số trống nhỏ nhất trước', () => {
    expect(nextFreeCustomerCode(['KH001', 'KH002', 'KH004', 'KH005', 'KH007'])).toEqual({ code: 'KH003', highest: 'KH007', fillsGap: true });
    expect(nextFreeCustomerCode(['KH002', 'KH003'])).toMatchObject({ code: 'KH001', fillsGap: true });
  });

  it('bỏ qua mã không theo dạng KH + số (NCC, mã MISA khác dạng)', () => {
    expect(nextFreeCustomerCode(['NCC-OEM-QD', 'KH001', 'KH002A', 'kh003', 'MISA-KH05'])).toMatchObject({ code: 'KH002', highest: 'KH001' });
  });

  it('KH020 và KH0020 là cùng số; quá 999 thì thành 4 chữ số', () => {
    expect(customerCodeNumber('KH0020')).toBe(20);
    expect(nextFreeCustomerCode(['KH001', 'KH0002'])).toMatchObject({ code: 'KH003' });
    const all = Array.from({ length: 999 }, (_, index) => `KH${String(index + 1).padStart(3, '0')}`);
    expect(nextFreeCustomerCode(all)).toEqual({ code: 'KH1000', highest: 'KH999', fillsGap: false });
  });
});
