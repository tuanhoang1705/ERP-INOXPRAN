import { describe, expect, it } from 'vitest';
import { planHistoryCredits, receivableStatus } from './history-edit';

const day = (value: string) => new Date(`${value}T12:00:00+07:00`);
const doc = (id: string, room: string, date: string) => ({ id, code: id, room, dueDate: day(date), createdAt: day(date) });
const credit = (id: string, amount: string, date: string) => ({ id, code: id, amount, receivedAt: day(date), createdAt: day(date) });

describe('sửa / xóa dòng sổ công nợ cũ (CN-HIST-EDIT-01)', () => {
  it('phiếu sổ cũ theo ngày, chứng từ hạn sớm trước; thu vượt tổng chứng từ → khoản trả trước', () => {
    const plan = planHistoryCredits([doc('A', '1000', '2026-08-01'), doc('B', '500', '2026-09-01')], [credit('P1', '1200', '2026-08-10'), credit('P2', '600', '2026-09-10')], '1500');
    expect(plan.credits.get('P1')).toEqual({ allocations: [{ receivableId: 'A', amount: '1000.00' }, { receivableId: 'B', amount: '200.00' }], unapplied: '0.00' });
    expect(plan.credits.get('P2')).toEqual({ allocations: [{ receivableId: 'B', amount: '300.00' }], unapplied: '300.00' });
    expect(plan.leftover).toBe('300.00');
  });

  it('giảm số tiền chứng từ → phần thu dư tăng; tăng lại → dùng hết, không còn trả trước', () => {
    const credits = [credit('P1', '1000', '2026-08-10')];
    expect(planHistoryCredits([doc('A', '600', '2026-08-01')], credits, '600').leftover).toBe('400.00');
    expect(planHistoryCredits([doc('A', '1500', '2026-08-01')], credits, '1500').leftover).toBe('0.00');
  });

  it('xóa phiếu thu → chứng từ không còn được trả (không phân bổ)', () => {
    const plan = planHistoryCredits([doc('A', '1000', '2026-08-01')], [], '1000');
    expect(plan.credits.size).toBe(0);
    expect(plan.leftover).toBe('0.00');
  });

  it('phiếu ERP giữ nguyên phần đã chiếm: phiếu sổ cũ chỉ lấy phần sức chứa còn lại, chứng từ hết chỗ (âm) bỏ qua', () => {
    // A 1.000 đã bị phiếu ERP chiếm 1.200 (vừa giảm A) → chỗ âm; B 800 còn trống; ERP vào chứng từ vừa xóa 100 → sức chứa 1.800 − 1.300 = 500.
    const plan = planHistoryCredits([doc('A', '-200', '2026-08-01'), doc('B', '800', '2026-09-01')], [credit('P1', '700', '2026-08-10')], '500');
    expect(plan.credits.get('P1')).toEqual({ allocations: [{ receivableId: 'B', amount: '500.00' }], unapplied: '200.00' });
    expect(plan.leftover).toBe('200.00');
  });

  it('đổi ngày phiếu → thứ tự lấy sức chứa đổi theo ngày', () => {
    const plan = planHistoryCredits([doc('A', '500', '2026-08-01')], [credit('P1', '400', '2026-09-20'), credit('P2', '400', '2026-08-20')], '500');
    expect(plan.credits.get('P2')?.unapplied).toBe('0.00');
    expect(plan.credits.get('P1')).toEqual({ allocations: [{ receivableId: 'A', amount: '100.00' }], unapplied: '300.00' });
  });

  it('trạng thái chứng từ theo số đã thu; khoản trả trước (âm) bù trừ hết là PAID', () => {
    expect(receivableStatus('1000', '1000')).toBe('PAID');
    expect(receivableStatus('1000', '1')).toBe('PARTIALLY_PAID');
    expect(receivableStatus('1000', '0')).toBe('OPEN');
    expect(receivableStatus('-300', '-300')).toBe('PAID');
    expect(receivableStatus('-300', '-100')).toBe('OPEN');
  });
});
