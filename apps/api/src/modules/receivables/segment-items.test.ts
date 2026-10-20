import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { segmentItems, type ItemDocument, type ItemLine } from './segment-items';
import type { SegmentRule } from './segments';

const QUAT: SegmentRule = { code: 'QUAT-VOT', name: 'Quạt & vợt muỗi', categoryIds: ['cat-quat'], skus: ['INP7901'], manualOnly: false, active: true, sortOrder: 1, scope: 'SELECTED', partnerIds: ['kh068'] };
const MAU: SegmentRule = { code: 'MAU-KH015', name: 'Hàng mẫu KH015', categoryIds: [], skus: [], manualOnly: true, active: true, sortOrder: 2, scope: 'ALL', partnerIds: [] };
const line = (sku: string, quantity: string, weight: string, extra: Partial<ItemLine> = {}): ItemLine => ({ sku, quantity, weight, name: `Hàng ${sku}`, unit: 'Cái', ...extra });
const doc = (id: string, partnerId: string, parts: ItemDocument['parts'], lines: ItemLine[], extra: Partial<ItemDocument> = {}): ItemDocument => ({ id, code: id.toUpperCase(), date: '2026-06-08', partnerId, parts, lines, ...extra });

describe('segmentItems', () => {
  it('chứng từ gắn tay: mọi dòng có tiền của chứng từ, tổng thành tiền = phần nhóm còn nợ', () => {
    const [holding] = segmentItems([
      doc('ls00102', 'kh015', [{ code: 'MAU-KH015', amount: '3739999.96', paid: '0' }], [line('INP3002', '1', '570000'), line('INP3003', '1', '580000'), line('INP6802', '1', '850000'), line('INP3004', '1', '0', { gift: true })], { tag: 'MAU-KH015' }),
    ], [], [QUAT, MAU]);
    expect(holding?.skuCount).toBe(3);
    expect(holding?.quantity).toBe('3');
    expect(holding?.items.map((item) => item.sku)).toEqual(['INP3002', 'INP3003', 'INP6802']);
    expect(holding?.items.reduce((sum, item) => sum.add(item.amount), new Decimal(0)).toFixed(2)).toBe('3739999.96');
  });

  it('nhóm theo hàng: chỉ dòng khớp luật (nhóm hàng / mã thêm) của khách được nợ riêng', () => {
    const holdings = segmentItems([
      doc('d1', 'kh068', [{ code: 'QUAT-VOT', amount: '1000', paid: '0' }], [line('INP6408', '10', '600', { categoryId: 'cat-quat' }), line('INP7901', '5', '400'), line('INP1001', '2', '900')]),
    ], [], [QUAT, MAU]);
    expect(holdings[0]?.items.map((item) => [item.sku, item.quantity, item.amount])).toEqual([['INP6408', '10', '600.00'], ['INP7901', '5', '400.00']]);
  });

  it('thu một phần: còn hiện, thành tiền theo số còn nợ; thu đủ: không hiện', () => {
    const lines = [line('INP3001', '1', '620000')];
    expect(segmentItems([doc('a', 'kh015', [{ code: 'MAU-KH015', amount: '620000', paid: '120000' }], lines, { tag: 'MAU-KH015' })], [], [MAU])[0]?.outstanding).toBe('500000.00');
    expect(segmentItems([doc('a', 'kh015', [{ code: 'MAU-KH015', amount: '620000', paid: '620000' }], lines, { tag: 'MAU-KH015' })], [], [MAU])).toEqual([]);
  });

  it('hàng trả lại vào phần nhóm của chứng từ đang nợ: trừ số lượng', () => {
    const [holding] = segmentItems(
      [doc('d1', 'kh068', [{ code: 'QUAT-VOT', amount: '1000', paid: '400' }], [line('INP7901', '5', '1000')])],
      // Sổ cũ ghi số lượng hàng trả là số âm.
      [{ partnerId: 'kh068', allocations: [{ receivableId: 'd1', segment: 'QUAT-VOT', amount: '400' }], lines: [line('INP7901', '-2', '400')] }],
      [QUAT],
    );
    expect(holding?.items[0]).toMatchObject({ sku: 'INP7901', quantity: '3', returned: '2', amount: '600.00' });
  });

  it('tiền hàng trả trừ vào chứng từ cũ (không có mã đó): chứng từ cũ vẫn hiện, số lượng = bán − trả theo mã', () => {
    // A (INP6403 ×30) cũ hơn bị tiền hàng trả trả hết; B (INP6401 ×100) là chứng từ có hàng bị trả.
    const [holding] = segmentItems(
      [
        doc('a', 'kh042', [{ code: 'QUAT-VOT', amount: '300', paid: '300' }], [line('INP6403', '30', '300', { categoryId: 'cat-quat' })]),
        doc('b', 'kh042', [{ code: 'QUAT-VOT', amount: '1000', paid: '700' }], [line('INP6401', '100', '1000', { categoryId: 'cat-quat' })]),
      ],
      [{ partnerId: 'kh042', allocations: [{ receivableId: 'a', segment: 'QUAT-VOT', amount: '300' }, { receivableId: 'b', segment: 'QUAT-VOT', amount: '700' }], lines: [line('INP6401', '-100', '1000', { categoryId: 'cat-quat' })] }],
      [{ ...QUAT, partnerIds: ['kh042'] }],
    );
    expect(holding?.items).toEqual([{ sku: 'INP6403', name: 'Hàng INP6403', unit: 'Cái', quantity: '30', returned: '0', amount: '300.00' }]);
  });

  it('bán ghi mã chung (INP6401), trả lại ghi mã theo màu (INP6401-A / -B) → trừ vào mã chung', () => {
    const [holding] = segmentItems(
      [doc('d1', 'kh068', [{ code: 'QUAT-VOT', amount: '1000', paid: '0' }], [line('INP6401', '231', '1000', { categoryId: 'cat-quat' })])],
      [{ partnerId: 'kh068', allocations: [{ receivableId: 'd1', segment: 'QUAT-VOT', amount: '0' }], lines: [line('INP6401-A', '-36', '150', { categoryId: 'cat-quat' }), line('INP6401-B', '-27', '120', { categoryId: 'cat-quat' }), line('INP6401', '-140', '600', { categoryId: 'cat-quat' })] }],
      [QUAT],
    );
    expect(holding?.items.map((item) => [item.sku, item.quantity, item.returned])).toEqual([['INP6401', '28', '203']]);
  });

  it('thu tiền (không phải hàng trả) trả hết chứng từ → không hiện chứng từ đó', () => {
    const holdings = segmentItems([
      doc('a', 'kh015', [{ code: 'MAU-KH015', amount: '620000', paid: '620000' }], [line('INP3001', '1', '620000')], { tag: 'MAU-KH015' }),
      doc('b', 'kh015', [{ code: 'MAU-KH015', amount: '570000', paid: '0' }], [line('INP3002', '1', '570000')], { tag: 'MAU-KH015' }),
    ], [], [MAU]);
    expect(holdings[0]?.items.map((item) => item.sku)).toEqual(['INP3002']);
  });

  it('cùng mã ở nhiều chứng từ gộp một dòng; chứng từ không có dòng hàng ghi "—"', () => {
    const [holding] = segmentItems([
      doc('a', 'kh015', [{ code: 'MAU-KH015', amount: '100', paid: '0' }], [line('INP3001', '1', '100')], { tag: 'MAU-KH015' }),
      doc('b', 'kh015', [{ code: 'MAU-KH015', amount: '200', paid: '0' }], [line(' inp3001 ', '2', '200')], { tag: 'MAU-KH015', date: '2026-06-15' }),
      doc('c', 'kh015', [{ code: 'MAU-KH015', amount: '50', paid: '0' }], [], { tag: 'MAU-KH015' }),
    ], [], [MAU]);
    expect(holding?.items.map((item) => [item.sku, item.quantity, item.amount])).toEqual([['INP3001', '3', '300.00'], ['—', '0', '50.00']]);
    expect(holding?.skuCount).toBe(1);
    expect(holding?.documents.map((row) => row.code)).toEqual(['A', 'C', 'B']);
  });
});
