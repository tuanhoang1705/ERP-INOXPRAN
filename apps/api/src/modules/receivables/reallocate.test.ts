import { describe, expect, it } from 'vitest';
import { reallocateCustomer, ReallocationError, type EnginePayment, type EngineReceivable } from './reallocate';

const day = (value: string) => new Date(`${value}T12:00:00+07:00`);
const receivable = (id: string, amount: string, paid: string, due: string, segments: EngineReceivable['segments'] = [], status?: string): EngineReceivable => ({
  id, code: id.toUpperCase(), amount, paidAmount: paid, status: status ?? (paid === amount ? 'PAID' : Number(paid) > 0 ? 'PARTIALLY_PAID' : 'OPEN'),
  dueDate: day(due), createdAt: day(due), segments,
});
const payment = (id: string, date: string, allocations: EnginePayment['allocations'], extra: Partial<EnginePayment> = {}): EnginePayment => ({
  id, code: id.toUpperCase(), receivedAt: day(date), createdAt: day(date), kind: 'RECEIPT', mode: 'CUSTOMER', allocations, ...extra,
});
const sum = (list: ReadonlyArray<{ amount: string }>) => list.reduce((total, item) => total + Number(item.amount), 0);

describe('reallocateCustomer', () => {
  // NPP: chứng từ 1 (quạt 60 + nồi 40), chứng từ 2 (nồi 50). Đã thu 100 theo FIFO cũ → trả hết chứng từ 1.
  const receivables = [
    receivable('d1', '100', '100', '2026-06-01', [{ code: 'QUAT', amount: '60' }]),
    receivable('d2', '50', '0', '2026-07-01'),
  ];
  const payments = [payment('p1', '2026-07-15', [{ receivableId: 'd1', amount: '100' }], { mode: 'HISTORY' })];

  it('nợ thường trước: tiền chuyển sang nồi của chứng từ 2, quạt còn nợ', () => {
    const result = reallocateCustomer(receivables, payments);
    expect(result.payments.get('p1')).toEqual([
      { receivableId: 'd1', amount: '40.00' },
      { receivableId: 'd2', amount: '50.00' },
      { receivableId: 'd1', amount: '10.00', segment: 'QUAT' },
    ]);
    expect(result.receivables.get('d1')).toEqual({ paidAmount: '50.00', status: 'PARTIALLY_PAID', segments: [{ code: 'QUAT', amount: '60.00', paid: '10.00' }] });
    expect(result.receivables.get('d2')).toMatchObject({ paidAmount: '50.00', status: 'PAID' });
    expect(result.changedPayments).toEqual(['p1']);
  });

  it('giữ tổng mỗi phiếu và tổng đã thu của khách', () => {
    const result = reallocateCustomer(receivables, payments);
    expect(sum(result.payments.get('p1') ?? [])).toBe(100);
    expect([...result.receivables.values()].reduce((total, row) => total + Number(row.paidAmount), 0)).toBe(100);
  });

  it('phiếu chọn nhóm trả phần quạt trước', () => {
    const result = reallocateCustomer(receivables, [payment('p1', '2026-07-15', [{ receivableId: 'd1', amount: '100' }], { segment: 'QUAT' })]);
    expect(result.payments.get('p1')).toEqual([{ receivableId: 'd1', amount: '60.00', segment: 'QUAT' }, { receivableId: 'd1', amount: '40.00' }]);
  });

  it('phiếu trả hàng có dòng quạt: phần quạt vào phần nhóm', () => {
    const result = reallocateCustomer(
      [receivable('d1', '100', '30', '2026-06-01', [{ code: 'QUAT', amount: '60' }])],
      [payment('r1', '2026-07-01', [{ receivableId: 'd1', amount: '30' }], { kind: 'RETURN', mode: 'HISTORY', returnSegments: [{ code: 'QUAT', amount: '20' }] })],
    );
    expect(result.payments.get('r1')).toEqual([{ receivableId: 'd1', amount: '20.00', segment: 'QUAT' }, { receivableId: 'd1', amount: '10.00' }]);
  });

  it('phiếu thu theo chứng từ chỉ chia lại trong chính chứng từ (nợ thường trước); bản ghi cũ không có mode cũng vậy', () => {
    const docs = [receivable('d1', '100', '70', '2026-06-01', [{ code: 'QUAT', amount: '60' }]), receivable('d2', '50', '0', '2026-05-01')];
    const result = reallocateCustomer(docs, [payment('p1', '2026-07-01', [{ receivableId: 'd1', amount: '70' }], { mode: 'DOCUMENT' })]);
    expect(result.payments.get('p1')).toEqual([{ receivableId: 'd1', amount: '40.00' }, { receivableId: 'd1', amount: '30.00', segment: 'QUAT' }]);
    const legacy = reallocateCustomer(docs, [payment('p1', '2026-07-01', [{ receivableId: 'd1', amount: '70' }], { mode: undefined })]);
    expect(legacy.receivables.get('d2')?.paidAmount).toBe('0.00');
  });

  it('chứng từ hủy và khoản trả trước giữ nguyên phân bổ', () => {
    const docs = [
      receivable('void', '80', '80', '2026-05-01', [], 'VOIDED'),
      receivable('credit', '-80', '-30', '2036-01-01', [], 'OPEN'),
      receivable('d1', '30', '30', '2026-06-01', [{ code: 'QUAT', amount: '30' }]),
    ];
    const result = reallocateCustomer(docs, [
      payment('p1', '2026-05-10', [{ receivableId: 'void', amount: '80' }], { mode: 'DOCUMENT' }),
      payment('off', '2026-06-10', [{ receivableId: 'credit', amount: '-30' }, { receivableId: 'd1', amount: '30' }], { kind: 'OFFSET' }),
    ]);
    expect(result.receivables.get('void')).toMatchObject({ paidAmount: '80.00', status: 'VOIDED' });
    expect(result.receivables.get('credit')).toMatchObject({ paidAmount: '-30.00', status: 'OPEN' });
    expect(result.payments.get('off')).toEqual([{ receivableId: 'credit', amount: '-30.00' }, { receivableId: 'd1', amount: '30.00', segment: 'QUAT' }]);
    expect(result.changedPayments).toEqual(['off']);
  });

  it('dừng khi số đã thu của chứng từ không khớp tổng phiếu thu', () => {
    expect(() => reallocateCustomer([receivable('d1', '100', '90', '2026-06-01')], [payment('p1', '2026-07-01', [{ receivableId: 'd1', amount: '80' }])])).toThrow(ReallocationError);
  });

  it('dừng khi phần nhóm vượt số tiền chứng từ', () => {
    expect(() => reallocateCustomer([receivable('d1', '100', '0', '2026-06-01', [{ code: 'QUAT', amount: '120' }])], [])).toThrow(/vượt số tiền/);
  });
});
