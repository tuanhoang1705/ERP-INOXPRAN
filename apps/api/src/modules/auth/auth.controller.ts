import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ChangePasswordSchema, LoginSchema } from '@inoxpran/contracts';
import { randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ConfigService } from '@nestjs/config';
import { AllowPending } from '../../common/allow-pending.decorator';
import { Public } from '../../common/public.decorator';
import type { AuthenticatedRequest } from '../../common/request-context';
import { AuthService } from './auth.service';

@ApiTags('Identity')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly config: ConfigService,
  ) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(@Body() body: unknown, @Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    const result = await this.auth.login(LoginSchema.parse(body), { ip: request.ip, userAgent: request.headers['user-agent'] });
    const secure = this.config.get<boolean>('COOKIE_SECURE') ?? false;
    const csrfToken = randomBytes(32).toString('base64url');
    reply.setCookie('erp_session', result.token, {
      httpOnly: true,
      secure,
      sameSite: 'strict',
      path: '/',
      maxAge: 8 * 60 * 60,
    });
    reply.setCookie('erp_csrf', csrfToken, {
      httpOnly: false,
      secure,
      sameSite: 'strict',
      path: '/',
      maxAge: 8 * 60 * 60,
    });
    return { user: result.user, csrfToken };
  }

  @AllowPending()
  @Get('me')
  me(@Req() request: AuthenticatedRequest) {
    return this.auth.me(request.user);
  }

  /** Đổi mật khẩu (kể cả mật khẩu tạm bắt buộc đổi ở lần đăng nhập đầu). */
  @AllowPending()
  @Post('password')
  @HttpCode(200)
  changePassword(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    return this.auth.changePassword(request.user, ChangePasswordSchema.parse(body));
  }

  @Get('logins')
  logins(@Req() request: AuthenticatedRequest) {
    return this.auth.myLogins(request.user);
  }

  @AllowPending()
  @Post('mfa/start')
  startMfa(@Req() request: AuthenticatedRequest) {
    return this.auth.beginMfa(request.user.sub);
  }

  @AllowPending()
  @Post('mfa/confirm')
  async confirmMfa(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const code = String((body as { code?: unknown }).code ?? '');
    await this.auth.confirmMfa(request.user, code);
    return { enabled: true };
  }

  @Public()
  @Post('logout')
  @HttpCode(204)
  logout(@Req() _request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply): void {
    reply.clearCookie('erp_session', { path: '/' });
    reply.clearCookie('erp_csrf', { path: '/' });
  }
}
