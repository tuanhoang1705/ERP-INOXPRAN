/**
 * Khóa giới hạn tần suất (20/10/2026 — sếp báo "操作过于频繁，请稍后再试" / "thao tác quá nhanh" hiện thường xuyên).
 *
 * Trước đây giới hạn 300 yêu cầu / phút tính theo IP. Cả văn phòng ra Internet qua MỘT IP công cộng (NAT) nên mọi người
 * dùng chung 300 yêu cầu / phút: vài người mở danh sách, tìm kiếm, trang tự tải lại… là cả công ty bị chặn 429.
 *
 * Nay: cookie phiên hợp lệ (JWT ký bằng khóa của máy chủ) → tính theo TÀI KHOẢN, mỗi người một hạn mức riêng (mọi tab chung).
 * Chưa đăng nhập hoặc cookie giả / hết hạn → vẫn tính theo IP như cũ (chặn dò mật khẩu, gọi ồ ạt không đăng nhập).
 */
export const RATE_LIMIT_PER_USER = 600;
export const RATE_LIMIT_PER_IP = 300;

export type SessionVerifier = (token: string) => { sub?: unknown } | null;

/** Lấy cookie erp_session từ header thô (hook onRequest của rate-limit có thể chạy trước khi @fastify/cookie gắn request.cookies). */
export function sessionCookie(header: string | string[] | undefined): string | null {
  const raw = Array.isArray(header) ? header.join('; ') : header;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const index = part.indexOf('=');
    if (index > 0 && part.slice(0, index).trim() === 'erp_session') {
      const value = part.slice(index + 1).trim();
      try {
        return value ? decodeURIComponent(value) : null;
      } catch {
        return null;
      }
    }
  }
  return null;
}

export function rateLimitKey(request: { ip: string; headers: Record<string, string | string[] | undefined> }, verify: SessionVerifier): string {
  const token = sessionCookie(request.headers.cookie);
  if (token) {
    let payload: { sub?: unknown } | null = null;
    try {
      payload = verify(token);
    } catch {
      payload = null;
    }
    if (payload && typeof payload.sub === 'string' && payload.sub) return `u:${payload.sub}`;
  }
  return `ip:${request.ip}`;
}

export const rateLimitMax = (key: string) => (key.startsWith('u:') ? RATE_LIMIT_PER_USER : RATE_LIMIT_PER_IP);
