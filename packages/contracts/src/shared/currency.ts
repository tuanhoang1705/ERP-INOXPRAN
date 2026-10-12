/**
 * Tiền tệ chứng từ mua hàng nhập khẩu (hợp đồng với công ty mẹ thường bằng CNY / USD).
 * Sổ sách vẫn ghi VND: số tiền ngoại tệ × tỷ giá (VND cho 1 đơn vị ngoại tệ), làm tròn tới đồng.
 */
export const CURRENCIES = ['VND', 'CNY', 'USD'] as const;
export type Currency = (typeof CURRENCIES)[number];

export const CURRENCY_SYMBOL: Record<Currency, string> = { VND: '₫', CNY: '¥', USD: '$' };
/** Số chữ số lẻ thường dùng khi nhập đơn giá. */
export const CURRENCY_DECIMALS: Record<Currency, number> = { VND: 0, CNY: 4, USD: 4 };

export function isCurrency(value: unknown): value is Currency {
  return typeof value === 'string' && (CURRENCIES as readonly string[]).includes(value);
}
