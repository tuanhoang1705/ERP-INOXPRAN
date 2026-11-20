/**
 * Số chứng từ / số hóa đơn hiển thị của một dòng công nợ (CN-HIST-NO-01, 19/11/2026 — kế toán: "lấy số hóa đơn hiển thị cho số chứng
 * từ là không đúng"). Dòng sổ cũ — chứng từ nhập từ file sổ cũ (HISTORY_IMPORT), dòng kế toán thêm tay trên sổ (MANUAL), phiếu thu /
 * trả hàng sổ cũ (`mode: HISTORY`) — chỉ dùng số chứng từ của sổ cũ; không có thì để trống, KHÔNG lấy số hóa đơn hay mã ERP thay.
 * Số hóa đơn đi riêng (cột "số hóa đơn" của Excel, dòng "HĐ …" trên sổ). Chứng từ ERP giữ như cũ: số phiếu BH, chứng từ đầu kỳ,
 * phiếu bảo hành, rồi mã ERP; phiếu thu ERP: mã giao dịch rồi mã phiếu.
 */

const text = (value: unknown): string | undefined => {
  if (value === undefined || value === null) return undefined;
  const trimmed = String(value).trim();
  return trimmed ? trimmed : undefined;
};

/** Nguồn chứng từ phải thu có số chứng từ / số hóa đơn do kế toán ghi (sổ cũ). */
export const LEDGER_HISTORY_SOURCES: readonly string[] = ['HISTORY_IMPORT', 'MANUAL'];

export interface DisplayNumbers {
  /** Dòng sổ cũ: số chứng từ có thể trống. */
  history: boolean;
  documentNo?: string;
  invoiceNo?: string;
}

const numbers = (history: boolean, documentNo: string | undefined, invoiceNo?: string): DisplayNumbers => ({
  history,
  ...(documentNo ? { documentNo } : {}),
  ...(invoiceNo ? { invoiceNo } : {}),
});

export function receivableNumbers(row: {
  sourceType?: unknown; code?: unknown; salesOrderCode?: unknown; historyDocumentNo?: unknown; historyInvoiceNo?: unknown;
  openingDocumentNo?: unknown; warrantyCode?: unknown;
} | null | undefined): DisplayNumbers {
  if (LEDGER_HISTORY_SOURCES.includes(String(row?.sourceType ?? ''))) return numbers(true, text(row?.historyDocumentNo), text(row?.historyInvoiceNo));
  return numbers(false, text(row?.salesOrderCode) ?? text(row?.openingDocumentNo) ?? text(row?.warrantyCode) ?? text(row?.code));
}

export function paymentNumbers(row: { mode?: unknown; code?: unknown; reference?: unknown; historyDocumentNo?: unknown; historyInvoiceNo?: unknown } | null | undefined): DisplayNumbers {
  if (row?.mode === 'HISTORY') {
    const documentNo = text(row.historyDocumentNo);
    // Phiếu sổ cũ nhập 10/2026: `reference` = số chứng từ, hoặc số hóa đơn khi dòng sổ cũ không có số chứng từ.
    return numbers(true, documentNo, text(row.historyInvoiceNo) ?? (documentNo ? undefined : text(row.reference)));
  }
  return numbers(false, text(row?.reference) ?? text(row?.code));
}

/** Chữ để nhận ra một chứng từ khi bắt buộc có (danh sách phân bổ, dòng hủy): số chứng từ, không có thì "HĐ …", rồi mã ERP. */
export function numbersLabel(value: DisplayNumbers, code: string): string {
  return value.documentNo ?? (value.invoiceNo ? `HĐ ${value.invoiceNo}` : code);
}
