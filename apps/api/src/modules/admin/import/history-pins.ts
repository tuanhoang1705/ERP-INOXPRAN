import Decimal from 'decimal.js';

/** Chứng từ phải thu trong file lịch sử (bán hàng / hoàn tiền cho khách). */
const DEBIT_TYPES = new Set(['BAN_HANG', 'HOAN_TIEN']);

export interface PinEntry { id: string; customerCode: string; type: string; status: string; amount: string }
export interface DocumentPin { paid: Decimal; payments: string[] }
export interface KeptRow { id: string; customerCode: string; fileAmount: string; keptAmount: string; payments: string[] }

/**
 * Thay lô lịch sử (IMP-AR-01): chứng từ đã được phiếu thu theo từng chứng từ (ngoài lô) thu nhiều hơn số theo file mới.
 * - Lệch dưới 1 đ (bản cũ làm tròn đồng, kế toán thu đủ số tròn): giữ số đã thu làm số chứng từ, ghi lại số theo file.
 * - Lệch từ 1 đ, hoặc file mới không còn chứng từ đó: chặn, báo phiếu thu nào.
 */
export function planDocumentPins(entries: readonly PinEntry[], pins: ReadonlyMap<string, DocumentPin>) {
  const floors = new Map<string, Decimal>();
  const kept: KeptRow[] = [];
  const blocked: string[] = [];
  const present = new Set<string>();
  for (const entry of entries) {
    if (entry.status !== 'NHAP' || !DEBIT_TYPES.has(entry.type)) continue;
    present.add(entry.id);
    const pin = pins.get(entry.id);
    if (!pin || pin.paid.lte(entry.amount)) continue;
    const amount = new Decimal(entry.amount);
    if (pin.paid.minus(amount).lt(1)) {
      floors.set(entry.id, pin.paid);
      kept.push({ id: entry.id, customerCode: entry.customerCode, fileAmount: amount.toFixed(2), keptAmount: pin.paid.toFixed(2), payments: pin.payments });
    } else {
      blocked.push(`${entry.id} (${entry.customerCode}): phiếu thu ${pin.payments.join(', ')} đã thu theo chứng từ ${pin.paid.toFixed(2)} đ, nhiều hơn số theo file mới ${amount.toFixed(2)} đ — hủy / sửa phiếu thu trước khi thay`);
    }
  }
  for (const [rowId, pin] of pins) {
    if (!present.has(rowId)) blocked.push(`${rowId}: phiếu thu ${pin.payments.join(', ')} đã thu theo chứng từ này nhưng file mới không còn chứng từ ${rowId} — hủy / sửa phiếu thu trước khi thay`);
  }
  return { floors, kept, blocked };
}
