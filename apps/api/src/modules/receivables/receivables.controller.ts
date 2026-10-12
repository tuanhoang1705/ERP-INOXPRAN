import { Body, Controller, Get, Headers, Post, Query, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CreatePaymentSchema } from '@inoxpran/contracts';
import { Roles } from '../../common/roles.decorator';
import type { AuthenticatedRequest } from '../../common/request-context';
import { pageRequest } from '../../common/paging';
import { ReceivablesService } from './receivables.service';

@ApiTags('Receivables')
@Controller()
export class ReceivablesController {
  constructor(private readonly receivables: ReceivablesService) {}

  @Get('receivables')
  list(
    @Query('partnerId') partnerId?: string,
    @Query('overdueOnly') overdueOnly?: string,
    @Query('includePaid') includePaid?: string,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.receivables.list(partnerId, overdueOnly === 'true', includePaid === 'true', search, pageRequest(page, pageSize));
  }

  @Get('receivables/aging')
  aging() {
    return this.receivables.aging();
  }

  @Roles('ADMIN', 'ACCOUNTANT', 'DIRECTOR')
  @Post('receivables/overdue-review')
  review(@Req() request: AuthenticatedRequest) {
    return this.receivables.runReview(request);
  }

  @Roles('ADMIN', 'ACCOUNTANT')
  @Post('payments')
  payment(
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.receivables.recordPayment(CreatePaymentSchema.parse(body), request, key);
  }
}
