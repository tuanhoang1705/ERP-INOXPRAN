import { Decimal128, ObjectId } from 'mongodb';
import { describe, expect, it } from 'vitest';
import { remainingQuantities, returnSourceOptions } from './return-sources';

const A = new ObjectId();
const B = new ObjectId();
const q = (value: string) => Decimal128.fromString(value);
const line = (productId: ObjectId, sku: string, baseQuantity: string, extra: Record<string, unknown> = {}) => ({ productId, sku, productName: `Tên ${sku}`, unit: 'Bộ', baseQuantity: q(baseQuantity), ...extra });
const order = (code: string, status: string, lines: unknown[], extra: Record<string, unknown> = {}) => ({ code, status, orderDate: new Date('2026-11-10T03:00:00Z'), createdAt: new Date('2026-11-10T03:05:00Z'), lines, ...extra });
const returned = (salesOrderCode: string, lines: Array<[ObjectId, string]>) => ({ salesOrderCode, lines: lines.map(([productId, quantity]) => ({ productId, quantity: q(quantity) })) });

describe('gợi ý số phiếu BH gốc (RET-SRC-PICK-01)', () => {
  it('số còn trả = số đã xuất (gộp dòng bán + tặng cùng mã) trừ các phiếu trả trước', () => {
    const remaining = remainingQuantities([line(A, 'INP1', '10'), line(A, 'INP1', '2', { gift: true }), line(B, 'INP2', '5')], (row) => row.baseQuantity, [
      returned('BH1', [[A, '3']]),
      returned('BH1', [[A, '1.5'], [B, '5']]),
    ]);
    expect(remaining.get(A.toHexString())?.toFixed()).toBe('7.5');
    expect(remaining.get(B.toHexString())?.toFixed()).toBe('0');
  });

  it('mỗi mã một dòng, đơn vị cơ bản theo danh mục; trạng thái theo giao hàng / số còn trả', () => {
    const options = returnSourceOptions(
      [
        order('BH2026110003', 'DELIVERED', [line(A, 'INP1', '10'), line(A, 'INP1', '2', { gift: true }), line(B, 'INP2', '4')]),
        order('BH2026110002', 'SHIPPED', [line(A, 'INP1', '1')]),
        order('BH2026110001', 'DELIVERED', [line(B, 'INP2', '4')]),
        order('BH2026100009', 'SHIPPED', [line(B, 'INP2', '1')], { purpose: 'WARRANTY', orderDate: undefined }),
      ],
      [returned('BH2026110003', [[A, '5']]), returned('BH2026110001', [[B, '4']])],
      (id) => (id === A.toHexString() ? 'Cái' : undefined),
    );
    expect(options.map((row) => [row.code, row.state])).toEqual([
      ['BH2026110003', 'RETURNABLE'],
      ['BH2026110002', 'NOT_DELIVERED'],
      ['BH2026110001', 'FULLY_RETURNED'],
      // Phiếu đổi bảo hành: xuất kho là nhận trả được (không có bước giao thành công / công nợ).
      ['BH2026100009', 'RETURNABLE'],
    ]);
    expect(options[0]?.lines).toEqual([
      { productId: A.toHexString(), sku: 'INP1', productName: 'Tên INP1', unit: 'Cái', shipped: '12', remaining: '7' },
      { productId: B.toHexString(), sku: 'INP2', productName: 'Tên INP2', unit: 'Bộ', shipped: '4', remaining: '4' },
    ]);
    expect(options[0]?.date).toBe('2026-11-10T03:00:00.000Z');
    expect(options[3]).toMatchObject({ warranty: true, date: '2026-11-10T03:05:00.000Z' });
    expect(options[2]?.lines[0]?.remaining).toBe('0');
  });

  it('trả quá số (dữ liệu cũ) không hiện số âm', () => {
    const [option] = returnSourceOptions([order('BH1', 'DELIVERED', [line(A, 'INP1', '2')])], [returned('BH1', [[A, '3']])], () => 'Cái');
    expect(option?.lines[0]?.remaining).toBe('0');
    expect(option?.state).toBe('FULLY_RETURNED');
  });
});
