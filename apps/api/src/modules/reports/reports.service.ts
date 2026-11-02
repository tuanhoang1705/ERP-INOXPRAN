import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { customerProvince, provinceReportName, type SalesReport } from '@inoxpran/contracts';
import Decimal from 'decimal.js';
import type { Db, Document, ObjectId } from 'mongodb';
import { decimal, decimalString, toObjectId, vnParts } from '../../common/domain';
import { addBodyRow, brandSheet, brandWorkbook, exportedAt, finalize, FORMATS, kpiStrip, noteRow, signatureBlock, tableHeader, titleBlock, toBuffer, totalRow, type BrandColumn, type Kpi } from '../../common/excel-brand';
import { MONGO_DATABASE } from '../../common/tokens';
import { SALE_ONLY_FILTER } from '@inoxpran/contracts';
import { REVENUE_STATUSES } from '../sales/pricing.service';

const DAY_MS = 86_400_000;
const TIER_LABELS: Record<string, string> = { TIER_1: 'NPP · Cấp 1', TIER_2: 'Đại lý · Cấp 2', RETAIL: 'Khách lẻ' };

export interface SalesReportFilter {
  from: string;
  to: string;
  /** Mã tỉnh mới (34) hoặc "B2C". */
  regionCode?: string | undefined;
  salesRepId?: string | undefined;
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
    const match: Document = { status: { $in: REVENUE_STATUSES }, ...SALE_ONLY_FILTER, deliveredAt: { $gte: from, $lt: toExclusive } };
    // Lọc tỉnh / NVKD làm sau khi gom theo khách (theo tỉnh hiện tại của khách — PV-01).
    if (filter.regionCode === 'B2C') match.channel = 'B2C';
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

  /**
   * Công nợ cuối kỳ (cùng công thức với sổ chi tiết công nợ theo khách — CN-KH-01): chứng từ phải thu phát sinh trước cuối kỳ
   * − chứng từ đã hủy trước cuối kỳ − các khoản giảm nợ trước cuối kỳ (thu tiền, phí vận chuyển khách trả, trả hàng).
   * Khoản khách trả trước (phải thu âm) và phiếu bù trừ chỉ là phân bổ nên không cộng thêm (trước đây phiếu đã thu rồi hủy bị trừ hai lần).
   */
  private async closingDebt(customerIds: ObjectId[], toExclusive: Date): Promise<Map<string, Decimal>> {
    const positive = { $gt: decimal('0') };
    const [debits, voided, reductions] = await Promise.all([
      this.db.collection('receivables').aggregate([
        { $match: { partnerId: { $in: customerIds }, createdAt: { $lt: toExclusive }, amount: positive } },
        { $group: { _id: '$partnerId', total: { $sum: '$amount' } } },
      ]).toArray(),
      this.db.collection('receivables').aggregate([
        { $match: { partnerId: { $in: customerIds }, status: 'VOIDED', amount: positive, $or: [{ voidedAt: { $lt: toExclusive } }, { voidedAt: { $exists: false }, updatedAt: { $lt: toExclusive } }] } },
        { $group: { _id: '$partnerId', total: { $sum: '$amount' } } },
      ]).toArray(),
      this.db.collection('payments').aggregate([
        { $match: { partnerId: { $in: customerIds }, receivedAt: { $lt: toExclusive }, status: 'POSTED', kind: { $ne: 'OFFSET' } } },
        { $group: { _id: '$partnerId', total: { $sum: '$amount' } } },
      ]).toArray(),
    ]);
    const debt = new Map<string, Decimal>();
    const add = (rows: Document[], sign: 1 | -1) => {
      for (const row of rows) {
        const key = (row._id as ObjectId).toHexString();
        const value = new Decimal(decimalString(row.total));
        debt.set(key, (debt.get(key) ?? new Decimal(0)).add(sign === 1 ? value : value.neg()));
      }
    };
    add(debits, 1);
    add(voided, -1);
    add(reductions, -1);
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

    const [currentAll, previousAll, settings] = await Promise.all([
      this.revenueByCustomer(filter, from, toExclusive),
      this.revenueByCustomer(filter, previousFrom, from),
      this.db.collection<{ _id: string } & Document>("settings").findOne({ _id: "pricing" }),
    ]);
    const allIds = [...new Set([...currentAll, ...previousAll].map((row) => (row._id as ObjectId).toHexString()))].map((id) => toObjectId(id));
    const customers = await this.db.collection('partners').find({ _id: { $in: allIds } }).toArray();
    const customerById = new Map(customers.map((row) => [(row._id as ObjectId).toHexString(), row]));
    // Khu vực = tỉnh mới (34) của khách, kèm tỉnh cũ nếu khác tên (PV-01); khách kênh bán lẻ gom vào "Kênh bán lẻ (B2C)".
    const regionOf = (row: Document) => {
      if (row.b2c) return { code: 'B2C', name: 'Kênh bán lẻ (B2C)' };
      const province = customerProvince(customerById.get((row._id as ObjectId).toHexString()) ?? {});
      return province.newCode ? { code: province.newCode, name: provinceReportName(province) } : { code: 'OTHER', name: 'Chưa có tỉnh' };
    };
    const keep = (row: Document) => {
      const customer = customerById.get((row._id as ObjectId).toHexString());
      if (filter.salesRepId && String(customer?.salesRepId ?? '') !== filter.salesRepId) return false;
      if (filter.regionCode && filter.regionCode !== 'B2C' && regionOf(row).code !== filter.regionCode) return false;
      return true;
    };
    const current = currentAll.filter(keep);
    const previous = previousAll.filter(keep);
    const customerIds = current.map((row) => row._id as ObjectId);
    const dealerFilter: Document = { kind: { $in: ['CUSTOMER', 'BOTH'] }, customerTier: { $in: ['TIER_1', 'TIER_2'] }, status: { $ne: 'INACTIVE' } };
    if (filter.tier) dealerFilter.customerTier = filter.tier;
    if (filter.salesRepId) dealerFilter.salesRepId = toObjectId(filter.salesRepId, 'salesRepId');
    const [debts, dealers] = await Promise.all([
      this.closingDebt(customerIds, toExclusive),
      filter.regionCode === 'B2C' || filter.tier === 'RETAIL' ? Promise.resolve([]) : this.db.collection('partners').find(dealerFilter, { projection: { provinceOldCode: 1, provinceNewCode: 1, regionCode: 1, province: 1 } }).toArray(),
    ]);
    const totalDealers = filter.regionCode ? dealers.filter((row) => customerProvince(row).newCode === filter.regionCode).length : dealers.length;

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
        const region = regionOf(row);
        return {
          customerId: id,
          code: String(customer?.code ?? '—'),
          name: String(customer?.name ?? '—'),
          province: region.code === 'B2C' || region.code === 'OTHER' ? undefined : region.name,
          regionCode: region.code,
          regionName: region.name,
          salesRepId: customer?.salesRepId ? String(customer.salesRepId) : undefined,
          salesRepName: customer?.salesRepName ? String(customer.salesRepName) : undefined,
          tier: TIER_LABELS[String(customer?.customerTier ?? 'RETAIL')] ?? '—',
          tierCode: String(customer?.customerTier ?? 'RETAIL'),
          orderIds: (row.orderIds as ObjectId[]).map((orderId) => orderId.toHexString()),
          orders: (row.orderIds as ObjectId[]).length,
          revenue,
          discount: new Decimal(decimalString(row.discount)),
          closingDebt: Decimal.max(0, debts.get(id) ?? new Decimal(0)),
        };
      })
      .sort((a, b) => b.revenue.comparedTo(a.revenue));

    const regionTotals = new Map<string, { name: string; revenue: Decimal }>();
    for (const row of rows) {
      const entry = regionTotals.get(row.regionCode) ?? { name: row.regionName.replace(/ \(.*\)$/, ''), revenue: new Decimal(0) };
      entry.revenue = entry.revenue.add(row.revenue);
      regionTotals.set(row.regionCode, entry);
    }
    const regionList = [...regionTotals.entries()]
      .map(([code, entry]) => ({ code, name: entry.name, revenue: entry.revenue.toFixed(2), share: share(entry.revenue) }))
      .sort((a, b) => Number(b.revenue) - Number(a.revenue));

    const repTotals = new Map<string, { id: string | null; name: string; customers: number; orders: Set<string>; revenue: Decimal; closingDebt: Decimal }>();
    for (const row of rows) {
      const repKey = row.salesRepId ?? '';
      const entry = repTotals.get(repKey) ?? { id: row.salesRepId ?? null, name: row.salesRepName ?? 'Chưa giao NVKD', customers: 0, orders: new Set<string>(), revenue: new Decimal(0), closingDebt: new Decimal(0) };
      entry.customers += 1;
      for (const orderId of row.orderIds) entry.orders.add(orderId);
      entry.revenue = entry.revenue.add(row.revenue);
      entry.closingDebt = entry.closingDebt.add(row.closingDebt);
      repTotals.set(repKey, entry);
    }
    const repList = [...repTotals.values()]
      .map((entry) => ({ id: entry.id, name: entry.name, customers: entry.customers, orders: entry.orders.size, revenue: entry.revenue.toFixed(2), closingDebt: entry.closingDebt.toFixed(2), share: share(entry.revenue) }))
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
      reps: repList,
      rows: rows.map((row) => ({
        customerId: row.customerId,
        code: row.code,
        name: row.name,
        regionCode: row.regionCode,
        regionName: row.regionName,
        ...(row.salesRepId ? { salesRepId: row.salesRepId } : {}),
        ...(row.salesRepName ? { salesRepName: row.salesRepName } : {}),
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

  /**
   * File Excel doanh số (bảng điều khiển + Báo cáo) theo bộ chuẩn thương hiệu (XLS-01): sheet chi tiết theo khách có cột NV phụ
   * trách (PV-01, yêu cầu của Ban Giám đốc 30/10/2026), sheet theo nhân viên KD và sheet theo tỉnh / thành.
   */
  async salesByDealerWorkbook(filter: SalesReportFilter, preparedBy: string): Promise<Buffer> {
    const report = await this.salesByDealer(filter);
    const workbook = brandWorkbook();
    const filters = [
      filter.regionCode ? `Khu vực: ${report.regions.find((row) => row.code === filter.regionCode)?.name ?? filter.regionCode}` : '',
      filter.salesRepId ? `NVKD: ${report.reps.find((row) => row.id === filter.salesRepId)?.name ?? ''}` : '',
      filter.tier ? `Cấp: ${TIER_LABELS[filter.tier] ?? filter.tier}` : '',
    ].filter(Boolean).join(' · ');
    const meta = [
      `Kỳ báo cáo: ${report.period.label}${filters ? ` · ${filters}` : ''}`,
      `Người lập: ${preparedBy} · Xuất lúc ${exportedAt()} · Doanh số sau chiết khấu, chưa VAT, tính theo ngày giao thành công`,
    ];
    const kpis: Kpi[] = [
      { label: 'TỔNG DOANH SỐ (Đ)', value: Number(report.summary.revenue), format: FORMATS.money },
      { label: 'SO VỚI KỲ TRƯỚC', value: report.summary.changePercent === null ? '—' : report.summary.changePercent / 100, format: '+0.0%;-0.0%;0.0%', tone: report.summary.changePercent !== null && report.summary.changePercent < 0 ? 'danger' : 'good' },
      { label: 'SỐ ĐƠN ĐÃ GIAO', value: report.summary.orders, format: FORMATS.int },
      { label: 'ĐẠI LÝ PHÁT SINH', value: `${report.summary.activeDealers}/${report.summary.totalDealers}` },
      { label: 'CÔNG NỢ CUỐI KỲ (Đ)', value: Number(report.totals.closingDebt), format: FORMATS.money },
    ];

    // Sheet 1: chi tiết theo khách hàng.
    const columns: BrandColumn[] = [
      { key: 'stt', header: 'STT', width: 6, type: 'int' },
      { key: 'code', header: 'Mã KH', width: 13, type: 'code' },
      { key: 'name', header: 'Tên đại lý / khách hàng', width: 38, wrap: true },
      { key: 'region', header: 'Khu vực (tỉnh / thành)', width: 28, wrap: true },
      { key: 'rep', header: 'NV phụ trách', width: 22 },
      { key: 'tier', header: 'Cấp', width: 15 },
      { key: 'orders', header: 'Số đơn', width: 9, type: 'int' },
      { key: 'revenue', header: 'Doanh số (đ)', width: 18, type: 'money', emphasis: true },
      { key: 'discount', header: 'Chiết khấu (đ)', width: 15, type: 'money' },
      { key: 'debt', header: 'Công nợ cuối kỳ (đ)', width: 19, type: 'money' },
      { key: 'share', header: 'Tỷ trọng', width: 10, type: 'percent' },
    ];
    const sheet = brandSheet(workbook, 'Doanh số theo khách', columns);
    let rowNo = titleBlock(sheet, columns.length, 'Báo cáo doanh số theo đại lý & khu vực', meta);
    rowNo = kpiStrip(sheet, rowNo, columns.length, kpis);
    const header = rowNo;
    tableHeader(sheet, header, columns);
    report.rows.forEach((row, index) => {
      addBodyRow(sheet, columns, {
        stt: index + 1, code: row.code, name: row.name, region: row.regionName, rep: row.salesRepName ?? '—', tier: row.tier,
        orders: row.orders, revenue: Number(row.revenue), discount: Number(row.discount), debt: Number(row.closingDebt), share: row.share / 100,
      }, index, { cells: { rep: row.salesRepName ? {} : { color: 'red' } } });
    });
    totalRow(sheet, columns, {
      name: `TỔNG CỘNG (${report.rows.length} khách hàng phát sinh)`, orders: report.totals.orders, revenue: Number(report.totals.revenue),
      discount: Number(report.totals.discount), debt: Number(report.totals.closingDebt), share: report.rows.length ? 1 : 0,
    });
    finalize(sheet, header, header + report.rows.length, columns.length, { freezeColumns: 3 });
    signatureBlock(sheet, columns.length, preparedBy);

    // Sheet 2: theo nhân viên kinh doanh.
    const repColumns: BrandColumn[] = [
      { key: 'stt', header: 'STT', width: 6, type: 'int' },
      { key: 'name', header: 'Nhân viên kinh doanh', width: 30, type: 'code' },
      { key: 'customers', header: 'Số khách phát sinh', width: 14, type: 'int' },
      { key: 'orders', header: 'Số đơn', width: 10, type: 'int' },
      { key: 'revenue', header: 'Doanh số (đ)', width: 20, type: 'money', emphasis: true },
      { key: 'debt', header: 'Công nợ cuối kỳ (đ)', width: 20, type: 'money' },
      { key: 'share', header: 'Tỷ trọng', width: 11, type: 'percent' },
    ];
    const repSheet = brandSheet(workbook, 'Theo nhân viên KD', repColumns, { portrait: true });
    const repHeader = titleBlock(repSheet, repColumns.length, 'Doanh số theo nhân viên kinh doanh', meta);
    tableHeader(repSheet, repHeader, repColumns);
    report.reps.forEach((row, index) => {
      addBodyRow(repSheet, repColumns, {
        stt: index + 1, name: row.name, customers: row.customers, orders: row.orders, revenue: Number(row.revenue), debt: Number(row.closingDebt), share: row.share / 100,
      }, index, row.id ? {} : { highlight: 'warn' });
    });
    totalRow(repSheet, repColumns, {
      name: 'TỔNG CỘNG', customers: report.rows.length, orders: report.totals.orders, revenue: Number(report.totals.revenue), debt: Number(report.totals.closingDebt), share: report.reps.length ? 1 : 0,
    });
    finalize(repSheet, repHeader, repHeader + report.reps.length, repColumns.length);
    noteRow(repSheet, repColumns.length, 'NVKD lấy theo người đang phụ trách khách (phân vùng theo tỉnh). Dòng tô vàng: khách chưa giao NVKD.');

    // Sheet 3: theo tỉnh / thành (34 tỉnh mới).
    const regionColumns: BrandColumn[] = [
      { key: 'stt', header: 'STT', width: 6, type: 'int' },
      { key: 'name', header: 'Tỉnh / thành', width: 32, type: 'code' },
      { key: 'revenue', header: 'Doanh số (đ)', width: 22, type: 'money', emphasis: true },
      { key: 'share', header: 'Tỷ trọng', width: 12, type: 'percent' },
    ];
    const regionSheet = brandSheet(workbook, 'Theo tỉnh thành', regionColumns, { portrait: true });
    const regionHeader = titleBlock(regionSheet, regionColumns.length, 'Cơ cấu doanh số theo tỉnh / thành', meta);
    tableHeader(regionSheet, regionHeader, regionColumns);
    report.regions.forEach((row, index) => addBodyRow(regionSheet, regionColumns, { stt: index + 1, name: row.name, revenue: Number(row.revenue), share: row.share / 100 }, index));
    totalRow(regionSheet, regionColumns, { name: 'TỔNG CỘNG', revenue: Number(report.totals.revenue), share: report.regions.length ? 1 : 0 });
    finalize(regionSheet, regionHeader, regionHeader + report.regions.length, regionColumns.length);

    return toBuffer(workbook);
  }
}
