/**
 * Đa ngôn ngữ (Paraglide JS): tiếng Việt là ngôn ngữ gốc, thêm tiếng Trung giản thể.
 * - Chữ giao diện: apps/web/messages/{vi,zh}.json, gọi qua `m.<khóa>()` (kiểm tra kiểu khi biên dịch).
 * - Ngôn ngữ đã chọn lưu ở localStorage; lần đầu theo ngôn ngữ trình duyệt nếu khớp, không thì tiếng Việt.
 * - Đổi ngôn ngữ tải lại trang để mọi nhãn (kể cả nhãn khai báo sẵn trong module) dùng ngôn ngữ mới.
 * - Chứng từ in (phiếu xuất kho BH/SWK) luôn bằng tiếng Việt theo quy định kế toán.
 */
import { getLocale, setLocale, type Locale } from '$lib/paraglide/runtime';
import { m } from '$lib/paraglide/messages';
import type { SalesIssueTemplateInfo } from '$shared/sales-templates';

export { getLocale };

export const LOCALE_OPTIONS: ReadonlyArray<{ value: Locale; label: string; short: string }> = [
  { value: 'vi', label: 'Tiếng Việt', short: 'VI' },
  { value: 'zh', label: '简体中文', short: '中文' },
];

/** Mã ngôn ngữ cho Intl (định dạng số, ngày). */
export function intlLocale(): string {
  return getLocale() === 'zh' ? 'zh-CN' : 'vi-VN';
}

/** Giá trị thuộc tính lang của trang (để trình duyệt chọn đúng phông chữ Hán giản thể). */
export function htmlLang(): string {
  return getLocale() === 'zh' ? 'zh-Hans' : 'vi';
}

export function changeLocale(locale: Locale): void {
  if (locale !== getLocale()) setLocale(locale);
}

/** Mô tả mẫu chứng từ theo ngôn ngữ giao diện (danh mục mẫu dùng chung với API chỉ có tiếng Việt). */
export function templateDescription(template: SalesIssueTemplateInfo): string {
  return template.code === 'PXK-001' ? m.mo_ta_mau_pxk_001() : template.description;
}
