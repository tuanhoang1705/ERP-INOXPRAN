import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { CreatePartner, CreateProduct, CreateWarehouse } from '@inoxpran/contracts';
import type { Db, Document, Filter } from 'mongodb';
import Decimal from 'decimal.js';
import { Decimal128, ObjectId } from 'mongodb';
import { dateRangeFilter } from '../../common/date-range';
import { AuditService } from '../../common/audit.service';
import { decimal, decimalString, serializeDocument, toObjectId } from '../../common/domain';
import type { AuthenticatedRequest } from '../../common/request-context';
import { MONGO_DATABASE } from '../../common/tokens';
import { MasterDataService, normalizePartnerLists } from './master-data.service';
import { OPEN_RECEIVABLE_STATUSES } from '../receivables/overdue-review';
import { SALE_ONLY_FILTER } from '@inoxpran/contracts';
import { REVENUE_STATUSES } from '../sales/pricing.service';
import { canCreatePartnerKind } from './partner-access';
import { pageOf, type PageRequest } from '../../common/paging';
import { enforceTerritory, normalizeProvinces } from '../../common/territories';

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function actor(request: AuthenticatedRequest) {
  return {
    actorId: request.user.sub,
    actorEmail: request.user.email,
    correlationId: request.correlationId,
  };
}

@Injectable()
export class CatalogService {
  constructor(
    @Inject(MONGO_DATABASE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly master: MasterDataService,
  ) {}

  async listProducts(
    filters: { search?: string | undefined; status?: string | undefined; categoryId?: string | undefined; availability?: string | undefined; from?: string | undefined; to?: string | undefined },
    paging: PageRequest | null = null,
  ) {
    // Lọc theo ngày tạo mã (LIST-DATE-01).
    const filter: Filter<Record<string, unknown>> = dateRangeFilter('createdAt', filters.from, filters.to);
    if (filters.status) filter.status = filters.status;
    if (filters.categoryId) filter.categoryId = toObjectId(filters.categoryId, 'categoryId');
    if (filters.availability) filter.availability = filters.availability;
    if (filters.search) {
      const pattern = new RegExp(escapeRegex(filters.search), 'i');
      filter.$or = [{ sku: pattern }, { name: pattern }, { model: pattern }];
    }
    const cursor = this.db.collection('products').find(filter).sort({ sku: 1 });
    const documents = paging ? await cursor.skip(paging.skip).limit(paging.pageSize).toArray() : await cursor.limit(500).toArray();
    const [categories, balances] = await Promise.all([
      this.db.collection('product_categories').find({}).toArray(),
      // Chỉ cộng tồn của các mã đang hiển thị.
      this.db.collection('inventory_balances').aggregate([
        { $match: { productId: { $in: documents.map((document) => document._id) } } },
        { $group: { _id: '$productId', onHand: { $sum: '$onHand' }, reserved: { $sum: '$reserved' } } },
      ]).toArray(),
    ]);
    const categoryById = new Map(categories.map((row) => [row._id.toHexString(), row]));
    const stockById = new Map(balances.map((row) => [(row._id as ObjectId).toHexString(), row]));
    const rows = documents.map((document) => {
      const category = document.categoryId ? categoryById.get((document.categoryId as ObjectId).toHexString()) : undefined;
      const stock = stockById.get(document._id.toHexString());
      const onHand = Number(stock?.onHand?.toString() ?? 0);
      const reserved = Number(stock?.reserved?.toString() ?? 0);
      return {
        ...serializeDocument(document),
        categoryCode: category?.code,
        categoryName: category?.name,
        onHand: String(onHand),
        available: String(onHand - reserved),
      };
    });
    if (!paging) return rows;
    const [total, all, priceReview] = await Promise.all([
      this.db.collection('products').countDocuments(filter),
      this.db.collection('products').countDocuments({}),
      this.db.collection('products').countDocuments({ priceNeedsReview: true }),
    ]);
    return pageOf(rows, total, paging, { all, priceReview });
  }

  async createProduct(input: CreateProduct, request: AuthenticatedRequest) {
    const now = new Date();
    if (input.categoryId && !(await this.db.collection('product_categories').findOne({ _id: toObjectId(input.categoryId, 'categoryId') }))) {
      throw new BadRequestException({ code: 'CATEGORY_NOT_FOUND', message: 'Không tìm thấy nhóm hàng' });
    }
    const productId = new ObjectId();
    const document = {
      _id: productId,
      ...input,
      ...(await this.master.productRefs({ defaultSupplierId: input.defaultSupplierId })),
      ...(input.categoryId ? { categoryId: toObjectId(input.categoryId, 'categoryId') } : {}),
      listPrice: decimal(input.listPrice),
      ...(input.standardCost !== undefined ? { standardCost: decimal(input.standardCost) } : {}),
      minimumStock: decimal(input.minimumStock),
      unitConversions: input.unitConversions.map((item) => ({ ...item, factorToBase: decimal(item.factorToBase) })),
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    try {
      await this.db.collection('products').insertOne(document);
    } catch (error) {
      if ((error as { code?: number }).code === 11000) {
        throw new ConflictException({ code: 'SKU_EXISTS', message: `SKU ${input.sku} đã tồn tại` });
      }
      throw error;
    }
    await this.audit.record({
      ...actor(request),
      action: 'PRODUCT_CREATED',
      entityType: 'Product',
      entityId: document._id.toHexString(),
      after: serializeDocument(document),
    });
    return serializeDocument(document);
  }

  /** Hồ sơ một sản phẩm cho trang chi tiết (cửa sổ chứng từ): kèm nhóm hàng và tồn tổng. */
  async getProduct(id: string) {
    const product = await this.db.collection('products').findOne({ _id: toObjectId(id) });
    if (!product) throw new NotFoundException({ code: 'PRODUCT_NOT_FOUND', message: 'Không tìm thấy sản phẩm' });
    const [category, stock] = await Promise.all([
      product.categoryId ? this.db.collection('product_categories').findOne({ _id: product.categoryId as ObjectId }) : null,
      this.db.collection('inventory_balances').aggregate([
        { $match: { productId: product._id } },
        { $group: { _id: null, onHand: { $sum: '$onHand' }, reserved: { $sum: '$reserved' } } },
      ]).toArray(),
    ]);
    const onHand = new Decimal(decimalString(stock[0]?.onHand ?? '0'));
    const reserved = new Decimal(decimalString(stock[0]?.reserved ?? '0'));
    return {
      ...serializeDocument(product),
      categoryCode: category?.code,
      categoryName: category?.name,
      onHand: onHand.toString(),
      available: onHand.sub(reserved).toString(),
    };
  }

  /**
   * Tab Tồn kho / Mua – bán của trang sản phẩm: tồn theo kho – vị trí, lần mua / bán gần nhất,
   * tổng số lượng (đơn vị cơ bản) và giá trị 12 tháng gần đây.
   */
  async productOverview(id: string) {
    const productId = toObjectId(id);
    if (!(await this.db.collection('products').findOne({ _id: productId }, { projection: { _id: 1 } }))) {
      throw new NotFoundException({ code: 'PRODUCT_NOT_FOUND', message: 'Không tìm thấy sản phẩm' });
    }
    const since = new Date(Date.now() - 365 * 86_400_000);
    const [balances, warehouses, lastPurchases, purchaseTotals, lastSales, salesTotals] = await Promise.all([
      this.db.collection('inventory_balances').find({ productId }).toArray(),
      this.db.collection('warehouses').find({}, { projection: { code: 1, name: 1 } }).toArray(),
      this.db.collection('purchase_orders').aggregate([
        { $match: { 'lines.productId': productId, status: { $ne: 'CANCELLED' } } },
        { $sort: { createdAt: -1 } },
        { $limit: 5 },
        { $unwind: '$lines' },
        { $match: { 'lines.productId': productId } },
        { $project: { code: 1, supplierName: 1, status: 1, createdAt: 1, currency: 1, line: '$lines' } },
      ]).toArray(),
      this.db.collection('purchase_orders').aggregate([
        { $match: { 'lines.productId': productId, status: { $ne: 'CANCELLED' }, createdAt: { $gte: since } } },
        { $unwind: '$lines' },
        { $match: { 'lines.productId': productId } },
        { $group: { _id: null, quantity: { $sum: '$lines.baseQuantity' }, amount: { $sum: '$lines.lineTotal' }, orders: { $sum: 1 } } },
      ]).toArray(),
      this.db.collection('sales_orders').aggregate([
        { $match: { 'lines.productId': productId, status: { $in: REVENUE_STATUSES }, ...SALE_ONLY_FILTER } },
        { $sort: { orderDate: -1 } },
        { $limit: 5 },
        { $unwind: '$lines' },
        { $match: { 'lines.productId': productId } },
        { $project: { code: 1, customerName: 1, status: 1, orderDate: 1, line: '$lines' } },
      ]).toArray(),
      this.db.collection('sales_orders').aggregate([
        { $match: { 'lines.productId': productId, status: { $in: REVENUE_STATUSES }, ...SALE_ONLY_FILTER, deliveredAt: { $gte: since } } },
        { $unwind: '$lines' },
        { $match: { 'lines.productId': productId } },
        { $group: { _id: null, quantity: { $sum: '$lines.baseQuantity' }, amount: { $sum: '$lines.netAmount' }, orders: { $addToSet: '$_id' } } },
      ]).toArray(),
    ]);
    const warehouseById = new Map(warehouses.map((row) => [row._id.toHexString(), row]));
    const total = (rows: Document[]) => ({
      quantity: decimalString(rows[0]?.quantity ?? '0'),
      amount: new Decimal(decimalString(rows[0]?.amount ?? '0')).toFixed(2),
      orders: Array.isArray(rows[0]?.orders) ? rows[0].orders.length : Number(rows[0]?.orders ?? 0),
    });
    return {
      stock: balances
        .map((row) => {
          const warehouse = warehouseById.get((row.warehouseId as ObjectId).toHexString());
          const onHand = new Decimal(decimalString(row.onHand));
          const reserved = new Decimal(decimalString(row.reserved ?? '0'));
          return {
            warehouseId: (row.warehouseId as ObjectId).toHexString(),
            warehouseCode: warehouse?.code,
            warehouseName: warehouse?.name,
            locationCode: (row.locationCode as string | null | undefined) ?? null,
            onHand: onHand.toString(),
            reserved: reserved.toString(),
            available: onHand.sub(reserved).toString(),
          };
        })
        .filter((row) => row.onHand !== '0' || row.reserved !== '0')
        .sort((a, b) => String(a.warehouseCode).localeCompare(String(b.warehouseCode)) || String(a.locationCode ?? '').localeCompare(String(b.locationCode ?? ''))),
      purchases: {
        recent: lastPurchases.map((row) => ({
          id: (row._id as ObjectId).toHexString(),
          code: row.code,
          supplierName: row.supplierName,
          status: row.status,
          date: (row.createdAt as Date).toISOString(),
          currency: row.currency ?? 'VND',
          unit: row.line.unit,
          quantity: decimalString(row.line.quantity),
          unitCost: decimalString(row.line.unitCost),
        })),
        last12Months: total(purchaseTotals),
      },
      sales: {
        recent: lastSales.map((row) => ({
          id: (row._id as ObjectId).toHexString(),
          code: row.code,
          customerName: row.customerName,
          status: row.status,
          date: (row.orderDate as Date).toISOString(),
          unit: row.line.unit,
          quantity: decimalString(row.line.quantity),
          unitPrice: decimalString(row.line.unitPrice),
        })),
        last12Months: total(salesTotals),
      },
    };
  }

  async listPartners(kind?: string, search?: string, paging: PageRequest | null = null, stage?: string, from?: string, to?: string) {
    const filter: Filter<Record<string, unknown>> = dateRangeFilter('createdAt', from, to);
    if (kind) filter.kind = { $in: [kind, 'BOTH'] };
    // stage=CUSTOMER: khách chính thức (gồm dữ liệu cũ chưa có stage) — ô chọn khách trên phiếu bán hàng.
    if (stage === 'CUSTOMER') filter.stage = { $ne: 'PROSPECT' };
    else if (stage === 'PROSPECT') filter.stage = 'PROSPECT';
    if (search) {
      const pattern = new RegExp(escapeRegex(search), 'i');
      filter.$or = [{ code: pattern }, { name: pattern }, { taxCode: pattern }];
    }
    const cursor = this.db.collection('partners').find(filter).sort({ name: 1, _id: 1 });
    if (!paging) return (await cursor.limit(250).toArray()).map(serializeDocument);
    const [documents, total] = await Promise.all([cursor.skip(paging.skip).limit(paging.pageSize).toArray(), this.db.collection('partners').countDocuments(filter)]);
    if (kind !== 'SUPPLIER') return pageOf(documents.map(serializeDocument), total, paging);
    // Nhà cung cấp: số đơn mua, tổng giá trị, ngày đơn gần nhất (chỉ cho các dòng đang hiển thị).
    const purchases = await this.db.collection('purchase_orders').aggregate([
      { $match: { supplierId: { $in: documents.map((document) => document._id) }, status: { $ne: 'CANCELLED' } } },
      { $group: { _id: '$supplierId', orderCount: { $sum: 1 }, purchaseTotal: { $sum: '$total' }, lastOrderAt: { $max: '$createdAt' } } },
    ]).toArray();
    const stats = new Map(purchases.map((row) => [String(row._id), row]));
    return pageOf(documents.map((document) => {
      const stat = stats.get(String(document._id));
      return {
        ...serializeDocument(document),
        orderCount: Number(stat?.orderCount ?? 0),
        purchaseTotal: decimalString(stat?.purchaseTotal ?? '0'),
        lastOrderAt: (stat?.lastOrderAt as Date | undefined)?.toISOString() ?? null,
      };
    }), total, paging);
  }

  async createPartner(input: CreatePartner, request: AuthenticatedRequest) {
    if (!canCreatePartnerKind(request.user.roles, input.kind, input.stage)) {
      throw new ForbiddenException({
        code: 'PARTNER_KIND_FORBIDDEN',
        message: request.user.roles.includes('SALES')
          ? 'Nhân viên kinh doanh chỉ thêm được khách "cơ hội"; quản lý chuyển thành khách chính thức'
          : 'Kế toán chỉ được thêm khách hàng; nhà cung cấp do phòng mua hàng hoặc quản lý danh mục thêm',
      });
    }
    const now = new Date();
    const { stage, territoryExceptionReason, ...rest } = normalizePartnerLists(input);
    const customer = input.kind !== 'SUPPLIER';
    const refs: Document = await this.master.partnerRefs(input);
    const provinces = customer ? normalizeProvinces(input) : {};
    // Phân vùng NVKD (PV-01): vùng đã giao thì NVKD tự điền / phải khớp người phụ trách (ngoại lệ: Admin ghi lý do).
    const territory = customer
      ? await enforceTerritory(this.db, { provinceOldCode: provinces.provinceOldCode, territoryChannel: input.territoryChannel, salesRepId: refs.salesRepId }, request.user, territoryExceptionReason)
      : { set: {} as Document };
    const document = {
      _id: new ObjectId(),
      ...rest,
      // Nhà cung cấp không có giai đoạn chăm sóc; khách cơ hội chưa có cấp giá.
      ...(input.kind === 'SUPPLIER' ? {} : { stage }),
      ...refs,
      ...provinces,
      ...territory.set,
      // Khách do NVKD tạo mà chưa chọn người phụ trách (vùng chưa giao ai): gán NVKD gắn với tài khoản đang đăng nhập.
      ...(input.kind === 'CUSTOMER' && !input.salesRepId && !territory.set.salesRepId ? ((await this.master.employeeOfUser(request.user.sub)) ?? {}) : {}),
      creditLimit: decimal(input.creditLimit),
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    try {
      await this.db.collection('partners').insertOne(document);
    } catch (error) {
      if ((error as { code?: number }).code === 11000) {
        throw new ConflictException({ code: 'PARTNER_CODE_EXISTS', message: `Mã ${input.code} đã tồn tại` });
      }
      throw error;
    }
    await this.audit.record({
      ...actor(request),
      action: 'PARTNER_CREATED',
      entityType: 'Partner',
      entityId: document._id.toHexString(),
      after: serializeDocument(document),
    });
    return serializeDocument(document);
  }

  async createWarehouse(input: CreateWarehouse, request: AuthenticatedRequest) {
    const now = new Date();
    const document = { _id: new ObjectId(), ...input, version: 1, createdAt: now, updatedAt: now };
    try {
      await this.db.collection('warehouses').insertOne(document);
    } catch (error) {
      if ((error as { code?: number }).code === 11000) {
        throw new ConflictException({ code: 'WAREHOUSE_CODE_EXISTS', message: `Mã kho ${input.code} đã tồn tại` });
      }
      throw error;
    }
    await this.audit.record({
      ...actor(request),
      action: 'WAREHOUSE_CREATED',
      entityType: 'Warehouse',
      entityId: document._id.toHexString(),
      after: serializeDocument(document),
    });
    await this.master.grantWarehouse(request.user.sub, document._id);
    return serializeDocument(document);
  }

  /** Hồ sơ đối tác cho trang chi tiết: khách hàng kèm dư nợ / doanh số / hẹn chăm sóc; nhà cung cấp kèm tổng mua. */
  async getPartner(id: string) {
    const partner = await this.db.collection('partners').findOne({ _id: toObjectId(id) });
    if (!partner) throw new NotFoundException({ code: 'PARTNER_NOT_FOUND', message: 'Không tìm thấy đối tác' });
    const partnerId = partner._id as ObjectId;
    const yearStart = new Date(Date.UTC(new Date().getUTCFullYear(), 0, 1) - 7 * 3_600_000);
    const [exposure, revenue, lastOrder, purchases, nextFollowUp, region] = await Promise.all([
      this.db.collection('receivables').aggregate([
        { $match: { partnerId, status: { $in: OPEN_RECEIVABLE_STATUSES } } },
        {
          $group: {
            _id: null,
            outstanding: { $sum: { $subtract: ['$amount', '$paidAmount'] } },
            overdue: { $sum: { $cond: [{ $lt: ['$dueDate', new Date()] }, { $subtract: ['$amount', '$paidAmount'] }, 0] } },
          },
        },
      ]).toArray(),
      this.db.collection('sales_orders').aggregate([
        { $match: { customerId: partnerId, status: { $in: REVENUE_STATUSES }, ...SALE_ONLY_FILTER } },
        {
          $group: {
            _id: null,
            total: { $sum: { $ifNull: ['$netTotal', { $subtract: ['$subtotal', '$discountTotal'] }] } },
            yearToDate: { $sum: { $cond: [{ $gte: ['$deliveredAt', yearStart] }, { $ifNull: ['$netTotal', { $subtract: ['$subtotal', '$discountTotal'] }] }, 0] } },
            orders: { $sum: 1 },
          },
        },
      ]).toArray(),
      // Phiếu đã hủy không tính là đơn gần nhất (DOC-HIDE-01).
      this.db.collection('sales_orders').findOne({ customerId: partnerId, status: { $ne: 'CANCELLED' } }, { sort: { orderDate: -1 }, projection: { code: 1, orderDate: 1 } }),
      this.db.collection('purchase_orders').aggregate([
        { $match: { supplierId: partnerId, status: { $ne: 'CANCELLED' } } },
        { $group: { _id: null, orderCount: { $sum: 1 }, purchaseTotal: { $sum: '$total' }, lastOrderAt: { $max: '$createdAt' } } },
      ]).toArray(),
      this.db.collection('partner_activities').findOne({ partnerId, done: false, followUpOn: { $exists: true } }, { sort: { followUpOn: 1 }, projection: { followUpOn: 1, followUpNote: 1 } }),
      partner.regionCode ? this.db.collection('regions').findOne({ code: partner.regionCode }, { projection: { name: 1 } }) : null,
    ]);
    const money = (value: unknown) => new Decimal(decimalString(value ?? '0')).toFixed(2);
    return {
      ...serializeDocument(partner),
      stage: partner.kind === 'SUPPLIER' ? undefined : (partner.stage ?? 'CUSTOMER'),
      regionName: region?.name,
      summary: {
        outstanding: money(exposure[0]?.outstanding),
        overdue: money(exposure[0]?.overdue),
        revenueTotal: money(revenue[0]?.total),
        revenueYearToDate: money(revenue[0]?.yearToDate),
        orderCount: Number(revenue[0]?.orders ?? 0),
        lastOrder: lastOrder ? { id: lastOrder._id.toHexString(), code: lastOrder.code, date: (lastOrder.orderDate as Date).toISOString() } : null,
        purchaseOrderCount: Number(purchases[0]?.orderCount ?? 0),
        purchaseTotal: money(purchases[0]?.purchaseTotal),
        lastPurchaseAt: (purchases[0]?.lastOrderAt as Date | undefined)?.toISOString() ?? null,
        nextFollowUp: nextFollowUp ? { on: nextFollowUp.followUpOn, note: nextFollowUp.followUpNote } : null,
      },
    };
  }

  async getProductDocument(id: string) {
    const product = await this.db.collection('products').findOne({ _id: toObjectId(id), status: 'ACTIVE' });
    if (!product) throw new NotFoundException({ code: 'PRODUCT_NOT_FOUND', message: 'Không tìm thấy sản phẩm đang hoạt động' });
    return product as typeof product & { listPrice: Decimal128 };
  }
}
