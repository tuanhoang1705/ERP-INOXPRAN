import { describe, expect, it } from 'vitest';
import { compareLines, type ChangePreviewLine } from './change-requests';

const line = { sku: 'INP1001', productName: 'Bộ nồi', unit: 'Bộ', quantity: '1', gift: true, unitPrice: '0', lineTotal: '0' };

describe('so sánh đề nghị sửa loại hàng khác', () => {
  it('không gộp mất ba loại hàng không tính tiền của cùng một SKU', () => {
    const lines: ChangePreviewLine[] = [
      { ...line, zeroPriceKind: 'GIFT' },
      { ...line, quantity: '2', zeroPriceKind: 'EXCHANGE' },
      { ...line, quantity: '3', zeroPriceKind: 'COMPENSATION' },
    ];
    const result = compareLines(lines, lines.map(row => ({ ...row, quantity: String(Number(row.quantity) + 1) })));
    expect(result).toHaveLength(3);
    expect(result.map(row => [row.zeroPriceKind, row.before?.quantity, row.after?.quantity])).toEqual([
      ['GIFT', '1', '2'], ['EXCHANGE', '2', '3'], ['COMPENSATION', '3', '4'],
    ]);
  });

  it('dòng cùng mã khác đơn giá (sao chép dòng rồi sửa giá) hiện "nhiều giá", vẫn cộng đúng thành tiền', () => {
    const sale = { ...line, gift: false, unitPrice: '100', lineTotal: '100' };
    const result = compareLines([sale], [sale, { ...sale, unitPrice: '90', lineTotal: '90' }]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ changed: true, before: { quantity: '1', unitPrice: '100' }, after: { quantity: '2', unitPrice: '', lineTotal: '190' } });
  });

  it('đổi hàng tặng cũ thành hàng đổi được thể hiện là thay loại, không bỏ sót vì cùng tiền 0', () => {
    const result = compareLines([line], [{ ...line, zeroPriceKind: 'EXCHANGE' }]);
    expect(result).toHaveLength(2);
    expect(result.every(row => row.changed)).toBe(true);
    expect(result[0]).toMatchObject({ zeroPriceKind: 'GIFT', before: { quantity: '1' } });
    expect(result[1]).toMatchObject({ zeroPriceKind: 'EXCHANGE', after: { quantity: '1' } });
  });
});
