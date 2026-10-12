/**
 * Kiểm kê kho 2 bước (STK-01, 09/10/2026):
 * 1. Kiểm tồn sản phẩm — danh sách mã kho thấy còn hàng so với các mã ERP có tồn thực tế (onHand > 0) ở kho đó.
 * 2. Kiểm tồn số lượng — số thực đếm từng mã so với tồn thực tế ERP.
 * Dùng chung cho API (so sánh thật khi bấm "Kiểm tra") và giao diện (tô đỏ / xanh).
 */
export type StockCountStep = 'SKU' | 'QTY';
export const STOCK_COUNT_STATUSES = ['SKU_CHECK', 'QTY_CHECK', 'CLOSED', 'CANCELLED'] as const;
export type StockCountStatus = (typeof STOCK_COUNT_STATUSES)[number];

/**
 * MATCH: khớp. ONLY_COUNTED: kho có, ERP không còn tồn. ONLY_ERP: ERP còn tồn, kho không nhập.
 * DIFF: lệch số lượng. NOT_COUNTED: mã đã chốt ở bước 1 nhưng chưa nhập số. NOT_IN_SKU_LIST: nhập số cho mã không có trong danh sách đã chốt.
 */
export type StockCountRowState = 'MATCH' | 'ONLY_COUNTED' | 'ONLY_ERP' | 'DIFF' | 'NOT_COUNTED' | 'NOT_IN_SKU_LIST';

export interface ErpStockLine {
  productId: string;
  sku: string;
  onHand: number;
}

export interface StockCountRow {
  productId: string;
  sku: string;
  state: StockCountRowState;
  erpOnHand: number;
  /** Bước 2: số thực đếm (null nếu chưa nhập). Bước 1 luôn null. */
  counted: number | null;
  /** Thực đếm − ERP (bước 2, khi có số đếm). */
  difference: number | null;
  /** Mã có xuất / nhập sau lúc bắt đầu kiểm kê → lệch có thể do phát sinh, không hẳn do đếm sai. */
  movedSinceStart: boolean;
}

/** So sánh số lượng đến 4 chữ số lẻ (đơn vị cơ bản). */
const same = (a: number, b: number) => Math.round(a * 10_000) === Math.round(b * 10_000);
const round4 = (value: number) => Math.round(value * 10_000) / 10_000;

/** Bước 1: thứ tự giữ như danh sách kho nhập (mới nhất trước), sau đó các mã ERP còn tồn mà kho chưa nhập (theo mã). */
export function compareSkus(counted: ReadonlyArray<{ productId: string; sku: string }>, erp: readonly ErpStockLine[], moved: ReadonlySet<string> = new Set()): StockCountRow[] {
  const erpById = new Map(erp.map((line) => [line.productId, line]));
  const seen = new Set<string>();
  const rows: StockCountRow[] = [];
  for (const entry of counted) {
    if (seen.has(entry.productId)) continue;
    seen.add(entry.productId);
    const onHand = erpById.get(entry.productId)?.onHand ?? 0;
    rows.push({ productId: entry.productId, sku: entry.sku, state: onHand > 0 ? 'MATCH' : 'ONLY_COUNTED', erpOnHand: onHand, counted: null, difference: null, movedSinceStart: moved.has(entry.productId) });
  }
  const missing = erp.filter((line) => line.onHand > 0 && !seen.has(line.productId)).sort((a, b) => a.sku.localeCompare(b.sku));
  for (const line of missing) rows.push({ productId: line.productId, sku: line.sku, state: 'ONLY_ERP', erpOnHand: line.onHand, counted: null, difference: null, movedSinceStart: moved.has(line.productId) });
  return rows;
}

/**
 * Bước 2: các dòng đã nhập (giữ thứ tự), rồi mã đã chốt ở bước 1 chưa nhập số, rồi mã ERP còn tồn mà cả 2 bước đều không có.
 * Số đếm = 0 với mã ERP không còn tồn được coi là khớp.
 */
export function compareQuantities(
  entries: ReadonlyArray<{ productId: string; sku: string; quantity: number }>,
  erp: readonly ErpStockLine[],
  lockedProductIds: Iterable<string>,
  moved: ReadonlySet<string> = new Set(),
  skuOf: (productId: string) => string = (productId) => productId,
): StockCountRow[] {
  const erpById = new Map(erp.map((line) => [line.productId, line]));
  const locked = new Set(lockedProductIds);
  const seen = new Set<string>();
  const rows: StockCountRow[] = [];
  for (const entry of entries) {
    if (seen.has(entry.productId)) continue;
    seen.add(entry.productId);
    const onHand = erpById.get(entry.productId)?.onHand ?? 0;
    const counted = round4(entry.quantity);
    const state = !locked.has(entry.productId) && !(counted === 0 && onHand === 0) ? 'NOT_IN_SKU_LIST' : same(counted, onHand) ? 'MATCH' : 'DIFF';
    rows.push({ productId: entry.productId, sku: entry.sku, state, erpOnHand: onHand, counted, difference: round4(counted - onHand), movedSinceStart: moved.has(entry.productId) });
  }
  for (const productId of locked) {
    if (seen.has(productId)) continue;
    seen.add(productId);
    const line = erpById.get(productId);
    rows.push({ productId, sku: line?.sku ?? skuOf(productId), state: 'NOT_COUNTED', erpOnHand: line?.onHand ?? 0, counted: null, difference: null, movedSinceStart: moved.has(productId) });
  }
  const missing = erp.filter((line) => line.onHand > 0 && !seen.has(line.productId)).sort((a, b) => a.sku.localeCompare(b.sku));
  for (const line of missing) rows.push({ productId: line.productId, sku: line.sku, state: 'ONLY_ERP', erpOnHand: line.onHand, counted: null, difference: null, movedSinceStart: moved.has(line.productId) });
  return rows;
}

export function stockCountSummary(rows: readonly StockCountRow[]): { total: number; matched: number; mismatched: number } {
  const matched = rows.filter((row) => row.state === 'MATCH').length;
  return { total: rows.length, matched, mismatched: rows.length - matched };
}
