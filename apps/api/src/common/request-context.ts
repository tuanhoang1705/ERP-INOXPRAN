import type { SetupStep } from '@inoxpran/contracts';
import type { FastifyRequest } from 'fastify';

export interface RequestUser {
  sub: string;
  email: string;
  displayName: string;
  roles: string[];
  warehouseScopes: string[];
  mfa: boolean;
  /** Tài khoản quản trị gốc. */
  root?: boolean;
  /** Bước bắt buộc còn thiếu (đổi mật khẩu tạm / bật MFA). */
  pending?: SetupStep[];
}

export type AuthenticatedRequest = FastifyRequest & {
  user: RequestUser;
  correlationId: string;
};
