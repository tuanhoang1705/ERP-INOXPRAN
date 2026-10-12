import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CreateUserSchema, UpdateUserSchema, USER_VIEWER_ROLES } from '@inoxpran/contracts';
import { pageRequest } from '../../common/paging';
import { onlyProvided } from '../../common/patch';
import { Roles, RootOnly } from '../../common/roles.decorator';
import type { AuthenticatedRequest } from '../../common/request-context';
import { SystemService } from './system.service';
import { UsersAdminService } from './users.service';

/** Quản trị hệ thống: người dùng & phân quyền, lịch sử đăng nhập, giám sát. Quy tắc root / ADMIN: $shared/user-admin.ts. */
@ApiTags('Admin')
@Controller('admin')
export class AdminController {
  constructor(
    private readonly users: UsersAdminService,
    private readonly system: SystemService,
  ) {}

  @Roles(...USER_VIEWER_ROLES)
  @Get('users')
  list(@Query('search') search?: string, @Query('role') role?: string, @Query('status') status?: string, @Query('page') page?: string, @Query('pageSize') pageSize?: string) {
    return this.users.list({ search, role, status }, pageRequest(page, pageSize));
  }

  @Roles('ADMIN')
  @Post('users')
  create(@Body() body: unknown, @Req() request: AuthenticatedRequest) {
    return this.users.create(CreateUserSchema.parse(body), request);
  }

  @Roles('ADMIN')
  @Patch('users/:id')
  update(@Param('id') id: string, @Body() body: unknown, @Req() request: AuthenticatedRequest) {
    return this.users.update(id, onlyProvided(body, UpdateUserSchema.parse(body)), request);
  }

  @Roles('ADMIN')
  @Post('users/:id/disable')
  @HttpCode(200)
  disable(@Param('id') id: string, @Req() request: AuthenticatedRequest) {
    return this.users.setStatus(id, 'DISABLED', request);
  }

  @Roles('ADMIN')
  @Post('users/:id/enable')
  @HttpCode(200)
  enable(@Param('id') id: string, @Req() request: AuthenticatedRequest) {
    return this.users.setStatus(id, 'ACTIVE', request);
  }

  @Roles('ADMIN')
  @Post('users/:id/reset-password')
  @HttpCode(200)
  resetPassword(@Param('id') id: string, @Req() request: AuthenticatedRequest) {
    return this.users.resetPassword(id, request);
  }

  @Roles('ADMIN')
  @Post('users/:id/reset-mfa')
  @HttpCode(200)
  resetMfa(@Param('id') id: string, @Req() request: AuthenticatedRequest) {
    return this.users.resetMfa(id, request);
  }

  @Roles('ADMIN')
  @Post('users/:id/revoke-sessions')
  @HttpCode(200)
  revokeSessions(@Param('id') id: string, @Req() request: AuthenticatedRequest) {
    return this.users.revokeSessions(id, request);
  }

  @Roles(...USER_VIEWER_ROLES)
  @Get('login-events')
  loginEvents(@Query('userId') userId?: string, @Query('success') success?: string, @Query('search') search?: string, @Query('page') page?: string, @Query('pageSize') pageSize?: string) {
    return this.users.loginEvents({ userId, success, search }, pageRequest(page || '1', pageSize) ?? { page: 1, pageSize: 50, skip: 0 });
  }

  @RootOnly()
  @Roles('ADMIN')
  @Get('system')
  systemStatus() {
    return this.system.status();
  }
}
