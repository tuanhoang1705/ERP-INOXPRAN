import { describe, expect, it } from 'vitest';
import { allocateLineVat, commonVatRate, documentTotals, isVatRate, lineTax, linesTotals, priceLine, pricedLineAmounts, roundDong, summarizeDocument, sumMoney, toScaled, vatLabel, vatPercent, type LineBasis } from './sales-math.js';

const included = (vatRate: string) => ({ vatRate, pricesIncludeTax: true });
const sale = (baseUnitPrice: number, quantity: number, discountRate = 0, conversionFactor = 1): LineBasis => ({ baseUnitPrice, quantity, discountRate, conversionFactor });

/** Phiếu thật BH Giang Châu 12/08/2026: 9 mã nồi cơm điện giá NPP đã gồm VAT + 9 dòng tặng. */
const giangChau: LineBasis[] = [
  sale(586000, 15), sale(696000, 15), sale(570000, 15), sale(680000, 15), sale(620000, 15),
  sale(750000, 15), sale(520000, 15), sale(620000, 15), sale(650000, 8),
  ...Array.from({ length: 9 }, () => ({ ...sale(586000, 1), gift: true })),
];

describe('priceLine — tái lập phiếu thật', () => {
  it('phiếu BH Giang Châu: đúng từng đơn giá, thành tiền và tổng (VAT 8%)', () => {
    const lines = giangChau.map((line) => priceLine(line, included('8')));
    expect(lines.slice(0, 9).map((line) => line.unitPrice)).toEqual([
      '542592.59', '644444.44', '527777.78', '629629.63', '574074.07', '694444.44', '481481.48', '574074.07', '601851.85',
    ]);
    expect(lines.slice(0, 9).map((line) => roundDong(line.netAmount))).toEqual([
      '8138889', '9666667', '7916667', '9444444', '8611111', '10416667', '7222222', '8611111', '4814815',
    ]);
    expect(lines.slice(9).every((line) => line.unitPrice === '0.00' && line.netAmount === '0.00' && line.baseQuantity === '1')).toBe(true);
    const totals = summarizeDocument(lines, '8');
    expect(totals.netAmountSum).toBe('74842592.30');
    expect(totals).toMatchObject({ netTotal: '74842592', taxTotal: '5987407', grandTotal: '80830000' });
  });

  it('phiếu SWK Đào Thị Quỳnh Hoa: 12 × 148.148,15', () => {
    const line = priceLine(sale(160000, 12), included('8'));
    expect(line.unitPrice).toBe('148148.15');
    expect(summarizeDocument([line], '8')).toMatchObject({ netTotal: '1777778', taxTotal: '142222', grandTotal: '1920000' });
  });
});

describe('priceLine — đổi thuế suất khi bảng giá đã gồm thuế', () => {
  it.each([
    ['10', '532727.27', '7990909', '799091', '8790000'],
    ['8', '542592.59', '8138889', '651111', '8790000'],
    ['5', '558095.24', '8371429', '418571', '8790000'],
    ['3', '568932.04', '8533981', '256019', '8790000'],
    ['KCT', '586000.00', '8790000', '0', '8790000'],
  ])('%s%%: tách lại đơn giá chưa thuế, tổng thanh toán giữ nguyên giá niêm yết', (rate, unitPrice, net, tax, total) => {
    const line = priceLine(sale(586000, 15), included(rate));
    expect(line.unitPrice).toBe(unitPrice);
    expect(summarizeDocument([line], rate)).toMatchObject({ netTotal: net, taxTotal: tax, grandTotal: total });
  });

  it('bảng giá chưa gồm thuế: đơn giá giữ nguyên, thuế cộng thêm', () => {
    const line = priceLine(sale(100000, 3, 5), { vatRate: '10', pricesIncludeTax: false });
    expect(line.unitPrice).toBe('95000.00');
    expect(summarizeDocument([line], '10')).toMatchObject({ netTotal: '285000', taxTotal: '28500', grandTotal: '313500' });
  });
});

describe('priceLine — đơn giá sửa tay', () => {
  it('đơn giá 0 (phiếu xuất đi kiểm định): thành tiền, thuế = 0, giá niêm yết vẫn giữ', () => {
    const line = priceLine({ ...sale(820000, 1), unitPriceOverride: '0' }, included('8'));
    expect(line.unitPrice).toBe('0.00');
    expect(line.netAmount).toBe('0.00');
    expect(line.taxAmount).toBe('0.00');
    expect(line.grossAmount).toBe('0.00');
    expect(line.listPrice).toBe('820000.00');
    expect(line.baseQuantity).toBe('1');
  });

  it('đơn giá 0 khi bảng giá chưa gồm thuế, quy đổi thùng 4 cái: thành tiền 0, số lượng quy đổi đúng', () => {
    const line = priceLine({ baseUnitPrice: '500000', quantity: '3', conversionFactor: '4', discountRate: '5', unitPriceOverride: '0' }, { vatRate: '10', pricesIncludeTax: false });
    expect(line.baseQuantity).toBe('12');
    expect(line.unitPrice).toBe('0.00');
    expect(line.listUnitPrice).toBe('0.00');
    expect(line.discountAmount).toBe('0.00');
    expect(line.netAmount).toBe('0.00');
    expect(line.listPrice).toBe('2000000.00');
  });

  it('phiếu trộn: dòng giá 0 + dòng thường + hàng tặng — tổng chỉ tính dòng thường', () => {
    const zero = priceLine({ ...sale(820000, 2), unitPriceOverride: '0' }, included('8'));
    const normal = priceLine(sale(160000, 12), included('8'));
    const gift = priceLine({ ...sale(586000, 1), gift: true }, included('8'));
    expect(summarizeDocument([zero, normal, gift], '8')).toMatchObject(summarizeDocument([normal], '8'));
    expect(summarizeDocument([zero, normal, gift], '8')).toMatchObject({ netTotal: '1777778', taxTotal: '142222', grandTotal: '1920000' });
  });

  it('phiếu toàn dòng giá 0: tổng thanh toán 0 với mọi thuế suất', () => {
    for (const rate of ['0', '5', '8', '10', 'KCT']) {
      const line = priceLine({ ...sale(820000, 5), unitPriceOverride: '0' }, included(rate));
      expect(summarizeDocument([line], rate)).toMatchObject({ subtotal: '0.00', discountTotal: '0.00', netTotal: '0', taxTotal: '0', grandTotal: '0' });
    }
    expect(documentTotals('0', '8')).toEqual({ netTotal: '0', taxTotal: '0', grandTotal: '0' });
  });

  it('đơn giá âm bị từ chối', () => {
    expect(() => priceLine({ ...sale(820000, 1), unitPriceOverride: '-1' }, included('8'))).toThrow('không được âm');
  });
});

describe('priceLine — chiết khấu, quy đổi đơn vị, số lẻ', () => {
  it('thùng 2 bộ, CK 6% (bậc 2% + KM 4%), VAT 8%', () => {
    const line = priceLine(sale(1610000, 2, 6, 2), included('8'));
    expect(line.baseQuantity).toBe('4');
    expect(line.listPrice).toBe('3220000.00');
    expect(line.listUnitPrice).toBe('2981481.48');
    expect(line.unitPrice).toBe('2802592.59');
    expect(line.netAmount).toBe('5605185.18');
    expect(line.subtotal).toBe('5962962.96');
    expect(line.discountAmount).toBe('357777.78');
  });

  it('số lượng lẻ (0,5 thùng) và CK có 2 số lẻ', () => {
    const line = priceLine({ baseUnitPrice: '750000', quantity: '0.5', conversionFactor: '4', discountRate: '2.5' }, included('8'));
    expect(line.baseQuantity).toBe('2');
    expect(line.unitPrice).toBe('2708333.33');
    expect(line.netAmount).toBe('1354166.67');
  });

  it('làm tròn nửa lên chính xác ở nơi số thực của JavaScript sai (1,005 → 1,01)', () => {
    expect(1.005 * 100).toBeLessThan(100.5); // minh họa lỗi dấu phẩy động
    const line = priceLine({ baseUnitPrice: '1.005', quantity: 1, conversionFactor: 1, discountRate: 0 }, { vatRate: 'KCT', pricesIncludeTax: true });
    expect(line.unitPrice).toBe('1.01');
    expect(roundDong('2.5')).toBe('3');
    expect(roundDong('2.49')).toBe('2');
  });

  it('chặn dữ liệu sai', () => {
    expect(() => priceLine({ ...sale(1000, 1), discountRate: 101 }, included('8'))).toThrow();
    expect(() => priceLine({ ...sale(1000, -1) }, included('8'))).toThrow();
    expect(() => toScaled('1,5')).toThrow();
    expect(() => vatPercent('abc')).toThrow();
  });
});

describe('tổng chứng từ & tiện ích', () => {
  it('thuế và tổng tính trên Σ chưa làm tròn (lệch 1 đồng như phiếu giấy)', () => {
    expect(documentTotals('74842592.30', '8')).toEqual({ netTotal: '74842592', taxTotal: '5987407', grandTotal: '80830000' });
    expect(documentTotals('74842592.30', 'KCT')).toEqual({ netTotal: '74842592', taxTotal: '0', grandTotal: '74842592' });
    expect(documentTotals('0', '10')).toEqual({ netTotal: '0', taxTotal: '0', grandTotal: '0' });
  });

  it('cộng tiền chính xác', () => {
    expect(sumMoney(['0.10', '0.20'])).toBe('0.30');
    expect(sumMoney([])).toBe('0.00');
  });

  it('nhãn và kiểm tra thuế suất', () => {
    expect(vatLabel('8')).toBe('8 %');
    expect(vatLabel('KCT')).toBe('KCT');
    expect(vatPercent('KCT')).toBe('0');
    expect(isVatRate('5')).toBe(true);
    expect(isVatRate('7')).toBe(false);
  });
});

describe('PXK-002 — thuế suất từng dòng, không lệch đồng nào (allocateLineVat)', () => {
  const vat = (lines: ReturnType<typeof priceLine>[], rate: string | string[]) => allocateLineVat(lines.map((line, index) => ({ netAmount: line.netAmount, vatRate: Array.isArray(rate) ? (rate[index] as string) : rate })));
  const sum = (values: string[]) => values.reduce((total, value) => total + Number(value), 0);

  it('hóa đơn MISA 27/10/2026: 3.422.222 → 273.778; 3.611.111 → 288.889; tổng 7.596.000', () => {
    const lines = [priceLine(sale(308000, 12), included('8')), priceLine(sale(650000, 6), included('8'))];
    const result = vat(lines, '8');
    expect(result.taxAmounts).toEqual(['273778.00', '288889.00']);
    expect(result).toMatchObject({ netTotal: '7033333', taxTotal: '562667', grandTotal: '7596000' });
  });

  it('phiếu Giang Châu: tổng thanh toán như PXK-001 (80.830.000), tiền hàng + thuế = tổng, Σ thuế dòng = thuế', () => {
    const lines = giangChau.map((line) => priceLine(line, included('8')));
    const result = vat(lines, '8');
    expect(result).toMatchObject({ netTotal: '74842592', taxTotal: '5987408', grandTotal: '80830000' });
    expect(sum(result.taxAmounts)).toBe(5987408);
    expect(Number(result.netTotal) + Number(result.taxTotal)).toBe(Number(result.grandTotal));
    expect(result.grandTotal).toBe(summarizeDocument(lines, '8').grandTotal);
    expect(result.taxAmounts.slice(9).every((tax) => tax === '0.00')).toBe(true);
  });

  it('phiếu nhiều thuế suất: tổng mỗi thuế suất như PXK-001, KCT thuế 0', () => {
    const eight = priceLine(sale(160000, 12), included('8'));
    const ten = priceLine({ baseUnitPrice: '100000', quantity: 3, conversionFactor: 1, discountRate: 5 }, { vatRate: '10', pricesIncludeTax: false });
    const kct = priceLine(sale(50000, 2), included('KCT'));
    const result = vat([eight, ten, kct], ['8', '10', 'KCT']);
    expect(result.taxAmounts).toEqual(['142222.00', '28500.00', '0.00']);
    expect(result).toMatchObject({ netTotal: '2162778', taxTotal: '170722', grandTotal: '2333500' });
  });

  it('5.000 phiếu ngẫu nhiên: Σ thuế dòng = thuế, tiền hàng + thuế = tổng, tổng = PXK-001 với một thuế suất, mỗi dòng sai số < 1 đồng', () => {
    let seed = 20261027;
    const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    for (let index = 0; index < 5000; index += 1) {
      const rate = (['3', '5', '8', '10', 'KCT'] as const)[Math.floor(random() * 5)] as string;
      const count = 1 + Math.floor(random() * 25);
      const lines = Array.from({ length: count }, () => priceLine({ baseUnitPrice: String(Math.round(random() * 3_000_000)), quantity: 1 + Math.floor(random() * 40), conversionFactor: 1, discountRate: Math.floor(random() * 12), gift: random() < 0.1 }, included(rate)));
      const result = vat(lines, rate);
      expect(sum(result.taxAmounts)).toBe(Number(result.taxTotal));
      expect(Number(result.netTotal) + Number(result.taxTotal)).toBe(Number(result.grandTotal));
      expect(result.grandTotal).toBe(summarizeDocument(lines, rate).grandTotal);
      lines.forEach((line, position) => expect(Math.abs(Number(result.taxAmounts[position]) - Number(line.netAmount) * Number(vatPercent(rate)) / 100)).toBeLessThan(1.0001));
    }
  });

  it('tiện ích thuế dòng: lineTax, linesTotals, commonVatRate, pricedLineAmounts, nhãn "Theo từng dòng"', () => {
    expect(lineTax('3422222.28', '8')).toBe('273778');
    expect(linesTotals([{ netAmount: '3422222.28', taxAmount: '273778.00' }, { netAmount: '3611111.10', taxAmount: '288889.00' }])).toEqual({ netTotal: '7033333', taxTotal: '562667', grandTotal: '7596000' });
    expect(commonVatRate(['8', '8'], '10')).toBe('8');
    expect(commonVatRate(['8', '10'], '8')).toBe('MIXED');
    expect(commonVatRate([], '8')).toBe('8');
    expect(pricedLineAmounts('2', '125000', '8')).toEqual({ netAmount: '250000', taxAmount: '20000', amount: '270000' });
    expect(vatLabel('MIXED')).toBe('Theo từng dòng');
  });
});
