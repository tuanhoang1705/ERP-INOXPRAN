import { Controller, Delete, Get, Param, Post, Query, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthenticatedRequest } from '../../common/request-context';
import { AllowReadOnly } from '../../common/roles.decorator';
import { NotificationsService } from './notifications.service';

@ApiTags('Notifications')
@AllowReadOnly()
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  list(@Req() request: AuthenticatedRequest, @Query('unreadOnly') unreadOnly?: string) {
    return this.notifications.list(request.user.sub, unreadOnly === 'true');
  }

  /** Xóa tất cả thông báo của chính người dùng (NOTI-02, 31/10/2026). */
  @Delete()
  clear(@Req() request: AuthenticatedRequest) {
    return this.notifications.clear(request.user.sub);
  }

  @Post(':id/read')
  markRead(@Param('id') id: string, @Req() request: AuthenticatedRequest) {
    return this.notifications.markRead(id, request.user.sub);
  }
}
