import { describe, expect, it } from 'vitest';
import { CreateSalesOrderSchema, SalesQuoteRequestSchema, UpdateSalesOrderSchema } from '../index.js';
import { isZeroPriceLine, ZERO_PRICE_KINDS, zeroPriceKindOf } from './sales-line-kind.js';

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

  it.each(['SAMPLE', 'INSPECTION', 'GIFT'])('phiếu %s không nhận dòng hàng khác kèm theo dù không gửi cờ gift', (purpose) => {
    expect(CreateSalesOrderSchema.safeParse({ warehouseId: id, salesRepId: id, purpose, lines: [{ ...line, zeroPriceKind: 'EXCHANGE' }] }).success).toBe(false);
  });
});
