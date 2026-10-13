/**
 * Tìm người mua trên phiếu BH: gõ số điện thoại (bỏ khoảng trắng / dấu chấm, +84 ≈ 0), mã khách, tên (có dấu hay không),
 * tỉnh hoặc mã số thuế. Ưu tiên: trùng mã > khớp số điện thoại > tên bắt đầu bằng chữ gõ > chứa chữ gõ.
 */
import { foldText } from '$shared/text';

export interface CustomerOption {
  id: string;
  code: string;
  name: string;
  province?: string | undefined;
  phone?: string | undefined;
  taxCode?: string | undefined;
  status?: string | undefined;
}

/** Chỉ giữ chữ số; số bắt đầu bằng 84 (dạng +84 912…) quy về 0912… */
export function phoneDigits(value: string | undefined): string {
  const digits = (value ?? '').replace(/\D/g, '');
  return digits.startsWith('84') && digits.length >= 11 ? `0${digits.slice(2)}` : digits;
}

export function customerLabel(option: CustomerOption): string {
  return `${option.code} — ${option.name}${option.province ? ` (${option.province})` : ''}`;
}

export function searchCustomers<T extends CustomerOption>(options: readonly T[], query: string, limit = 50): T[] {
  const text = foldText(query);
  if (!text) return options.slice(0, limit);
  const digits = phoneDigits(query);
  const phoneQuery = digits.length >= 3 && /^[\d\s.+()-]+$/.test(query.trim());
  const tokens = text.split(' ');
  const scored: Array<{ option: T; score: number; index: number }> = [];
  options.forEach((option, index) => {
    const code = foldText(option.code);
    const name = foldText(option.name);
    const haystack = `${code} ${name} ${foldText(option.province ?? '')} ${foldText(option.taxCode ?? '')}`;
    let score = 0;
    if (code === text) score = 100;
    else if (phoneQuery && phoneDigits(option.phone).includes(digits)) score = 90;
    else if (code.startsWith(text)) score = 80;
    else if (name.startsWith(text)) score = 70;
    else if (tokens.every((token) => haystack.includes(token))) score = 50;
    if (score) scored.push({ option, score, index });
  });
  return scored.sort((a, b) => b.score - a.score || a.index - b.index).slice(0, limit).map((row) => row.option);
}
