import { Controller, Get, Query, Req, StreamableFile } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CUSTOMER_RETURN_CATEGORIES, customerProvince, RETURN_DEBT_STATES, RETURNS_SCOPES, INVENTORY_CATEGORIES } from '@inoxpran/contracts';
import { z } from 'zod';
import { Roles } from '../../common/roles.decorator';
import type { AuthenticatedRequest } from '../../common/request-context';
import { returnsReportWorkbook } from './returns-report-workbook';
import { ReturnsReportService, type ReturnsReportFilter } from './returns-report.service';
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

const ReturnsFilterSchema = z.object({
  region: z.string().trim().max(20).optional(),
  salesRepId: z.string().trim().max(64).optional(),
  tier: z.enum(['TIER_1', 'TIER_2', 'RETAIL']).optional(),
  category: z.enum(CUSTOMER_RETURN_CATEGORIES).optional(),
});
const ReturnsReportQuerySchema = ReturnsFilterSchema.extend({
  month: z.string().regex(/^\d{4}-\d{2}$/).optional(),
  scope: z.enum(RETURNS_SCOPES as unknown as ['month', '90', '180']).default('90'),
});
const ReturnsSlipQuerySchema = ReturnsFilterSchema.extend({
  from: z.string().date(),
  to: z.string().date(),
  customerId: z.string().trim().max(64).optional(),
  state: z.enum(RETURN_DEBT_STATES as unknown as ['CREDITED', 'NOT_CREDITED', 'PENDING', 'NO_MONEY']).optional(),
  warehouseId: z.string().trim().max(64).optional(),
  repId: z.string().trim().max(64).optional(),
  soldMonth: z.string().regex(/^\d{4}-\d{2}$/).optional(),
  linked: z.enum(['none']).optional(),
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
  constructor(private readonly reports: ReportsService, private readonly returns: ReturnsReportService) {}

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

  private returnsFilter(query: unknown): ReturnsReportFilter {
    const parsed = ReturnsReportQuerySchema.parse(query);
    return { month: parsed.month, scope: parsed.scope, region: regionFilter(parsed.region), salesRepId: parsed.salesRepId || undefined, tier: parsed.tier, category: parsed.category };
  }

  /** Doanh số & hàng trả (RPT-RET-01): hàng khách trả tách đã giảm công nợ / không giảm / chờ kế toán. */
  @Get('returns')
  returnsReport(@Query() query: unknown) {
    return this.returns.report(this.returnsFilter(query));
  }

  @Get('returns/slips')
  returnsSlips(@Query() query: unknown) {
    const parsed = ReturnsSlipQuerySchema.parse(query);
    return this.returns.slips({ ...parsed, region: regionFilter(parsed.region), salesRepId: parsed.salesRepId || undefined, customerId: parsed.customerId || undefined, warehouseId: parsed.warehouseId || undefined, repId: parsed.repId || undefined });
  }

  @Get('returns/export')
  async returnsExport(@Query() query: unknown, @Req() request: AuthenticatedRequest) {
    const filter = this.returnsFilter(query);
    const report = await this.returns.report(filter);
    const slips = await this.returns.slips({ from: report.month.from, to: report.month.to, region: filter.region, salesRepId: filter.salesRepId, tier: filter.tier, category: filter.category });
    const preparedBy = request.user.displayName || request.user.email;
    const repName = filter.salesRepId ? report.reps.find((row) => row.id === filter.salesRepId)?.name : undefined;
    const filterText = [
      filter.region ? `Tỉnh: ${filter.region}` : '',
      filter.salesRepId ? `NVKD phụ trách: ${repName ?? filter.salesRepId}` : '',
      filter.tier ? `Cấp: ${{ TIER_1: 'NPP · Cấp 1', TIER_2: 'Đại lý · Cấp 2', RETAIL: 'Khách lẻ' }[filter.tier] ?? filter.tier}` : '',
      filter.category ? `Loại hàng trả: ${INVENTORY_CATEGORIES.find((item) => item.code === filter.category)?.vi ?? filter.category}` : '',
    ].filter(Boolean).join(' · ');
    const buffer = await returnsReportWorkbook(report, slips, preparedBy, filterText);
    return new StreamableFile(buffer, {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      disposition: `attachment; filename="BaoCao_HangTra_${report.month.key}.xlsx"`,
      length: buffer.length,
    });
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
