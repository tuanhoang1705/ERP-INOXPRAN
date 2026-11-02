import { Controller, Get, Query, Req, StreamableFile } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { customerProvince } from '@inoxpran/contracts';
import { z } from 'zod';
import { Roles } from '../../common/roles.decorator';
import type { AuthenticatedRequest } from '../../common/request-context';
import { ReportsService } from './reports.service';

const SalesReportQuerySchema = z.object({
  from: z.string().date(),
  to: z.string().date(),
  /** Tỉnh mới (34) hoặc B2C; mã khu vực cũ (tỉnh cũ) vẫn nhận, quy về tỉnh mới. */
  region: z.string().trim().max(20).optional(),
  salesRepId: z.string().trim().max(64).optional(),
  tier: z.enum(['TIER_1', 'TIER_2', 'RETAIL']).optional(),
  categoryId: z.string().trim().max(64).optional(),
});

/** Bộ lọc khu vực: tỉnh mới; mã khu vực cũ (= tỉnh cũ, HN-LE / HN-NPP = Hà Nội) quy về tỉnh mới để đường dẫn đã lưu vẫn chạy. */
function regionFilter(value: string | undefined): string | undefined {
  if (!value || value === 'B2C') return value || undefined;
  return customerProvince({ regionCode: value }).newCode ?? value;
}

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
      regionCode: regionFilter(parsed.region),
      salesRepId: parsed.salesRepId || undefined,
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
