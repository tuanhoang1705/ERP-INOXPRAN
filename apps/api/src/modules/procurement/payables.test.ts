import { describe, expect, it } from 'vitest';
import { orderPayable, unitCosts, valueOf, vndOf } from './payables';

describe('sổ phải trả nhà cung cấp (D2)', () => {
  // Đặt 10 thùng × 12 cái (120 cái) giá 600 CNY/thùng = 6.000 CNY; mã B 50 cái × 2,5 = 125 CNY.
  const lines = [
    { productId: 'a', baseQuantity: '120', receivedBaseQuantity: '60', lineTotal: '6000' },
    { productId: 'b', baseQuantity: '50', receivedBaseQuantity: '50', lineTotal: '125' },
  ];

  it('đơn giá theo đơn vị cơ bản, gộp các dòng cùng mã', () => {
    const costs = unitCosts([...lines, { productId: 'a', baseQuantity: '30', receivedBaseQuantity: '0', lineTotal: '1500' }]);
    expect(costs.get('a')?.toFixed(2)).toBe('50.00');
    expect(costs.get('b')?.toFixed(2)).toBe('2.50');
    expect(valueOf([{ productId: 'a', quantity: '3' }, { productId: 'zz', quantity: '9' }], costs).toFixed(2)).toBe('150.00');
  });

  it('còn phải trả = đã nhận − trả nhà máy − đã trả; đặt cọc trước khi nhận hàng thì âm', () => {
    const result = orderPayable({ total: '6125', cancelled: false, lines, payments: [{ amount: '1800' }, { amount: '500' }] }, [{ productId: 'b', quantity: '10' }]);
    expect(result.received.toFixed(2)).toBe('3125.00');
    expect(result.returned.toFixed(2)).toBe('25.00');
    expect(result.paid.toFixed(2)).toBe('2300.00');
    expect(result.balance.toFixed(2)).toBe('800.00');
    const deposit = orderPayable({ total: '6125', cancelled: false, lines: lines.map((line) => ({ ...line, receivedBaseQuantity: '0' })), payments: [{ amount: '1837.5' }] }, []);
    expect(deposit.balance.toFixed(2)).toBe('-1837.50');
  });

  it('đơn đã hủy không tính giá trị đặt; quy VND theo tỷ giá trên đơn, giữ dấu', () => {
    expect(orderPayable({ total: '6125', cancelled: true, lines, payments: [] }, []).ordered.toFixed(0)).toBe('0');
    expect(vndOf('-1837.50', 'CNY', '3550')).toBe('-6523125');
    expect(vndOf('12500000', 'VND', undefined)).toBe('12500000');
  });
});
