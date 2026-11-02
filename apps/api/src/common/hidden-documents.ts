import type { Document } from 'mongodb';

/**
 * Chứng từ đã hủy / đã xóa coi như đã xóa (DOC-HIDE-01, 27/10/2026): chỉ tài khoản quản trị gốc còn thấy (danh sách, chi tiết,
 * thẻ kho, sổ công nợ, đề nghị). Người khác mở trực tiếp → "không tìm thấy". Tiền thật (khoản khách trả trước, thanh toán NCC)
 * vẫn hiện. Giao diện không nói ra là quản trị gốc còn thấy.
 */
export type Viewer = { root?: boolean | undefined } | undefined;

export const seesCancelled = (viewer: Viewer): boolean => Boolean(viewer?.root);

/**
 * Thêm điều kiện bỏ các trạng thái hủy vào bộ lọc khi người xem không phải quản trị gốc (ghép `$and` nên lọc riêng
 * "Đã hủy" của người thường ra rỗng).
 */
export function hideStatus(filter: Document, viewer: Viewer, statuses: readonly string[] = ['CANCELLED']): Document {
  if (seesCancelled(viewer)) return filter;
  const hidden = { status: { $nin: [...statuses] } };
  return Object.keys(filter).length ? { $and: [filter, hidden] } : hidden;
}
