import { SetMetadata } from '@nestjs/common';

export const ALLOW_PENDING_KEY = 'allowPendingSetup';

/** Endpoint dùng được khi tài khoản còn bước bắt buộc (đổi mật khẩu tạm, bật MFA): xem phiên, thiết lập MFA, đổi mật khẩu. */
export const AllowPending = () => SetMetadata(ALLOW_PENDING_KEY, true);
