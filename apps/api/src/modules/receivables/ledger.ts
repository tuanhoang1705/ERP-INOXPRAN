import Decimal from 'decimal.js';

/**
 * Sổ chi tiết công nợ theo khách (CN-KH-01) dựng theo sự kiện:
 * - chứng từ phải thu (số tiền > 0) → phát sinh nợ tại ngày phát sinh (createdAt; nhập lịch sử = ngày chứng từ);
 * - chứng từ bị hủy (VOIDED) → ghi giảm đúng số đó tại ngày hủy;
 * - phiếu giảm nợ: thu tiền (RECEIPT), phí vận chuyển khách trả (FREIGHT), trả hàng / điều chỉnh giảm (RETURN).
 * Khoản khách trả trước (phải thu âm) và phiếu bù trừ (OFFSET) chỉ là cách phân bổ nên không thành dòng sổ;
 * số dư theo sổ luôn bằng tổng còn nợ của các chứng từ (kể cả khoản trả trước âm).
 */
export type LedgerKind = 'DEBIT' | 'VOID' | 'RETURN' | 'FREIGHT' | 'RECEIPT';
const KIND_ORDER: Record<LedgerKind, number> = { DEBIT: 0, VOID: 1, RETURN: 2, FREIGHT: 3, RECEIPT: 4 };

export interface LedgerReceivable {
  id: string;
  code: string;
  amount: string;
  status: string;
  createdAt: Date;
  voidedAt?: Date | undefined;
  updatedAt?: Date | undefined;
  sourceType?: string | undefined;
  salesOrderId?: string | undefined;
  salesOrderCode?: string | undefined;
  warrantyTicketId?: string | undefined;
  warrantyCode?: string | undefined;
  openingDocumentNo?: string | undefined;
  historyDocumentNo?: string | undefined;
  historyInvoiceNo?: string | undefined;
  note?: string | undefined;
  voidReason?: string | undefined;
  /** Phần nhóm công nợ tách riêng của chứng từ (CN-SEG-01) — hiện "trong đó …" trên dòng phát sinh. */
  segments?: ReadonlyArray<{ code: string; amount: string }> | undefined;
}

export interface LedgerPayment {
  id: string;
  code: string;
  amount: string;
  kind: string;
  status: string;
  receivedAt: Date;
  method?: string | undefined;
  reference?: string | undefined;
  note?: string | undefined;
  mode?: string | undefined;
  documentNo?: string | undefined;
}

export interface LedgerRow {
  date: string;
  kind: LedgerKind;
  refId: string;
  code: string;
  /** Số chứng từ hiển thị: số phiếu BH / HĐ / mã giao dịch ngân hàng. */
  documentNo: string;
  description: string;
  /** Mã giao dịch / ghi chú (giao diện tự dịch nhãn theo loại, hiện thêm dòng này). */
  detail?: string;
  salesOrderId?: string;
  sourceType?: string;
  segments?: Array<{ code: string; amount: string }>;
  debit: string;
  receipt: string;
  freight: string;
  returns: string;
  balance: string;
}

export interface LedgerTotals {
  debit: string;
  receipt: string;
  freight: string;
  returns: string;
}

export interface Ledger {
  opening: string;
  rows: LedgerRow[];
  totals: LedgerTotals;
  closing: string;
}

const PAYMENT_KIND: Record<string, LedgerKind> = { RECEIPT: 'RECEIPT', FREIGHT: 'FREIGHT', RETURN: 'RETURN' };
const METHOD_VI: Record<string, string> = { BANK_TRANSFER: 'chuyển khoản', CASH: 'tiền mặt', OTHER: 'khác' };

function receivableLabel(row: LedgerReceivable): { documentNo: string; description: string } {
  if (row.sourceType === 'HISTORY_IMPORT') {
    const parts = [row.historyInvoiceNo ? `HĐ ${row.historyInvoiceNo}` : '', row.historyDocumentNo ? `CT ${row.historyDocumentNo}` : ''].filter(Boolean);
    return {
      documentNo: row.historyInvoiceNo || row.historyDocumentNo || row.code,
      description: `Công nợ lịch sử${parts.length ? ` — ${parts.join(' · ')}` : ''}${row.note ? ` · ${row.note}` : ''}`,
    };
  }
  if (row.sourceType === 'OPENING_BALANCE') return { documentNo: row.openingDocumentNo ?? row.code, description: `Công nợ đầu kỳ — chứng từ ${row.openingDocumentNo ?? ''}`.trim() };
  if (row.salesOrderCode) return { documentNo: row.salesOrderCode, description: `Xuất bán — phiếu ${row.salesOrderCode}` };
  if (row.warrantyCode) return { documentNo: row.warrantyCode, description: `Phí dịch vụ bảo hành ${row.warrantyCode}` };
  return { documentNo: row.code, description: row.note ?? 'Chứng từ phải thu' };
}

function paymentLabel(row: LedgerPayment, kind: LedgerKind): string {
  const extra = [row.reference, row.note].filter(Boolean).join(' · ');
  const base = kind === 'FREIGHT' ? 'Phí vận chuyển khách trả (trừ nợ)'
    : kind === 'RETURN' ? 'Trả hàng / điều chỉnh giảm'
    : `Thu tiền${row.method ? ` (${METHOD_VI[row.method] ?? row.method})` : ''}`;
  return extra ? `${base} — ${extra}` : base;
}

type LedgerEvent = Omit<LedgerRow, 'balance'> & { at: Date; effect: Decimal };

/** Các sự kiện của sổ (chưa lọc kỳ), sắp theo ngày rồi loại rồi mã. */
export function ledgerEvents(receivables: readonly LedgerReceivable[], payments: readonly LedgerPayment[]): LedgerEvent[] {
  const events: LedgerEvent[] = [];
  const zero = '0.00';
  for (const row of receivables) {
    const amount = new Decimal(row.amount);
    if (amount.lte(0)) continue;
    const label = receivableLabel(row);
    const link = { ...(row.salesOrderId ? { salesOrderId: row.salesOrderId } : {}), ...(row.sourceType ? { sourceType: row.sourceType } : {}), ...(row.note && row.sourceType === 'HISTORY_IMPORT' ? { detail: row.note } : {}) };
    const segments = (row.segments ?? []).filter((part) => new Decimal(part.amount).gt(0)).map((part) => ({ code: part.code, amount: new Decimal(part.amount).toFixed(2) }));
    events.push({ at: row.createdAt, date: row.createdAt.toISOString(), kind: 'DEBIT', refId: row.id, code: row.code, ...label, ...link, ...(segments.length ? { segments } : {}), debit: amount.toFixed(2), receipt: zero, freight: zero, returns: zero, effect: amount });
    if (row.status === 'VOIDED') {
      const at = row.voidedAt ?? row.updatedAt ?? row.createdAt;
      events.push({
        at, date: at.toISOString(), kind: 'VOID', refId: row.id, code: row.code, documentNo: label.documentNo,
        description: `Hủy chứng từ ${label.documentNo}${row.voidReason ? ` — ${row.voidReason}` : ''}`, ...link,
        debit: amount.neg().toFixed(2), receipt: zero, freight: zero, returns: zero, effect: amount.neg(),
      });
    }
  }
  for (const row of payments) {
    const kind = PAYMENT_KIND[row.kind || 'RECEIPT'];
    if (row.status !== 'POSTED' || !kind) continue;
    const amount = new Decimal(row.amount);
    const detail = [row.reference, row.note].filter(Boolean).join(' · ');
    events.push({
      ...(detail ? { detail } : {}),
      at: row.receivedAt, date: row.receivedAt.toISOString(), kind, refId: row.id, code: row.code, documentNo: row.documentNo || row.reference || row.code, description: paymentLabel(row, kind),
      debit: zero, receipt: kind === 'RECEIPT' ? amount.toFixed(2) : zero, freight: kind === 'FREIGHT' ? amount.toFixed(2) : zero, returns: kind === 'RETURN' ? amount.toFixed(2) : zero,
      effect: amount.neg(),
    });
  }
  return events.sort((a, b) => a.at.getTime() - b.at.getTime() || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.code.localeCompare(b.code));
}

/** Sổ chi tiết trong kỳ [from, toExclusive): số dư đầu kỳ, các dòng có số dư lũy kế, cộng phát sinh, số dư cuối kỳ. */
export function buildLedger(receivables: readonly LedgerReceivable[], payments: readonly LedgerPayment[], from?: Date, toExclusive?: Date): Ledger {
  let opening = new Decimal(0);
  let balance = new Decimal(0);
  const totals = { debit: new Decimal(0), receipt: new Decimal(0), freight: new Decimal(0), returns: new Decimal(0) };
  const rows: LedgerRow[] = [];
  for (const event of ledgerEvents(receivables, payments)) {
    if (toExclusive && event.at >= toExclusive) break;
    if (from && event.at < from) {
      opening = opening.add(event.effect);
      balance = opening;
      continue;
    }
    balance = balance.add(event.effect);
    totals.debit = totals.debit.add(event.debit);
    totals.receipt = totals.receipt.add(event.receipt);
    totals.freight = totals.freight.add(event.freight);
    totals.returns = totals.returns.add(event.returns);
    const { at: _at, effect: _effect, ...row } = event;
    rows.push({ ...row, balance: balance.toFixed(2) });
  }
  return {
    opening: opening.toFixed(2),
    rows,
    totals: { debit: totals.debit.toFixed(2), receipt: totals.receipt.toFixed(2), freight: totals.freight.toFixed(2), returns: totals.returns.toFixed(2) },
    closing: balance.toFixed(2),
  };
}
