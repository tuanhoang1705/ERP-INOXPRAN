import { m } from '$lib/paraglide/messages';
import * as messages from '$lib/paraglide/messages';
import { getLocale } from '$lib/paraglide/runtime';
import type { ApiError } from '@inoxpran/contracts';

/**
 * Thông báo lỗi theo ngôn ngữ giao diện. Tiếng Việt dùng nguyên câu máy chủ trả về (có chi tiết cụ thể);
 * ngôn ngữ khác dịch theo mã lỗi (messages: err_<mã>), chưa có bản dịch thì giữ câu của máy chủ.
 */
export function localizedErrorMessage(payload: Pick<ApiError, 'code' | 'message'>): string {
  if (getLocale() === 'vi' || !payload.code) return payload.message;
  const translate = (messages as unknown as Record<string, unknown>)[`err_${payload.code.toLowerCase()}`];
  return typeof translate === 'function' ? (translate as () => string)() : payload.message;
}

export class ApiRequestError extends Error {
  constructor(public readonly payload: ApiError) {
    super(localizedErrorMessage(payload));
  }
}

function cookie(name: string): string | undefined {
  if (typeof document === 'undefined') return undefined;
  return document.cookie
    .split('; ')
    .find((entry) => entry.startsWith(`${name}=`))
    ?.split('=')
    .slice(1)
    .join('=');
}

export async function api<T>(
  path: string,
  options: RequestInit & { idempotentCommand?: boolean } = {},
): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  const csrf = cookie('erp_csrf');
  if (csrf && !['GET', 'HEAD', 'OPTIONS'].includes(options.method ?? 'GET')) {
    headers.set('x-csrf-token', decodeURIComponent(csrf));
  }
  if (options.idempotentCommand) headers.set('idempotency-key', crypto.randomUUID());
  const response = await fetch(`/api/v1${path}`, {
    ...options,
    headers,
    credentials: 'include',
  });
  if (response.status === 204) return undefined as T;
  const payload = (await response.json()) as T | ApiError;
  if (!response.ok) {
    const error = payload as ApiError;
    // Tài khoản còn bước bắt buộc (đổi mật khẩu tạm / bật MFA) → màn thiết lập; phiên bị thu hồi (khóa, đặt lại) → đăng nhập lại.
    if (typeof window !== 'undefined') {
      const here = window.location.pathname;
      if (error.code === 'SETUP_REQUIRED' && here !== '/setup') window.location.assign('/setup');
      if (error.code === 'SESSION_REVOKED' && here !== '/login') window.location.assign('/login?revoked=1');
    }
    throw new ApiRequestError(error);
  }
  return payload as T;
}

/** Tải tệp nhị phân (ví dụ báo cáo Excel) bằng phiên đăng nhập hiện tại. */
export async function download(path: string, fallbackName: string): Promise<void> {
  const response = await fetch(`/api/v1${path}`, { credentials: 'include' });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({ message: m.khong_tai_duoc_tep() }))) as ApiError;
    throw new ApiRequestError(payload);
  }
  const disposition = response.headers.get('content-disposition') ?? '';
  const name = /filename="?([^";]+)"?/.exec(disposition)?.[1] ?? fallbackName;
  const url = URL.createObjectURL(await response.blob());
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export { vnd as formatVnd, dateTime as formatDate } from './format';
