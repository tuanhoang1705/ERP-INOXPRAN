import { Inject, Injectable } from '@nestjs/common';
import type { DashboardSummary } from '@inoxpran/contracts';
import Decimal from 'decimal.js';
import type { Db, Document, ObjectId } from 'mongodb';
import { decimalString, vnMonthStart, vnParts } from '../../common/domain';
import { MONGO_DATABASE } from '../../common/tokens';
import { defectiveWarehouseIds } from '../../common/warehouses';
import { OPEN_RECEIVABLE_STATUSES } from '../receivables/overdue-review';
import { orderParty, SALE_ONLY_FILTER, slipTypeOf } from '@inoxpran/contracts';
import { REVENUE_STATUSES } from '../sales/pricing.service';
import type { RequestUser } from '../../common/request-context';
import { salesOrderScope } from '../sales/keeper-scope';
import { openWarrantyTickets, ticketSla, warrantySettings } from '../warranty/warranty-sla';

const DAY_MS = 86_400_000;
const DISTRIBUTOR_TIER = 'TIER_1';
const NET_AMOUNT = { $ifNull: ['$netTotal', { $subtract: ['$subtotal', '$discountTotal'] }] };

function formatVnd(value: Decimal | string): string {
  return `${new Decimal(value).toDecimalPlaces(0).toNumber().toLocaleString('vi-VN')} đ`;
}

@Injectable()
export class DashboardService {
  constructor(@Inject(MONGO_DATABASE) private readonly db: Db) {}

  async summary(page = 1, pageSize = 5, user?: RequestUser): Promise<DashboardSummary> {
    const scope = user ? salesOrderScope(user) : {};
    // "Đơn hàng mới nhất": phiếu đã hủy chỉ tài khoản Admin (kể cả quản trị gốc) thấy.
    const canSeeCancelled = Boolean(user?.root || user?.roles.includes('ADMIN'));
    const recentScope: Document = canSeeCancelled ? scope : { $and: [scope, { status: { $ne: 'CANCELLED' } }] };
    const now = new Date();
    const { year, month } = vnParts(now);
    const monthStarts = Array.from({ length: 7 }, (_, index) => vnMonthStart(year, month - 5 + index));
    const overdue30Boundary = new Date(now.getTime() - 30 * DAY_MS);
    const overdue60Boundary = new Date(now.getTime() - 60 * DAY_MS);
    const safePage = Math.max(1, Math.floor(page));
    const safeSize = Math.min(50, Math.max(1, Math.floor(pageSize)));
    // So sánh cùng kỳ: từ đầu tháng trước đến cùng mốc thời gian đã trôi qua của tháng này.
    const thisMonthStart = monthStarts[5] as Date;
    const previousMonthStart = monthStarts[4] as Date;
    // Tính trọn ngày: từ ngày 1 đến hết ngày cùng số ngày của tháng trước.
    const elapsedDays = vnParts(now).day;
    const previousToDate = new Date(Math.min(previousMonthStart.getTime() + elapsedDays * DAY_MS, thisMonthStart.getTime()));

    // Kho hàng lỗi không tính vào giá trị tồn và cảnh báo dưới định mức.
    const defective = await defectiveWarehouseIds(this.db);
    const [
      monthlyRows,
      pendingApprovalOrders,
      pendingOver24h,
      inventoryRows,
      lowStockRows,
      overdueRows,
      dealersOverdue30,
      dangerRows,
      recentOrders,
      recentOrdersTotal,
      expiringPromotions,
      previousToDateRows,
    ] = await Promise.all([
      this.db.collection('sales_orders').aggregate([
        { $match: { status: { $in: REVENUE_STATUSES }, ...SALE_ONLY_FILTER, orderDate: { $gte: monthStarts[0], $lt: monthStarts[6] } } },
        {
          $group: {
            _id: { $dateToString: { date: '$orderDate', format: '%Y-%m', timezone: 'Asia/Ho_Chi_Minh' } },
            revenue: { $sum: NET_AMOUNT },
          },
        },
      ]).toArray(),
      this.db.collection('sales_orders').countDocuments({ status: 'PENDING_APPROVAL' }),
      this.db.collection('approval_requests').countDocuments({
        status: 'PENDING',
        entityType: 'SalesOrder',
        requestedAt: { $lt: new Date(now.getTime() - DAY_MS) },
      }),
      this.inventoryAtDistributorPrice(defective, now),
      this.db.collection('inventory_balances').aggregate([
        { $match: { warehouseId: { $nin: defective } } },
        { $lookup: { from: 'products', localField: 'productId', foreignField: '_id', as: 'product' } },
        { $unwind: '$product' },
        { $match: { 'product.status': 'ACTIVE', 'product.minimumStock': { $gt: 0 } } },
        { $addFields: { available: { $subtract: ['$onHand', '$reserved'] } } },
        { $match: { $expr: { $lte: ['$available', '$product.minimumStock'] } } },
        { $addFields: { ratio: { $cond: [{ $gt: ['$product.minimumStock', 0] }, { $divide: ['$available', '$product.minimumStock'] }, 0] } } },
        { $sort: { ratio: 1 } },
      ]).toArray(),
      this.db.collection('receivables').aggregate([
        { $match: { dueDate: { $lt: now }, status: { $in: OPEN_RECEIVABLE_STATUSES } } },
        { $group: { _id: null, total: { $sum: { $subtract: ['$amount', '$paidAmount'] } } } },
      ]).toArray(),
      this.db.collection('receivables').distinct('partnerId', {
        dueDate: { $lt: overdue30Boundary },
        status: { $in: OPEN_RECEIVABLE_STATUSES },
      }).then((ids) => ids.length),
      this.db.collection('receivables').aggregate([
        { $match: { dueDate: { $lt: overdue60Boundary }, status: { $in: OPEN_RECEIVABLE_STATUSES } } },
        { $group: { _id: '$partnerId', total: { $sum: { $subtract: ['$amount', '$paidAmount'] } } } },
        { $lookup: { from: 'partners', localField: '_id', foreignField: '_id', as: 'partner' } },
        { $unwind: '$partner' },
        { $sort: { total: -1 } },
      ]).toArray(),
      // Phiếu lập gần nhất lên đầu (cả nháp lẫn đã xuất), không theo ngày chứng từ.
      this.db.collection('sales_orders').find(recentScope)
        .sort({ createdAt: -1, _id: -1 })
        .skip((safePage - 1) * safeSize)
        .limit(safeSize)
        .toArray(),
      this.db.collection('sales_orders').countDocuments(recentScope),
      this.db.collection('promotions').find({
        status: 'ACTIVE',
        validTo: { $gte: now, $lte: new Date(now.getTime() + 7 * DAY_MS) },
      }).sort({ validTo: 1 }).toArray(),
      this.db.collection('sales_orders').aggregate([
        { $match: { status: { $in: REVENUE_STATUSES }, ...SALE_ONLY_FILTER, orderDate: { $gte: previousMonthStart, $lt: previousToDate } } },
        { $group: { _id: null, revenue: { $sum: NET_AMOUNT } } },
      ]).toArray(),
    ]);

    const revenueByMonth = new Map(monthlyRows.map((row) => [String(row._id), decimalString(row.revenue)]));
    const monthlyRevenue = monthStarts.slice(0, 6).map((start, index) => {
      const parts = vnParts(start);
      const key = `${parts.year}-${String(parts.month).padStart(2, '0')}`;
      return {
        month: key,
        label: `T${parts.month}/${String(parts.year).slice(-2)}`,
        revenue: new Decimal(revenueByMonth.get(key) ?? '0').toFixed(2),
        current: index === 5,
      };
    });
    const revenueThisMonth = new Decimal(monthlyRevenue[5]?.revenue ?? '0');
    const revenuePreviousMonth = new Decimal(monthlyRevenue[4]?.revenue ?? '0');
    const revenuePreviousToDate = new Decimal(decimalString(previousToDateRows[0]?.revenue ?? '0'));
    const previousMonthNumber = vnParts(previousMonthStart).month;
    const overdue = new Decimal(decimalString(overdueRows[0]?.total ?? '0'));

    const alerts: DashboardSummary['alerts'] = [];
    const worstDebtor = dangerRows[0];
    if (worstDebtor) {
      const others = dangerRows.length - 1;
      alerts.push({
        id: 'overdue-60',
        level: 'CRITICAL',
        title: 'Công nợ quá hạn trên 60 ngày',
        detail: `${String(worstDebtor.partner.name)}${worstDebtor.partner.province ? ` (${String(worstDebtor.partner.province)})` : ''} — ${formatVnd(decimalString(worstDebtor.total))}${others > 0 ? ` và ${others} đại lý khác` : ''}`,
        href: '/receivables/overdue',
        template: 'OVERDUE_60',
        params: {
          name: String(worstDebtor.partner.name),
          province: worstDebtor.partner.province ? String(worstDebtor.partner.province) : '',
          total: decimalString(worstDebtor.total),
          others,
        },
      });
    }
    const lowest = lowStockRows[0] as (Document & { product: Document; available: unknown }) | undefined;
    if (lowest) {
      alerts.push({
        id: 'low-stock',
        level: 'WARNING',
        title: 'Tồn kho dưới định mức',
        detail: `${String(lowest.product.name)} ${String(lowest.product.sku)} — còn ${Number(decimalString(lowest.available)).toLocaleString('vi-VN')}/${Number(decimalString(lowest.product.minimumStock)).toLocaleString('vi-VN')} ${String(lowest.product.baseUnit).toLowerCase()}${lowStockRows.length > 1 ? ` (+${lowStockRows.length - 1} SKU)` : ''}`,
        href: '/inventory?low=1',
        template: 'LOW_STOCK',
        params: {
          name: String(lowest.product.name),
          sku: String(lowest.product.sku),
          available: decimalString(lowest.available),
          minimum: decimalString(lowest.product.minimumStock),
          unit: String(lowest.product.baseUnit).toLowerCase(),
          more: lowStockRows.length - 1,
        },
      });
    }
    if (pendingOver24h > 0) {
      alerts.push({
        id: 'approval-24h',
        level: 'WARNING',
        title: 'Đơn hàng chờ duyệt quá 24 giờ',
        detail: `${pendingOver24h} đơn hàng đang chờ quyết định phê duyệt`,
        href: '/approvals',
        template: 'APPROVAL_OVERDUE_24H',
        params: { count: pendingOver24h },
      });
    } else if (pendingApprovalOrders > 0) {
      alerts.push({
        id: 'approval',
        level: 'INFO',
        title: 'Đơn hàng chờ duyệt',
        detail: `${pendingApprovalOrders} đơn hàng cần xem xét ngoại lệ`,
        href: '/approvals',
        template: 'APPROVAL_PENDING',
        params: { count: pendingApprovalOrders },
      });
    }
    for (const promotion of expiringPromotions.slice(0, 1)) {
      const daysLeft = Math.max(0, Math.ceil(((promotion.validTo as Date).getTime() - now.getTime()) / DAY_MS));
      alerts.push({
        id: `promotion-${String(promotion.code)}`,
        level: 'INFO',
        title: 'Chương trình khuyến mãi sắp hết hạn',
        detail: `${String(promotion.name)} — còn ${daysLeft} ngày`,
        href: '/pricing/promotions',
        template: 'PROMOTION_EXPIRING',
        params: { name: String(promotion.name), days: daysLeft },
      });
    }
    // Phiếu bảo hành quá hẹn trả — chỉ người phụ trách bảo hành và Giám đốc cần thấy.
    if (user?.roles.some((role) => ['ADMIN', 'DIRECTOR', 'WARRANTY'].includes(role))) {
      const settings = await warrantySettings(this.db);
      const overdueWarranty = (await openWarrantyTickets(this.db)).filter((ticket) => ticketSla(ticket, settings, now).tone === 'overdue').length;
      if (overdueWarranty > 0) {
        alerts.unshift({
          id: 'warranty-overdue',
          level: 'CRITICAL',
          title: 'Phiếu bảo hành quá hẹn trả',
          detail: `${overdueWarranty} phiếu đã quá ngày hẹn trả khách`,
          href: '/warranty?tone=overdue',
          template: 'WARRANTY_OVERDUE',
          params: { count: overdueWarranty },
        });
      }
    }

    return {
      generatedAt: now.toISOString(),
      period: { month: `${year}-${String(month).padStart(2, '0')}`, label: `${String(month).padStart(2, '0')}/${year}` },
      revenueThisMonth: revenueThisMonth.toFixed(2),
      revenuePreviousMonth: revenuePreviousMonth.toFixed(2),
      // 3 ngày đầu tháng số liệu quá ít để so sánh có ý nghĩa.
      revenueChangePercent: elapsedDays > 3 && revenuePreviousToDate.gt(0)
        ? revenueThisMonth.minus(revenuePreviousToDate).div(revenuePreviousToDate).mul(100).toDecimalPlaces(1).toNumber()
        : null,
      revenueComparisonLabel: `cùng kỳ tháng ${previousMonthNumber}`,
      pendingApprovalOrders,
      pendingOver24h,
      inventoryValue: inventoryRows.total.toFixed(2),
      inventoryValueBasis: 'DISTRIBUTOR_NET_PRICE',
      inventoryValueFallbackSkus: inventoryRows.fallbackSkus,
      lowStockSkuCount: lowStockRows.length,
      overdueReceivables: overdue.toFixed(2),
      dealersOverdue30,
      monthlyRevenue,
      recentOrders: recentOrders.map((order) => ({
        id: (order._id as ObjectId).toHexString(),
        code: String(order.code),
        customerName: orderParty(order),
        ...(order.province ? { province: String(order.province) } : {}),
        channel: order.channel === 'B2C' ? 'B2C' : 'B2B',
        slipType: slipTypeOf(order),
        orderDate: ((order.orderDate ?? order.createdAt) as Date).toISOString(),
        lineCount: Number(order.lineCount ?? (order.lines as unknown[] | undefined)?.length ?? 0),
        total: new Decimal(decimalString(order.grandTotal)).toFixed(2),
        status: order.status,
        ...(order.confirmationStatus ? { confirmationStatus: order.confirmationStatus } : {}),
        version: Number(order.version),
      })),
      recentOrdersTotal,
      alerts,
    };
  }

  /**
   * Giá trị tồn kho (trừ kho hàng lỗi) theo giá Net NPP — bảng giá cấp NPP đang hiệu lực, cùng quy tắc chọn bảng giá
   * như khi lập phiếu (ưu tiên cao nhất, phiên bản mới nhất). Mã chưa có giá NPP tạm tính theo giá bán lẻ và được đếm riêng.
   */
  private async inventoryAtDistributorPrice(defective: ObjectId[], now: Date): Promise<{ total: Decimal; fallbackSkus: number }> {
    const [balances, books] = await Promise.all([
      this.db.collection('inventory_balances').aggregate([
        { $match: { warehouseId: { $nin: defective } } },
        { $group: { _id: '$productId', onHand: { $sum: '$onHand' } } },
        { $match: { onHand: { $gt: 0 } } },
      ]).toArray(),
      this.db.collection('price_books').find({
        status: 'PUBLISHED',
        validFrom: { $lte: now },
        $or: [{ validTo: null }, { validTo: { $gte: now } }],
        customerTier: { $in: [DISTRIBUTOR_TIER, 'ALL'] },
      }).sort({ priority: -1, version: -1 }).toArray(),
    ]);
    const price = new Map<string, string>();
    for (const book of books) {
      for (const line of (book.lines as Array<{ productId: ObjectId; baseUnitPrice: unknown }> | undefined) ?? []) {
        const key = line.productId.toHexString();
        if (!price.has(key)) price.set(key, decimalString(line.baseUnitPrice));
      }
    }
    const missing = balances.filter((row) => !price.has((row._id as ObjectId).toHexString())).map((row) => row._id as ObjectId);
    const listPrices = missing.length
      ? new Map((await this.db.collection('products').find({ _id: { $in: missing } }, { projection: { listPrice: 1 } }).toArray()).map((row) => [(row._id as ObjectId).toHexString(), decimalString(row.listPrice ?? '0')]))
      : new Map<string, string>();
    let total = new Decimal(0);
    for (const row of balances) {
      const key = (row._id as ObjectId).toHexString();
      total = total.add(new Decimal(decimalString(row.onHand)).mul(price.get(key) ?? listPrices.get(key) ?? '0'));
    }
    return { total, fallbackSkus: missing.length };
  }
}
