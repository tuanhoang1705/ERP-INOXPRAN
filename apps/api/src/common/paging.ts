/**
 * Phân trang danh sách. Có tham số `page` thì trả { rows, total, page, pageSize }; không có thì trả cả danh sách như cũ
 * (các ô chọn trong form vẫn cần đủ danh mục).
 */
export interface PageRequest {
  page: number;
  pageSize: number;
  skip: number;
}

export const MAX_PAGE_SIZE = 200;

export function pageRequest(page?: string, pageSize?: string, defaultSize = 50): PageRequest | null {
  if (page === undefined || page === '') return null;
  const current = Math.max(1, Math.floor(Number(page)) || 1);
  const size = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(Number(pageSize)) || defaultSize));
  return { page: current, pageSize: size, skip: (current - 1) * size };
}

export function pageOf<T, E extends object = object>(rows: T[], total: number, request: PageRequest, extra?: E) {
  return { rows, total, page: request.page, pageSize: request.pageSize, ...(extra ?? ({} as E)) };
}

/** Cắt một trang từ danh sách đã sắp xếp (khi phải tính trên toàn bộ trước, VD sắp theo màu hẹn trả). */
export function slicePage<T, E extends object = object>(all: T[], request: PageRequest, extra?: E) {
  return pageOf(all.slice(request.skip, request.skip + request.pageSize), all.length, request, extra);
}
