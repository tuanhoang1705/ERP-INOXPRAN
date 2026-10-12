import { Controller, Get, Query, Req, StreamableFile } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Roles } from '../../common/roles.decorator';
import type { AuthenticatedRequest } from '../../common/request-context';
import { ReportsService } from './reports.service';

const SalesReportQuerySchema = z.object({
  from: z.string().date(),
  to: z.string().date(),
  region: z.string().trim().max(20).optional(),
  tier: z.enum(['TIER_1', 'TIER_2', 'RETAIL']).optional(),
  categoryId: z.string().trim().max(64).optional(),
});

@ApiTags('Reporting')
@Roles('ADMIN', 'DIRECTOR', 'SALES_MANAGER', 'ACCOUNTANT', 'AUDITOR')
@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  private filter(query: unknown) {
    const parsed = SalesReportQuerySchema.parse(query);
    return {
      from: parsed.from,
      to: parsed.to,
      regionCode: parsed.region || undefined,
      tier: parsed.tier,
      categoryId: parsed.categoryId || undefined,
    };
  }

  @Get('sales-by-dealer')
  salesByDealer(@Query() query: unknown) {
    return this.reports.salesByDealer(this.filter(query));
  }

  @Get('sales-by-dealer/export')
  async export(@Query() query: unknown, @Req() request: AuthenticatedRequest) {
    const filter = this.filter(query);
    const buffer = await this.reports.salesByDealerWorkbook(filter, request.user.displayName || request.user.email);
    return new StreamableFile(buffer, {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      disposition: `attachment; filename="BaoCao_DoanhSo_${filter.from}_${filter.to}.xlsx"`,
      length: buffer.length,
    });
  }
}
