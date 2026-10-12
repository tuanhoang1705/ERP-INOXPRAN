/** Hiển thị hồ sơ sản phẩm theo ngôn ngữ giao diện: tiếng Trung ưu tiên tên Trung nếu đã khai báo. */
import { getLocale } from '$lib/paraglide/runtime';
import { m } from '$lib/paraglide/messages';

export function productName(product: { name: string; nameZh?: string | undefined; nameEn?: string | undefined }): string {
  return getLocale() === 'zh' && product.nameZh ? product.nameZh : product.name;
}

export const productTypeLabel = (type: string | undefined): string =>
  type === 'FINISHED' ? m.sp_loai_thanh_pham() : type === 'SET' ? m.sp_loai_bo() : type === 'PART' ? m.sp_loai_linh_kien() : '—';

/** Chuỗi số người dùng gõ (có thể dùng dấu phẩy thập phân) → chuỗi số máy chủ nhận; rỗng giữ rỗng. */
export function decimalInput(value: string): string {
  return value.trim().replace(/\s/g, '').replace(',', '.');
}
