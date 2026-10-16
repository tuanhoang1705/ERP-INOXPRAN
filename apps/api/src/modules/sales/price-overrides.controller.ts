import { Body, Controller, Get, Headers, Param, Post, Query, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { PriceOverrideDecisionSchema, PriceOverrideRequestSchema } from '@inoxpran/contracts';
import { RequirePermission, Roles } from '../../common/roles.decorator';
import type { AuthenticatedRequest } from '../../common/request-context';
import { PriceOverridesService } from './price-overrides.service';

/** Xin / duyệt quyền sửa đơn giá trên phiếu BH: kế toán xin, Admin / Giám đốc duyệt. */
@ApiTags('Sales')
@Controller('price-override-requests')
export class PriceOverridesController {
  constructor(private readonly overrides: PriceOverridesService) {}

  @Roles('ADMIN', 'ACCOUNTANT')
  @Post()
  create(@Body() body: unknown, @Headers('idempotency-key') key: string | undefined, @Req() request: AuthenticatedRequest) {
    return this.overrides.create(PriceOverrideRequestSchema.parse(body), request, key);
  }

  @RequirePermission('sales.price_override_approve')
  @Get()
  list(@Query('status') status?: string) {
    return this.overrides.list(status && ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'].includes(status) ? status : undefined);
  }

  @Roles('ADMIN', 'ACCOUNTANT', 'DIRECTOR')
  @Get(':id')
  get(@Param('id') id: string, @Req() request: AuthenticatedRequest) {
    return this.overrides.get(id, request);
  }

  @RequirePermission('sales.price_override_approve')
  @Post(':id/decision')
  decide(@Param('id') id: string, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined, @Req() request: AuthenticatedRequest) {
    return this.overrides.decide(id, PriceOverrideDecisionSchema.parse(body), request, key);
  }

  @Roles('ADMIN', 'ACCOUNTANT')
  @Post(':id/cancel')
  cancel(@Param('id') id: string, @Req() request: AuthenticatedRequest) {
    return this.overrides.cancel(id, request);
  }
}
