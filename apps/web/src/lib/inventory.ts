/**
 * Nhãn loại phát sinh kho theo ngôn ngữ giao diện, lấy từ bảng dùng chung với API và file Excel
 * ($shared/inventory-categories — tiêu đề cột của 月库存明细单). Ngôn ngữ còn lại hiện kèm làm phụ đề.
 */
import { categoryInfo, categoryOf, type InventoryCategory, type StockDirection } from '$shared/inventory-categories';
import { getLocale } from '$lib/paraglide/runtime';

export function categoryLabel(code: string): string {
  const info = categoryInfo(code);
  if (!info) return code;
  return getLocale() === 'zh' ? info.zh : info.vi;
}

/** Tiêu đề song ngữ như file Excel: [nhãn chính, nhãn phụ]. */
export function categoryHeading(code: string): [string, string] {
  const info = categoryInfo(code);
  if (!info) return [code, ''];
  return getLocale() === 'zh' ? [info.zh, info.vi] : [info.vi, info.zh];
}

export function movementCategory(row: { movementType: string; direction: StockDirection; category?: string | null | undefined }): InventoryCategory {
  return categoryOf(row);
}
