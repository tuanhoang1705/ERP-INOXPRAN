/**
 * Phân trang phía máy chủ: danh sách gửi page + pageSize, nhận { rows, total, page, pageSize }.
 * Số dòng mỗi trang người dùng chọn được ghi nhớ trên trình duyệt (chỉ là tiện ích, đọc/ghi lỗi thì dùng mặc định).
 */
import type { Paged } from '@inoxpran/contracts';

export type { Paged };
export const PAGE_SIZE_OPTIONS = [20, 50, 100] as const;
const STORAGE_KEY = 'erp:pageSize';

export function initialPageSize(fallback = 50): number {
  try {
    const stored = Number(localStorage.getItem(STORAGE_KEY));
    return (PAGE_SIZE_OPTIONS as readonly number[]).includes(stored) ? stored : fallback;
  } catch {
    return fallback;
  }
}

export function rememberPageSize(size: number): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(size));
  } catch {
    // Trình duyệt chặn lưu trữ: bỏ qua, lần sau dùng mặc định.
  }
}

/** Ghép tham số lọc + trang thành query string (bỏ giá trị rỗng). */
export function pageQuery(filters: Record<string, string | number | boolean | undefined | null>, page: number, pageSize: number): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== null && value !== '' && value !== false) query.set(key, String(value));
  }
  query.set('page', String(page));
  query.set('pageSize', String(pageSize));
  return query.toString();
}

/** Gọi trễ (ô tìm kiếm): chỉ tải lại sau khi người dùng ngừng gõ. */
export function debounce<A extends unknown[]>(fn: (...args: A) => void, wait = 300): (...args: A) => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (...args: A) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}
