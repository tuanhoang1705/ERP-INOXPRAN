import { describe, expect, it } from 'vitest';
import { presetOf, presetRange, rangeQuery, validRange } from './date-range';

const today = { year: 2026, month: 10, day: 15 };

describe('khoảng ngày lọc danh sách (LIST-DATE-01)', () => {
  it('mốc chọn nhanh theo ngày hôm nay', () => {
    expect(presetRange('TODAY', today)).toEqual({ from: '2026-10-15', to: '2026-10-15' });
    expect(presetRange('7D', today)).toEqual({ from: '2026-10-09', to: '2026-10-15' });
    expect(presetRange('THIS_MONTH', today)).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    expect(presetRange('LAST_MONTH', today)).toEqual({ from: '2026-09-01', to: '2026-09-30' });
    expect(presetRange('THIS_QUARTER', today)).toEqual({ from: '2026-10-01', to: '2026-12-31' });
    expect(presetRange('THIS_YEAR', today)).toEqual({ from: '2026-01-01', to: '2026-12-31' });
    expect(presetRange('ALL', today)).toEqual({ from: '', to: '' });
  });

  it('tháng trước của tháng 1 lùi sang năm trước; 7 ngày qua qua đầu tháng', () => {
    expect(presetRange('LAST_MONTH', { year: 2027, month: 1, day: 3 })).toEqual({ from: '2026-12-01', to: '2026-12-31' });
    expect(presetRange('7D', { year: 2026, month: 3, day: 2 })).toEqual({ from: '2026-02-24', to: '2026-03-02' });
  });

  it('nhận lại mốc từ khoảng (mở trang từ URL), còn lại là tùy chọn', () => {
    expect(presetOf({ from: '', to: '' }, today)).toBe('ALL');
    expect(presetOf({ from: '2026-10-01', to: '2026-10-31' }, today)).toBe('THIS_MONTH');
    expect(presetOf({ from: '2026-10-02', to: '2026-10-31' }, today)).toBe('CUSTOM');
    expect(presetOf({ from: '2026-10-01', to: '' }, today)).toBe('CUSTOM');
  });

  it('tham số gửi máy chủ bỏ đầu trống; từ > đến là không hợp lệ', () => {
    expect(rangeQuery({ from: '2026-10-01', to: '' })).toEqual({ from: '2026-10-01' });
    expect(validRange({ from: '2026-10-02', to: '2026-10-01' })).toBe(false);
    expect(validRange({ from: '2026-10-01', to: '' })).toBe(true);
  });
});
