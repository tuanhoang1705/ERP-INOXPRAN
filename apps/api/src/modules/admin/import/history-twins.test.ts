import { describe, expect, it } from 'vitest';
import { findErpTwins, type TwinEntry, type TwinOrder } from './history-twins';

// Lô KH001 thật: sổ cũ BH2026090104 ngày 30/09 (ngày đơn), kho xuất 01/10, sếp lập lại trên ERP là BH2026100104.
const cookers = ['INP6004', 'INP6005', 'INP6006', 'INP6007', 'INP6008', 'INP6009', 'INP6010'];
const entry = (extra: Partial<TwinEntry> = {}): TwinEntry => ({
  id: 'LS00026', customerCode: 'KH001', date: '2026-09-30', documentNo: 'BH2026090104', amount: '66149999.95',
  lines: cookers.map((sku) => ({ sku, quantity: '15', amount: '9000000' })), ...extra,
});
const order = (extra: Partial<TwinOrder> = {}): TwinOrder => ({
  code: 'BH2026100104', customerCode: 'KH001', orderDate: '2026-10-01', debt: '66150000.00',
  lines: [...cookers.map((sku) => ({ sku, quantity: '15', paid: true })), ...cookers.map((sku) => ({ sku, quantity: '1', paid: false })), { sku: 'INP7951', quantity: '2', paid: false }],
  ...extra,
});

describe('findErpTwins', () => {
  it('cùng khách, cùng dòng hàng có tiền, công nợ lệch 0,05 đ → nghi trùng (khớp cả hai)', () => {
    expect(findErpTwins([entry()], [order()])).toEqual([{
      id: 'LS00026', customerCode: 'KH001', date: '2026-09-30', documentNo: 'BH2026090104', amount: '66149999.95',
      order: { code: 'BH2026100104', orderDate: '2026-10-01', debt: '66150000.00' }, sameAmount: true, sameLines: true,
    }]);
  });
  it('chỉ khớp dòng hàng (giá trên ERP khác) vẫn báo', () => {
    const [twin] = findErpTwins([entry()], [order({ debt: '70000000' })]);
    expect(twin?.sameLines).toBe(true);
    expect(twin?.sameAmount).toBe(false);
  });
  it('khác khách, ngoài khoảng ngày hoặc không khớp gì → không báo', () => {
    expect(findErpTwins([entry()], [order({ customerCode: 'KH002' })])).toEqual([]);
    expect(findErpTwins([entry()], [order({ orderDate: '2026-11-15' })])).toEqual([]);
    expect(findErpTwins([entry()], [order({ orderDate: '2026-09-20' })])).toEqual([]);
    expect(findErpTwins([entry()], [order({ debt: '1000000', lines: [{ sku: 'INP6004', quantity: '2', paid: true }] })])).toEqual([]);
  });
  it('mã có khoảng trắng / chữ thường vẫn so được', () => {
    expect(findErpTwins([entry({ amount: '1', lines: [{ sku: ' inp6004 ', quantity: '15', amount: '1' }] })], [order({ debt: '5', lines: [{ sku: 'INP6004', quantity: '15', paid: true }] })])).toHaveLength(1);
  });
  it('mỗi phiếu ERP ghép một chứng từ: ưu tiên khớp cả hai, rồi ngày gần nhất', () => {
    const twins = findErpTwins(
      [entry({ id: 'LS1', date: '2026-09-20', lines: [] }), entry({ id: 'LS2' })],
      [order()],
    );
    expect(twins.map((twin) => twin.id)).toEqual(['LS2']);
  });
});
