/** Đề nghị sửa / hủy / xóa phiếu BH (SAL-CHG-01) — kiểu dữ liệu và nhãn dùng chung cho trang phiếu và trang danh sách. */
import { m } from '$lib/paraglide/messages';

export type ChangeKind = 'EDIT' | 'VOID' | 'CANCEL' | 'DELETE';
export type ChangeStatus = 'PENDING' | 'APPLIED' | 'REJECTED' | 'WITHDRAWN' | 'FAILED';
export interface ChangePreviewLine { sku: string; productName: string; unit: string; quantity: string; gift: boolean; unitPrice: string; lineTotal: string }
export interface ChangeRequest {
  id: string;
  code: string;
  kind: ChangeKind;
  status: ChangeStatus;
  orderId: string;
  orderCode: string;
  orderVersion: number;
  customerName?: string;
  reason: string;
  requestedById: string;
  requestedByName: string;
  requestedAt: string;
  decidedByName?: string;
  decidedAt?: string;
  decisionNote?: string;
  error?: string;
  preview?: { customerName: string; grandTotal: string; lines: ChangePreviewLine[] };
}

export function changeKindLabel(kind: ChangeKind): string {
  return { EDIT: m.yc_loai_sua(), VOID: m.yc_loai_huy_da_giao(), CANCEL: m.yc_loai_huy(), DELETE: m.yc_loai_xoa() }[kind];
}

export function changeStatus(status: ChangeStatus): { label: string; tone: string } {
  return {
    PENDING: { label: m.yc_tt_cho_duyet(), tone: 'warning' },
    APPLIED: { label: m.yc_tt_da_thuc_hien(), tone: 'success' },
    REJECTED: { label: m.yc_tt_tu_choi(), tone: 'danger' },
    WITHDRAWN: { label: m.yc_tt_da_rut(), tone: 'neutral' },
    FAILED: { label: m.yc_tt_khong_thuc_hien(), tone: 'danger' },
  }[status];
}

/** Gộp dòng hiện tại và dòng theo đề nghị theo mã + hàng tặng để so sánh. */
export function compareLines(
  current: Array<{ sku: string; productName: string; unit: string; quantity: string; gift?: boolean; unitPrice: string; lineTotal: string }>,
  proposed: ChangePreviewLine[],
) {
  const key = (row: { sku: string; gift?: boolean }) => `${row.sku}|${row.gift ? 'G' : ''}`;
  const map = new Map<string, { sku: string; productName: string; unit: string; gift: boolean; before?: { quantity: string; unitPrice: string; lineTotal: string }; after?: { quantity: string; unitPrice: string; lineTotal: string } }>();
  for (const row of current) {
    const entry = map.get(key(row)) ?? { sku: row.sku, productName: row.productName, unit: row.unit, gift: Boolean(row.gift) };
    entry.before = { quantity: String(Number(entry.before?.quantity ?? 0) + Number(row.quantity)), unitPrice: row.unitPrice, lineTotal: String(Number(entry.before?.lineTotal ?? 0) + Number(row.lineTotal)) };
    map.set(key(row), entry);
  }
  for (const row of proposed) {
    const entry = map.get(key(row)) ?? { sku: row.sku, productName: row.productName, unit: row.unit, gift: row.gift };
    entry.after = { quantity: String(Number(entry.after?.quantity ?? 0) + Number(row.quantity)), unitPrice: row.unitPrice, lineTotal: String(Number(entry.after?.lineTotal ?? 0) + Number(row.lineTotal)) };
    map.set(key(row), entry);
  }
  return [...map.values()].map((row) => ({
    ...row,
    changed: row.before?.quantity !== row.after?.quantity || Number(row.before?.unitPrice ?? -1) !== Number(row.after?.unitPrice ?? -1),
  }));
}
