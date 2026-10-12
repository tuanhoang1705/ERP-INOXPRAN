import { describe, expect, it } from 'vitest';
import { idempotencyFingerprint } from './idempotency.service';

describe('idempotency fingerprint', () => {
  it('không phụ thuộc thứ tự key trong JSON object', () => {
    const first = idempotencyFingerprint({ warehouseId: 'w1', lines: [{ quantity: '2', productId: 'p1' }] });
    const second = idempotencyFingerprint({ lines: [{ productId: 'p1', quantity: '2' }], warehouseId: 'w1' });

    expect(first).toBe(second);
  });

  it('thay đổi khi nội dung lệnh thay đổi', () => {
    const first = idempotencyFingerprint({ version: 1, quantity: '2' });
    const second = idempotencyFingerprint({ version: 1, quantity: '3' });

    expect(first).not.toBe(second);
  });
});
