/**
 * Điều hướng bản ghi trong cửa sổ chứng từ (đầu / trước / sau / cuối) theo ĐÚNG thứ tự và bộ lọc của danh sách
 * người dùng vừa mở. Danh sách ghi lại trang đang xem vào sessionStorage; trang chi tiết hết trang thì tự tải trang kế
 * tiếp với cùng bộ lọc. Lưu trữ lỗi / bị chặn → nút điều hướng tắt, trang vẫn dùng bình thường.
 */
import { api } from './api';
import { pageQuery, type Paged } from './paging';

type Filters = Record<string, string | number | boolean | undefined | null>;

interface StoredList {
  endpoint: string;
  filters: Filters;
  pageSize: number;
  total: number;
  /** Trang → danh sách id theo thứ tự hiển thị. */
  pages: Record<string, string[]>;
}

const storageKey = (key: string) => `erp:list:${key}`;

function read(key: string): StoredList | null {
  try {
    const raw = sessionStorage.getItem(storageKey(key));
    return raw ? (JSON.parse(raw) as StoredList) : null;
  } catch {
    return null;
  }
}

function write(key: string, list: StoredList): void {
  try {
    sessionStorage.setItem(storageKey(key), JSON.stringify(list));
  } catch {
    // Không lưu được: điều hướng bản ghi tạm tắt.
  }
}

/** Danh sách gọi mỗi lần tải xong một trang. Bộ lọc / số dòng đổi thì bỏ các trang đã nhớ trước đó. */
export function rememberList(key: string, input: { endpoint: string; filters: Filters; page: number; pageSize: number; total: number; ids: string[] }): void {
  const previous = read(key);
  const sameQuery = previous && previous.endpoint === input.endpoint && previous.pageSize === input.pageSize && JSON.stringify(previous.filters) === JSON.stringify(input.filters);
  write(key, {
    endpoint: input.endpoint,
    filters: input.filters,
    pageSize: input.pageSize,
    total: input.total,
    pages: { ...(sameQuery ? previous.pages : {}), [String(input.page)]: input.ids },
  });
}

/** Vị trí (tính từ 0) của bản ghi trong danh sách đã mở; null nếu mở thẳng bằng đường dẫn. */
export function recordPosition(key: string, id: string): { index: number; total: number } | null {
  const list = read(key);
  if (!list) return null;
  for (const [page, ids] of Object.entries(list.pages)) {
    const offset = ids.indexOf(id);
    if (offset >= 0) return { index: (Number(page) - 1) * list.pageSize + offset, total: list.total };
  }
  return null;
}

/** Id của bản ghi đầu / trước / sau / cuối; tải thêm trang khi cần. */
export async function neighbor(key: string, id: string, which: 'first' | 'prev' | 'next' | 'last'): Promise<string | null> {
  const list = read(key);
  const position = recordPosition(key, id);
  if (!list || !position || list.total === 0) return null;
  const target = which === 'first' ? 0 : which === 'last' ? list.total - 1 : position.index + (which === 'next' ? 1 : -1);
  if (target < 0 || target >= list.total || target === position.index) return null;
  const page = Math.floor(target / list.pageSize) + 1;
  let ids = list.pages[String(page)];
  if (!ids) {
    const result = await api<Paged<{ id: string }>>(`${list.endpoint}?${pageQuery(list.filters, page, list.pageSize)}`);
    ids = result.rows.map((row) => row.id);
    rememberList(key, { endpoint: list.endpoint, filters: list.filters, page, pageSize: list.pageSize, total: result.total, ids });
  }
  return ids[target % list.pageSize] ?? null;
}
