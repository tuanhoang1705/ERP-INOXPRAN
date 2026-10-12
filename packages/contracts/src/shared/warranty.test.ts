import { describe, expect, it } from 'vitest';
import { addMonths, coverageFor, serviceDays, slaState, warrantyExpiry, WARRANTY_ACTIONS_BY_STATUS, WARRANTY_STATUSES } from './warranty';

describe('hạn bảo hành', () => {
  it('12 tháng kết thúc vào ngày tương ứng của tháng cuối (BLDS 2015 Điều 147–148)', () => {
    expect(warrantyExpiry('2026-10-03', 12)).toBe('2027-10-03');
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2027-02-28', 12)).toBe('2028-02-28');
  });

  it('cộng thêm thời gian các lần bảo hành trước', () => {
    expect(warrantyExpiry('2026-10-03', 12, 11)).toBe('2027-10-14');
  });

  it('bắt buộc có hóa đơn', () => {
    expect(coverageFor({ invoiceDate: null, receivedDate: '2026-10-03' })).toEqual({ coverage: 'NOT_COVERED', exclusion: 'NO_INVOICE' });
  });

  it('còn / hết bảo hành theo ngày tiếp nhận', () => {
    expect(coverageFor({ invoiceDate: '2025-10-03', receivedDate: '2026-10-03' })).toMatchObject({ coverage: 'IN_WARRANTY', expiresOn: '2026-10-03' });
    expect(coverageFor({ invoiceDate: '2025-10-03', receivedDate: '2026-10-04' })).toMatchObject({ coverage: 'OUT_OF_WARRANTY' });
    expect(coverageFor({ invoiceDate: '2025-10-03', receivedDate: '2026-10-10', extensionDays: 7 })).toMatchObject({ coverage: 'IN_WARRANTY', expiresOn: '2026-10-10' });
  });
});

describe('màu theo hẹn trả (vàng khi qua 70% thời gian hẹn)', () => {
  // Tiếp nhận 08:00 ngày 01/10 (giờ VN), hẹn trả 07/10 → hết hạn 23:59:59 ngày 07/10.
  const receivedAt = new Date('2026-10-01T08:00:00+07:00');
  const base = { receivedAt, promisedDate: '2026-10-07' };
  const window = new Date('2026-10-07T23:59:59.999+07:00').getTime() - receivedAt.getTime();

  it('chưa qua 70%: không màu', () => {
    const state = slaState({ ...base, now: new Date(receivedAt.getTime() + window * 0.69) });
    expect(state.tone).toBe('normal');
    expect(state.daysLeft).toBeGreaterThan(0);
  });

  it('qua 70%: vàng', () => {
    expect(slaState({ ...base, now: new Date(receivedAt.getTime() + window * 0.71) }).tone).toBe('warning');
    expect(slaState({ ...base, now: new Date('2026-10-07T23:00:00+07:00') }).tone).toBe('warning');
  });

  it('quá cuối ngày hẹn: đỏ, đếm số ngày trễ', () => {
    const state = slaState({ ...base, now: new Date('2026-10-09T10:00:00+07:00') });
    expect(state.tone).toBe('overdue');
    expect(state.lateDays).toBe(2);
  });

  it('đã trả khách: không tô màu, ghi số ngày trễ khi trả', () => {
    expect(slaState({ ...base, now: new Date('2026-10-20T00:00:00+07:00'), closedAt: '2026-10-06T15:00:00+07:00' })).toMatchObject({ tone: 'closed', lateDays: 0 });
    expect(slaState({ ...base, now: new Date('2026-10-20T00:00:00+07:00'), closedAt: '2026-10-08T15:00:00+07:00' })).toMatchObject({ tone: 'closed', lateDays: 1 });
  });
});

describe('luồng trạng thái', () => {
  it('mọi trạng thái đều khai báo thao tác; phiếu đã đóng không còn thao tác', () => {
    for (const status of WARRANTY_STATUSES) expect(WARRANTY_ACTIONS_BY_STATUS[status]).toBeDefined();
    expect(WARRANTY_ACTIONS_BY_STATUS.RETURNED).toEqual([]);
    expect(WARRANTY_ACTIONS_BY_STATUS.CANCELLED).toEqual([]);
  });

  it('số ngày giữ máy', () => {
    expect(serviceDays('2026-09-01T09:00:00+07:00', '2026-09-06T16:00:00+07:00')).toBe(5);
  });
});
