import { describe, expect, it } from 'vitest';
import { buildLedger, type LedgerPayment, type LedgerReceivable } from './ledger';

const at = (value: string) => new Date(`${value}T10:00:00+07:00`);
const receivable = (id: string, amount: string, date: string, extra: Partial<LedgerReceivable> = {}): LedgerReceivable => ({ id, code: `AR-${id}`, amount, status: 'OPEN', createdAt: at(date), ...extra });
const payment = (id: string, amount: string, date: string, kind = 'RECEIPT', extra: Partial<LedgerPayment> = {}): LedgerPayment => ({ id, code: `PAY-${id}`, amount, kind, status: 'POSTED', receivedAt: at(date), ...extra });

describe('buildLedger', () => {
  const receivables = [
    receivable('1', '100000000', '2026-07-01', { salesOrderCode: 'BH2026070001', salesOrderId: 'o1' }),
    receivable('2', '50000000', '2026-08-01', { sourceType: 'HISTORY_IMPORT', historyInvoiceNo: '00000172' }),
    receivable('3', '20000000', '2026-08-05', { status: 'VOIDED', voidedAt: at('2026-08-06'), salesOrderCode: 'BH2026080009' }),
    receivable('credit', '-10000000', '2026-08-06', { sourceType: 'SALES_VOID_CREDIT' }),
  ];
  const payments = [
    payment('a', '60000000', '2026-07-20'),
    payment('f', '1950000', '2026-07-21', 'FREIGHT'),
    payment('r', '5000000', '2026-08-10', 'RETURN'),
    payment('offset', '10000000', '2026-08-11', 'OFFSET'),
    payment('void', '1', '2026-08-12', 'RECEIPT', { status: 'VOIDED' }),
  ];

  it('số dư = phát sinh − hủy − thu − phí vận chuyển − trả hàng; bỏ khoản trả trước âm và bù trừ', () => {
    const ledger = buildLedger(receivables, payments);
    expect(ledger.rows.map((row) => row.kind)).toEqual(['DEBIT', 'RECEIPT', 'FREIGHT', 'DEBIT', 'DEBIT', 'VOID', 'RETURN']);
    expect(ledger.totals).toEqual({ debit: '150000000.00', receipt: '60000000.00', freight: '1950000.00', returns: '5000000.00' });
    expect(ledger.closing).toBe('83050000.00');
    expect(ledger.rows.at(-1)?.balance).toBe('83050000.00');
  });

  it('lọc kỳ: số dư đầu kỳ cộng dồn các sự kiện trước kỳ', () => {
    const ledger = buildLedger(receivables, payments, at('2026-08-01'), at('2026-08-07'));
    expect(ledger.opening).toBe('38050000.00');
    expect(ledger.rows.map((row) => row.kind)).toEqual(['DEBIT', 'DEBIT', 'VOID']);
    expect(ledger.closing).toBe('88050000.00');
  });

  it('mô tả: phiếu BH, công nợ lịch sử, phí vận chuyển', () => {
    const ledger = buildLedger(receivables, payments);
    expect(ledger.rows[0]?.documentNo).toBe('BH2026070001');
    expect(ledger.rows[3]?.description).toContain('HĐ 00000172');
    expect(ledger.rows[2]?.description).toContain('Phí vận chuyển');
  });
});
