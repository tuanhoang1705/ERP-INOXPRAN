import type { SalesPriceSheet } from '@inoxpran/contracts';
import { describe, expect, it } from 'vitest';
import { computeIssue, normalizeQuantity, type IssueProduct } from './sales-issue';

const product = (id: string, sku: string, pack = 4): IssueProduct => ({ id, sku, baseUnit: 'Cái', unitConversions: [{ unit: 'Thùng', factorToBase: String(pack) }] });
const products = new Map([product('p1', 'INP6004'), product('p2', 'INP6012'), product('p3', 'INP2001', 2)].map((item) => [item.id, item]));

const sheet = (overrides: Partial<SalesPriceSheet['customer']> = {}): SalesPriceSheet => ({
  generatedAt: '2026-10-01T03:00:00.000Z',
  defaultVatRate: '8',
  pricesIncludeTax: true,
  discountCapRate: '10',
  approvalThreshold: '150000000',
  customer: { id: 'c1', tier: 'TIER_1', status: 'ACTIVE', creditLimit: '300000000', exposure: '0', periodRevenue: '0', periodLabel: '90 ngày', salesTierRate: '0', paymentTermDays: 45, ...overrides },
  items: [
    { productId: 'p1', sku: 'INP6004', baseUnitPrice: '586000', tierDiscountRate: '0', salesTierDiscountRate: '0', promotionDiscountRate: '0', discountRate: '0', available: '28', minimumStock: '16' },
    { productId: 'p2', sku: 'INP6012', baseUnitPrice: '650000', tierDiscountRate: '0', salesTierDiscountRate: '0', promotionDiscountRate: '0', discountRate: '0', available: '60', minimumStock: '8' },
    { productId: 'p3', sku: 'INP2001', baseUnitPrice: '1610000', tierDiscountRate: '0', salesTierDiscountRate: '2', promotionDiscountRate: '4', discountRate: '6', available: '3', minimumStock: '4' },
  ],
});

describe('computeIssue', () => {
  const lines = [
    { productId: 'p1', unit: 'Cái', quantity: '15', gift: false },
    { productId: 'p2', unit: 'Cái', quantity: 8, gift: false },
    { productId: 'p1', unit: 'Cái', quantity: '1', gift: true },
  ];

  it('tính đúng như phiếu giấy và tính lại ngay khi đổi thuế suất', () => {
    const at8 = computeIssue(lines, products, sheet(), '8');
    expect(at8.lines.map((line) => line?.unitPrice)).toEqual(['542592.59', '601851.85', '0.00']);
    expect(at8.summary).toMatchObject({ netTotal: '12953704', taxTotal: '1036296', grandTotal: '13990000' });
    const at10 = computeIssue(lines, products, sheet(), '10');
    expect(at10.lines[0]?.unitPrice).toBe('532727.27');
    expect(at10.summary.grandTotal).toBe('13990000');
    const kct = computeIssue(lines, products, sheet(), 'KCT');
    expect(kct.summary).toMatchObject({ netTotal: '13990000', taxTotal: '0', grandTotal: '13990000' });
  });

  it('đơn giá sửa tay (đã được cấp quyền): dùng đúng giá, CK 0, vẫn nhớ giá bảng giá; hàng tặng bỏ qua', () => {
    const result = computeIssue([
      { productId: 'p3', unit: 'Cái', quantity: '2', gift: false, overrideUnitPrice: '1400000' },
      { productId: 'p1', unit: 'Cái', quantity: '1', gift: true, overrideUnitPrice: '999' },
    ], products, sheet(), '8');
    expect(result.lines[0]).toMatchObject({ unitPrice: '1400000.00', listUnitPrice: '1400000.00', discountRate: '0', overridden: true, originalUnitPrice: '1401296.30', netAmount: '2800000.00' });
    expect(result.lines[1]).toMatchObject({ unitPrice: '0.00', overridden: false });
    expect(result.summary).toMatchObject({ netTotal: '2800000', taxTotal: '224000', grandTotal: '3024000' });
  });

  it('cộng cả hàng tặng vào nhu cầu xuất và cảnh báo tồn', () => {
    const result = computeIssue([...lines, { productId: 'p3', unit: 'Thùng', quantity: '2', gift: false }], products, sheet(), '8');
    expect(result.demandByProduct.get('p1')).toBe(16);
    expect(result.stockWarnings.map((warning) => [warning.productId, warning.tone])).toEqual([['p1', 'warning'], ['p3', 'error']]);
    expect(result.lines[3]).toMatchObject({ baseQuantity: '4', unitPrice: '2802592.59', discountRate: '6' });
  });

  it('tặng / đổi / bù cùng mã: tiền đều 0, không nhận giá sửa tay, tổng kho gồm đủ cả ba loại', () => {
    const result = computeIssue([
      { productId: 'p1', unit: 'Cái', quantity: '2', gift: false },
      { productId: 'p1', unit: 'Cái', quantity: '1', gift: true, zeroPriceKind: 'GIFT' },
      { productId: 'p1', unit: 'Cái', quantity: '2', gift: false, zeroPriceKind: 'EXCHANGE', overrideUnitPrice: '999' },
      { productId: 'p1', unit: 'Cái', quantity: '3', gift: false, zeroPriceKind: 'COMPENSATION', overrideUnitPrice: '999' },
    ], products, sheet(), '8');
    expect(result.summary.grandTotal).toBe('1172000');
    expect(result.demandByProduct.get('p1')).toBe(8);
    for (const line of result.lines.slice(1)) expect(line).toMatchObject({ unitPrice: '0.00', netAmount: '0.00', discountRate: '0', overridden: false });
  });

  it('báo vượt hạn mức / ngưỡng duyệt theo tổng thanh toán', () => {
    expect(computeIssue(lines, products, sheet({ creditLimit: '10000000' }), '8').needsApproval).toEqual({ overThreshold: false, overCredit: true });
    expect(computeIssue(lines, products, sheet({ tier: 'RETAIL', creditLimit: '0' }), '8').creditRemainingAfter).toBeNull();
  });

  it('đại lý hạn mức 0 = không cấp công nợ: không báo vượt hạn mức', () => {
    const result = computeIssue(lines, products, sheet({ tier: 'TIER_2', creditLimit: '0' }), '8');
    expect(result.creditRemainingAfter).toBeNull();
    expect(result.needsApproval.overCredit).toBe(false);
  });

  it('dòng chưa có giá (đang tải) hoặc số lượng sai không làm sai tổng', () => {
    const result = computeIssue([{ productId: 'p1', unit: 'Cái', quantity: '-2', gift: false }, { productId: 'p2', unit: 'Cái', quantity: '1', gift: false }], products, null, '8');
    expect(result.pending).toBe(true);
    expect(result.lineErrors[0]).toBe('Số lượng không hợp lệ');
    expect(result.summary.grandTotal).toBe('0');
  });

  it('chuẩn hóa số lượng nhập', () => {
    expect(normalizeQuantity('2,5')).toEqual({ quantity: '2.5', error: null });
    expect(normalizeQuantity('')).toEqual({ quantity: null, error: null });
    expect(normalizeQuantity('0')).toEqual({ quantity: null, error: null });
    expect(normalizeQuantity('1.23456').error).toBe('Số lượng tối đa 4 chữ số lẻ');
  });
});
