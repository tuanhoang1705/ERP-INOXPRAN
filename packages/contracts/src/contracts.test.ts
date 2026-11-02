import { describe, expect, it } from 'vitest';
import { CreateInventoryTransferSchema, CreateSalesOrderSchema, CreateWarrantyTicketSchema, DecimalStringSchema, LoginSchema } from './index.js';

describe('public contracts', () => {
  it('rejects floating point ambiguity and negative quantities', () => {
    expect(DecimalStringSchema.safeParse('-1').success).toBe(false);
    expect(DecimalStringSchema.safeParse('1.12345').success).toBe(false);
    expect(DecimalStringSchema.safeParse('12.5').success).toBe(true);
  });

  it('requires at least one sales order line', () => {
    const result = CreateSalesOrderSchema.safeParse({
      customerId: 'customer-1',
      warehouseId: 'warehouse-1',
      lines: [],
    });
    expect(result.success).toBe(false);
  });

  it('normalizes login email', () => {
    const value = LoginSchema.parse({ email: ' Admin@INOXPRAN.vn ', password: 'very-long-password' });
    expect(value.email).toBe('admin@inoxpran.vn');
  });

  it('không cho phép chuyển hàng trong cùng một kho', () => {
    const result = CreateInventoryTransferSchema.safeParse({
      fromWarehouseId: 'warehouse-1',
      toWarehouseId: 'warehouse-1',
      reason: 'Điều chuyển nội bộ',
      lines: [{ productId: 'product-1', quantity: '1' }],
    });
    expect(result.success).toBe(false);
  });
});

describe('phiếu bảo hành không hóa đơn (WAR-NOINV-01)', () => {
  const base = { channel: 'WALK_IN', customerName: 'Khách lẻ', productId: 'product-1', receivedDate: '2026-10-28', promisedDate: '2026-11-04', symptom: 'Không vào điện' } as const;
  it('không hóa đơn: chọn vẫn bảo hành, kèm ngày mua khách khai', () => {
    expect(CreateWarrantyTicketSchema.safeParse({ ...base, noInvoiceWarranty: true, declaredPurchaseDate: '2026-05-01' }).success).toBe(true);
  });
  it('có hóa đơn thì không dùng lựa chọn không hóa đơn', () => {
    const result = CreateWarrantyTicketSchema.safeParse({ ...base, invoiceNumber: 'HD-1', invoiceDate: '2026-05-01', noInvoiceWarranty: true });
    expect(result.success).toBe(false);
  });
  it('ngày mua khách khai không sau ngày tiếp nhận', () => {
    expect(CreateWarrantyTicketSchema.safeParse({ ...base, noInvoiceWarranty: true, declaredPurchaseDate: '2026-10-29' }).success).toBe(false);
  });
});
