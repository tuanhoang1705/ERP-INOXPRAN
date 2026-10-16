import type { Workspace } from '@inoxpran/contracts';
import { Controller, Get, Inject, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import Decimal from 'decimal.js';
import type { Db, Document, ObjectId } from 'mongodb';
import { dateBounds } from '../../common/date-range';
import { decimalString, salesTierWindow, serializeDocument, toObjectId } from '../../common/domain';
import { pageOf, pageRequest } from '../../common/paging';
import { Public } from '../../common/public.decorator';
import { Roles } from '../../common/roles.decorator';
import { MONGO_DATABASE } from '../../common/tokens';
import { OPEN_RECEIVABLE_STATUSES } from '../receivables/overdue-review';
import { SALE_ONLY_FILTER } from '@inoxpran/contracts';
import { REVENUE_STATUSES } from '../sales/pricing.service';

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Dữ liệu tham chiếu chỉ đọc: nhóm hàng, khu vực, nhân viên kinh doanh, bảng giá theo cấp, khuyến mãi và người dùng. */
@ApiTags('Catalog')
@Controller()
export class ReferenceController {
  constructor(@Inject(MONGO_DATABASE) private readonly db: Db) {}

  /**
   * Nơi làm việc cho ô "Chi nhánh / Kho làm việc" trên màn hình đăng nhập: văn phòng (không giữ hàng) và kho.
   * Văn phòng dùng kho mặc định cho các form; chỉ trả mã, tên, loại.
   */
  @Public()
  @Get('auth/workspaces')
  async workspaces(): Promise<Workspace[]> {
    const [branches, warehouses] = await Promise.all([
      this.db.collection('branches').find({ active: true }, { projection: { code: 1, name: 1, defaultWarehouseId: 1 } }).sort({ code: 1 }).toArray(),
      this.db.collection('warehouses').find({ active: true, purpose: { $ne: 'DEFECTIVE' } }, { projection: { code: 1, name: 1 } }).sort({ code: 1 }).toArray(),
    ]);
    const fallbackWarehouse = (warehouses[0]?._id as ObjectId | undefined)?.toHexString() ?? null;
    return [
      ...branches.map((row) => ({
        id: (row._id as ObjectId).toHexString(), code: String(row.code), name: String(row.name), kind: 'OFFICE' as const,
        defaultWarehouseId: (row.defaultWarehouseId as ObjectId | undefined)?.toHexString() ?? fallbackWarehouse,
      })),
      ...warehouses.map((row) => ({
        id: (row._id as ObjectId).toHexString(), code: String(row.code), name: String(row.name), kind: 'WAREHOUSE' as const,
        defaultWarehouseId: (row._id as ObjectId).toHexString(),
      })),
    ];
  }

  /** Khu vực kèm số đại lý / khách hàng đang thuộc vùng. */
  @Get('regions')
  async regions() {
    const [rows, counts] = await Promise.all([
      this.db.collection('regions').find({}).sort({ sortOrder: 1, code: 1 }).toArray(),
      this.db.collection('partners').aggregate([{ $match: { kind: { $in: ['CUSTOMER', 'BOTH'] }, regionCode: { $ne: null } } }, { $group: { _id: '$regionCode', count: { $sum: 1 } } }]).toArray(),
    ]);
    const countByCode = new Map(counts.map((row) => [String(row._id), Number(row.count)]));
    return rows.map((row) => ({ ...serializeDocument(row), dealerCount: countByCode.get(String(row.code)) ?? 0 }));
  }

  /** Nhân viên kinh doanh kèm số đại lý đang phụ trách. */
  @Get('employees')
  async employees(@Query('role') role?: string) {
    const [rows, counts] = await Promise.all([
      this.db.collection('employees').find(role ? { role } : {}).sort({ code: 1 }).toArray(),
      this.db.collection('partners').aggregate([{ $match: { salesRepId: { $ne: null } } }, { $group: { _id: '$salesRepId', count: { $sum: 1 } } }]).toArray(),
    ]);
    const countById = new Map(counts.map((row) => [String(row._id), Number(row.count)]));
    const userIds = rows.map((row) => row.userId as ObjectId | null | undefined).filter((id): id is ObjectId => Boolean(id));
    const users = userIds.length ? await this.db.collection('users').find({ _id: { $in: userIds } }, { projection: { email: 1, displayName: 1 } }).toArray() : [];
    const userById = new Map(users.map((user) => [String(user._id), user]));
    return rows.map((row) => {
      const user = row.userId ? userById.get(String(row.userId)) : undefined;
      return { ...serializeDocument(row), status: row.status ?? 'ACTIVE', dealerCount: countById.get(String(row._id)) ?? 0, ...(user ? { userEmail: String(user.email), userName: String(user.displayName) } : {}) };
    });
  }

  /** Bảng giá hiện hành: giá Net NPP (cấp 1), giá đại lý (cấp 2) và giá bán lẻ cho từng mã hàng. */
  @Get('price-list')
  async priceList(@Query('search') search?: string, @Query('categoryId') categoryId?: string, @Query('page') page?: string, @Query('pageSize') pageSize?: string, @Query('at') at?: string) {
    const paging = pageRequest(page, pageSize);
    // Bảng giá áp dụng tại cuối một ngày (LIST-DATE-01); bỏ trống = hiện tại. Giá bán lẻ lấy theo hồ sơ mã hàng hiện tại.
    const bounds = at ? dateBounds(at, at) : null;
    const now = bounds?.$lt ? new Date(bounds.$lt.getTime() - 1) : new Date();
    const filter: Document = { status: 'ACTIVE' };
    if (categoryId) filter.categoryId = toObjectId(categoryId, 'categoryId');
    if (search) {
      const pattern = new RegExp(escapeRegex(search), 'i');
      filter.$or = [{ sku: pattern }, { name: pattern }];
    }
    const [products, categories, books] = await Promise.all([
      paging ? this.db.collection('products').find(filter).sort({ sku: 1 }).skip(paging.skip).limit(paging.pageSize).toArray() : this.db.collection('products').find(filter).sort({ sku: 1 }).toArray(),
      this.db.collection('product_categories').find({}).toArray(),
      this.db.collection('price_books').find({
        status: 'PUBLISHED',
        validFrom: { $lte: now },
        $or: [{ validTo: null }, { validTo: { $gte: now } }],
      }).sort({ priority: -1, version: -1 }).toArray(),
    ]);
    const categoryById = new Map(categories.map((row) => [(row._id as ObjectId).toHexString(), row]));
    const priceFor = (tier: string, productId: ObjectId): string | null => {
      for (const book of books) {
        if (book.customerTier !== tier && book.customerTier !== 'ALL') continue;
        const line = (book.lines as Array<{ productId: ObjectId; baseUnitPrice: unknown }>).find((item) => item.productId.equals(productId));
        if (line) return decimalString(line.baseUnitPrice);
      }
      return null;
    };
    const booksSummary = books.map((book) => ({
      code: String(book.code),
      name: String(book.name),
      customerTier: String(book.customerTier),
      version: Number(book.version),
      validFrom: (book.validFrom as Date).toISOString(),
      lineCount: (book.lines as unknown[]).length,
    }));
    const rows = products
      .map((product) => {
        const id = product._id as ObjectId;
        const category = product.categoryId ? categoryById.get((product.categoryId as ObjectId).toHexString()) : undefined;
        return {
          productId: id.toHexString(),
          sku: String(product.sku),
          name: String(product.name),
          categoryName: category ? String(category.name) : undefined,
          baseUnit: String(product.baseUnit),
          packSize: product.packSize as number | undefined,
          distributorPrice: priceFor('TIER_1', id),
          dealerPrice: priceFor('TIER_2', id),
          retailPrice: decimalString(product.listPrice),
          availability: String(product.availability ?? 'IN_STOCK'),
          clearance: Boolean(product.clearance),
        };
      });
    if (!paging) return { books: booksSummary, rows };
    return { books: booksSummary, ...pageOf(rows, await this.db.collection('products').countDocuments(filter), paging) };
  }

  @Get('promotions')
  async promotions() {
    const [rows, categories] = await Promise.all([
      this.db.collection('promotions').find({}).sort({ validTo: -1 }).toArray(),
      this.db.collection('product_categories').find({}).toArray(),
    ]);
    const now = new Date();
    const categoryName = new Map(categories.map((row) => [(row._id as ObjectId).toHexString(), String(row.name)]));
    return rows.map((row) => ({
      ...serializeDocument(row),
      categoryNames: ((row.categoryIds as ObjectId[] | undefined) ?? []).map((id) => categoryName.get(id.toHexString()) ?? '—'),
      state: row.status !== 'ACTIVE' ? 'INACTIVE' : (row.validFrom as Date) > now ? 'UPCOMING' : (row.validTo as Date) < now ? 'EXPIRED' : 'RUNNING',
    }));
  }

  /** Cấu hình chiết khấu theo Giải thuật 2: chiết khấu theo cấp, bậc doanh số lũy kế quý và trần chiết khấu. */
  @Get('pricing/policy')
  async pricingPolicy() {
    const [pricing, approval] = await Promise.all([
      this.db.collection<{ _id: string } & Document>('settings').findOne({ _id: 'pricing' }),
      this.db.collection<{ _id: string } & Document>('settings').findOne({ _id: 'approval' }),
    ]);
    const quarter = salesTierWindow(pricing?.salesTierPeriod);
    const tiers = ((pricing?.salesTiers as Array<{ minimumRevenue: string; discountRate: string }> | undefined) ?? [])
      .slice()
      .sort((a, b) => Number(a.minimumRevenue) - Number(b.minimumRevenue));
    const progress = await this.db.collection('sales_orders').aggregate([
      { $match: { status: { $in: REVENUE_STATUSES }, ...SALE_ONLY_FILTER, orderDate: { $gte: quarter.start } } },
      { $group: { _id: '$customerId', revenue: { $sum: { $ifNull: ['$netTotal', { $subtract: ['$subtotal', '$discountTotal'] }] } } } },
      { $lookup: { from: 'partners', localField: '_id', foreignField: '_id', as: 'partner' } },
      { $unwind: '$partner' },
      { $match: { 'partner.customerTier': { $in: ['TIER_1', 'TIER_2'] } } },
      { $sort: { revenue: -1 } },
    ]).toArray();
    return {
      taxRate: String(pricing?.defaultTaxRate ?? '8'),
      pricesIncludeTax: Boolean(pricing?.pricesIncludeTax ?? true),
      discountCapRate: String(pricing?.discountCapRate ?? '15'),
      tierRates: pricing?.customerTierDiscounts ?? {},
      salesTiers: tiers,
      salesTierPeriod: quarter.label,
      /** Mã kỳ tính (ROLLING_90D / QUARTER) và phiên bản — cho màn hình sửa cấu hình. */
      salesTierPeriodCode: String(pricing?.salesTierPeriod ?? 'QUARTER'),
      version: Number(pricing?.version ?? 0),
      updatedAt: pricing?.updatedAt ?? null,
      updatedBy: pricing?.updatedBy ?? null,
      approval: {
        orderValueThreshold: String(approval?.orderValueThreshold ?? '100000000'),
        discountRateThreshold: String(approval?.discountRateThreshold ?? '15'),
        purchaseOrderThreshold: String(approval?.purchaseOrderThreshold ?? '50000000'),
      },
      dealerProgress: progress.map((row) => {
        const revenue = new Decimal(decimalString(row.revenue));
        const reached = [...tiers].reverse().find((tier) => revenue.gte(tier.minimumRevenue));
        const next = tiers.find((tier) => revenue.lt(tier.minimumRevenue));
        return {
          code: String(row.partner.code),
          name: String(row.partner.name),
          tier: String(row.partner.customerTier),
          revenue: revenue.toFixed(2),
          currentRate: reached?.discountRate ?? '0',
          nextThreshold: next?.minimumRevenue ?? null,
          nextRate: next?.discountRate ?? null,
        };
      }),
    };
  }

  /** Hồ sơ khách hàng kèm dư nợ hiện tại, doanh số lũy kế quý (D2 trong đồ án) và lần hẹn chăm sóc gần nhất (CRM). */
  @Get('dealers')
  async dealers(
    @Query('region') region?: string,
    @Query('tier') tier?: string,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('stage') stage?: string,
    @Query('grade') grade?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const paging = pageRequest(page, pageSize);
    // Khoảng ngày (LIST-DATE-01) = kỳ tính cột doanh số; bỏ trống = kỳ bậc doanh số đang cấu hình (quý).
    const revenueWindow = dateBounds(from, to);
    const filter: Document = { kind: { $in: ['CUSTOMER', 'BOTH'] } };
    if (region) filter.regionCode = region;
    if (tier) filter.customerTier = tier;
    if (stage === 'PROSPECT') filter.stage = 'PROSPECT';
    else if (stage === 'CUSTOMER') filter.stage = { $ne: 'PROSPECT' };
    if (grade) filter.grade = grade;
    if (search) {
      const pattern = new RegExp(escapeRegex(search), 'i');
      filter.$or = [{ code: pattern }, { name: pattern }, { province: pattern }];
    }
    const pricing = await this.db.collection<{ _id: string } & Document>('settings').findOne({ _id: 'pricing' });
    const quarter = salesTierWindow(pricing?.salesTierPeriod);
    const cursor = this.db.collection('partners').find(filter).sort({ customerTier: 1, code: 1 });
    const [partners, total] = await Promise.all([
      paging ? cursor.skip(paging.skip).limit(paging.pageSize).toArray() : cursor.toArray(),
      paging ? this.db.collection('partners').countDocuments(filter) : Promise.resolve(0),
    ]);
    const ids = partners.map((partner) => partner._id as ObjectId);
    const [exposures, revenues, regions, followUps] = await Promise.all([
      this.db.collection('receivables').aggregate([
        { $match: { status: { $in: OPEN_RECEIVABLE_STATUSES }, partnerId: { $in: ids } } },
        {
          $group: {
            _id: '$partnerId',
            outstanding: { $sum: { $subtract: ['$amount', '$paidAmount'] } },
            overdue: { $sum: { $cond: [{ $lt: ['$dueDate', new Date()] }, { $subtract: ['$amount', '$paidAmount'] }, 0] } },
          },
        },
      ]).toArray(),
      this.db.collection('sales_orders').aggregate([
        { $match: { status: { $in: REVENUE_STATUSES }, ...SALE_ONLY_FILTER, orderDate: revenueWindow ?? { $gte: quarter.start }, customerId: { $in: ids } } },
        { $group: { _id: '$customerId', revenue: { $sum: { $ifNull: ['$netTotal', { $subtract: ['$subtotal', '$discountTotal'] }] } } } },
      ]).toArray(),
      this.db.collection('regions').find({}).toArray(),
      this.db.collection('partner_activities').aggregate([
        { $match: { partnerId: { $in: ids }, done: false, followUpOn: { $exists: true } } },
        { $sort: { followUpOn: 1 } },
        { $group: { _id: '$partnerId', followUpOn: { $first: '$followUpOn' }, followUpNote: { $first: '$followUpNote' } } },
      ]).toArray(),
    ]);
    const followUpById = new Map(followUps.map((row) => [(row._id as ObjectId).toHexString(), { on: String(row.followUpOn), note: row.followUpNote as string | undefined }]));
    const exposureById = new Map(exposures.map((row) => [(row._id as ObjectId).toHexString(), row]));
    const revenueById = new Map(revenues.map((row) => [(row._id as ObjectId).toHexString(), decimalString(row.revenue)]));
    const regionName = new Map(regions.map((row) => [String(row.code), String(row.name)]));
    const rows = partners.map((partner) => {
        const id = (partner._id as ObjectId).toHexString();
        const exposure = exposureById.get(id);
        return {
          ...serializeDocument(partner),
          stage: partner.stage ?? 'CUSTOMER',
          nextFollowUp: followUpById.get(id) ?? null,
          regionName: partner.regionCode ? regionName.get(String(partner.regionCode)) : undefined,
          outstanding: new Decimal(decimalString(exposure?.outstanding ?? '0')).toFixed(2),
          overdue: new Decimal(decimalString(exposure?.overdue ?? '0')).toFixed(2),
          periodRevenue: new Decimal(revenueById.get(id) ?? '0').toFixed(2),
        };
      });
    const periodLabel = revenueWindow ? `${from ? from.split('-').reverse().join('/') : '…'} – ${to ? to.split('-').reverse().join('/') : '…'}` : quarter.label;
    return paging ? { periodLabel, ...pageOf(rows, total, paging) } : { periodLabel, rows };
  }

  @Roles('ADMIN', 'DIRECTOR', 'AUDITOR')
  @Get('users')
  async users() {
    const [users, warehouses] = await Promise.all([
      this.db.collection('users').find({}, {
        projection: { email: 1, displayName: 1, roles: 1, warehouseScopes: 1, status: 1, mfaEnabled: 1, lastLoginAt: 1, title: 1, department: 1 },
      }).sort({ displayName: 1 }).toArray(),
      this.db.collection('warehouses').find({}).toArray(),
    ]);
    const warehouseName = new Map(warehouses.map((row) => [(row._id as ObjectId).toHexString(), String(row.name)]));
    return users.map((user) => ({
      ...serializeDocument(user),
      warehouseNames: ((user.warehouseScopes as string[] | undefined) ?? []).map((id) => warehouseName.get(id) ?? id),
    }));
  }
}
