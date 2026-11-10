import { cancelledCode } from '@inoxpran/contracts';
import type { ClientSession, Db, Document, ObjectId } from 'mongodb';

/**
 * Quy chuẩn số phiếu chung (NUM-02, 09/11/2026 — người dùng: "phiếu nào đã delete hoặc huỷ thì sẽ thêm -H vào sau số phiếu",
 * "phiếu huỷ không được tính số phiếu"). Áp như phiếu BH (BH/SWK có releaseNumber riêng, phiếu trả hàng NK/XT ở return-codes):
 * - Số tự sinh = số lớn nhất **đang dùng** (chưa hủy) trong năm + 1 — hủy / xóa phiếu cuối thì phiếu mới lấy lại số đó.
 * - Phiếu hủy đổi số thành `…-H1` (giữ `originalCode`), đổi theo các chỗ đang chép số phiếu.
 * Loại không có trong danh sách (ADJ, TRF, GR, IS, IMP, YC — không hủy được) vẫn đếm bằng bộ đếm năm.
 */
export interface NumberedDocument {
  collection: string;
  /** Trạng thái coi là đã hủy (không tính số). */
  inactive: string[];
  /** Chỗ chép số phiếu sang chứng từ khác — đổi theo khi nhả số. */
  references: Array<{ collection: string; field: string; filter?: Document }>;
}

export const NUMBERED_DOCUMENTS: Record<string, NumberedDocument> = {
  SC: {
    collection: 'warranty_tickets',
    inactive: ['CANCELLED'],
    references: [
      { collection: 'inventory_movements', field: 'referenceId', filter: { referenceType: 'WarrantyTicket' } },
      { collection: 'receivables', field: 'warrantyCode' },
      { collection: 'sales_orders', field: 'warrantyCode' },
    ],
  },
  KK: { collection: 'stock_counts', inactive: ['CANCELLED'], references: [{ collection: 'inventory_movements', field: 'referenceId', filter: { referenceType: 'StockCount' } }] },
  PO: { collection: 'purchase_orders', inactive: ['CANCELLED'], references: [{ collection: 'stock_returns', field: 'purchaseOrderCode' }] },
  PAY: {
    collection: 'payments',
    inactive: ['VOIDED'],
    references: [
      { collection: 'receivables', field: 'paymentCode' },
      { collection: 'stock_returns', field: 'creditNote.code' },
    ],
  },
  AR: { collection: 'receivables', inactive: ['VOIDED'], references: [{ collection: 'warranty_tickets', field: 'receivable.code' }] },
  SG: { collection: 'price_override_requests', inactive: ['CANCELLED'], references: [] },
};

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Mã số chuẩn kiểu phiếu BH của một năm: PREFIX + năm + tháng + 4–5 số. */
export function yearCodePattern(prefix: string, year: number): string {
  return `^${prefix}${year}(0[1-9]|1[0-2])\\d{4,5}$`;
}

/**
 * Nhả số của phiếu đã hủy: CODE → CODE-H1 (n nhỏ nhất chưa dùng), lưu `originalCode`, đổi theo các chỗ chép số.
 * Phiếu đã mang đuôi -H… thì giữ nguyên. Trả phiếu sau khi đổi.
 */
export async function releaseDocumentNumber(db: Db, prefix: string, row: Document | null, session?: ClientSession): Promise<Document | null> {
  const source = NUMBERED_DOCUMENTS[prefix];
  if (!source || !row?.code) return row;
  const oldCode = String(row.code);
  if (!oldCode.startsWith(prefix) || /-H\d+$/.test(oldCode)) return row;
  const options = session ? { session } : {};
  const taken = await db.collection(source.collection).find({ code: { $regex: `^${escape(oldCode)}-H\\d+$` } }, { ...options, projection: { code: 1 } }).toArray();
  const newCode = cancelledCode(oldCode, new Set(taken.map((item) => String(item.code))));
  const updated = await db.collection(source.collection).findOneAndUpdate(
    { _id: row._id as ObjectId, code: oldCode },
    { $set: { code: newCode, originalCode: oldCode } },
    { ...options, returnDocument: 'after' },
  );
  if (!updated) return row;
  for (const reference of source.references) {
    await db.collection(reference.collection).updateMany({ ...(reference.filter ?? {}), [reference.field]: oldCode }, { $set: { [reference.field]: newCode } }, options);
  }
  return updated;
}

/** Số lớn nhất đang dùng (chưa hủy) trong năm của một loại phiếu; null nếu chưa có. */
export async function highestActiveSequence(db: Db, prefix: string, year: number, session: ClientSession): Promise<number | null> {
  const source = NUMBERED_DOCUMENTS[prefix];
  if (!source) return null;
  const [highest] = await db.collection(source.collection)
    .aggregate<{ value: number }>([
      { $match: { code: { $regex: yearCodePattern(prefix, year) }, status: { $nin: source.inactive } } },
      { $group: { _id: null, value: { $max: { $toInt: { $substrCP: ['$code', prefix.length + 6, 5] } } } } },
    ], { session })
    .toArray();
  return highest?.value ?? null;
}
