/**
 * Kiểm kê (STK-01) phía giao diện: tra mã khi quét / gõ (SKU, mã vạch, mã vạch thùng, mã hàng NCC — không phân biệt
 * hoa thường) và giữ danh sách "mã mới nhất ở đầu".
 */
import { m } from '$lib/paraglide/messages';
import type { StockCountRowState } from '@inoxpran/contracts';

export interface CountProduct {
  id: string;
  sku: string;
  name: string;
  baseUnit?: string;
  barcode?: string | null;
  supplierItemCode?: string | null;
  unitConversions?: Array<{ unit: string; barcode?: string | null }>;
  status?: string;
}

const key = (value: string) => value.trim().toUpperCase().replace(/\s+/g, '');

/** Bảng tra mã → sản phẩm; SKU được ưu tiên khi trùng với mã vạch của mã khác. */
export function buildCodeIndex(products: readonly CountProduct[]): Map<string, CountProduct> {
  const index = new Map<string, CountProduct>();
  const add = (code: string | null | undefined, product: CountProduct) => {
    if (!code) return;
    const normalized = key(code);
    if (normalized && !index.has(normalized)) index.set(normalized, product);
  };
  for (const product of products) add(product.sku, product);
  for (const product of products) {
    add(product.barcode, product);
    add(product.supplierItemCode, product);
    for (const conversion of product.unitConversions ?? []) add(conversion.barcode, product);
  }
  return index;
}

export function lookupCode(index: Map<string, CountProduct>, code: string): CountProduct | null {
  return index.get(key(code)) ?? null;
}

/** Đưa dòng lên đầu (mã mới nhất ở trên), bỏ bản cũ cùng mã. */
export function pushNewest<T extends { productId: string }>(list: readonly T[], item: T): T[] {
  return [item, ...list.filter((row) => row.productId !== item.productId)];
}

export const isMismatch = (state: StockCountRowState) => state !== 'MATCH';

export function rowStateLabel(state: StockCountRowState): string {
  switch (state) {
    case 'MATCH': return m.kk_st_match();
    case 'ONLY_COUNTED': return m.kk_st_only_counted();
    case 'ONLY_ERP': return m.kk_st_only_erp();
    case 'DIFF': return m.kk_st_diff();
    case 'NOT_COUNTED': return m.kk_st_not_counted();
    case 'NOT_IN_SKU_LIST': return m.kk_st_not_in_list();
  }
}

export function countStatusLabel(status: string): string {
  switch (status) {
    case 'SKU_CHECK': return m.kk_status_sku();
    case 'QTY_CHECK': return m.kk_status_qty();
    case 'CLOSED': return m.kk_status_closed();
    case 'CANCELLED': return m.kk_status_cancelled();
    default: return status;
  }
}
