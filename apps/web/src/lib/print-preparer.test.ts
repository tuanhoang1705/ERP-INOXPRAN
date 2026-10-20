import { describe, expect, it } from 'vitest';
import { slipPreparerName } from './print-preparer';

const order = { issuedByName: 'Kế toán lập phiếu', shippedByName: 'Thủ kho xuất' };

describe('slipPreparerName', () => {
  it('BH: kế toán / Admin đang mở → in họ tên người đang mở', () => {
    expect(slipPreparerName('BH', { displayName: 'Nguyễn Thị Kế Toán', roles: ['ACCOUNTANT'] }, order)).toBe('Nguyễn Thị Kế Toán');
    expect(slipPreparerName('BH', { displayName: 'Quản trị', roles: ['ADMIN'] }, order)).toBe('Quản trị');
    expect(slipPreparerName('BH', { displayName: 'Gốc', roles: [], root: true }, order)).toBe('Gốc');
  });
  it('BH: thủ kho / NVKD / Giám đốc mở → giữ tên người đã lập phiếu', () => {
    expect(slipPreparerName('BH', { displayName: 'Thủ kho A', roles: ['WAREHOUSE'] }, order)).toBe('Kế toán lập phiếu');
    expect(slipPreparerName('BH', { displayName: 'NV KD', roles: ['SALES'] }, order)).toBe('Kế toán lập phiếu');
    expect(slipPreparerName('BH', { displayName: 'Giám đốc', roles: ['DIRECTOR'] }, order)).toBe('Kế toán lập phiếu');
  });
  it('SWK: thủ kho / quản lý kho đang mở → in họ tên người đang mở; kế toán mở → tên người xuất', () => {
    expect(slipPreparerName('SWK', { displayName: 'Thủ kho B', roles: ['WAREHOUSE'] }, order)).toBe('Thủ kho B');
    expect(slipPreparerName('SWK', { displayName: 'QL kho', roles: ['WAREHOUSE_MANAGER'] }, order)).toBe('QL kho');
    expect(slipPreparerName('SWK', { displayName: 'Kế toán', roles: ['ACCOUNTANT'] }, order)).toBe('Thủ kho xuất');
  });
  it('không biết người đang mở → tên đã lưu', () => {
    expect(slipPreparerName('BH', null, order)).toBe('Kế toán lập phiếu');
    expect(slipPreparerName('SWK', { displayName: '  ', roles: ['WAREHOUSE'] }, {})).toBe('');
  });
});
