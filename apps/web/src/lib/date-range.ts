/**
 * Lọc danh sách theo khoảng ngày (LIST-DATE-01, 15/10/2026): các mốc chọn nhanh tính theo giờ Việt Nam, gửi máy chủ dạng
 * `from` / `to` = YYYY-MM-DD (trọn ngày). Rỗng = không giới hạn.
 */
import { isoFromParts, lastDayOfMonth, todayIso, vnToday } from '$lib/format';

export const DATE_PRESETS = ['ALL', 'TODAY', '7D', 'THIS_MONTH', 'LAST_MONTH', 'THIS_QUARTER', 'THIS_YEAR', 'CUSTOM'] as const;
export type DatePreset = (typeof DATE_PRESETS)[number];
export interface DateRange { from: string; to: string }

export function presetRange(preset: DatePreset, today = vnToday()): DateRange {
  const { year, month, day } = today;
  const iso = isoFromParts(year, month, day);
  switch (preset) {
    case 'TODAY':
      return { from: iso, to: iso };
    case '7D': {
      const start = new Date(Date.UTC(year, month - 1, day - 6));
      return { from: start.toISOString().slice(0, 10), to: iso };
    }
    case 'THIS_MONTH':
      return { from: isoFromParts(year, month, 1), to: isoFromParts(year, month, lastDayOfMonth(year, month)) };
    case 'LAST_MONTH': {
      const lastYear = month === 1 ? year - 1 : year;
      const last = month === 1 ? 12 : month - 1;
      return { from: isoFromParts(lastYear, last, 1), to: isoFromParts(lastYear, last, lastDayOfMonth(lastYear, last)) };
    }
    case 'THIS_QUARTER': {
      const start = Math.floor((month - 1) / 3) * 3 + 1;
      return { from: isoFromParts(year, start, 1), to: isoFromParts(year, start + 2, lastDayOfMonth(year, start + 2)) };
    }
    case 'THIS_YEAR':
      return { from: isoFromParts(year, 1, 1), to: isoFromParts(year, 12, 31) };
    default:
      return { from: '', to: '' };
  }
}

/** Mốc ứng với khoảng đang chọn (để hiện lại đúng lựa chọn khi mở trang từ URL / bộ lọc đã nhớ). */
export function presetOf(range: DateRange, today = vnToday()): DatePreset {
  if (!range.from && !range.to) return 'ALL';
  for (const preset of DATE_PRESETS) {
    if (preset === 'ALL' || preset === 'CUSTOM') continue;
    const candidate = presetRange(preset, today);
    if (candidate.from === range.from && candidate.to === range.to) return preset;
  }
  return 'CUSTOM';
}

/** Tham số gửi máy chủ — bỏ đầu trống. */
export function rangeQuery(range: DateRange): Record<string, string> {
  return { ...(range.from ? { from: range.from } : {}), ...(range.to ? { to: range.to } : {}) };
}

export function validRange(range: DateRange): boolean {
  return !range.from || !range.to || range.from <= range.to;
}

export { todayIso };
