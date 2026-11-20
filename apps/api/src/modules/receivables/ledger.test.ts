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

  it('CN-HIST-NO-01: dòng sổ cũ chỉ hiện số chứng từ sổ cũ — không có thì trống, số hóa đơn đi riêng', () => {
    const ledger = buildLedger(
      [
        receivable('h1', '141359996', '2026-01-14', { sourceType: 'HISTORY_IMPORT', historyInvoiceNo: '00000024' }),
        receivable('h2', '1000', '2026-01-15', { sourceType: 'HISTORY_IMPORT', historyDocumentNo: 'BH2026090062', historyInvoiceNo: '00000307' }),
        receivable('h3', '2000', '2026-01-16', { sourceType: 'MANUAL', historyInvoiceNo: '00000301', status: 'VOIDED', voidedAt: at('2026-01-17') }),
        receivable('h4', '3000', '2026-01-18', { sourceType: 'HISTORY_IMPORT' }),
      ],
      [
        payment('p1', '300000', '2026-01-19', 'RETURN', { mode: 'HISTORY', reference: '00000071', note: 'Trả hàng' }),
        payment('p2', '70680000', '2026-01-26', 'RECEIPT', { mode: 'HISTORY', reference: 'NTTK00009', documentNo: 'NTTK00009', note: 'Thu tiền' }),
        payment('p3', '100', '2026-01-27', 'RECEIPT', { mode: 'HISTORY', note: 'Thu tiền mặt' }),
        payment('p4', '200', '2026-01-28', 'RECEIPT', { mode: 'CUSTOMER', reference: 'FT123' }),
        payment('p5', '300', '2026-01-29', 'RECEIPT', { mode: 'DOCUMENT' }),
      ],
    );
    const byRef = (refId: string, kind = 'DEBIT') => ledger.rows.find((row) => row.refId === refId && row.kind === kind);
    expect(byRef('h1')).toMatchObject({ documentNo: '', invoiceNo: '00000024', code: 'AR-h1' });
    expect(byRef('h2')).toMatchObject({ documentNo: 'BH2026090062', invoiceNo: '00000307' });
    expect(byRef('h3')).toMatchObject({ documentNo: '', invoiceNo: '00000301' });
    expect(byRef('h3', 'VOID')).toMatchObject({ documentNo: '', invoiceNo: '00000301', description: 'Hủy chứng từ HĐ 00000301' });
    expect(byRef('h4')?.documentNo).toBe('');
    expect(byRef('h4')).not.toHaveProperty('invoiceNo');
    // Phiếu sổ cũ: reference là số hóa đơn khi sổ cũ không có số chứng từ; diễn giải phụ chỉ còn ghi chú.
    expect(byRef('p1', 'RETURN')).toMatchObject({ documentNo: '', invoiceNo: '00000071', detail: 'Trả hàng' });
    expect(byRef('p2', 'RECEIPT')).toMatchObject({ documentNo: 'NTTK00009', detail: 'Thu tiền' });
    expect(byRef('p2', 'RECEIPT')).not.toHaveProperty('invoiceNo');
    expect(byRef('p3', 'RECEIPT')?.documentNo).toBe('');
    // Phiếu ERP giữ như cũ: mã giao dịch, không có thì mã phiếu.
    expect(byRef('p4', 'RECEIPT')).toMatchObject({ documentNo: 'FT123', detail: 'FT123' });
    expect(byRef('p5', 'RECEIPT')?.documentNo).toBe('PAY-p5');
  });
});
