import { Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthenticatedRequest } from '../../common/request-context';
import { NotificationsService } from './notifications.service';

@ApiTags('Notifications')
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  list(@Req() request: AuthenticatedRequest, @Query('unreadOnly') unreadOnly?: string) {
    return this.notifications.list(request.user.sub, unreadOnly === 'true');
  }

  @Post(':id/read')
  markRead(@Param('id') id: string, @Req() request: AuthenticatedRequest) {
    return this.notifications.markRead(id, request.user.sub);
  }
}
