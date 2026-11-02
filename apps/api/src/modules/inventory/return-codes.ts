import { ConflictException } from '@nestjs/common';
import type { ClientSession, Db } from 'mongodb';
import { vnParts } from '../../common/domain';
import type { SequenceService } from '../../common/sequence.service';

/**
 * Mã phiếu nhập trả hàng (NK-01, 31/10/2026): theo quy trình kho cũ, phiếu khách trả hàng / hàng mẫu nhập lại đánh số NK
 * (NK + yyyy + mm + 4 số, đếm lại mỗi tháng) thay cho TH. Phiếu trả nhà máy vẫn là XT.
 * Kho có thể đã ghi số NK giấy trước khi vào ERP (ghi chú phiếu, công nợ nhập từ sổ cũ) → bỏ qua số đã có.
 */
export const RETURN_IN_PREFIX = 'NK';

const NK_IN_TEXT = /NK\s*-?\s*(20\d{2})(\d{2})(\d{4})(?!\d)/gi;

/** Các số NK (chuẩn hóa, không trùng) ghi trong một đoạn chữ, theo thứ tự xuất hiện. */
export function nkCodesIn(text: unknown): string[] {
  const found = [...String(text ?? '').matchAll(NK_IN_TEXT)].map((match) => `NK${match[1]}${match[2]}${match[3]}`);
  return [...new Set(found)];
}

/** Số NK kế tiếp chưa dùng (không trùng phiếu trả hàng nào và số NK của công nợ nhập từ sổ cũ). */
export async function nextReturnInCode(db: Db, sequences: SequenceService, session: ClientSession, at = new Date()): Promise<string> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const code = await sequences.next(RETURN_IN_PREFIX, session, 4, at, 'compact');
    const [returns, history] = await Promise.all([
      db.collection('stock_returns').countDocuments({ $or: [{ code }, { legacyCode: code }] }, { session, limit: 1 }),
      db.collection('payments').countDocuments({ reference: code, mode: 'HISTORY' }, { session, limit: 1 }),
    ]);
    if (!returns && !history) return code;
  }
  throw new ConflictException({ code: 'RETURN_CODE_EXHAUSTED', message: 'Không cấp được số NK mới — báo quản trị hệ thống' });
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
