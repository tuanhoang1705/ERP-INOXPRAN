import { intlLocale } from './i18n';
import { m } from './paraglide/messages';

const VN_TZ = 'Asia/Ho_Chi_Minh';
/** Định dạng số/ngày theo ngôn ngữ giao diện (vi-VN: 1.234.567 · zh-CN: 1,234,567); đổi ngôn ngữ thì trang tải lại. */
const LOCALE = intlLocale();
const integer = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 0 });
const oneDecimal = new Intl.NumberFormat(LOCALE, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const twoDecimals = new Intl.NumberFormat(LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Số nguyên theo ngôn ngữ; số âm dưới 1 đơn vị (VD −0,32 đ số lẻ sổ cũ) hiện "0", không hiện "-0". */
function whole(value: number): string {
  const text = integer.format(value);
  return /^[-−]0$/.test(text) ? '0' : text;
}
/** Số tiền dạng "4.286.500.000 đ" như bản thiết kế. */
export function vnd(value: string | number | null | undefined): string {
  return `${whole(Math.round(Number(value ?? 0)))} ${m.tien_te_hau_to()}`;
}
export function num(value: string | number | null | undefined): string {
  return whole(Number(value ?? 0));
}
/** Số có tối đa 1 chữ số thập phân theo ngôn ngữ (VD 5,4 / 5.4). */
export function decimal1(value: number): string {
  return new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 1 }).format(value);
}
/** Tỷ lệ % tối đa 2 chữ số lẻ theo ngôn ngữ (VD 12,5% / 12.5%). */
export function rate(value: string | number | null | undefined): string {
  return `${new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 2 }).format(Number(value ?? 0))}%`;
}
export function millions(value: string | number): string {
  return `${oneDecimal.format(Number(value) / 1_000_000)} ${m.trieu_viet_tat()}`;
}
export function billions(value: string | number): string {
  return twoDecimals.format(Number(value) / 1_000_000_000);
}
export function percent(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return `${new Intl.NumberFormat(LOCALE, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value)}%`;
}
export function date(value: string | Date | null | undefined): string {
  if (!value) return '—';
  return new Intl.DateTimeFormat(LOCALE, { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: VN_TZ }).format(new Date(value));
}
export function dateTime(value: string | Date | null | undefined): string {
  if (!value) return '—';
  return new Intl.DateTimeFormat(LOCALE, { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: VN_TZ }).format(new Date(value));
}
export function time(value: string | Date): string {
  return new Intl.DateTimeFormat(LOCALE, { hour: '2-digit', minute: '2-digit', timeZone: VN_TZ }).format(new Date(value));
}

/** Ngày hôm nay theo giờ Việt Nam dạng YYYY-MM-DD (dùng cho input type=date). */
export function todayIso(offsetDays = 0): string {
  const shifted = new Date(Date.now() + 7 * 3_600_000 + offsetDays * 86_400_000);
  return shifted.toISOString().slice(0, 10);
}
export function isoFromParts(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
export function vnToday(): { year: number; month: number; day: number } {
  const [year, month, day] = todayIso().split('-').map(Number) as [number, number, number];
  return { year, month, day };
}
export function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}
export function initials(name: string | undefined): string {
  if (!name) return '··';
  const parts = name.trim().split(/\s+/);
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? parts[parts.length - 1]?.[0] ?? '' : '';
  return (first + last).toUpperCase();
}
