import { Controller, Get, Query, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthenticatedRequest } from '../../common/request-context';
import { DashboardService } from './dashboard.service';

@ApiTags('Reporting')
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get('summary')
  summary(@Req() request: AuthenticatedRequest, @Query('page') page?: string, @Query('pageSize') pageSize?: string) {
    return this.dashboard.summary(Number(page ?? 1) || 1, Number(pageSize ?? 5) || 5, request.user);
  }
}
