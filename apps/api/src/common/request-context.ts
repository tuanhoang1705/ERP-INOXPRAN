import type { SetupStep } from '@inoxpran/contracts';
import type { FastifyRequest } from 'fastify';

export interface RequestUser {
  sub: string;
  email: string;
  displayName: string;
  roles: string[];
  warehouseScopes: string[];
  mfa: boolean;
  /** Đang bị bắt buộc bật 2 lớp (MFA-02) — không tự tắt được. */
  mfaRequired?: boolean;
  /** Tài khoản quản trị gốc. */
  root?: boolean;
  /** Bước bắt buộc còn thiếu (đổi mật khẩu tạm / bật MFA). */
  pending?: SetupStep[];
  /** Quyền nghiệp vụ hiệu lực (PERM-01): theo vai trò + chỉnh riêng của quản trị gốc. */
  permissions?: string[];
}

export type AuthenticatedRequest = FastifyRequest & {
  user: RequestUser;
  correlationId: string;
};
