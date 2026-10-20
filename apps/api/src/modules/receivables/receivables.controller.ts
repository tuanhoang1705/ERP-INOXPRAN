import { Body, Controller, Get, Headers, Param, Patch, Post, Query, Req, StreamableFile } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CreateCustomerPaymentSchema, CreatePaymentSchema, SetAutoHoldExemptSchema } from '@inoxpran/contracts';
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
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.receivables.list(partnerId, overdueOnly === 'true', includePaid === 'true', search, pageRequest(page, pageSize), from, to);
  }

  /** Công nợ theo khách hàng (CN-KH-01). */
  @Get('receivables/customers')
  customers(@Query('search') search?: string, @Query('onlyOpen') onlyOpen?: string, @Query('page') page?: string, @Query('pageSize') pageSize?: string) {
    return this.receivables.customers(search, onlyOpen === 'true', pageRequest(page, pageSize));
  }

  @Get('receivables/customers/:id/statement')
  statement(@Param('id') id: string, @Query('from') from?: string, @Query('to') to?: string) {
    return this.receivables.statement(id, from || undefined, to || undefined);
  }

  @Get('receivables/customers/:id/statement/export')
  async statementExport(@Param('id') id: string, @Req() request: AuthenticatedRequest, @Query('from') from?: string, @Query('to') to?: string) {
    const { buffer, fileName } = await this.receivables.statementWorkbook(id, from || undefined, to || undefined, request.user.displayName || request.user.email);
    return new StreamableFile(buffer, {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      disposition: `attachment; filename="${fileName}"`,
      length: buffer.length,
    });
  }

  @Roles('ADMIN', 'ACCOUNTANT')
  @Get('receivables/customer-payments/preview')
  preview(@Query('partnerId') partnerId: string, @Query('amount') amount: string, @Query('segment') segment?: string) {
    return this.receivables.previewCustomerPayment(partnerId, amount ?? '', segment || undefined);
  }

  /** Thu theo khách / ghi phí vận chuyển khách trả: tự phân bổ chứng từ cũ nhất trước, thu dư thành trả trước. */
  @Roles('ADMIN', 'ACCOUNTANT')
  @Post('receivables/customer-payments')
  customerPayment(@Body() body: unknown, @Headers('idempotency-key') key: string | undefined, @Req() request: AuthenticatedRequest) {
    return this.receivables.recordCustomerPayment(CreateCustomerPaymentSchema.parse(body), request, key);
  }

  @Roles('ADMIN', 'ACCOUNTANT')
  @Post('receivables/customers/:id/apply-credit')
  applyCredit(@Param('id') id: string, @Headers('idempotency-key') key: string | undefined, @Req() request: AuthenticatedRequest) {
    return this.receivables.applyCredit(id, request, key);
  }

  /** Cờ "Không tự khóa" khi nợ quá hạn (NPP trả gối đầu) — chỉ Admin. */
  @Roles('ADMIN')
  @Patch('receivables/customers/:id/auto-hold')
  autoHold(@Param('id') id: string, @Body() body: unknown, @Req() request: AuthenticatedRequest) {
    return this.receivables.setAutoHoldExempt(id, SetAutoHoldExemptSchema.parse(body).exempt, request);
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
