/**
 * Đếm lỗi 5xx theo ngày cho màn giám sát hệ thống. Bộ lọc lỗi (tạo bằng `new`, không qua DI) chỉ tăng bộ đếm trong bộ nhớ;
 * SystemService định kỳ ghi dồn xuống collection `system_metrics` (`_id: errors:YYYY-MM-DD`).
 */
let pending = 0;

export const errorMetrics = {
  record(): void {
    pending += 1;
  },
  /** Lấy và đặt lại số lỗi chưa ghi. */
  drain(): number {
    const count = pending;
    pending = 0;
    return count;
  },
  /** Trả lại số lỗi khi ghi DB thất bại để lần sau ghi tiếp. */
  restore(count: number): void {
    pending += count;
  },
};
