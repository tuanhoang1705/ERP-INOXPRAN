import { customerReturnRating, returnMonthTone } from '@inoxpran/contracts';
import { Decimal128 } from 'mongodb';
import { describe, expect, it } from 'vitest';
import { addSlip, calendarDays, emptySplit, paymentBucket, percentOf, receivedBetween, slipReceivedAt, slipState, slipValue, splitView } from './returns-report';

const d = (value: string) => Decimal128.fromString(value);
const at = (iso: string) => new Date(iso);
const slip = (extra: Record<string, unknown>) => ({
  kind: 'CUSTOMER',
  status: 'POSTED',
  category: 'SLOW_RETURN_IN',
  receivedAt: at('2026-11-10T03:00:00Z'),
  lines: [{ quantity: d('2') }],
  ...extra,
});

describe('trạng thái và giá trị phiếu NK khách trả (RPT-RET-01)', () => {
  it('đã giảm nợ lấy số tiền kế toán ghi giảm, không lấy giá theo phiếu BH', () => {
    const row = slip({ accountingStatus: 'DONE', accountingMode: 'CREDIT', creditNote: { amount: d('950000') }, value: { total: '1000000' } });
    expect(slipState(row)).toBe('CREDITED');
    expect(slipValue(row)?.toString()).toBe('950000');
  });

  it('chờ kế toán / không giảm nợ lấy giá theo phiếu BH gốc; không có giá = chưa định giá', () => {
    expect(slipState(slip({ accountingStatus: 'PENDING', value: { total: '500000' } }))).toBe('PENDING');
    expect(slipValue(slip({ accountingStatus: 'PENDING', value: { total: '500000' } }))?.toString()).toBe('500000');
    expect(slipValue(slip({ accountingStatus: 'PENDING' }))).toBeNull();
    expect(slipState(slip({ accountingStatus: 'DONE', accountingMode: 'NONE', value: { total: '300000' } }))).toBe('NOT_CREDITED');
    // Phiếu giảm nợ đã tự hủy (BH gốc hủy): chế độ NONE, không còn creditNote.
    expect(slipState(slip({ accountingStatus: 'DONE', accountingMode: 'CREDIT' }))).toBe('NOT_CREDITED');
  });

  it('hàng tặng trả lại không tính tiền, chỉ cộng số lượng', () => {
    const split = emptySplit();
    addSlip(split, slip({ category: 'GIFT_RETURN_IN', lines: [{ quantity: d('3') }, { quantity: d('1') }] }));
    addSlip(split, slip({ accountingStatus: 'PENDING', value: { total: '200000' } }));
    addSlip(split, slip({ accountingStatus: 'DONE', accountingMode: 'CREDIT', creditNote: { amount: d('100000') } }));
    addSlip(split, slip({ accountingStatus: 'PENDING' }));
    addSlip(split, slip({ accountingStatus: 'DONE', accountingMode: 'NONE', value: { total: '50000' } }));
    expect(splitView(split)).toEqual({
      total: '350000.00', credited: '100000.00', notCredited: '50000.00', pending: '200000.00',
      slips: 5, creditedSlips: 1, notCreditedSlips: 1, pendingSlips: 2, unvaluedSlips: 1, giftQuantity: '4',
    });
  });
});

describe('đếm ngày', () => {
  it('đếm ngày theo lịch Việt Nam', () => {
    // 26/09 00:30 và 26/09 08:00 giờ VN: cùng ngày; 25/09 23:30 → 26/09 08:00: 1 ngày.
    expect(calendarDays(at('2026-09-25T17:30:00Z'), at('2026-09-26T01:00:00Z'))).toBe(0);
    expect(calendarDays(at('2026-09-25T16:30:00Z'), at('2026-09-26T01:00:00Z'))).toBe(1);
    expect(calendarDays(at('2026-09-25T03:00:00Z'), at('2026-10-29T03:00:00Z'))).toBe(34);
  });
});

describe('ngưỡng và xếp loại', () => {
  it('tháng: ≤ 6% đạt, ≤ 9% theo dõi, trên 9% vượt', () => {
    expect([5.4, 6, 7.7, 9, 10.2].map(returnMonthTone)).toEqual(['OK', 'OK', 'WATCH', 'WATCH', 'OVER']);
    expect(returnMonthTone(null)).toBeNull();
  });

  it('khách: rủi ro cao khi trên 10% kèm quá hạn trên 60 ngày hoặc trả nợ bằng hàng trên 30%', () => {
    expect(customerReturnRating({ rate: 21, returns: 172, maxDaysOverdue: 74, debtByReturns: 47.9 })).toBe('HIGH_RISK');
    expect(customerReturnRating({ rate: 11.4, returns: 64, maxDaysOverdue: 52, debtByReturns: 0 })).toBe('WARNING');
    expect(customerReturnRating({ rate: 11, returns: 136, maxDaysOverdue: 35, debtByReturns: 31 })).toBe('HIGH_RISK');
    expect(customerReturnRating({ rate: 7, returns: 48, maxDaysOverdue: 90, debtByReturns: 80 })).toBe('WATCH');
    expect(customerReturnRating({ rate: 4.5, returns: 71, maxDaysOverdue: 0, debtByReturns: 4.8 })).toBe('NORMAL');
    expect(customerReturnRating({ rate: 0, returns: 0, maxDaysOverdue: 100, debtByReturns: null })).toBe('NORMAL');
    // Trả hàng mua từ trước, không có doanh số trong khoảng xem.
    expect(customerReturnRating({ rate: null, returns: 10, maxDaysOverdue: 0, debtByReturns: null })).toBe('WARNING');
  });
});

describe('lọc ngày nhận hàng trả', () => {
  it('ngày nhận → ngày ghi kho → ngày lập (phiếu cũ / dữ liệu mẫu thiếu ngày nhận)', () => {
    const from = at('2026-10-31T17:00:00Z');
    expect(receivedBetween(from)).toEqual({ $or: [{ receivedAt: { $gte: from } }, { receivedAt: null, postedAt: { $gte: from } }, { receivedAt: null, postedAt: null, createdAt: { $gte: from } }] });
    expect(slipReceivedAt({ createdAt: at('2026-11-13T07:00:00Z') })).toEqual(at('2026-11-13T07:00:00Z'));
  });
});

describe('tiện ích', () => {
  it('phần trăm một chữ số, mẫu 0 = không có', () => {
    expect(percentOf('168', '1960')).toBe(8.6);
    expect(percentOf('5', '0')).toBeNull();
  });

  it('loại phiếu thu: bù trừ không tính, thiếu loại = thu tiền', () => {
    expect([undefined, 'RECEIPT', 'RETURN', 'FREIGHT', 'OFFSET'].map(paymentBucket)).toEqual(['collected', 'collected', 'returnCredits', 'freight', null]);
  });
});
