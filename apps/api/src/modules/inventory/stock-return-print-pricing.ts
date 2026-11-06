import Decimal from 'decimal.js';
import type { Document } from 'mongodb';

const value = (input: unknown) => new Decimal(String(input ?? '0'));
const whole = (input: Decimal) => input.toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toFixed(0);
const sameId = (left: unknown, right: unknown) => String(left) === String(right);

/** Read-only print projection. A missing valuation must never turn into a zero-valued return. */
export function returnPrintPricing(slip: Document, order: Document | null, payment: Document | null) {
  const unpriced = (slip.lines as Document[]).map(() => ({ unitPrice: null as string | null, net: null as string | null, tax: null as string | null, rate: null as string | null }));
  if (slip.kind === 'SAMPLE') {
    return { lines: unpriced.map(() => ({ unitPrice: '0', net: '0', tax: '0', rate: '0' })), net: '0', tax: '0', total: '0', rate: '0', status: 'VALUED' as const };
  }
  // The posted credit contains the prices actually confirmed by accounting, including mixed VAT rates.
  if (payment?.status === 'POSTED' && payment.kind === 'RETURN') {
    const stored = payment.historyLines as Document[] | undefined;
    const lines = (slip.lines as Document[]).map(line => {
      const match = stored?.find(item => sameId(item.productId, line.productId) && value(item.quantity).eq(value(line.quantity)));
      return match && match.vatRate !== undefined && match.netAmount !== undefined && match.taxAmount !== undefined
        ? { unitPrice: String(match.netUnitPrice), net: String(match.netAmount), tax: String(match.taxAmount), rate: String(match.vatRate) }
        : null;
    });
    if (lines.every(line => line !== null)) {
      const net = lines.reduce((sum, line) => sum.add(line!.net), value(0));
      const tax = lines.reduce((sum, line) => sum.add(line!.tax), value(0));
      if (net.add(tax).eq(value(payment.amount))) return priced(lines as NonNullable<typeof lines[number]>[], net.toFixed(), tax.toFixed(), String(payment.amount));
    }
    return { lines: unpriced, net: null, tax: null, total: String(payment.amount), rate: null, status: 'TOTAL_ONLY' as const };
  }
  if (!slip.value) return { lines: unpriced, net: null, tax: null, total: null, rate: null, status: 'UNPRICED' as const };
  const totals = slip.value as { net: unknown; tax: unknown; total: unknown };
  if (order && Array.isArray(order.lines)) {
    const lines = (slip.lines as Document[]).map(line => {
      const sold = (order.lines as Document[]).filter(item => sameId(item.productId, line.productId) && !item.gift);
      const quantity = sold.reduce((sum, item) => sum.add(value(item.baseQuantity ?? item.quantity)), value(0));
      const amount = sold.reduce((sum, item) => sum.add(value(item.netAmount ?? item.lineTotal)), value(0));
      const rates = new Set(sold.map(item => String(item.vatRate ?? order.taxRate ?? '10')));
      if (rates.size > 1) return null;
      const rate = [...rates][0] ?? '0';
      const unitPrice = quantity.gt(0) ? amount.div(quantity) : value(0);
      const net = unitPrice.mul(value(line.quantity)).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
      const tax = rate === 'KCT' ? '0' : whole(net.mul(value(rate)).div(100));
      return { unitPrice: unitPrice.toFixed(), net: net.toFixed(), tax, rate };
    });
    if (lines.every(line => line !== null)) {
      const net = lines.reduce((sum, line) => sum.add(line!.net), value(0));
      const tax = lines.reduce((sum, line) => sum.add(line!.tax), value(0));
      // A source order can have been edited after receipt. Keep the return's saved totals authoritative.
      if (whole(net) === whole(value(totals.net)) && tax.eq(value(totals.tax)) && value(totals.net).add(value(totals.tax)).eq(value(totals.total))) {
        return priced(lines as NonNullable<typeof lines[number]>[], String(totals.net), String(totals.tax), String(totals.total));
      }
    }
  }
  return { lines: unpriced, net: String(totals.net), tax: String(totals.tax), total: String(totals.total), rate: null, status: 'TOTAL_ONLY' as const };
}

function priced(lines: Array<{ unitPrice: string; net: string; tax: string; rate: string }>, net: string, tax: string, total: string) {
  const rates = [...new Set(lines.map(line => line.rate))];
  return { lines, net, tax, total, rate: rates.length === 1 ? rates[0]! : 'MIXED', status: 'VALUED' as const };
}
