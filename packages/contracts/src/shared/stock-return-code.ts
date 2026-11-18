export type StockReturnPrefix = 'NK' | 'XT';

/** Số ngắn lấy tháng chứng từ. Số đầy đủ giữ tháng ghi trên phiếu giấy. */
export function expandStockReturnCode(input: string, prefix: StockReturnPrefix, documentDay: string): string | null {
  const value = input.trim().toUpperCase();
  const period = documentDay.slice(0, 7).replace('-', '');
  const code = /^\d{1,5}$/.test(value) ? prefix + period + value.padStart(4, '0') : value;
  const parts = /^(NK|XT)(20\d{2}(?:0[1-9]|1[0-2]))(\d{4,5})$/.exec(code);
  if (!parts || parts[1] !== prefix || Number(parts[3]) === 0) return null;
  return prefix + parts[2] + String(Number(parts[3])).padStart(4, '0');
}
