import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type { SalesReport } from '@inoxpran/contracts';
import Decimal from 'decimal.js';
import ExcelJS from 'exceljs';
import type { Db, Document, ObjectId } from 'mongodb';
import { decimalString, toObjectId, vnParts } from '../../common/domain';
import { MONGO_DATABASE } from '../../common/tokens';
import { SALE_ONLY_FILTER } from '@inoxpran/contracts';
import { REVENUE_STATUSES } from '../sales/pricing.service';

const DAY_MS = 86_400_000;
const TIER_LABELS: Record<string, string> = { TIER_1: 'NPP · Cấp 1', TIER_2: 'Đại lý · Cấp 2', RETAIL: 'Khách lẻ' };

export interface SalesReportFilter {
  from: string;
  to: string;
  regionCode?: string | undefined;
  tier?: string | undefined;
  categoryId?: string | undefined;
}

function parseDay(value: string, field: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new BadRequestException({ code: 'INVALID_DATE', message: `${field} phải có dạng YYYY-MM-DD` });
  }
  return new Date(`${value}T00:00:00+07:00`);
}

function formatDay(date: Date): string {
  const { year, month, day } = vnParts(date);
  return `${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}/${year}`;
}

function periodLabel(from: Date, toExclusive: Date): string {
  const start = vnParts(from);
  const lastDay = vnParts(new Date(toExclusive.getTime() - DAY_MS));
  const nextOfLast = vnParts(toExclusive);
  if (start.day === 1 && nextOfLast.day === 1 && start.year === lastDay.year && start.month === lastDay.month) {
    return `Tháng ${String(start.month).padStart(2, '0')}/${start.year}`;
  }
  return `${formatDay(from)} – ${formatDay(new Date(toExclusive.getTime() - DAY_MS))}`;
}

@Injectable()
export class ReportsService {
  constructor(@Inject(MONGO_DATABASE) private readonly db: Db) {}

  private async revenueByCustomer(filter: SalesReportFilter, from: Date, toExclusive: Date) {
    const match: Document = { status: { $in: REVENUE_STATUSES }, ...SALE_ONLY_FILTER, orderDate: { $gte: from, $lt: toExclusive } };
    if (filter.regionCode === 'B2C') match.channel = 'B2C';
    else if (filter.regionCode) match.regionCode = filter.regionCode;
    if (filter.tier) match.customerTier = filter.tier;
    const pipeline: Document[] = [{ $match: match }, { $unwind: '$lines' }];
    if (filter.categoryId) pipeline.push({ $match: { 'lines.categoryId': toObjectId(filter.categoryId, 'categoryId') } });
    pipeline.push({
      $group: {
        _id: '$customerId',
        revenue: { $sum: { $ifNull: ['$lines.netAmount', '$lines.pricingSnapshot.netAmount'] } },
        discount: { $sum: { $ifNull: ['$lines.pricingSnapshot.discountAmount', 0] } },
        orderIds: { $addToSet: '$_id' },
        b2c: { $max: { $cond: [{ $eq: ['$channel', 'B2C'] }, 1, 0] } },
      },
    });
    return this.db.collection('sales_orders').aggregate(pipeline).toArray();
  }

  /** Công nợ cuối kỳ = giá trị chứng từ phải thu phát sinh trước cuối kỳ trừ các khoản đã thu trước cuối kỳ. */
  private async closingDebt(customerIds: ObjectId[], toExclusive: Date): Promise<Map<string, Decimal>> {
    const [receivables, payments] = await Promise.all([
      this.db.collection('receivables').find({ partnerId: { $in: customerIds }, createdAt: { $lt: toExclusive } }).toArray(),
      this.db.collection('payments').aggregate([
        { $match: { partnerId: { $in: customerIds }, receivedAt: { $lt: toExclusive }, status: 'POSTED' } },
        { $unwind: '$allocations' },
        { $group: { _id: '$partnerId', paid: { $sum: '$allocations.amount' } } },
      ]).toArray(),
    ]);
    const debt = new Map<string, Decimal>();
    for (const row of receivables) {
      const key = (row.partnerId as ObjectId).toHexString();
      debt.set(key, (debt.get(key) ?? new Decimal(0)).add(decimalString(row.amount)));
    }
    for (const row of payments) {
      const key = (row._id as ObjectId).toHexString();
      debt.set(key, (debt.get(key) ?? new Decimal(0)).minus(decimalString(row.paid)));
    }
    return debt;
  }

  async salesByDealer(filter: SalesReportFilter): Promise<SalesReport> {
    const from = parseDay(filter.from, 'from');
    const toExclusive = new Date(parseDay(filter.to, 'to').getTime() + DAY_MS);
    if (toExclusive <= from) throw new BadRequestException({ code: 'INVALID_PERIOD', message: 'Kỳ báo cáo không hợp lệ' });
    if (toExclusive.getTime() - from.getTime() > 400 * DAY_MS) {
      throw new BadRequestException({ code: 'PERIOD_TOO_LONG', message: 'Kỳ báo cáo tối đa 13 tháng' });
    }
    const length = toExclusive.getTime() - from.getTime();
    const previousFrom = new Date(from.getTime() - length);

    const [current, previous, regions, settings] = await Promise.all([
      this.revenueByCustomer(filter, from, toExclusive),
      this.revenueByCustomer(filter, previousFrom, from),
      this.db.collection('regions').find({}).toArray(),
      this.db.collection<{ _id: string } & Document>("settings").findOne({ _id: "pricing" }),
    ]);
    const customerIds = current.map((row) => row._id as ObjectId);
    const dealerFilter: Document = { kind: { $in: ['CUSTOMER', 'BOTH'] }, customerTier: { $in: ['TIER_1', 'TIER_2'] }, status: { $ne: 'INACTIVE' } };
    if (filter.regionCode && filter.regionCode !== 'B2C') dealerFilter.regionCode = filter.regionCode;
    if (filter.tier) dealerFilter.customerTier = filter.tier;
    const [customers, debts, totalDealers] = await Promise.all([
      this.db.collection('partners').find({ _id: { $in: customerIds } }).toArray(),
      this.closingDebt(customerIds, toExclusive),
      filter.regionCode === 'B2C' || filter.tier === 'RETAIL' ? Promise.resolve(0) : this.db.collection('partners').countDocuments(dealerFilter),
    ]);
    const customerById = new Map(customers.map((row) => [(row._id as ObjectId).toHexString(), row]));
    const regionName = new Map(regions.map((row) => [String(row.code), String(row.name)]));
    regionName.set('B2C', 'Kênh bán lẻ (B2C)');
    regionName.set('OTHER', 'Khu vực khác');

    const totalRevenue = current.reduce<Decimal>((sum, row) => sum.add(decimalString(row.revenue)), new Decimal(0));
    const totalDiscount = current.reduce<Decimal>((sum, row) => sum.add(decimalString(row.discount)), new Decimal(0));
    const previousRevenue = previous.reduce<Decimal>((sum, row) => sum.add(decimalString(row.revenue)), new Decimal(0));
    const orderCount = new Set(current.flatMap((row) => (row.orderIds as ObjectId[]).map((id) => id.toHexString()))).size;
    const share = (value: Decimal) => (totalRevenue.gt(0) ? value.div(totalRevenue).mul(100).toDecimalPlaces(1).toNumber() : 0);

    const rows = current
      .map((row) => {
        const id = (row._id as ObjectId).toHexString();
        const customer = customerById.get(id);
        const revenue = new Decimal(decimalString(row.revenue));
        const regionCode = row.b2c ? 'B2C' : String(customer?.regionCode ?? 'OTHER');
        return {
          customerId: id,
          code: String(customer?.code ?? '—'),
          name: String(customer?.name ?? '—'),
          province: customer?.province as string | undefined,
          regionCode,
          regionName: regionName.get(regionCode) ?? regionCode,
          tier: TIER_LABELS[String(customer?.customerTier ?? 'RETAIL')] ?? '—',
          tierCode: String(customer?.customerTier ?? 'RETAIL'),
          orders: (row.orderIds as ObjectId[]).length,
          revenue,
          discount: new Decimal(decimalString(row.discount)),
          closingDebt: Decimal.max(0, debts.get(id) ?? new Decimal(0)),
        };
      })
      .sort((a, b) => b.revenue.comparedTo(a.revenue));

    const regionTotals = new Map<string, Decimal>();
    for (const row of rows) regionTotals.set(row.regionCode, (regionTotals.get(row.regionCode) ?? new Decimal(0)).add(row.revenue));
    const regionList = [...regionTotals.entries()]
      .map(([code, revenue]) => ({ code, name: regionName.get(code) ?? code, revenue: revenue.toFixed(2), share: share(revenue) }))
      .sort((a, b) => Number(b.revenue) - Number(a.revenue));

    const dealerRows = rows.filter((row) => row.tierCode !== 'RETAIL');
    return {
      period: { from: filter.from, to: filter.to, label: periodLabel(from, toExclusive) },
      generatedAt: new Date().toISOString(),
      summary: {
        revenue: totalRevenue.toFixed(2),
        previousRevenue: previousRevenue.toFixed(2),
        changePercent: previousRevenue.gt(0) ? totalRevenue.minus(previousRevenue).div(previousRevenue).mul(100).toDecimalPlaces(1).toNumber() : null,
        orders: orderCount,
        averageOrderValue: orderCount ? totalRevenue.div(orderCount).toFixed(2) : '0.00',
        activeDealers: dealerRows.length,
        totalDealers,
        averageDiscountRate: totalRevenue.add(totalDiscount).gt(0)
          ? totalDiscount.div(totalRevenue.add(totalDiscount)).mul(100).toDecimalPlaces(1).toNumber()
          : 0,
        discountCapRate: String(settings?.discountCapRate ?? '15'),
      },
      topDealers: dealerRows.slice(0, 6).map((row) => ({
        code: row.code,
        name: row.name,
        ...(row.province ? { province: row.province } : {}),
        revenue: row.revenue.toFixed(2),
      })),
      regions: regionList,
      rows: rows.map((row) => ({
        customerId: row.customerId,
        code: row.code,
        name: row.name,
        regionCode: row.regionCode,
        regionName: row.regionName,
        tier: row.tier,
        orders: row.orders,
        revenue: row.revenue.toFixed(2),
        discount: row.discount.toFixed(2),
        closingDebt: row.closingDebt.toFixed(2),
        share: share(row.revenue),
      })),
      totals: {
        orders: orderCount,
        revenue: totalRevenue.toFixed(2),
        discount: totalDiscount.toFixed(2),
        closingDebt: rows.reduce((sum, row) => sum.add(row.closingDebt), new Decimal(0)).toFixed(2),
      },
    };
  }

  async salesByDealerWorkbook(filter: SalesReportFilter, preparedBy: string): Promise<Buffer> {
    const report = await this.salesByDealer(filter);
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'INOXPRAN ERP';
    workbook.created = new Date();
    const navy = 'FF123B5E';
    const money = '#,##0';

    const sheet = workbook.addWorksheet('Doanh số theo đại lý', { views: [{ state: 'frozen', ySplit: 6 }] });
    sheet.columns = [
      { key: 'stt', width: 6 },
      { key: 'code', width: 14 },
      { key: 'name', width: 34 },
      { key: 'region', width: 26 },
      { key: 'tier', width: 16 },
      { key: 'orders', width: 10 },
      { key: 'revenue', width: 18 },
      { key: 'discount', width: 16 },
      { key: 'debt', width: 18 },
      { key: 'share', width: 10 },
    ];
    sheet.mergeCells('A1:J1');
    sheet.getCell('A1').value = 'CÔNG TY TNHH ĐẦU TƯ THẮNG VƯỢNG — INOXPRAN';
    sheet.getCell('A1').font = { bold: true, color: { argb: navy }, size: 11 };
    sheet.mergeCells('A2:J2');
    sheet.getCell('A2').value = 'BÁO CÁO DOANH SỐ THEO ĐẠI LÝ & KHU VỰC';
    sheet.getCell('A2').font = { bold: true, size: 15, color: { argb: navy } };
    sheet.mergeCells('A3:J3');
    sheet.getCell('A3').value = `Kỳ báo cáo: ${report.period.label} · Người lập: ${preparedBy} · Ngày kết xuất: ${formatDay(new Date())}`;
    sheet.mergeCells('A4:J4');
    sheet.getCell('A4').value = `Tổng doanh số (sau chiết khấu, chưa VAT): ${Number(report.summary.revenue).toLocaleString('vi-VN')} đ · ${report.summary.orders} đơn · ${report.summary.activeDealers}/${report.summary.totalDealers} đại lý phát sinh`;
    sheet.getCell('A4').font = { italic: true, color: { argb: 'FF5A6B7C' } };

    const header = sheet.getRow(6);
    header.values = ['STT', 'Mã ĐL', 'Tên đại lý / khách hàng', 'Khu vực', 'Cấp', 'Số đơn', 'Doanh số', 'Chiết khấu', 'Công nợ cuối kỳ', 'Tỷ trọng'];
    header.eachCell((cell) => {
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: navy } };
      cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    });
    header.height = 22;
    report.rows.forEach((row, index) => {
      const excelRow = sheet.addRow({
        stt: index + 1,
        code: row.code,
        name: row.name,
        region: row.regionName,
        tier: row.tier,
        orders: row.orders,
        revenue: Number(row.revenue),
        discount: Number(row.discount),
        debt: Number(row.closingDebt),
        share: row.share / 100,
      });
      if (index % 2 === 1) excelRow.eachCell((cell) => { cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF4F6F9' } }; });
    });
    const totalRow = sheet.addRow({
      name: `TỔNG CỘNG (${report.rows.length} khách hàng phát sinh)`,
      orders: report.totals.orders,
      revenue: Number(report.totals.revenue),
      discount: Number(report.totals.discount),
      debt: Number(report.totals.closingDebt),
      share: report.rows.length ? 1 : 0,
    });
    totalRow.font = { bold: true };
    totalRow.eachCell((cell) => { cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8F0F8' } }; });
    for (const key of ['revenue', 'discount', 'debt']) sheet.getColumn(key).numFmt = money;
    sheet.getColumn('share').numFmt = '0.0%';
    sheet.autoFilter = { from: { row: 6, column: 1 }, to: { row: 6, column: 10 } };

    const regionSheet = workbook.addWorksheet('Cơ cấu theo khu vực');
    regionSheet.columns = [
      { header: 'Khu vực', key: 'name', width: 32 },
      { header: 'Doanh số', key: 'revenue', width: 20, style: { numFmt: money } },
      { header: 'Tỷ trọng', key: 'share', width: 12, style: { numFmt: '0.0%' } },
    ];
    regionSheet.getRow(1).eachCell((cell) => {
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: navy } };
    });
    for (const region of report.regions) regionSheet.addRow({ name: region.name, revenue: Number(region.revenue), share: region.share / 100 });

    return Buffer.from(await workbook.xlsx.writeBuffer());
  }
}
