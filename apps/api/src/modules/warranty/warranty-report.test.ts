import { Decimal128, ObjectId } from 'mongodb';
import { describe, expect, it } from 'vitest';
import { buildWarrantyReport, monthsBetween, shiftMonth } from './warranty-report';

const at = (iso: string) => new Date(iso);
const ticket = (extra: Record<string, unknown>) => ({
  _id: new ObjectId(),
  code: 'SC26100001',
  status: 'RETURNED',
  product: { sku: 'INP6001', name: 'Nồi cơm điện 1.8 L' },
  customer: { name: 'Đại lý A' },
  warranty: { priorServiceCount: 0 },
  lines: [{ faultCode: 'NC-03' }],
  ...extra,
});
const options = { from: '2026-09', to: '2026-10', now: at('2026-10-20T03:00:00Z'), warningRatio: 0.7, faultNames: new Map([['NC-03', 'Báo lỗi mã E']]) };

describe('monthsBetween / shiftMonth', () => {
  it('walks across year boundaries', () => {
    expect(monthsBetween('2026-11', '2027-02')).toEqual(['2026-11', '2026-12', '2027-01', '2027-02']);
    expect(shiftMonth('2027-02', -5)).toBe('2026-09');
  });
});

describe('buildWarrantyReport', () => {
  it('counts on-time returns against the final promised date (end of Vietnam day)', () => {
    const report = buildWarrantyReport([
      // Hẹn 10/10, trả 23:30 ngày 10/10 giờ VN → đúng hẹn.
      ticket({ receivedAt: at('2026-10-03T02:00:00Z'), promisedDate: '2026-10-10', returnedAt: at('2026-10-10T16:30:00Z'), result: { resolution: 'REPAIRED', cost: Decimal128.fromString('0'), chargedTo: 'COMPANY' } }),
      // Hẹn 05/10, trả 08/10 → trễ.
      ticket({ receivedAt: at('2026-09-28T02:00:00Z'), promisedDate: '2026-10-05', returnedAt: at('2026-10-08T02:00:00Z'), result: { resolution: 'PART_REPLACED', cost: Decimal128.fromString('120000'), chargedTo: 'COMPANY' } }),
    ], options);
    expect(report.totals.returned).toBe(2);
    expect(report.totals.onTimeRate).toBe(50);
    expect(report.totals.companyCost).toBe('120000');
    expect(report.byMonth.find((row) => row.month === '2026-09')?.received).toBe(1);
    expect(report.byMonth.find((row) => row.month === '2026-10')?.returned).toBe(2);
  });

  it('separates company cost from paid service revenue and counts rejections, exchanges, refunds', () => {
    const report = buildWarrantyReport([
      ticket({ receivedAt: at('2026-10-01T02:00:00Z'), promisedDate: '2026-10-08', returnedAt: at('2026-10-04T02:00:00Z'), result: { resolution: 'REPAIRED', cost: Decimal128.fromString('250000'), chargedTo: 'CUSTOMER' } }),
      ticket({ receivedAt: at('2026-10-01T02:00:00Z'), promisedDate: '2026-10-08', returnedAt: at('2026-10-04T02:00:00Z'), result: { resolution: 'REJECTED', cost: Decimal128.fromString('0'), chargedTo: 'CUSTOMER' } }),
      ticket({ receivedAt: at('2026-10-01T02:00:00Z'), promisedDate: '2026-10-08', returnedAt: at('2026-10-04T02:00:00Z'), result: { resolution: 'EXCHANGED', cost: Decimal128.fromString('900000'), chargedTo: 'COMPANY' } }),
      ticket({ receivedAt: at('2026-10-01T02:00:00Z'), promisedDate: '2026-10-08', returnedAt: at('2026-10-04T02:00:00Z'), result: { resolution: 'REFUNDED', cost: Decimal128.fromString('1500000'), chargedTo: 'COMPANY' } }),
    ], options);
    expect(report.totals.serviceRevenue).toBe('250000');
    expect(report.totals.companyCost).toBe('2400000');
    expect(report.totals.rejectionRate).toBe(25);
    expect([report.totals.exchanged, report.totals.refunded]).toEqual([1, 1]);
    expect(report.totals.averageTurnaroundDays).toBe(3);
  });

  it('lists products serviced 3 times or more on the same invoice and fault-code frequency', () => {
    const report = buildWarrantyReport([
      ticket({ code: 'SC26100009', status: 'RECEIVED', receivedAt: at('2026-10-19T02:00:00Z'), promisedDate: '2026-10-26', invoice: { number: '0003310' }, warranty: { priorServiceCount: 2 } }),
      ticket({ status: 'RECEIVED', receivedAt: at('2026-10-01T02:00:00Z'), promisedDate: '2026-10-08', lines: [{ faultCode: 'NC-03' }, { faultCode: 'NC-01' }] }),
    ], options);
    expect(report.repeatProducts).toHaveLength(1);
    expect(report.repeatProducts[0]).toMatchObject({ sku: 'INP6001', invoiceNumber: '0003310', services: 3, lastCode: 'SC26100009' });
    expect(report.byFaultCode[0]).toEqual({ code: 'NC-03', name: 'Báo lỗi mã E', count: 2 });
    expect(report.totals.open).toBe(2);
    expect(report.totals.overdueOpen).toBe(1);
  });
});
