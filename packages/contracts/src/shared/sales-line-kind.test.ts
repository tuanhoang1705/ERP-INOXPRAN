import { describe, expect, it } from 'vitest';
import { CreateSalesOrderSchema, SalesQuoteRequestSchema, UpdateSalesOrderSchema } from '../index.js';
import { isZeroPriceLine, otherLinesLast, ZERO_PRICE_KINDS, zeroPriceKindOf, zeroPricedSaleLine } from './sales-line-kind.js';

const id = '6ad03a72341e3981d6f66b4b';
const line = { productId: id, unit: 'Cái', quantity: '2' };
const order = { customerId: id, warehouseId: id, lines: [line] };

describe('hàng tặng / đổi / bù trên phiếu bán', () => {
  it('giữ tương thích phiếu cũ và phân biệt dòng bán thường', () => {
    expect(zeroPriceKindOf({ gift: true })).toBe('GIFT');
    expect(zeroPriceKindOf({ gift: false })).toBeUndefined();
    expect(isZeroPriceLine({})).toBe(false);
  });

  it.each(ZERO_PRICE_KINDS)('%s giữ được loại qua tạo, sửa và báo giá; loại tự xác định là hàng không tính tiền', (kind) => {
    const other = { ...line, zeroPriceKind: kind };
    expect(CreateSalesOrderSchema.parse({ ...order, lines: [line, other] }).lines[1]?.zeroPriceKind).toBe(kind);
    expect(UpdateSalesOrderSchema.parse({ ...order, version: 1, lines: [line, other] }).lines[1]?.zeroPriceKind).toBe(kind);
    expect(SalesQuoteRequestSchema.parse({ ...order, lines: [line, other] }).lines[1]?.zeroPriceKind).toBe(kind);
    expect(isZeroPriceLine({ gift: false, zeroPriceKind: kind })).toBe(true);
  });

  it('không nhận loại ngoài danh sách', () => {
    expect(CreateSalesOrderSchema.safeParse({ ...order, lines: [{ ...line, zeroPriceKind: 'PAID' }] }).success).toBe(false);
  });

  it('hàng khác luôn xếp cuối, giữ thứ tự trong từng nhóm', () => {
    const rows = [{ sku: 'A' }, { sku: 'T1', gift: true }, { sku: 'B' }, { sku: 'D1', zeroPriceKind: 'EXCHANGE' as const }, { sku: 'C' }];
    expect(otherLinesLast(rows).map((row) => row.sku)).toEqual(['A', 'B', 'C', 'T1', 'D1']);
    expect(otherLinesLast([{ sku: 'A', gift: false }, { sku: 'B', gift: false }]).map((row) => row.sku)).toEqual(['A', 'B']);
  });

  it('phiếu bán: dòng hàng bán đơn giá 0 bị chặn, hàng khác 0 đ thì được', () => {
    expect(zeroPricedSaleLine([{ unitPrice: '480000' }, { unitPrice: '0', gift: true, zeroPriceKind: 'GIFT' }])).toBe(-1);
    expect(zeroPricedSaleLine([{ unitPrice: '480000' }, { unitPrice: '0.00' }])).toBe(1);
    expect(zeroPricedSaleLine([{ unitPrice: { toString: () => '0.00' } }])).toBe(0);
    expect(zeroPricedSaleLine([{ unitPrice: '' }])).toBe(0);
  });

  it.each(['SAMPLE', 'INSPECTION', 'GIFT'])('phiếu %s không nhận dòng hàng khác kèm theo dù không gửi cờ gift', (purpose) => {
    expect(CreateSalesOrderSchema.safeParse({ warehouseId: id, salesRepId: id, purpose, lines: [{ ...line, zeroPriceKind: 'EXCHANGE' }] }).success).toBe(false);
  });
});
