import { describe, expect, it } from 'vitest';
import { returnPrintPricing } from './stock-return-print-pricing';

const line = { productId: 'p1', quantity: '2' };
describe('return print valuation', () => {
  it('prints sample returns as zero without borrowing prices from the sales slip', () => {
    expect(returnPrintPricing({ kind: 'SAMPLE', lines: [line] }, { lines: [{ productId: 'p1', baseQuantity: '2', netAmount: '999' }] }, null)).toMatchObject({ net: '0', tax: '0', total: '0', lines: [{ unitPrice: '0' }] });
  });
  it('keeps pre-ERP and unvalued receipts blank rather than declaring zero', () => {
    expect(returnPrintPricing({ kind: 'CUSTOMER', preErpSalesCode: 'BH-OLD', lines: [line] }, null, null)).toMatchObject({ status: 'UNPRICED', total: null, lines: [{ unitPrice: null, net: null }] });
  });
  it('uses discounted source prices per base unit and the saved receipt totals', () => {
    const result = returnPrintPricing({ kind: 'CUSTOMER', lines: [line], value: { net: '180', tax: '14', total: '194' } }, { taxRate: '8', lines: [{ productId: 'p1', baseQuantity: '10', netAmount: '900' }, { productId: 'p1', gift: true, baseQuantity: '2', netAmount: '0' }] }, null);
    expect(result).toMatchObject({ status: 'VALUED', total: '194', lines: [{ unitPrice: '90', net: '180', tax: '14', rate: '8' }] });
  });
  it('does not invent line prices when the source order has subsequently changed', () => {
    expect(returnPrintPricing({ kind: 'CUSTOMER', lines: [line], value: { net: '180', tax: '14', total: '194' } }, { taxRate: '8', lines: [{ productId: 'p1', baseQuantity: '2', netAmount: '300' }] }, null)).toMatchObject({ status: 'TOTAL_ONLY', total: '194', net: '180', lines: [{ unitPrice: null }] });
  });
  it('prefers posted accounting prices and preserves mixed VAT', () => {
    const result = returnPrintPricing({ kind: 'CUSTOMER', lines: [line, { productId: 'p2', quantity: '1' }], value: { total: '999' } }, null, { status: 'POSTED', kind: 'RETURN', amount: '326', historyLines: [{ ...line, netUnitPrice: '100', netAmount: '200', taxAmount: '16', vatRate: '8' }, { productId: 'p2', quantity: '1', netUnitPrice: '100', netAmount: '100', taxAmount: '10', vatRate: '10' }] });
    expect(result).toMatchObject({ status: 'VALUED', rate: 'MIXED', net: '300', tax: '26', total: '326' });
  });
  it('preserves gross-only historical credits without labelling them pretax', () => {
    expect(returnPrintPricing({ kind: 'CUSTOMER', lines: [line] }, null, { status: 'POSTED', kind: 'RETURN', amount: '216', historyLines: [{ ...line, unitPrice: '108', amount: '216' }] })).toMatchObject({ status: 'TOTAL_ONLY', net: null, tax: null, total: '216' });
  });
  it('ignores voided credits and uses the saved return valuation', () => {
    expect(returnPrintPricing({ kind: 'CUSTOMER', lines: [line], value: { net: '100', tax: '0', total: '100' } }, null, { status: 'VOIDED', kind: 'RETURN', amount: '999' })).toMatchObject({ total: '100' });
  });
});
