import { describe, expect, it } from 'vitest';
import { allocate, landedCost, lineAmount, sumAmounts, toVnd, weightedAverageCost } from './landed-cost';

describe('quy đổi & thành tiền', () => {
  it('ngoại tệ × tỷ giá → VND làm tròn tới đồng', () => {
    expect(toVnd('185.5', '3520')).toBe('652960');
    expect(toVnd('12.3456', '25410.5')).toBe('313708');
    expect(toVnd('1500000')).toBe('1500000');
  });
  it('thành tiền theo tiền tệ hợp đồng (2 số lẻ) và cộng chính xác', () => {
    expect(lineAmount('120', '185.5')).toBe('22260.00');
    expect(lineAmount('3', '0.3333')).toBe('1.00');
    expect(sumAmounts(['0.10', '0.20'])).toBe('0.30');
  });
});

describe('phân bổ chi phí', () => {
  it('tổng các phần đúng bằng tổng chi phí', () => {
    expect(allocate('100', [1, 1, 1])).toEqual(['34', '33', '33']);
    expect(allocate('1000000', ['2', '1'])).toEqual(['666667', '333333']);
    expect(allocate('10', [0, 0])).toEqual(['5', '5']);
  });

  it('giá vốn nhập: phân bổ theo giá trị, thuế GTGT nhập khẩu không vào giá vốn', () => {
    const result = landedCost(
      [
        { key: 'A', quantity: 100, valueVnd: '30000000', cbm: 2 },
        { key: 'B', quantity: 50, valueVnd: '10000000', cbm: 6 },
      ],
      [{ type: 'FREIGHT', amountVnd: '4000000' }, { type: 'IMPORT_DUTY', amountVnd: '2000000' }, { type: 'IMPORT_VAT', amountVnd: '4600000' }],
      'VALUE',
    );
    expect(result.capitalizedVnd).toBe('6000000');
    expect(result.excludedVnd).toBe('4600000');
    expect(result.lines.map((line) => line.allocatedVnd)).toEqual(['4500000', '1500000']);
    expect(result.lines.map((line) => line.unitCostVnd)).toEqual(['345000.00', '230000.00']);
  });

  it('phân bổ theo CBM; thiếu CBM thì quay về theo giá trị', () => {
    const byCbm = landedCost([{ key: 'A', quantity: 10, valueVnd: 100, cbm: 1 }, { key: 'B', quantity: 10, valueVnd: 100, cbm: 3 }], [{ type: 'FREIGHT', amountVnd: 400 }], 'CBM');
    expect(byCbm.lines.map((line) => line.allocatedVnd)).toEqual(['100', '300']);
    const fallback = landedCost([{ key: 'A', quantity: 10, valueVnd: 100, cbm: 1 }, { key: 'B', quantity: 10, valueVnd: 300 }], [{ type: 'FREIGHT', amountVnd: 400 }], 'CBM');
    expect(fallback.methodUsed).toBe('VALUE');
    expect(fallback.lines.map((line) => line.allocatedVnd)).toEqual(['100', '300']);
  });
});

describe('giá vốn bình quân gia quyền', () => {
  it('bình quân tồn cũ và hàng mới nhập', () => {
    expect(weightedAverageCost(100, '200000', 50, '230000')).toBe('210000.00');
    expect(weightedAverageCost(0, '200000', 50, '230000')).toBe('230000.00');
    expect(weightedAverageCost(30, null, 10, '123456.78')).toBe('123456.78');
    expect(weightedAverageCost(3, '100', 0, '999')).toBe('100.00');
  });
});
