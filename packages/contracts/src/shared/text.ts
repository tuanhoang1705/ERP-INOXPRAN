/**
 * Chuẩn hóa chữ để tìm kiếm không phân biệt dấu / hoa thường: "Kiểm kê" ≈ "kiem ke", "Điều chỉnh" ≈ "dieu chinh".
 * Dùng cho ô tìm chức năng (web) và tra mã khi kiểm kê.
 */
export function foldText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}
