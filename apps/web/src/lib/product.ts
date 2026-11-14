/** Hiển thị hồ sơ sản phẩm theo ngôn ngữ giao diện: tiếng Trung ưu tiên tên Trung nếu đã khai báo. */
import { getLocale } from '$lib/paraglide/runtime';
import { m } from '$lib/paraglide/messages';

export function productName(product: { name: string; nameZh?: string | undefined; nameEn?: string | undefined }): string {
  return getLocale() === 'zh' && product.nameZh ? product.nameZh : product.name;
}

export const productTypeLabel = (type: string | undefined): string =>
  type === 'FINISHED' ? m.sp_loai_thanh_pham() : type === 'SET' ? m.sp_loai_bo() : type === 'PART' ? m.sp_loai_linh_kien() : '—';

/** Một dòng của ô gõ-tìm sản phẩm: mã hàng làm "mã", đơn vị tính làm dòng phụ. */
export interface ProductPick { id: string; code: string; name: string; unit?: string }

/**
 * Sản phẩm cho ô gõ-tìm (form bảo hành 05/11/2026; mọi form kho — PROD-PICK-01, 13/11/2026):
 * gõ mã hoặc tên (có dấu hay không) đều ra.
 */
export function productPickOptions(products: ReadonlyArray<{ id: string; sku: string; name: string; baseUnit?: string | undefined }>): ProductPick[] {
  return products.map((product) => ({ id: product.id, code: product.sku, name: product.name, ...(product.baseUnit ? { unit: product.baseUnit } : {}) }));
}

/** Chuỗi số người dùng gõ (có thể dùng dấu phẩy thập phân) → chuỗi số máy chủ nhận; rỗng giữ rỗng. */
export function decimalInput(value: string): string {
  return value.trim().replace(/\s/g, '').replace(',', '.');
}
