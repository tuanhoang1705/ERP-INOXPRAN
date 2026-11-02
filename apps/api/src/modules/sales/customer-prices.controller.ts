import { Body, Controller, Get, Param, Put, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { PRICING_EDITOR_ROLES, UpdateCustomerPricesSchema } from '@inoxpran/contracts';
import { Roles } from '../../common/roles.decorator';
import type { AuthenticatedRequest } from '../../common/request-context';
import { CustomerPricesService } from './customer-prices.service';

/** Giá riêng từng khách (PRI-CUST-01): xem như hồ sơ khách; kế toán / Admin sửa. */
@ApiTags('Customer prices')
@Controller('partners')
export class CustomerPricesController {
  constructor(private readonly prices: CustomerPricesService) {}

  @Get(':id/prices')
  list(@Param('id') id: string) {
    return this.prices.list(id);
  }

  @Roles(...PRICING_EDITOR_ROLES)
  @Put(':id/prices')
  update(@Param('id') id: string, @Body() body: unknown, @Req() request: AuthenticatedRequest) {
    return this.prices.update(id, UpdateCustomerPricesSchema.parse(body), request);
  }
}
