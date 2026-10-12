/**
 * Ô nhập số có phân cách hàng nghìn ngay khi gõ (dùng trong NumberInput.svelte).
 * - Hiển thị theo ngôn ngữ giao diện: vi `1.250.000,5` · zh `1,250,000.5`.
 * - Giá trị gửi lên API luôn là chuỗi chuẩn: chữ số + dấu chấm thập phân (`1250000.5`), rỗng khi chưa nhập.
 * - Định dạng lại sau mỗi lần gõ nhưng giữ con trỏ đúng chỗ: đếm số "ký tự có nghĩa" (chữ số, dấu thập phân)
 *   đứng trước con trỏ rồi đặt lại con trỏ sau đúng bấy nhiêu ký tự có nghĩa trong chuỗi mới.
 */
export interface NumberSeparators {
  group: string;
  decimal: string;
}

export function separatorsFor(locale: string): NumberSeparators {
  const parts = new Intl.NumberFormat(locale).formatToParts(1234567.5);
  return {
    group: parts.find((part) => part.type === 'group')?.value ?? ',',
    decimal: parts.find((part) => part.type === 'decimal')?.value ?? '.',
  };
}

const isDigit = (char: string) => char >= '0' && char <= '9';

function group(digits: string, separator: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, separator);
}

/** Giá trị chuẩn (hoặc số) → chuỗi hiển thị; bỏ số 0 thừa ở phần lẻ ("25.50" → "25,5"). */
export function formatNumberValue(value: string | number | null | undefined, sep: NumberSeparators): string {
  const text = value === null || value === undefined ? '' : String(value).trim();
  if (!text) return '';
  const negative = text.startsWith('-');
  const [intRaw = '', fracRaw = ''] = text.replace(/^-/, '').split('.');
  const intDigits = intRaw.replace(/\D/g, '').replace(/^0+(?=\d)/, '') || '0';
  const frac = fracRaw.replace(/\D/g, '').replace(/0+$/, '');
  return `${negative ? '-' : ''}${group(intDigits, sep.group)}${frac ? sep.decimal + frac : ''}`;
}

/** Chuẩn hóa giá trị để so sánh ("0100.500" → "100.5"). */
export function canonicalNumber(value: string | number | null | undefined): string {
  const text = value === null || value === undefined ? '' : String(value).trim();
  if (!text || !/\d/.test(text)) return '';
  const [intRaw = '', fracRaw = ''] = text.split('.');
  const intDigits = intRaw.replace(/\D/g, '').replace(/^0+(?=\d)/, '') || '0';
  const frac = fracRaw.replace(/\D/g, '').replace(/0+$/, '');
  return frac ? `${intDigits}.${frac}` : intDigits;
}

export interface Reformatted {
  /** Chuỗi hiển thị trong ô (có thể còn dấu thập phân cuối khi đang gõ, VD "25,"). */
  text: string;
  /** Giá trị chuẩn gửi đi. */
  value: string;
  caret: number;
}

/**
 * Đọc chuỗi người dùng vừa sửa (ký tự phân cách theo ngôn ngữ) và định dạng lại.
 * Chỉ dấu thập phân đầu tiên được giữ, phần lẻ cắt theo `decimals`; ô số nguyên bỏ mọi dấu.
 */
export function reformatNumberInput(text: string, caret: number, decimals: number, sep: NumberSeparators): Reformatted {
  let intDigits = '';
  let frac = '';
  let hasDecimal = false;
  let before = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? '';
    const decimalMark = decimals > 0 && !hasDecimal && char === sep.decimal;
    if (!isDigit(char) && !decimalMark) continue;
    if (decimalMark) hasDecimal = true;
    else if (hasDecimal) {
      if (frac.length >= decimals) continue;
      frac += char;
    } else intDigits += char;
    if (index < caret) before += 1;
  }
  const stripped = intDigits.replace(/^0+(?=\d)/, '');
  const removed = intDigits.length - stripped.length;
  before = before >= removed ? before - removed : 0;
  intDigits = stripped;
  if (!intDigits && hasDecimal) {
    intDigits = '0';
    before += 1;
  }
  const display = intDigits ? `${group(intDigits, sep.group)}${hasDecimal ? sep.decimal + frac : ''}` : '';
  let position = 0;
  let seen = 0;
  while (position < display.length && seen < before) {
    const char = display[position] ?? '';
    if (isDigit(char) || char === sep.decimal) seen += 1;
    position += 1;
  }
  return { text: display, value: intDigits ? (frac ? `${intDigits}.${frac}` : intDigits) : '', caret: position };
}

/**
 * Hiểu chuỗi dán vào ("1.250.000 đ", "1,250,000.50", "25,5") → giá trị chuẩn.
 * Có cả "." và "," thì dấu đứng sau cùng là dấu thập phân; một loại dấu lặp lại hoặc theo sau đúng 3 chữ số là phân cách nghìn.
 */
export function parseLooseNumber(text: string, decimals: number): string {
  const cleaned = text.replace(/[^\d.,]/g, '');
  if (!/\d/.test(cleaned)) return '';
  const lastDot = cleaned.lastIndexOf('.');
  const lastComma = cleaned.lastIndexOf(',');
  let decimalAt = -1;
  if (lastDot >= 0 && lastComma >= 0) decimalAt = Math.max(lastDot, lastComma);
  else {
    const mark = lastDot >= 0 ? '.' : lastComma >= 0 ? ',' : '';
    if (mark) {
      const at = cleaned.lastIndexOf(mark);
      const repeated = cleaned.indexOf(mark) !== at;
      const tail = cleaned.slice(at + 1);
      if (!repeated && !(tail.length === 3 && decimals < 3)) decimalAt = at;
    }
  }
  const intPart = (decimalAt >= 0 ? cleaned.slice(0, decimalAt) : cleaned).replace(/\D/g, '');
  const fracPart = decimalAt >= 0 ? cleaned.slice(decimalAt + 1).replace(/\D/g, '').slice(0, decimals) : '';
  return canonicalNumber(fracPart ? `${intPart || '0'}.${fracPart}` : intPart || '0');
}
