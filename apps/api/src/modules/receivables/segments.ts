import Decimal from 'decimal.js';
import { documentTotals, linesTotals } from '@inoxpran/contracts';

/**
 * Nhóm công nợ tách riêng (CN-SEG-01) — VD "Quạt & vợt muỗi": phần nợ của hàng thuộc nhóm được theo dõi riêng trên từng
 * chứng từ, không tính quá hạn / cảnh báo / tự khóa; tiền thu trừ nợ thường trước (kế toán chọn được "thu cho nhóm").
 * Một chứng từ vẫn là một khoản phải thu: `segments[]` ghi phần của từng nhóm, phần còn lại là nợ thường.
 */
export interface SegmentRule {
  code: string;
  name: string;
  categoryIds: readonly string[];
  skus: readonly string[];
  /** Nhóm chỉ gắn tay theo chứng từ (VD "Hàng mẫu", "Đơn 2025") — không tự xếp dòng hàng. */
  manualOnly: boolean;
  active: boolean;
  sortOrder: number;
  /** Phạm vi khách: ALL = mọi khách; SELECTED = chỉ khách trong partnerIds (VD chỉ NPP được nợ riêng quạt). Thiếu = ALL. */
  scope?: 'ALL' | 'SELECTED' | undefined;
  partnerIds?: readonly string[] | undefined;
}

/** Luật áp dụng cho một khách: nhóm "chọn khách" chỉ tách cho khách có trong danh sách (nhóm gắn tay không lọc). */
export function rulesFor(partnerId: string | null | undefined, rules: readonly SegmentRule[]): SegmentRule[] {
  return rules.filter((rule) => rule.manualOnly || rule.scope !== 'SELECTED' || (partnerId ? (rule.partnerIds ?? []).includes(partnerId) : false));
}

export interface SegmentAmount {
  code: string;
  amount: string;
}

export interface SegmentPart extends SegmentAmount {
  paid: string;
}

/** Mã hàng so khớp: in hoa, bỏ mọi khoảng trắng / xuống dòng (sổ cũ trích từ PDF có mã bị xuống dòng giữa chừng: "INP6401(⏎XANH)"). */
export const normalizeSku = (sku: string | null | undefined): string => (sku ?? '').replace(/\s+/g, '').toUpperCase();

const ordered = (rules: readonly SegmentRule[]) => [...rules].sort((a, b) => a.sortOrder - b.sortOrder || a.code.localeCompare(b.code));

/** Nhóm của một dòng hàng: nhóm đầu tiên (theo thứ tự) khớp nhóm hàng hoặc mã hàng; hàng tặng không tính. */
export function lineSegment(line: { sku?: string | undefined; categoryId?: string | undefined; gift?: boolean | undefined }, rules: readonly SegmentRule[]): string | null {
  if (line.gift) return null;
  const sku = normalizeSku(line.sku);
  for (const rule of ordered(rules)) {
    if (!rule.active || rule.manualOnly) continue;
    if ((line.categoryId && rule.categoryIds.includes(line.categoryId)) || (sku && rule.skus.some((item) => normalizeSku(item) === sku))) return rule.code;
  }
  return null;
}

/** Giữ thứ tự nhóm, bỏ phần ≤ 0 và không để tổng các phần vượt số tiền chứng từ. */
function capped(amounts: Map<string, Decimal>, total: Decimal.Value, rules: readonly SegmentRule[]): SegmentAmount[] {
  let room = Decimal.max(new Decimal(total), 0);
  const result: SegmentAmount[] = [];
  const rank = new Map(ordered(rules).map((rule, index) => [rule.code, index]));
  for (const [code, value] of [...amounts].sort((a, b) => (rank.get(a[0]) ?? 99) - (rank.get(b[0]) ?? 99) || a[0].localeCompare(b[0]))) {
    const take = Decimal.min(value.toDecimalPlaces(2), room);
    if (take.lte(0)) continue;
    result.push({ code, amount: take.toFixed(2) });
    room = room.minus(take);
  }
  return result;
}

/**
 * Phiếu BH trên ERP: phần nhóm = tiền hàng chưa thuế của các dòng thuộc nhóm + thuế, làm tròn như tổng phiếu, tối đa bằng tổng
 * phiếu. Phiếu có thuế dòng (27/10/2026): cộng thuế từng dòng (linesTotals); phiếu cũ: thuế một lần theo thuế suất phiếu.
 */
export function orderSegments(
  lines: ReadonlyArray<{ sku?: string | undefined; categoryId?: string | undefined; gift?: boolean | undefined; netAmount?: string | undefined; taxAmount?: string | undefined }>,
  taxRate: string,
  grandTotal: Decimal.Value,
  rules: readonly SegmentRule[],
): SegmentAmount[] {
  const parts = new Map<string, Array<{ netAmount: string; taxAmount?: string | undefined }>>();
  for (const line of lines) {
    const code = lineSegment(line, rules);
    if (code) parts.set(code, [...(parts.get(code) ?? []), { netAmount: line.netAmount ?? '0', taxAmount: line.taxAmount }]);
  }
  const gross = new Map([...parts].map(([code, list]) => {
    const perLine = list.every((line) => line.taxAmount !== undefined);
    const net = list.reduce((sum, line) => sum.add(line.netAmount), new Decimal(0)).toFixed(2);
    const total = perLine ? linesTotals(list as Array<{ netAmount: string; taxAmount: string }>).grandTotal : documentTotals(net, taxRate).grandTotal;
    return [code, new Decimal(total)] as const;
  }));
  return capped(gross, grandTotal, rules);
}

/** Chứng từ / phiếu trả hàng nhập từ sổ cũ: phần nhóm = thành tiền (đã gồm thuế) của các dòng thuộc nhóm, tối đa bằng số tiền chứng từ. */
export function historySegments(
  lines: ReadonlyArray<{ sku?: string | undefined; categoryId?: string | undefined; amount?: string | undefined }>,
  total: Decimal.Value,
  rules: readonly SegmentRule[],
): SegmentAmount[] {
  const sums = new Map<string, Decimal>();
  for (const line of lines) {
    const code = lineSegment(line, rules);
    if (code) sums.set(code, (sums.get(code) ?? new Decimal(0)).add(new Decimal(line.amount ?? 0).abs()));
  }
  return capped(sums, total, rules);
}

export interface SegmentedDocument {
  amount: unknown;
  paidAmount: unknown;
  segments?: ReadonlyArray<{ code: string; amount: unknown; paid: unknown }> | undefined;
}

const num = (value: unknown) => new Decimal(value === undefined || value === null ? 0 : String(value));

/** Phần nợ nhóm còn lại của chứng từ (tổng các nhóm). */
export function segmentOutstanding(doc: SegmentedDocument): Decimal {
  return (doc.segments ?? []).reduce((sum, part) => sum.add(num(part.amount).minus(num(part.paid))), new Decimal(0));
}

/** Phần nợ thường còn lại của chứng từ = còn nợ − phần nợ nhóm còn lại (chỉ phần này tính quá hạn / khóa). */
export function normalOutstanding(doc: SegmentedDocument): Decimal {
  return num(doc.amount).minus(num(doc.paidAmount)).minus(segmentOutstanding(doc));
}

/** Một "phần" của chứng từ để phân bổ tiền: phần nợ thường (segment null) hoặc phần của một nhóm. */
export interface OpenPart {
  receivableId: string;
  segment: string | null;
  outstanding: string;
  dueDate: Date;
  createdAt: Date;
  code: string;
}

export function openParts(doc: SegmentedDocument & { id: string; code: string; dueDate: Date; createdAt: Date }): OpenPart[] {
  const base = { receivableId: doc.id, dueDate: doc.dueDate, createdAt: doc.createdAt, code: doc.code };
  const parts: OpenPart[] = [];
  const normal = normalOutstanding(doc);
  if (normal.gt(0)) parts.push({ ...base, segment: null, outstanding: normal.toFixed(2) });
  for (const part of doc.segments ?? []) {
    const left = num(part.amount).minus(num(part.paid));
    if (left.gt(0)) parts.push({ ...base, segment: part.code, outstanding: left.toFixed(2) });
  }
  return parts;
}

/** Thứ tự trả: phiếu chọn nhóm → phần nhóm đó trước rồi nợ thường; mặc định → nợ thường trước rồi tới phần nhóm. */
export function partRank(segment: string | null, prefer: string | null): number {
  if (prefer) return segment === prefer ? 0 : segment === null ? 1 : 2;
  return segment === null ? 0 : 1;
}

export interface PartAllocation {
  receivableId: string;
  segment: string | null;
  amount: string;
}

/** Phân bổ một khoản thu vào các phần còn nợ: theo thứ tự nhóm ưu tiên, rồi hạn trả, ngày phát sinh, mã chứng từ. */
export function planPartsAllocation(parts: readonly OpenPart[], amount: string, prefer: string | null = null): { allocations: PartAllocation[]; leftover: string } {
  let remaining = new Decimal(amount);
  if (remaining.lte(0)) return { allocations: [], leftover: '0.00' };
  const queue = [...parts]
    .filter((part) => new Decimal(part.outstanding).gt(0))
    .sort((a, b) => partRank(a.segment, prefer) - partRank(b.segment, prefer)
      || a.dueDate.getTime() - b.dueDate.getTime()
      || a.createdAt.getTime() - b.createdAt.getTime()
      || a.code.localeCompare(b.code)
      || (a.segment ?? '').localeCompare(b.segment ?? ''));
  const allocations: PartAllocation[] = [];
  for (const part of queue) {
    if (remaining.lte(0)) break;
    const take = Decimal.min(remaining, new Decimal(part.outstanding));
    allocations.push({ receivableId: part.receivableId, segment: part.segment, amount: take.toFixed(2) });
    remaining = remaining.minus(take);
  }
  return { allocations, leftover: remaining.toFixed(2) };
}
