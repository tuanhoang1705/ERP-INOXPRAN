import { ConflictException } from '@nestjs/common';
import { cancelledCode } from '@inoxpran/contracts';
import type { ClientSession, Db, Document, ObjectId } from 'mongodb';
import { vnParts } from '../../common/domain';
import { documentCode, type SequenceService } from '../../common/sequence.service';

/**
 * Mã phiếu nhập trả hàng (NK-01, 31/10/2026): theo quy trình kho cũ, phiếu khách trả hàng / hàng mẫu nhập lại đánh số NK
 * (NK + yyyy + mm + 4 số) thay cho TH; từ 06/11/2026 4 số cuối đếm tiếp cả năm như phiếu BH (NUM-01). Trả nhà máy vẫn là XT.
 * Kho có thể đã ghi số NK giấy trước khi vào ERP (ghi chú phiếu, công nợ nhập từ sổ cũ) → bỏ qua số đã có.
 */
export const RETURN_IN_PREFIX = 'NK';

const NK_IN_TEXT = /NK\s*-?\s*(20\d{2})(\d{2})(\d{4})(?!\d)/gi;

/** Các số NK (chuẩn hóa, không trùng) ghi trong một đoạn chữ, theo thứ tự xuất hiện. */
export function nkCodesIn(text: unknown): string[] {
  const found = [...String(text ?? '').matchAll(NK_IN_TEXT)].map((match) => `NK${match[1]}${match[2]}${match[3]}`);
  return [...new Set(found)];
}

/** Mã chuẩn của phiếu trả hàng (NK / XT + năm + tháng + 4 số) — chỉ mã này được nhả số khi hủy. */
const STANDARD_RETURN_CODE = /^(NK|XT)20\d{2}(0[1-9]|1[0-2])\d{4,5}$/;

/**
 * Phiếu trả hàng hủy nhả số cho phiếu mới, như phiếu BH (09/11/2026 — người dùng: "phiếu đã hủy 43 thì phiếu mới phải là 43"):
 * NK2026110043 → NK2026110043-H1 (giữ `originalCode`). Đổi theo thẻ kho, phiếu giảm nợ, liên kết phiếu bảo hành.
 */
export async function releaseReturnNumber(db: Db, row: Document, session: ClientSession): Promise<Document> {
  const oldCode = String(row.code);
  if (!STANDARD_RETURN_CODE.test(oldCode)) return row;
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const taken = await db.collection('stock_returns').find({ code: { $regex: `^${escape(oldCode)}-H\\d+$` } }, { session, projection: { code: 1 } }).toArray();
  const newCode = cancelledCode(oldCode, new Set(taken.map((item) => String(item.code))));
  const id = row._id as ObjectId;
  const updated = await db.collection('stock_returns').findOneAndUpdate({ _id: id }, { $set: { code: newCode, originalCode: oldCode } }, { session, returnDocument: 'after' });
  await db.collection('inventory_movements').updateMany({ referenceType: 'StockReturn', referenceId: oldCode }, { $set: { referenceId: newCode } }, { session });
  await db.collection('payments').updateMany({ stockReturnId: id }, { $set: { stockReturnCode: newCode } }, { session });
  await db.collection('payments').updateMany({ stockReturnId: id, reference: oldCode }, { $set: { reference: newCode } }, { session });
  await db.collection('warranty_tickets').updateMany({ 'stock.returnSlip.code': oldCode }, { $set: { 'stock.returnSlip.code': newCode } }, { session });
  return updated ?? row;
}

/**
 * Số phiếu trả hàng kế tiếp (NK khách trả / hàng mẫu, XT trả nhà máy) theo cách phiếu BH (NUM-01): số lớn nhất **đang dùng** trong
 * năm + 1 — phiếu hủy đã nhả số nên số của phiếu cuối bị hủy được dùng lại; số trống ở giữa bỏ qua. Bỏ qua số đã có ở phiếu khác
 * (kể cả mã cũ) và số NK của công nợ nhập từ sổ cũ. Phiếu hủy từ trước khi có quy tắc nhả số mà đang giữ số này → nhả rồi dùng.
 */
export async function nextReturnCode(db: Db, sequences: SequenceService, session: ClientSession, prefix: 'NK' | 'XT', at = new Date()): Promise<string> {
  const { year } = vnParts(at);
  const pattern = `^${prefix}${year}(0[1-9]|1[0-2])\\d{4,5}$`;
  const [highest] = await db.collection('stock_returns')
    .aggregate<{ value: number }>([
      { $match: { code: { $regex: pattern }, status: { $ne: 'VOIDED' } } },
      { $group: { _id: null, value: { $max: { $toInt: { $substrCP: ['$code', prefix.length + 6, 5] } } } } },
    ], { session })
    .toArray();
  let sequence = (highest?.value ?? 0) + 1;
  for (let attempt = 0; attempt < 200; attempt += 1, sequence += 1) {
    const code = documentCode(prefix, at, sequence);
    const [holder, legacy, history] = await Promise.all([
      db.collection('stock_returns').findOne({ code }, { session }),
      db.collection('stock_returns').countDocuments({ legacyCode: code }, { session, limit: 1 }),
      prefix === RETURN_IN_PREFIX ? db.collection('payments').countDocuments({ reference: code, mode: 'HISTORY' }, { session, limit: 1 }) : Promise.resolve(0),
    ]);
    if (legacy || history) continue;
    if (holder && holder.status !== 'VOIDED') continue;
    if (holder) await releaseReturnNumber(db, holder, session);
    await sequences.claim(prefix, at, sequence, session);
    return code;
  }
  throw new ConflictException({ code: 'RETURN_CODE_EXHAUSTED', message: `Không cấp được số ${prefix} mới — báo quản trị hệ thống` });
}

/** Số NK kế tiếp (khách trả hàng / hàng mẫu nhập lại). */
export function nextReturnInCode(db: Db, sequences: SequenceService, session: ClientSession, at = new Date()): Promise<string> {
  return nextReturnCode(db, sequences, session, RETURN_IN_PREFIX, at);
}

// ---------------------------------------------------------------------------------------------------------------------
// Đổi mã phiếu TH cũ sang NK theo số kho ghi trong ghi chú (script renumber-stock-returns).

export interface RenumberSlip {
  code: string;
  createdAt: Date;
  /** Ngày chứng từ (ngày nhận hàng) — tháng của số NK mới. */
  documentAt: Date;
  note?: string;
  partnerId?: string;
}

export type RenumberFlag =
  /** Ghi chú không có số NK → cấp số NK mới chưa dùng của tháng chứng từ. */
  | 'NO_NK'
  /** Ghi chú có từ 2 số NK trở lên → cần quyết định (RENUMBER_DECISIONS_JSON). */
  | 'MULTIPLE_NK'
  /** Tháng của số NK khác tháng chứng từ (chỉ báo). */
  | 'MONTH_MISMATCH'
  /** Nhiều phiếu ghi cùng một số NK → phiếu sau thêm đuôi -2, -3. */
  | 'DUPLICATE_NK'
  /** Số NK đã có trong công nợ nhập từ sổ cũ của chính khách này → có thể trừ nợ 2 lần (chỉ báo). */
  | 'HISTORY_SAME_CUSTOMER'
  /** Số NK đã có trong công nợ sổ cũ của khách khác (chỉ báo). */
  | 'HISTORY_OTHER_CUSTOMER'
  /** Mã đích đã là mã của phiếu khác → dừng. */
  | 'TARGET_EXISTS'
  /** Theo file quyết định. */
  | 'DECISION';

export interface RenumberRow {
  from: string;
  to: string | null;
  base: string | null;
  flags: RenumberFlag[];
}

export interface RenumberPlan {
  rows: RenumberRow[];
  /** Hàng chặn chạy thật (MULTIPLE_NK chưa có quyết định, TARGET_EXISTS). */
  blocked: RenumberRow[];
  /** Số lớn nhất đã dùng theo tháng (yyyymm → số) — đẩy bộ đếm NK lên sau khi đổi. */
  counters: Record<string, number>;
}

const monthKey = (at: Date) => {
  const { year, month } = vnParts(at);
  return `${year}${String(month).padStart(2, '0')}`;
};
const sequenceOf = (code: string) => Number(code.slice(8, 12));

/**
 * Lập bảng đổi mã (thuần, có unit test). `existingCodes`: mã phiếu trả hàng hiện có (kể cả NK đã đổi trước);
 * `history`: số NK trong công nợ sổ cũ → partnerId; `decisions`: mã TH → số NK chốt tay (không đuôi).
 */
export function planRenumber(
  slips: readonly RenumberSlip[],
  existingCodes: ReadonlySet<string>,
  history: ReadonlyMap<string, ReadonlySet<string>>,
  decisions: Readonly<Record<string, string>> = {},
): RenumberPlan {
  const ordered = [...slips].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.code.localeCompare(b.code));
  const rows = ordered.map((slip): RenumberRow & { slip: RenumberSlip } => {
    const flags: RenumberFlag[] = [];
    const decided = decisions[slip.code];
    const found = nkCodesIn(slip.note);
    let base: string | null = null;
    if (decided) {
      base = nkCodesIn(decided)[0] ?? null;
      flags.push('DECISION');
    } else if (found.length === 1) base = found[0]!;
    else if (found.length > 1) flags.push('MULTIPLE_NK');
    else flags.push('NO_NK');
    if (base && base.slice(2, 8) !== monthKey(slip.documentAt)) flags.push('MONTH_MISMATCH');
    return { slip, from: slip.code, to: null, base, flags };
  });

  // Số đã dùng theo tháng: số NK ghi chú, mã NK hiện có, công nợ sổ cũ.
  const used = new Set<string>([...existingCodes].filter((code) => code.startsWith(RETURN_IN_PREFIX)).map((code) => code.slice(0, 12)));
  for (const row of rows) if (row.base) used.add(row.base);
  for (const code of history.keys()) used.add(code);
  const highest = new Map<string, number>();
  for (const code of used) {
    const month = code.slice(2, 8);
    highest.set(month, Math.max(highest.get(month) ?? 0, sequenceOf(code)));
  }

  // Phiếu không có số NK: cấp số kế tiếp của tháng chứng từ.
  for (const row of rows) {
    if (row.base || row.flags.includes('MULTIPLE_NK')) continue;
    const month = monthKey(row.slip.documentAt);
    const next = (highest.get(month) ?? 0) + 1;
    highest.set(month, next);
    row.base = `${RETURN_IN_PREFIX}${month}${String(next).padStart(4, '0')}`;
  }

  // Trùng số: phiếu lập trước giữ số, phiếu sau thêm đuôi -2, -3…
  const seen = new Map<string, number>();
  for (const row of rows) {
    if (!row.base) continue;
    const count = (seen.get(row.base) ?? 0) + 1;
    seen.set(row.base, count);
    row.to = count === 1 ? row.base : `${row.base}-${count}`;
  }
  for (const row of rows) {
    if (row.base && (seen.get(row.base) ?? 0) > 1) row.flags.push('DUPLICATE_NK');
    if (row.to && existingCodes.has(row.to)) row.flags.push('TARGET_EXISTS');
    const owners = row.base ? history.get(row.base) : undefined;
    if (owners?.size) row.flags.push(row.slip.partnerId && owners.has(row.slip.partnerId) ? 'HISTORY_SAME_CUSTOMER' : 'HISTORY_OTHER_CUSTOMER');
  }

  const plain = rows.map(({ slip: _slip, ...row }) => row);
  return {
    rows: plain,
    blocked: plain.filter((row) => !row.to || row.flags.includes('TARGET_EXISTS')),
    counters: Object.fromEntries(highest),
  };
}
