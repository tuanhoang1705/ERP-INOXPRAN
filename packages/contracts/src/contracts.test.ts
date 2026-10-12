import { describe, expect, it } from 'vitest';
import { CreateInventoryTransferSchema, CreateSalesOrderSchema, DecimalStringSchema, LoginSchema } from './index.js';

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
