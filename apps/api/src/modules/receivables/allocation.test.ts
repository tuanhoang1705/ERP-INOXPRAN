import { describe, expect, it } from 'vitest';
import { planFifoAllocation, type OpenItem } from './allocation';

const day = (value: string) => new Date(`${value}T00:00:00+07:00`);
const items: OpenItem[] = [
  { id: 'c', outstanding: '30000000', dueDate: day('2026-08-10'), createdAt: day('2026-07-10'), code: 'AR3' },
  { id: 'a', outstanding: '20000000', dueDate: day('2026-07-01'), createdAt: day('2026-06-01'), code: 'AR1' },
  { id: 'b', outstanding: '15000000', dueDate: day('2026-07-01'), createdAt: day('2026-06-05'), code: 'AR2' },
  { id: 'credit', outstanding: '-5000000', dueDate: day('2036-01-01'), createdAt: day('2026-06-01') },
];

describe('planFifoAllocation', () => {
  it('trả gối đầu 50 triệu: chứng từ hạn sớm nhất trước, cùng hạn thì phát sinh trước', () => {
    expect(planFifoAllocation(items, '50000000')).toEqual({
      allocations: [{ id: 'a', amount: '20000000.00' }, { id: 'b', amount: '15000000.00' }, { id: 'c', amount: '15000000.00' }],
      leftover: '0.00',
    });
  });
  it('thu đủ đúng tổng còn nợ', () => {
    const plan = planFifoAllocation(items, '65000000');
    expect(plan.allocations.map((row) => row.amount)).toEqual(['20000000.00', '15000000.00', '30000000.00']);
    expect(plan.leftover).toBe('0.00');
  });
  it('thu vượt → phần dư thành trả trước; bỏ qua khoản âm (trả trước cũ)', () => {
    const plan = planFifoAllocation(items, '70000000.50');
    expect(plan.allocations).toHaveLength(3);
    expect(plan.leftover).toBe('5000000.50');
  });
  it('khách không còn nợ → toàn bộ là trả trước', () => {
    expect(planFifoAllocation([], '1000000')).toEqual({ allocations: [], leftover: '1000000.00' });
  });
  it('thu ít hơn chứng từ đầu tiên → trả một phần', () => {
    expect(planFifoAllocation(items, '1500000').allocations).toEqual([{ id: 'a', amount: '1500000.00' }]);
  });
});
