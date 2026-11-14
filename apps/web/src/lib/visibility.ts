/**
 * Quyền hiển thị theo vai trò ở giao diện (VIS-ROLE-01, 13/11/2026) — cùng quy tắc với API (`$shared/visibility`).
 * Dùng để ẩn liên kết chéo / tab sang phần không thuộc công việc của tài khoản đang đăng nhập.
 */
import { canSeeArea, canSeePath, type Area } from '$shared/visibility';
import { session } from '$lib/session.svelte';

/** Tài khoản đang đăng nhập mở được đường dẫn này không (liên kết, nút chuyển trang). */
export function canOpen(href: string): boolean {
  return canSeePath(session.user, href);
}

/** Tài khoản đang đăng nhập thấy vùng này không. */
export function canSee(area: Area): boolean {
  return canSeeArea(session.user, area);
}
