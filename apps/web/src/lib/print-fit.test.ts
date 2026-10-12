import { describe, expect, it } from 'vitest';
import { findPrintScale } from './print-fit';

describe('findPrintScale', () => {
  it('giữ 100% khi nội dung đã vừa trang', () => {
    expect(findPrintScale(() => 600, 729)).toBe(1);
  });
  it('tìm tỷ lệ lớn nhất còn vừa trang, tính cả việc chữ dàn rộng hơn khi thu nhỏ', () => {
    // Chiều cao giảm khi bề rộng tăng (thu nhỏ): mô phỏng 1500px ở 100%, tỷ lệ thuận với tỷ lệ thu nhỏ.
    const heightAt = (scale: number) => 1500 * (0.4 + 0.6 * scale);
    const scale = findPrintScale(heightAt, 729);
    expect(heightAt(scale) * scale).toBeLessThanOrEqual(729);
    expect(heightAt(scale + 0.01) * (scale + 0.01)).toBeGreaterThan(729);
  });
  it('không thu nhỏ quá 30%', () => {
    expect(findPrintScale(() => 100_000, 729)).toBeCloseTo(0.3, 2);
  });
  it('bỏ qua phép đo lỗi', () => {
    expect(findPrintScale(() => Number.NaN, 729)).toBeCloseTo(0.3, 2);
  });
});
