import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CRM_ROLES, PARTNER_MANAGER_ROLES, PartnerActivityInputSchema, UpdatePartnerActivitySchema } from '@inoxpran/contracts';
import { pageRequest } from '../../common/paging';
import { onlyProvided } from '../../common/patch';
import type { AuthenticatedRequest } from '../../common/request-context';
import { Roles } from '../../common/roles.decorator';
import { CrmService } from './crm.service';

/** Xem nhật ký chăm sóc: đội kinh doanh, quản lý hồ sơ khách, kế toán, kiểm soát nội bộ. */
const CRM_VIEWER_ROLES = [...new Set([...CRM_ROLES, ...PARTNER_MANAGER_ROLES, 'ACCOUNTANT', 'AUDITOR'])];

@ApiTags('CRM')
@Controller()
export class CrmController {
  constructor(private readonly crm: CrmService) {}

  @Roles(...CRM_VIEWER_ROLES)
  @Get('partners/:id/activities')
  list(@Param('id') id: string, @Query('page') page?: string, @Query('pageSize') pageSize?: string) {
    return this.crm.list(id, pageRequest(page ?? '1', pageSize, 20) ?? { page: 1, pageSize: 20, skip: 0 });
  }

  @Roles(...CRM_ROLES)
  @Post('partners/:id/activities')
  create(@Param('id') id: string, @Body() body: unknown, @Req() request: AuthenticatedRequest) {
    return this.crm.create(id, PartnerActivityInputSchema.parse(body), request);
  }

  @Roles(...CRM_ROLES)
  @Patch('partners/:id/activities/:activityId')
  update(@Param('id') id: string, @Param('activityId') activityId: string, @Body() body: unknown, @Req() request: AuthenticatedRequest) {
    return this.crm.update(id, activityId, onlyProvided(body, UpdatePartnerActivitySchema.parse(body)), request);
  }

  @Roles(...CRM_ROLES)
  @Delete('partners/:id/activities/:activityId')
  remove(@Param('id') id: string, @Param('activityId') activityId: string, @Req() request: AuthenticatedRequest) {
    return this.crm.remove(id, activityId, request);
  }

  @Roles(...CRM_VIEWER_ROLES)
  @Get('crm/follow-ups')
  followUps(@Req() request: AuthenticatedRequest, @Query('due') due?: string, @Query('mine') mine?: string, @Query('page') page?: string, @Query('pageSize') pageSize?: string) {
    return this.crm.followUps(due, mine === '1', request, pageRequest(page ?? '1', pageSize, 20) ?? { page: 1, pageSize: 20, skip: 0 });
  }
}
