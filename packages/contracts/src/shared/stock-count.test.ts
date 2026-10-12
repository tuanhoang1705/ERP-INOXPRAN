import { describe, expect, it } from 'vitest';
import { compareQuantities, compareSkus, stockCountSummary } from './stock-count.js';
import { foldText } from './text.js';

const erp = [
  { productId: 'a', sku: 'INP1001', onHand: 598 },
  { productId: 'b', sku: 'INP1002', onHand: 729 },
  { productId: 'c', sku: 'INP1003', onHand: 0 },
  { productId: 'd', sku: 'INP1101', onHand: 674 },
];

describe('foldText — tìm không dấu', () => {
  it('bỏ dấu, đ → d, chữ thường, gộp khoảng trắng', () => {
    expect(foldText('  Kiểm   kê KHO ')).toBe('kiem ke kho');
    expect(foldText('Điều chỉnh tồn')).toBe('dieu chinh ton');
    expect(foldText('库存')).toBe('库存');
  });
});

describe('compareSkus — bước 1 kiểm tồn sản phẩm', () => {
  it('khớp, kho có mà ERP hết, ERP còn mà kho không nhập; giữ thứ tự nhập rồi thêm mã ERP thiếu', () => {
    const rows = compareSkus([{ productId: 'c', sku: 'INP1003' }, { productId: 'a', sku: 'INP1001' }], erp, new Set(['d']));
    expect(rows.map((row) => [row.sku, row.state])).toEqual([
      ['INP1003', 'ONLY_COUNTED'],
      ['INP1001', 'MATCH'],
      ['INP1002', 'ONLY_ERP'],
      ['INP1101', 'ONLY_ERP'],
    ]);
    expect(rows.find((row) => row.sku === 'INP1101')?.movedSinceStart).toBe(true);
    expect(stockCountSummary(rows)).toEqual({ total: 4, matched: 1, mismatched: 3 });
  });
  it('nhập trùng mã chỉ tính một dòng; đủ mã thì khớp hết', () => {
    const rows = compareSkus([{ productId: 'a', sku: 'INP1001' }, { productId: 'b', sku: 'INP1002' }, { productId: 'd', sku: 'INP1101' }, { productId: 'a', sku: 'INP1001' }], erp);
    expect(stockCountSummary(rows)).toEqual({ total: 3, matched: 3, mismatched: 0 });
  });
});

describe('compareQuantities — bước 2 kiểm tồn số lượng', () => {
  it('khớp, lệch, chưa đếm, ngoài danh sách đã chốt, ERP còn mà không ai đếm', () => {
    const rows = compareQuantities(
      [{ productId: 'b', sku: 'INP1002', quantity: 728 }, { productId: 'a', sku: 'INP1001', quantity: 598 }, { productId: 'c', sku: 'INP1003', quantity: 2 }],
      erp,
      ['a', 'b', 'x'],
      new Set(['b']),
      (id) => (id === 'x' ? 'INP9999' : id),
    );
    expect(rows.map((row) => [row.sku, row.state, row.counted, row.difference])).toEqual([
      ['INP1002', 'DIFF', 728, -1],
      ['INP1001', 'MATCH', 598, 0],
      ['INP1003', 'NOT_IN_SKU_LIST', 2, 2],
      ['INP9999', 'NOT_COUNTED', null, null],
      ['INP1101', 'ONLY_ERP', null, null],
    ]);
    expect(rows[0]?.movedSinceStart).toBe(true);
  });
  it('đếm 0 với mã ERP đã hết là khớp; số lẻ so tới 4 chữ số', () => {
    const rows = compareQuantities([{ productId: 'c', sku: 'INP1003', quantity: 0 }, { productId: 'a', sku: 'INP1001', quantity: 598.00001 }], erp.filter((line) => line.productId !== 'b' && line.productId !== 'd'), ['a']);
    expect(rows.map((row) => row.state)).toEqual(['MATCH', 'MATCH']);
  });
});
