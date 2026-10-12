import { describe, expect, it } from 'vitest';
import { classifyOverdue, daysOverdue } from './overdue-review';

describe('classifyOverdue', () => {
  it('không cảnh báo khi còn trong hạn', () => {
    expect(classifyOverdue(0)).toBeNull();
    expect(classifyOverdue(-5)).toBeNull();
  });

  it('phân đúng ba mức theo biên 30 và 60 ngày', () => {
    expect(classifyOverdue(1)).toBe('REMINDER');
    expect(classifyOverdue(30)).toBe('REMINDER');
    expect(classifyOverdue(31)).toBe('WARNING');
    expect(classifyOverdue(60)).toBe('WARNING');
    expect(classifyOverdue(61)).toBe('DANGER');
  });
});

describe('daysOverdue', () => {
  it('đếm theo ngày lịch Việt Nam, không theo số giờ trôi qua', () => {
    const due = new Date('2026-09-30T16:30:00.000Z'); // 23:30 ngày 30/09 giờ VN
    const now = new Date('2026-10-01T17:10:00.000Z'); // 00:10 ngày 02/10 giờ VN
    expect(daysOverdue(due, now)).toBe(2);
  });
});
