const DIGITS = ['không', 'một', 'hai', 'ba', 'bốn', 'năm', 'sáu', 'bảy', 'tám', 'chín'];

/** Đọc một nhóm 3 chữ số. `full` = đọc cả hàng trăm/chục bằng 0 khi nhóm đứng sau nhóm khác (vd. "không trăm linh năm"). */
function readTriple(value: number, full: boolean): string {
  const hundreds = Math.floor(value / 100);
  const tens = Math.floor(value / 10) % 10;
  const units = value % 10;
  const parts: string[] = [];
  if (full || hundreds > 0) parts.push(`${DIGITS[hundreds]} trăm`);
  if (tens === 0) {
    if (units > 0 && (full || hundreds > 0)) parts.push('linh');
  } else if (tens === 1) {
    parts.push('mười');
  } else {
    parts.push(`${DIGITS[tens]} mươi`);
  }
  if (units > 0) {
    if (units === 1 && tens > 1) parts.push('mốt');
    else if (units === 5 && tens > 0) parts.push('lăm');
    else parts.push(DIGITS[units] as string);
  }
  return parts.join(' ');
}

/** Đọc số nhỏ hơn một tỷ theo các nhóm triệu – nghìn – đơn vị. */
function readBelowBillion(value: number, full: boolean): string {
  const groups = [Math.floor(value / 1_000_000), Math.floor(value / 1_000) % 1_000, value % 1_000];
  const scales = ['triệu', 'nghìn', ''];
  const parts: string[] = [];
  let started = full;
  groups.forEach((group, index) => {
    if (group === 0) return;
    parts.push(`${readTriple(group, started)}${scales[index] ? ` ${scales[index]}` : ''}`);
    started = true;
  });
  return parts.join(' ');
}

function readNumber(value: number): string {
  if (value === 0) return 'không';
  const billions = Math.floor(value / 1_000_000_000);
  const rest = value % 1_000_000_000;
  const parts: string[] = [];
  if (billions > 0) parts.push(`${readNumber(billions)} tỷ`);
  if (rest > 0) parts.push(readBelowBillion(rest, billions > 0));
  return parts.join(' ');
}

/**
 * Số tiền bằng chữ theo cách trình bày trên chứng từ kế toán Việt Nam,
 * ví dụ 80.830.000 → "Tám mươi triệu tám trăm ba mươi nghìn đồng."
 */
export function vndInWords(amount: number | string): string {
  const value = Math.round(Math.abs(Number(amount)));
  if (!Number.isFinite(value)) return '';
  const text = readNumber(value);
  const sentence = `${Number(amount) < 0 ? 'âm ' : ''}${text} đồng.`;
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}
