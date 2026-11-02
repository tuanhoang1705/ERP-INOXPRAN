import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { AttachmentMeta, CreateSalesOrder, CustomerConfirmation, DiscardSalesOrder, LoanClose, LoanPurpose, LoanReturn, NotificationTemplate, PermissionKey, SalesPriceSheet, SalesQuote, SalesQuoteRequest, SalesStepOwners, TextParams, UpdateSalesOrder, WarehouseIssue, WarehouseKeeper } from '@inoxpran/contracts';
import { CANCELLABLE_SALES_STATUSES, cancelledCode, hasKeeperRole, expandSalesOrderCode, nextSalesOrderSequence, salesIssueTemplate, salesOrderCodeProblem, salesOrderPeriodPrefix, salesOrderSequence, warehouseSlipNumber } from '@inoxpran/contracts';
import { isZeroPriceLine } from '@inoxpran/contracts';
import { defaultReturnDate, isLoanPurpose, isNonSale, isNonSalePurpose, loanInCategory, nonSaleOutCategory, orderParty, PURPOSE_LABEL_VI, purposeOf, SALES_SLIP_TYPES, slipTypeFilter, vnDate, type SalesSlipType } from '@inoxpran/contracts';
import Decimal from 'decimal.js';
import type { ClientSession, Db, Document } from 'mongodb';
import { Decimal128, ObjectId } from 'mongodb';
import { assertWarehouseAccess } from '../../common/access';
import { AuditService } from '../../common/audit.service';
import { dateRangeFilter } from '../../common/date-range';
import { decimal, decimalString, serializeDocument, toObjectId, vnDayStart, vnParts } from '../../common/domain';
import { EvidenceIntakeService } from '../../common/evidence-intake.service';
import { PriceOverridesService } from './price-overrides.service';
import { releaseHoldIfCleared } from '../receivables/overdue-review';
import { voidReturnCreditsOf } from '../receivables/return-credit';
import { PAY_NOW_ACTOR, postPayNowReceipt, voidPayNowReceipts } from '../receivables/pay-now';
import { nextReturnInCode } from '../inventory/return-codes';
import { pendingDeliveryOf } from '../receivables/pending-delivery';
import { loadSegmentRules, orderLinesForSegments, reallocatePartner } from '../receivables/segment-store';
import { orderSegments, rulesFor } from '../receivables/segments';
import { IdempotencyService } from '../../common/idempotency.service';
import { OutboxService } from '../../common/outbox.service';
import type { AuthenticatedRequest, RequestUser } from '../../common/request-context';
import { SequenceService } from '../../common/sequence.service';
import { MONGO_DATABASE } from '../../common/tokens';
import { pageOf, type PageRequest } from '../../common/paging';
import { territoryOwner } from '../../common/territories';
import { InventoryService } from '../inventory/inventory.service';
import { evaluateApproval } from './approval.engine';
import { can, holdsStep, permissionsOf, stepHolders } from '../../common/permissions';
import { canDeliverSalesOrder, isAssignedKeeper, salesOrderScope } from './keeper-scope';

const EVIDENCE_PURPOSE = 'CONFIRMATION_EVIDENCE';
/** Ảnh tải lên nhưng chưa gắn vào lần xác nhận nào: worker xóa cả file S3 và bản ghi sau 24 giờ. */
const PENDING_EVIDENCE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_PENDING_EVIDENCE = 20;
import { PricingService } from './pricing.service';

/** Trường chỉ phiếu bán có (khách, kênh, điều khoản, quyền sửa giá) — gỡ khi phiếu chuyển thành hàng mẫu / kiểm định. */
const SALE_ONLY_FIELDS = [
  'customerId', 'customerCode', 'customerName', 'customerTier', 'province', 'regionCode', 'buyer', 'channel', 'paymentTermDays', 'payNowMethod',
  'priceOverrideRequestId', 'priceOverrideApprovedByName', 'priceOverrideReason',
];

/** Thao tác thực hiện khi duyệt đề nghị sửa / hủy (SAL-CHG-01) — ghi kèm vào nhật ký. */
export interface SalesChangeVia { code: string; requestedBy: string; requestedByName: string }

/** Admin / quản trị gốc được đặt NVKD của phiếu khác NVKD phụ trách vùng của khách (PV-01). */
const canOverrideRep = (user: Pick<RequestUser, 'roles' | 'root'>) => Boolean(user.root) || user.roles.includes('ADMIN');

@Injectable()
export class SalesService {
  constructor(
    @Inject(MONGO_DATABASE) private readonly db: Db,
    private readonly pricing: PricingService,
    private readonly inventory: InventoryService,
    private readonly audit: AuditService,
    private readonly sequences: SequenceService,
    private readonly idempotency: IdempotencyService,
    private readonly outbox: OutboxService,
    private readonly evidence: EvidenceIntakeService,
    private readonly priceOverrides: PriceOverridesService,
  ) {}

  /** Có dòng (không phải hàng tặng) mang đơn giá sửa tay → cần quyền sửa giá đã duyệt cho phiếu này. */
  private hasPriceOverride(input: CreateSalesOrder): boolean {
    return input.lines.some((line) => Boolean(line.overrideUnitPrice) && !isZeroPriceLine(line));
  }

  private priceOverrideFields(grant: Document | null) {
    return grant
      ? { priceOverrideRequestId: (grant._id as ObjectId).toHexString(), priceOverrideApprovedByName: String(grant.decidedByName ?? ''), priceOverrideReason: String(grant.reason) }
      : {};
  }

  async list(
    user: RequestUser, status?: string, search?: string, channel?: string, customerId?: string, confirmation?: string, paging: PageRequest | null = null,
    more: { type?: string | undefined; loan?: string | undefined; from?: string | undefined; to?: string | undefined } = {},
  ) {
    const filter: Document = {};
    if (status) filter.status = status.includes(',') ? { $in: status.split(',').map((value) => value.trim()).filter(Boolean) } : status;
    // Danh sách mặc định không hiện phiếu đã hủy; quản trị gốc lọc "Đã hủy" hoặc tìm theo số / khách vẫn thấy.
    // Người khác không bao giờ thấy phiếu đã hủy (salesOrderScope — DOC-HIDE-01).
    else if (!search) filter.status = { $ne: 'CANCELLED' };
    if (confirmation) filter.confirmationStatus = confirmation.includes(',') ? { $in: confirmation.split(',').map((value) => value.trim()).filter(Boolean) } : confirmation;
    // Loại phiếu (SAL-TYPE-01); `channel` cũ = loại B2B / B2C.
    const type = more.type ?? channel;
    if (type) {
      if (!SALES_SLIP_TYPES.includes(type as SalesSlipType)) throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'Loại phiếu không hợp lệ', details: [{ path: ['type'] }] });
      Object.assign(filter, slipTypeFilter(type as SalesSlipType));
    }
    // Hàng mẫu / kiểm định còn ở ngoài (chưa về đủ, chưa chốt).
    if (more.loan === 'OUT') filter.loanStatus = { $in: ['OUT', 'PARTIAL'] };
    Object.assign(filter, dateRangeFilter('orderDate', more.from, more.to));
    if (customerId) filter.customerId = toObjectId(customerId, 'customerId');
    if (search) {
      const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.$or = [
        { code: { $regex: escaped, $options: 'i' } },
        { warehouseSlipNo: { $regex: escaped, $options: 'i' } },
        { customerName: { $regex: escaped, $options: 'i' } },
        { customerCode: { $regex: escaped, $options: 'i' } },
        { salesRepName: { $regex: escaped, $options: 'i' } },
        { destination: { $regex: escaped, $options: 'i' } },
      ];
    }
    const scope = salesOrderScope(user);
    const query = Object.keys(scope).length ? { $and: [filter, scope] } : filter;
    const cursor = this.db.collection('sales_orders').find(query).sort({ orderDate: -1, createdAt: -1, _id: -1 });
    if (!paging) return (await cursor.limit(250).toArray()).map(serializeDocument);
    const [rows, total, sum] = await Promise.all([
      cursor.skip(paging.skip).limit(paging.pageSize).toArray(),
      this.db.collection('sales_orders').countDocuments(query),
      // Tổng giá trị không cộng phiếu đã hủy (trừ khi đang lọc riêng phiếu đã hủy).
      this.db.collection('sales_orders').aggregate([
        { $match: status === 'CANCELLED' ? query : { $and: [query, { status: { $ne: 'CANCELLED' } }] } },
        { $group: { _id: null, value: { $sum: '$grandTotal' } } },
      ]).toArray(),
    ]);
    return pageOf(rows.map(serializeDocument), total, paging, { totalValue: decimalString(sum[0]?.value ?? '0') });
  }

  /** Thủ kho chỉ mở được phiếu đã chọn mình (phiếu khác trả về "không tìm thấy" để không lộ thông tin). */
  async get(id: string, user: RequestUser) {
    const row = await this.db.collection('sales_orders').findOne({ _id: toObjectId(id), ...salesOrderScope(user) });
    if (!row) throw new NotFoundException({ code: 'SALES_ORDER_NOT_FOUND', message: 'Không tìm thấy đơn bán' });
    if (!isLoanPurpose(row.purpose) || !row.shippedAt) {
      // Đơn thanh toán ngay đã giao: phiếu thu tự động còn hiệu lực (AR-PAYNOW-01) — kế toán bỏ ghi thu được nếu khách chưa trả.
      const payNow = row.paymentTermDays === 0 && row.status === 'DELIVERED'
        ? await this.db.collection('payments').findOne({ salesOrderId: row._id, autoPayNow: true, status: 'POSTED' })
        : null;
      return {
        ...serializeDocument(row),
        ...(payNow ? { payNowReceipt: { id: (payNow._id as ObjectId).toHexString(), code: String(payNow.code), amount: decimalString(payNow.amount), method: String(payNow.method), receivedAt: (payNow.receivedAt as Date).toISOString() } } : {}),
      };
    }
    // Phiếu hàng mẫu / kiểm định đã xuất: số đã xuất / đã về / còn ở ngoài theo mã (đơn vị cơ bản) và các lần nhập lại.
    const returns = await this.db.collection('stock_returns').find({ kind: 'SAMPLE', salesOrderCode: row.code, status: { $ne: 'VOIDED' } }).sort({ createdAt: 1 }).toArray();
    const shipped = this.quantitiesOf(row.lines as Array<{ productId: unknown; baseQuantity: unknown }>);
    const returned = this.quantitiesOf(returns.flatMap((item) => (item.lines as Array<{ productId: unknown; quantity: unknown }>).map((line) => ({ productId: line.productId, baseQuantity: line.quantity }))));
    const products = await this.db.collection('products').find({ _id: { $in: [...shipped.keys()].map((key) => new ObjectId(key)) } }, { projection: { baseUnit: 1 } }).toArray();
    const baseUnit = new Map(products.map((product) => [(product._id as ObjectId).toHexString(), String(product.baseUnit ?? '')]));
    const loanLines = [...shipped].map(([productId, quantity]) => {
      const line = (row.lines as Array<{ productId: unknown; sku: string; productName: string }>).find((item) => String(item.productId) === productId);
      const back = returned.get(productId) ?? new Decimal(0);
      return {
        productId, sku: String(line?.sku ?? ''), productName: String(line?.productName ?? ''), unit: baseUnit.get(productId) ?? '',
        shipped: quantity.toString(), returned: back.toString(), remaining: Decimal.max(quantity.sub(back), 0).toString(),
      };
    });
    const loanReturns = returns.map((item) => ({
      code: String(item.code), createdAt: (item.createdAt as Date).toISOString(), createdByName: String(item.createdByName ?? ''), note: item.note ? String(item.note) : undefined,
      soldConversion: Boolean(item.soldConversion),
      lines: (item.lines as Array<{ sku: string; quantity: unknown; unit?: string }>).map((line) => ({ sku: String(line.sku), unit: String(line.unit ?? ''), quantity: decimalString(line.quantity) })),
    }));
    return { ...serializeDocument(row), loanLines, loanReturns };
  }

  private async loadCustomer(customerId: ObjectId, session?: ClientSession) {
    const customer = await this.db.collection('partners').findOne(
      { _id: customerId, kind: { $in: ['CUSTOMER', 'BOTH'] } },
      session ? { session } : {},
    );
    if (!customer || customer.status === 'INACTIVE') {
      throw new NotFoundException({ code: 'CUSTOMER_NOT_FOUND', message: 'Không tìm thấy khách hàng đang hoạt động' });
    }
    return customer;
  }

  private assertCustomerCanOrder(customer: Document) {
    if (customer.stage === 'PROSPECT') {
      throw new ConflictException({
        code: 'CUSTOMER_IS_PROSPECT',
        message: `${String(customer.name)} đang là khách "cơ hội" — cần chuyển thành khách chính thức (gán cấp giá) trước khi lập phiếu bán hàng`,
      });
    }
    if (customer.status === 'ON_HOLD') {
      throw new ConflictException({
        code: 'CUSTOMER_ON_HOLD',
        message: customer.holdReason === 'OVERDUE_60'
          ? `${String(customer.name)} đang tạm khóa đặt hàng do có công nợ quá hạn trên 60 ngày`
          : `${String(customer.name)} đang tạm khóa đặt hàng`,
      });
    }
  }

  /** Báo giá tức thời cho form đơn hàng: giá theo cấp, chiết khấu, tồn khả dụng và hạn mức còn lại. Không ghi dữ liệu. */
  async quote(input: SalesQuoteRequest): Promise<SalesQuote> {
    const customer = await this.loadCustomer(toObjectId(input.customerId, 'customerId'));
    const warehouseId = toObjectId(input.warehouseId, 'warehouseId');
    const lines = input.lines.filter((line) => Number(line.quantity) > 0);
    const priced = await this.pricing.priceLines(lines, customer, undefined, input.taxRate, salesIssueTemplate(input.templateCode).vatMode);
    const settings = priced.settings;
    const balances = await this.db.collection('inventory_balances').find({
      warehouseId,
      productId: { $in: priced.lines.map((line) => line.productId) },
    }).toArray();
    const availableByProduct = new Map(balances.map((row) => [
      (row.productId as ObjectId).toHexString(),
      new Decimal(decimalString(row.onHand)).minus(decimalString(row.reserved)),
    ]));
    const exposure = await this.exposure(customer._id as ObjectId);
    const creditLimit = decimalString(customer.creditLimit);
    return {
      lines: priced.lines.map((line) => {
        const available = availableByProduct.get(line.productId.toHexString()) ?? new Decimal(0);
        const minimum = new Decimal(line.minimumStock);
        const base = new Decimal(line.baseQuantity);
        const stockState: 'OK' | 'NEAR_MINIMUM' | 'INSUFFICIENT' = base.gt(available)
          ? 'INSUFFICIENT'
          : available.minus(base).lte(minimum) ? 'NEAR_MINIMUM' : 'OK';
        return {
          productId: line.productId.toHexString(),
          sku: line.sku,
          productName: line.productName,
          unit: line.unit,
          quantity: line.quantity,
          baseQuantity: line.baseQuantity,
          gift: line.gift,
          ...(line.zeroPriceKind ? { zeroPriceKind: line.zeroPriceKind } : {}),
          listUnitPrice: line.listUnitPrice,
          unitPrice: line.unitPrice,
          discountRate: line.discountRate,
          tierDiscountRate: line.tierDiscountRate,
          salesTierDiscountRate: line.salesTierDiscountRate,
          promotionDiscountRate: line.promotionDiscountRate,
          ...(line.promotionCode ? { promotionCode: line.promotionCode } : {}),
          netAmount: line.netAmount,
          ...(priced.vatMode === 'LINE' ? { vatRate: line.vatRate, taxAmount: line.taxAmount } : {}),
          available: available.toString(),
          minimumStock: line.minimumStock,
          stockState,
        };
      }),
      subtotal: priced.subtotal,
      discountTotal: priced.discountTotal,
      netTotal: priced.netTotal,
      taxTotal: priced.taxTotal,
      grandTotal: priced.grandTotal,
      taxRate: priced.vatRate,
      pricesIncludeTax: settings.pricesIncludeTax,
      discountCapRate: settings.discountCapRate,
      customer: {
        tier: priced.context.tier,
        status: String(customer.status),
        creditLimit,
        exposure,
        creditRemainingAfter: new Decimal(creditLimit).minus(exposure).minus(priced.grandTotal).toFixed(2),
        periodRevenue: priced.context.periodRevenue,
        periodLabel: priced.context.periodLabel,
        salesTierRate: priced.context.salesTierRate,
        paymentTermDays: Number(customer.paymentTermDays ?? 0),
      },
    };
  }

  /**
   * Bảng giá riêng của khách tại kho xuất: giá niêm yết theo cấp, chiết khấu đã áp trần, tồn khả dụng, dư nợ và ngưỡng duyệt
   * cho toàn bộ mã đang kinh doanh. Form tải một lần khi chọn khách rồi tự tính tiền tức thời bằng priceLine() dùng chung;
   * khi lưu, máy chủ tính lại bằng đúng hàm đó nên con số trên form và trên chứng từ luôn trùng nhau.
   */
  async priceSheet(customerId: string | undefined, warehouseId: string): Promise<SalesPriceSheet> {
    if (!customerId) return this.loanSheet(warehouseId);
    const customer = await this.loadCustomer(toObjectId(customerId, 'customerId'));
    const settings = await this.pricing.settings();
    const [context, balances, exposure, approval] = await Promise.all([
      this.pricing.customerContext(customer, settings),
      this.db.collection('inventory_balances').find({ warehouseId: toObjectId(warehouseId, 'warehouseId') }).toArray(),
      this.exposure(customer._id as ObjectId),
      this.db.collection<{ _id: string } & Document>('settings').findOne({ _id: 'approval' }),
    ]);
    const basis = await this.pricing.basis(customer, settings, context);
    const availableByProduct = new Map(balances.map((row) => [
      (row.productId as ObjectId).toHexString(),
      new Decimal(decimalString(row.onHand)).minus(decimalString(row.reserved)).toString(),
    ]));
    return {
      generatedAt: new Date().toISOString(),
      defaultVatRate: settings.taxRate,
      pricesIncludeTax: settings.pricesIncludeTax,
      discountCapRate: settings.discountCapRate,
      approvalThreshold: String(approval?.orderValueThreshold ?? '100000000'),
      customer: {
        id: (customer._id as ObjectId).toHexString(),
        tier: context.tier,
        status: String(customer.status),
        creditLimit: decimalString(customer.creditLimit),
        exposure,
        periodRevenue: context.periodRevenue,
        periodLabel: context.periodLabel,
        salesTierRate: context.salesTierRate,
        paymentTermDays: Number(customer.paymentTermDays ?? 0),
      },
      items: [...basis.entries()].map(([productId, item]) => ({
        productId,
        sku: String(item.product.sku),
        baseUnitPrice: item.baseUnitPrice,
        tierDiscountRate: item.tierDiscountRate,
        salesTierDiscountRate: item.salesTierDiscountRate,
        promotionDiscountRate: item.promotionDiscountRate,
        ...(item.promotionCode ? { promotionCode: item.promotionCode } : {}),
        discountRate: item.discountRate,
        available: availableByProduct.get(productId) ?? '0',
        minimumStock: decimalString(item.product.minimumStock),
        ...(item.pricingSource === 'CUSTOMER_PRICE' ? { pricingSource: item.pricingSource } : {}),
      })),
    };
  }

  /** Bảng của phiếu hàng mẫu / kiểm định (không khách): mọi mã đang kinh doanh, đơn giá 0, kèm tồn khả dụng tại kho xuất. */
  private async loanSheet(warehouseId: string): Promise<SalesPriceSheet> {
    const [settings, products, balances, approval] = await Promise.all([
      this.pricing.settings(),
      this.db.collection('products').find({ status: 'ACTIVE' }, { projection: { sku: 1, minimumStock: 1 } }).toArray(),
      this.db.collection('inventory_balances').find({ warehouseId: toObjectId(warehouseId, 'warehouseId') }).toArray(),
      this.db.collection<{ _id: string } & Document>('settings').findOne({ _id: 'approval' }),
    ]);
    const availableByProduct = new Map(balances.map((row) => [
      (row.productId as ObjectId).toHexString(),
      new Decimal(decimalString(row.onHand)).minus(decimalString(row.reserved)).toString(),
    ]));
    return {
      generatedAt: new Date().toISOString(),
      defaultVatRate: settings.taxRate,
      pricesIncludeTax: settings.pricesIncludeTax,
      discountCapRate: settings.discountCapRate,
      approvalThreshold: String(approval?.orderValueThreshold ?? '100000000'),
      items: products.map((product) => {
        const productId = (product._id as ObjectId).toHexString();
        return {
          productId, sku: String(product.sku), baseUnitPrice: '0',
          tierDiscountRate: '0', salesTierDiscountRate: '0', promotionDiscountRate: '0', discountRate: '0',
          available: availableByProduct.get(productId) ?? '0', minimumStock: decimalString(product.minimumStock),
        };
      }),
    };
  }

  /**
   * Thủ kho chọn được trên phiếu BH (ô "Thủ kho xuất hàng"): tài khoản đang hoạt động, có phạm vi kho xuất và được phân công
   * bước 4 — lập SWK & xuất kho (SAL-STEP-01; quản trị gốc / Admin không kiêm vai trò kho không hiện).
   */
  async warehouseKeepers(warehouseId: string): Promise<WarehouseKeeper[]> {
    const rows = (await this.db.collection('users')
      .find(
        { status: 'ACTIVE', root: { $ne: true }, warehouseScopes: toObjectId(warehouseId, 'warehouseId').toHexString() },
        { projection: { displayName: 1, title: 1, email: 1, roles: 1, root: 1, permissionGrants: 1, permissionRevokes: 1 } },
      )
      .sort({ displayName: 1 })
      .toArray()).filter((row) => holdsStep(row, 'sales.step.ship'));
    return rows.map((row) => ({
      id: (row._id as ObjectId).toHexString(),
      displayName: String(row.displayName),
      email: String(row.email),
      ...(row.title ? { title: String(row.title) } : {}),
    }));
  }

  /**
   * Thủ kho trên phiếu: tài khoản đang hoạt động, phụ trách kho xuất. `assignable` (lập / sửa nháp, phát hành): còn được phân công
   * bước 4 (SAL-STEP-01) — sửa phiếu đã xuất (root, đề nghị sửa) giữ thủ kho lịch sử dù người đó đã bị thu bước 4.
   */
  private async loadKeeper(keeperId: string, warehouseId: ObjectId, session: ClientSession, assignable = false) {
    const keeper = await this.db.collection('users').findOne(
      { _id: toObjectId(keeperId, 'warehouseKeeperId'), status: 'ACTIVE', root: { $ne: true } },
      { session, projection: { displayName: 1, warehouseScopes: 1, roles: 1, root: 1, permissionGrants: 1, permissionRevokes: 1 } },
    );
    if (!keeper) throw new BadRequestException({ code: 'KEEPER_NOT_FOUND', message: 'Không tìm thấy tài khoản thủ kho đang hoạt động' });
    if (!((keeper.warehouseScopes as string[] | undefined) ?? []).includes(warehouseId.toHexString())) {
      throw new BadRequestException({ code: 'KEEPER_WAREHOUSE_MISMATCH', message: `${String(keeper.displayName)} không phụ trách kho xuất đã chọn` });
    }
    if (assignable && !holdsStep(keeper, 'sales.step.ship')) {
      throw new BadRequestException({ code: 'KEEPER_NOT_ASSIGNABLE', message: `${String(keeper.displayName)} không còn được phân công bước 4 (lập SWK & xuất kho) — chọn thủ kho khác`, details: [{ path: ['warehouseKeeperId'] }] });
    }
    return keeper;
  }

  /** Dựng nội dung phiếu xuất kho bán hàng từ dữ liệu nhập: thông tin người mua, nhân viên, giá và tổng tiền. */
  private async composeOrder(input: CreateSalesOrder, session: ClientSession, options: { allowBlockedCustomer?: boolean; assignableKeeper?: boolean; allowRepOverride?: boolean } = {}) {
    // Phiếu xuất hàng mẫu / kiểm định / xuất tặng (SAL-TYPE-01): không khách hàng, người nhận = nhân viên phụ trách, đơn giá 0.
    const nonSale = isNonSalePurpose(input.purpose);
    const loan = isLoanPurpose(input.purpose);
    const warehouseId = toObjectId(input.warehouseId, 'warehouseId');
    const [customer, warehouse] = await Promise.all([
      nonSale ? null : this.loadCustomer(toObjectId(input.customerId ?? '', 'customerId'), session),
      this.db.collection('warehouses').findOne({ _id: warehouseId, active: true, purpose: { $ne: 'DEFECTIVE' } }, { session }),
    ]);
    if (customer && !options.allowBlockedCustomer) this.assertCustomerCanOrder(customer);
    if (!warehouse) throw new NotFoundException({ code: 'WAREHOUSE_NOT_FOUND', message: 'Không tìm thấy kho hoạt động' });
    const now = new Date();
    const orderDate = input.orderDate ? new Date(`${input.orderDate}T00:00:00+07:00`) : now;
    if (orderDate > now) {
      throw new BadRequestException({ code: 'ORDER_DATE_IN_FUTURE', message: 'Ngày chứng từ không được lớn hơn ngày hiện tại' });
    }
    if (input.requestedDeliveryDate && new Date(`${input.requestedDeliveryDate}T00:00:00+07:00`) < vnDayStart(orderDate)) {
      throw new BadRequestException({ code: 'DELIVERY_BEFORE_ORDER', message: 'Ngày giao dự kiến phải lớn hơn hoặc bằng ngày chứng từ' });
    }
    // PXK-001: một thuế suất cho cả phiếu (phiếu cũ, gọi API không ghi mẫu); PXK-002: thuế suất từng dòng (27/10/2026).
    const template = salesIssueTemplate(input.templateCode);
    if (!nonSale && !input.lines.some((line) => !isZeroPriceLine(line))) {
      throw new BadRequestException({ code: 'ONLY_GIFT_LINES', message: 'Phiếu cần ít nhất một dòng hàng bán (ngoài hàng tặng / đổi / bù)' });
    }
    const salesRepId = input.salesRepId ? toObjectId(input.salesRepId, 'salesRepId') : (customer?.salesRepId as ObjectId | undefined);
    const salesRep = salesRepId ? await this.db.collection('employees').findOne({ _id: salesRepId }, { session }) : null;
    if (input.salesRepId && !salesRep) {
      throw new NotFoundException({ code: 'SALES_REP_NOT_FOUND', message: 'Không tìm thấy nhân viên kinh doanh' });
    }
    // Phân vùng NVKD (PV-01): khách ở vùng đã giao thì NVKD của phiếu là NVKD của khách — Admin / quản trị gốc được đổi.
    if (customer && salesRep && customer.salesRepId && !(customer.salesRepId as ObjectId).equals(salesRep._id) && !options.allowRepOverride
      && await territoryOwner(this.db, customer.provinceOldCode as string | undefined, customer.territoryChannel as string | undefined, session)) {
      throw new BadRequestException({ code: 'TERRITORY_MISMATCH', message: `Khách ${String(customer.code)} do ${String(customer.salesRepName)} phụ trách theo phân vùng — NVKD của phiếu phải là ${String(customer.salesRepName)}`, details: [{ path: ['salesRepId'] }] });
    }
    if (nonSale && !salesRep) {
      throw new BadRequestException({ code: 'SALES_REP_REQUIRED', message: input.purpose === 'GIFT' ? 'Chọn nhân viên phụ trách' : 'Chọn nhân viên mượn hàng', details: [{ path: ['salesRepId'] }] });
    }
    if (!loan && input.expectedReturnDate) {
      throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'Chỉ phiếu hàng mẫu / kiểm định có ngày hẹn trả', details: [{ path: ['expectedReturnDate'] }] });
    }
    // Hàng mẫu / kiểm định: hẹn trả mặc định hôm nay + 15 ngày (giờ Việt Nam).
    const expectedReturnDate = loan ? input.expectedReturnDate || defaultReturnDate(vnDate(now)) : undefined;
    if (expectedReturnDate && new Date(`${expectedReturnDate}T00:00:00+07:00`) < vnDayStart(orderDate)) {
      throw new BadRequestException({ code: 'RETURN_BEFORE_ORDER', message: 'Ngày hẹn trả phải lớn hơn hoặc bằng ngày chứng từ', details: [{ path: ['expectedReturnDate'] }] });
    }
    const keeper = input.warehouseKeeperId ? await this.loadKeeper(input.warehouseKeeperId, warehouseId, session, options.assignableKeeper) : null;
    const priced = customer ? await this.pricing.priceLines(input.lines, customer, session, input.taxRate, template.vatMode) : await this.pricing.zeroLines(input.lines, session, input.taxRate, template.vatMode);
    const purpose = nonSale ? input.purpose : 'SALE';
    // Phần riêng của từng loại; khi đổi loại phiếu, các trường của loại kia bị gỡ ($unset).
    const partyFields = customer
      ? {
          customerId: customer._id as ObjectId,
          customerCode: customer.code,
          customerName: customer.name,
          customerTier: customer.customerTier,
          province: customer.province,
          regionCode: customer.regionCode,
          buyer: { code: customer.code, name: customer.name, address: customer.address, phone: customer.phone, taxCode: customer.taxCode },
          channel: input.channel,
          paymentTermDays: input.paymentTermDays ?? Number(customer.paymentTermDays ?? 0),
        }
      : {
          ...(input.destination ? { destination: input.destination } : {}),
          ...(expectedReturnDate ? { expectedReturnDate } : {}),
        };
    const loanKeys = ['destination', 'expectedReturnDate'];
    // Thanh toán ngay (AR-PAYNOW-01): hạn 0 ngày + người lập chọn hình thức thu → giao xong tự ghi phiếu thu. Không chọn (mặc định)
    // = chưa thu, ghi công nợ hạn = ngày giao — hạn 0 ngày là mặc định trên hồ sơ phần lớn khách, không có nghĩa là khách đã trả.
    const payNowFields = customer && input.payNowMethod && (input.paymentTermDays ?? Number(customer.paymentTermDays ?? 0)) === 0 ? { payNowMethod: input.payNowMethod } : {};
    const unsetKeys = customer ? [...loanKeys, ...('payNowMethod' in payNowFields ? [] : ['payNowMethod'])] : [...SALE_ONLY_FIELDS, ...loanKeys.filter((key) => !(key in partyFields))];
    const unset: Record<string, ''> = Object.fromEntries(unsetKeys.map((key) => [key, '']));
    const defaultDescription = customer
      ? `Bán hàng ${String(customer.name)}`
      : `${PURPOSE_LABEL_VI[purpose]} — ${String(salesRep?.name ?? '')}${input.destination ? ` (${purpose === 'GIFT' ? 'tặng' : 'gửi'} ${input.destination})` : ''}`;
    return {
      customer,
      orderDate,
      keeper,
      unset,
      fields: {
        purpose,
        ...partyFields,
        ...payNowFields,
        contactName: input.contactName,
        description: input.description || defaultDescription,
        deliveryLocation: input.deliveryLocation,
        warehouseId,
        ...(keeper ? { warehouseKeeperId: keeper._id as ObjectId, warehouseKeeperName: String(keeper.displayName) } : {}),
        ...(salesRep ? { salesRepId: salesRep._id, salesRepName: salesRep.name } : {}),
        orderDate,
        requestedDeliveryDate: input.requestedDeliveryDate,
        note: input.note,
        templateCode: template.code,
        taxRate: priced.vatRate,
        pricesIncludeTax: priced.settings.pricesIncludeTax,
        lineCount: input.lines.length,
        lines: priced.lines.map((line) => ({
          productId: line.productId,
          sku: line.sku,
          productName: line.productName,
          categoryId: line.categoryId,
          unit: line.unit,
          gift: line.gift,
          ...(line.zeroPriceKind ? { zeroPriceKind: line.zeroPriceKind } : {}),
          pricingSource: line.pricingSource,
          ...(line.promotionCode ? { promotionCode: line.promotionCode } : {}),
          ...(line.originalUnitPrice ? { originalUnitPrice: decimal(line.originalUnitPrice) } : {}),
          quantity: decimal(line.quantity),
          baseQuantity: decimal(line.baseQuantity),
          listUnitPrice: decimal(line.listUnitPrice),
          unitPrice: decimal(line.unitPrice),
          discountRate: decimal(line.discountRate),
          tierDiscountRate: decimal(line.tierDiscountRate),
          salesTierDiscountRate: decimal(line.salesTierDiscountRate),
          promotionDiscountRate: decimal(line.promotionDiscountRate),
          netAmount: decimal(line.netAmount),
          // PXK-002: thuế suất + tiền thuế của dòng; PXK-001 không lưu (thuế tính cho cả phiếu).
          ...(priced.vatMode === 'LINE' ? { vatRate: line.vatRate, taxAmount: decimal(line.taxAmount) } : {}),
          lineTotal: decimal(line.lineTotal),
          pricingSnapshot: Object.fromEntries(Object.entries(line.pricingSnapshot).map(([key, value]) => [key, decimal(value)])),
        })),
        subtotal: decimal(priced.subtotal),
        discountTotal: decimal(priced.discountTotal),
        netTotal: decimal(priced.netTotal),
        taxTotal: decimal(priced.taxTotal),
        grandTotal: decimal(priced.grandTotal),
      },
    };
  }

  private async notify(
    session: ClientSession,
    aggregateId: string,
    payload: { targetRoles?: string[]; targetUserIds?: string[]; level: string; title: string; message: string; href: string; template: NotificationTemplate; params: TextParams },
  ) {
    // Người nhận theo người được phân công bước (SAL-STEP-01) có thể rỗng — worker không gửi được thì bỏ qua.
    if (!payload.targetRoles?.length && !payload.targetUserIds?.length) return;
    await this.outbox.enqueue({ eventType: 'NOTIFICATION_REQUESTED', aggregateType: 'SalesOrder', aggregateId, payload: { category: 'SALES_ISSUE', ...payload } }, session);
  }

  /** Xem trước nội dung đề nghị sửa (SAL-CHG-01): tính lại phiếu theo nội dung mới, không ghi gì. */
  async previewEdit(changes: UpdateSalesOrder, session: ClientSession) {
    const { version: _version, codeMode: _codeMode, ...payload } = changes;
    const { fields } = await this.composeOrder(payload, session, { allowBlockedCustomer: true, allowRepOverride: true });
    return {
      customerName: orderParty(fields),
      grandTotal: decimalString(fields.grandTotal),
      lines: (fields.lines as Document[]).map((line) => ({
        sku: String(line.sku),
        productName: String(line.productName),
        unit: String(line.unit),
        quantity: decimalString(line.quantity),
        gift: Boolean(line.gift),
        ...(line.zeroPriceKind ? { zeroPriceKind: line.zeroPriceKind } : {}),
        unitPrice: decimalString(line.unitPrice),
        lineTotal: decimalString(line.lineTotal),
      })),
    };
  }

  /** Chỉ người được phân công bước 2 (phát hành) đặt / đổi số phiếu BH; người gửi đề nghị luôn nhận số tự sinh. */
  private assertCanNumber(request: AuthenticatedRequest) {
    if (!can(request.user, 'sales.step.issue')) {
      throw new ForbiddenException({ code: 'SALES_ORDER_CODE_FORBIDDEN', message: 'Chỉ người được phân công bước phát hành phiếu BH được tự nhập số phiếu' });
    }
  }

  /** Hai người lưu cùng một số tự nhập cùng lúc: chỉ mục duy nhất chặn người sau → báo trùng số thay vì lỗi chung. */
  private codeConflict(error: unknown, code: string): never {
    if ((error as { code?: number; keyPattern?: Record<string, unknown> } | null)?.code === 11000 && (error as { keyPattern?: Record<string, unknown> }).keyPattern?.code) {
      throw new ConflictException({ code: 'SALES_ORDER_CODE_EXISTS', message: `Số phiếu ${code} đã được dùng cho phiếu BH khác`, details: { code } });
    }
    throw error;
  }

  /** Số tự nhập sau khi ghép: chỉ gõ số hóa đơn ("104") → BH + năm + tháng của ngày chứng từ + 0104. */
  private manualCode(code: string, orderDate: Date): string {
    const expanded = expandSalesOrderCode(code, vnParts(orderDate));
    if (salesOrderCodeProblem(expanded)) {
      throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'Số phiếu không hợp lệ', details: [{ path: ['code'] }] });
    }
    return expanded;
  }

  /** Số phiếu kho SWK trùng số phiếu BH (SWK2026100104 ↔ BH2026100104); nếu (hiếm) đã có thì thêm hậu tố -2, -3… */
  private async warehouseSlipCode(orderCode: string, session: ClientSession): Promise<string> {
    const base = warehouseSlipNumber(orderCode);
    for (let attempt = 1; attempt <= 20; attempt += 1) {
      const candidate = attempt === 1 ? base : `${base}-${attempt}`;
      if (!(await this.db.collection('shipments').findOne({ code: candidate }, { session, projection: { _id: 1 } }))) return candidate;
    }
    throw new ConflictException({ code: 'SHIPMENT_CODE_EXISTS', message: `Không cấp được số phiếu kho cho ${orderCode}` });
  }

  /** Số phiếu tự nhập không được trùng phiếu BH khác (kể cả phiếu đã hủy). */
  private async assertCodeFree(code: string, session: ClientSession, request: AuthenticatedRequest, exceptId?: ObjectId): Promise<string> {
    const taken = await this.db.collection('sales_orders').findOne({ code, ...(exceptId ? { _id: { $ne: exceptId } } : {}) }, { session });
    // Phiếu đã hủy từ trước (còn giữ số gốc): nhả số ngay để dùng lại.
    if (taken?.status === 'CANCELLED' && !taken.originalCode) await this.releaseNumber(taken, request, session);
    else if (taken) throw new ConflictException({ code: 'SALES_ORDER_CODE_EXISTS', message: `Số phiếu ${code} đã được dùng cho phiếu BH khác`, details: { code } });
    return code;
  }

  /**
   * Phiếu giấy cũ đã nhập làm công nợ đầu kỳ của khách: lập lại phiếu BH cùng số cho chính khách đó sẽ ghi nợ hai lần
   * khi xuất kho → chặn (không phân biệt hoa thường, vì số chứng từ đầu kỳ lưu nguyên văn từ file Excel).
   */
  private async assertNotOpeningDocument(code: string, customerId: ObjectId, session: ClientSession) {
    const opening = await this.db.collection('receivables').findOne(
      { sourceType: 'OPENING_BALANCE', partnerId: customerId, openingDocumentNo: { $regex: `^${code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' } },
      { session, projection: { code: 1 } },
    );
    if (opening) {
      throw new ConflictException({
        code: 'SALES_ORDER_CODE_IN_OPENING_DEBT',
        message: `Số ${code} đã có trong công nợ đầu kỳ của khách này (${String(opening.code)}) — phiếu giấy đó đã được ghi nợ khi nhập dữ liệu ban đầu`,
        details: { code, receivableCode: opening.code },
      });
    }
  }

  /**
   * Số tự sinh BH + năm + tháng + 4 số (đánh lại mỗi tháng), **nối tiếp số lớn nhất đã có trong tháng** — kể cả số
   * kế toán tự nhập (vd. nhập tay 104 → phiếu tự sinh sau là 0105). Vẫn bỏ qua số đã bị dùng nếu có.
   */
  private async nextAutoCode(orderDate: Date, session: ClientSession, request: AuthenticatedRequest): Promise<string> {
    const prefix = salesOrderPeriodPrefix(vnParts(orderDate));
    const pattern = { $regex: `^${prefix}\\d{4}$` };
    // Số cuối đang dùng (phiếu hủy đã đổi sang đuôi -H nên tự bị loại; phiếu nháp xóa thì không còn).
    const [highest] = await this.db.collection('sales_orders').find({ code: pattern, status: { $ne: 'CANCELLED' } }, { session, projection: { code: 1 } }).sort({ code: -1 }).limit(1).toArray();
    // Số đầu tiên của tháng: bộ đếm, hoặc suy từ dữ liệu cũ (kể cả số gốc của phiếu đã hủy).
    const [lowest] = await this.db.collection('sales_orders')
      .find({ $or: [{ code: pattern }, { originalCode: pattern }] }, { session, projection: { code: 1, originalCode: 1 } })
      .sort({ code: 1 })
      .limit(50)
      .toArray()
      .then((rows) => [rows.map((row) => salesOrderSequence(String(row.originalCode ?? row.code), prefix)).filter((value): value is number => value !== null).sort((a, b) => a - b)[0]]);
    const tracked = await this.sequences.floor('BH', orderDate, session);
    const floor = [tracked, lowest ?? null].filter((value): value is number => typeof value === 'number').sort((a, b) => a - b)[0] ?? null;
    let sequence = nextSalesOrderSequence(highest ? salesOrderSequence(String(highest.code), prefix) : null, floor);
    for (let attempt = 0; attempt < 50; attempt += 1, sequence += 1) {
      const code = `${prefix}${String(sequence).padStart(4, '0')}`;
      const holder = await this.db.collection('sales_orders').findOne({ code }, { session });
      // Phiếu đã hủy từ trước khi có quy tắc nhả số vẫn giữ số gốc: nhả số ngay rồi dùng lại.
      const legacyCancelled = holder?.status === 'CANCELLED' && !holder.originalCode;
      if (legacyCancelled) await this.releaseNumber(holder, request, session);
      if (!holder || legacyCancelled) {
        await this.sequences.track('BH', orderDate, sequence, session);
        return code;
      }
    }
    throw new ConflictException({ code: 'SALES_ORDER_CODE_EXISTS', message: 'Không sinh được số phiếu BH mới, vui lòng thử lại' });
  }

  /** Số tự nhập đúng dạng BH + tháng + 4 số: ghi nhận làm số đầu tiên / số cuối của tháng. */
  private async trackManualCode(code: string, orderDate: Date, session: ClientSession) {
    const sequence = salesOrderSequence(code, salesOrderPeriodPrefix(vnParts(orderDate)));
    if (sequence !== null) await this.sequences.track('BH', orderDate, sequence, session);
  }

  /**
   * Phiếu hủy nhả số cho phiếu mới: BH2026100104 → BH2026100104-H1, SWK2026100104 → SWK2026100104-H1. Đổi luôn ký hiệu
   * tham chiếu của phiếu trên thẻ kho, công nợ, trả hàng, yêu cầu sửa giá (không đổi số lượng / tiền) để không lẫn với phiếu mới.
   */
  private async releaseNumber(order: Document, request: AuthenticatedRequest, session: ClientSession): Promise<Document> {
    const orderId = order._id as ObjectId;
    const oldCode = String(order.code);
    const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const taken = await this.db.collection('sales_orders').find({ code: { $regex: `^${escape(oldCode)}-H\\d+$` } }, { session, projection: { code: 1 } }).toArray();
    const newCode = cancelledCode(oldCode, new Set(taken.map((row) => String(row.code))));
    const suffix = newCode.slice(oldCode.length);
    const oldSlip = order.warehouseSlipNo ? String(order.warehouseSlipNo) : null;
    const newSlip = oldSlip ? `${oldSlip}${suffix}` : null;
    const updated = await this.db.collection('sales_orders').findOneAndUpdate(
      { _id: orderId },
      { $set: { code: newCode, originalCode: oldCode, ...(newSlip ? { warehouseSlipNo: newSlip, originalWarehouseSlipNo: oldSlip } : {}), updatedAt: new Date() } },
      { session, returnDocument: 'after' },
    );
    if (oldSlip && newSlip) {
      await this.db.collection('shipments').updateMany({ salesOrderId: orderId, code: oldSlip }, { $set: { code: newSlip, originalCode: oldSlip } }, { session });
      await this.db.collection('inventory_movements').updateMany({ referenceType: 'Shipment', referenceId: oldSlip }, { $set: { referenceId: newSlip } }, { session });
    }
    await this.db.collection('inventory_movements').updateMany({ salesOrderCode: oldCode }, { $set: { salesOrderCode: newCode } }, { session });
    await this.db.collection('receivables').updateMany({ salesOrderId: orderId }, { $set: { salesOrderCode: newCode } }, { session });
    await this.db.collection('stock_returns').updateMany({ kind: { $in: ['CUSTOMER', 'SAMPLE'] }, salesOrderCode: oldCode }, { $set: { salesOrderCode: newCode } }, { session });
    await this.db.collection('price_override_requests').updateMany({ salesOrderId: orderId }, { $set: { salesOrderCode: newCode } }, { session });
    await this.audit.record({
      actorId: request.user.sub, actorEmail: request.user.email, correlationId: request.correlationId,
      action: 'SALES_ORDER_NUMBER_RELEASED', entityType: 'SalesOrder', entityId: orderId.toHexString(),
      metadata: { from: oldCode, to: newCode, ...(oldSlip ? { slipFrom: oldSlip, slipTo: newSlip } : {}) },
    }, session);
    return updated as Document;
  }

  /**
   * Bước 1: lập phiếu xuất kho bán hàng (số BH). Kế toán lập trực tiếp; nhân viên kinh doanh có thể lập
   * "đề nghị" nháp để kế toán hoàn thiện và phát hành.
   */
  async create(input: CreateSalesOrder, request: AuthenticatedRequest, idempotencyKey: string | undefined) {
    return this.idempotency.execute(
      `sales-order-create:${request.user.sub}`,
      idempotencyKey,
      input,
      async (session) => {
        const grant = this.hasPriceOverride(input) ? await this.priceOverrides.assertUsable(input.priceOverrideRequestId, input.formSessionId, null, request, session) : null;
        const { fields, orderDate } = await this.composeOrder(input, session, { assignableKeeper: true, allowRepOverride: canOverrideRep(request.user) });
        const now = new Date();
        // Người lập không được phân công bước 2 (phát hành) → phiếu là đề nghị xuất bán chờ người phát hành (SAL-STEP-01).
        const requestedBySales = !can(request.user, 'sales.step.issue');
        const manualCode = input.code ? this.manualCode(input.code, orderDate) : undefined;
        if (manualCode) {
          this.assertCanNumber(request);
          if (input.customerId) await this.assertNotOpeningDocument(manualCode, toObjectId(input.customerId, 'customerId'), session);
        }
        const code = manualCode ? await this.assertCodeFree(manualCode, session, request) : await this.nextAutoCode(orderDate, session, request);
        if (manualCode) await this.trackManualCode(manualCode, orderDate, session);
        const document = {
          _id: new ObjectId(),
          code,
          codeMode: manualCode ? 'MANUAL' : 'AUTO',
          ...fields,
          ...this.priceOverrideFields(grant),
          status: 'DRAFT',
          approvalStatus: 'NOT_REQUIRED',
          ...(requestedBySales ? { requestedBy: toObjectId(request.user.sub), requestedByName: request.user.displayName } : {}),
          createdBy: toObjectId(request.user.sub),
          createdByName: request.user.displayName,
          version: 1,
          createdAt: now,
          updatedAt: now,
        };
        await this.db.collection('sales_orders').insertOne(document, { session }).catch((error: unknown) => this.codeConflict(error, code));
        if (grant) await this.priceOverrides.bind(grant, { _id: document._id, code }, session);
        if (requestedBySales) {
          await this.notify(session, document._id.toHexString(), {
            targetUserIds: await this.stepAudience('sales.step.issue', session, { exclude: [request.user.sub] }),
            level: 'INFO',
            title: `Đề nghị lập phiếu xuất kho ${document.code}`,
            message: `${request.user.displayName} đề nghị xuất ${isNonSale(fields) ? '' : 'bán '}cho ${orderParty(fields)}.`,
            href: `/sales/orders/${document._id.toHexString()}`,
            template: 'SALES_ISSUE_REQUESTED',
            params: { code: document.code, requester: request.user.displayName, customer: orderParty(fields) },
          });
        }
        await this.audit.record(
          {
            actorId: request.user.sub,
            actorEmail: request.user.email,
            correlationId: request.correlationId,
            action: 'SALES_ORDER_CREATED',
            entityType: 'SalesOrder',
            entityId: document._id.toHexString(),
            after: serializeDocument(document),
          },
          session,
        );
        return serializeDocument(document);
      },
    );
  }

  /** Kế toán sửa phiếu đang nháp (kể cả phiếu bị kinh doanh trả lại yêu cầu sửa). */
  async update(id: string, input: UpdateSalesOrder, request: AuthenticatedRequest, idempotencyKey: string | undefined) {
    return this.idempotency.execute(
      `sales-order-update:${id}`,
      idempotencyKey,
      input,
      async (session) => {
        const orderId = toObjectId(id);
        const before = await this.db.collection('sales_orders').findOne({ _id: orderId, version: input.version, status: 'DRAFT' }, { session });
        if (!before) throw new ConflictException({ code: 'ORDER_STATE_CONFLICT', message: 'Phiếu đã được người khác cập nhật hoặc không còn ở trạng thái nháp' });
        const { version: _version, codeMode: _codeMode, ...payload } = input;
        const grant = this.hasPriceOverride(input)
          ? await this.priceOverrides.assertUsable(input.priceOverrideRequestId ?? (before.priceOverrideRequestId as string | undefined), input.formSessionId, orderId, request, session)
          : null;
        const { fields, keeper, orderDate, unset } = await this.composeOrder(payload, session, { assignableKeeper: true, allowRepOverride: canOverrideRep(request.user) });
        // Số phiếu khi sửa: bỏ trống = giữ số cũ; nhập số khác = đổi sang số tự nhập (kiểm tra trùng);
        // chọn lại "Tự sinh" trên phiếu đang mang số tự nhập = cấp số tự sinh mới.
        let codeChange: { code?: string; codeMode?: 'AUTO' | 'MANUAL' } = {};
        const manualCode = input.code ? this.manualCode(input.code, orderDate) : undefined;
        if (manualCode && manualCode !== before.code) {
          this.assertCanNumber(request);
          codeChange = { code: await this.assertCodeFree(manualCode, session, request, orderId), codeMode: 'MANUAL' };
          await this.trackManualCode(manualCode, orderDate, session);
        } else if (!manualCode && input.codeMode === 'AUTO' && before.codeMode === 'MANUAL') {
          this.assertCanNumber(request);
          codeChange = { code: await this.nextAutoCode(orderDate, session, request), codeMode: 'AUTO' };
        }
        // Số tự nhập (mới đặt, hoặc giữ nguyên nhưng đổi sang khách khác) không được trùng chứng từ công nợ đầu kỳ của khách.
        const finalManualCode = codeChange.codeMode === 'MANUAL' ? codeChange.code : !codeChange.code && before.codeMode === 'MANUAL' ? String(before.code) : undefined;
        if (finalManualCode && input.customerId && (codeChange.codeMode === 'MANUAL' || String(before.customerId) !== input.customerId)) {
          await this.assertNotOpeningDocument(finalManualCode, toObjectId(input.customerId, 'customerId'), session);
        }
        const updated = await this.db.collection('sales_orders').findOneAndUpdate(
          { _id: orderId, version: input.version, status: 'DRAFT' },
          {
            $set: { ...fields, ...codeChange, ...this.priceOverrideFields(grant), updatedAt: new Date(), updatedByName: request.user.displayName },
            $unset: { ...unset, ...(keeper ? {} : { warehouseKeeperId: '', warehouseKeeperName: '' }) },
            $inc: { version: 1 },
          },
          { session, returnDocument: 'after' },
        ).catch((error: unknown) => this.codeConflict(error, codeChange.code ?? ''));
        if (!updated) throw new ConflictException({ code: 'ORDER_STATE_CONFLICT', message: 'Phiếu đã được người khác cập nhật' });
        if (grant) await this.priceOverrides.bind(grant, { _id: orderId, code: String(updated.code) }, session);
        await this.audit.record(
          {
            actorId: request.user.sub,
            actorEmail: request.user.email,
            correlationId: request.correlationId,
            action: 'SALES_ORDER_UPDATED',
            entityType: 'SalesOrder',
            entityId: id,
            before: serializeDocument(before),
            after: serializeDocument(updated),
          },
          session,
        );
        return serializeDocument(updated);
      },
    );
  }

  /**
   * Người đối chiếu phiếu với khách (22/10/2026 — rà soát liên phòng ban): NVKD gửi đề nghị + NVKD phụ trách (tài khoản liên kết,
   * còn hoạt động) nếu được phân công bước 3 (SAL-STEP-01). Không có ai thì người được phân bước 3 phía kinh doanh (không kiêm
   * phát hành — như "cả phòng KD" trước đây), rồi mọi người được phân bước 3.
   */
  private async confirmationAudience(order: Document, session: ClientSession, exclude: readonly string[] = []): Promise<{ targetUserIds: string[] }> {
    return { targetUserIds: (await this.confirmers(order, session, exclude)).map((user) => user.id) };
  }

  private async confirmers(order: Document, session: ClientSession | undefined, exclude: readonly string[] = []): Promise<Array<{ id: string; name: string }>> {
    const options = session ? { session } : {};
    const salesRep = order.salesRepId ? await this.db.collection('employees').findOne({ _id: order.salesRepId as ObjectId }, { ...options, projection: { userId: 1 } }) : null;
    const candidates = [order.requestedBy, salesRep?.userId].filter((value): value is ObjectId => value instanceof ObjectId);
    const active = candidates.length
      ? await this.db.collection('users').find({ _id: { $in: candidates }, status: 'ACTIVE' }, { ...options, projection: { displayName: 1, roles: 1, root: 1, permissionGrants: 1, permissionRevokes: 1 } }).toArray()
      : [];
    const named = active
      .filter((row) => permissionsOf(row).includes('sales.step.confirm') && !exclude.includes(String(row._id)))
      .map((row) => ({ id: String(row._id), name: String(row.displayName ?? '') }));
    if (named.length) return [...new Map(named.map((user) => [user.id, user])).values()];
    const holders = await stepHolders(this.db, 'sales.step.confirm', { session, exclude });
    const salesSide = holders.filter((user) => !holdsStep(user.doc, 'sales.step.issue'));
    return (salesSide.length ? salesSide : holders).map(({ id, name }) => ({ id, name }));
  }

  /** Chờ lập SWK: thủ kho trên phiếu; phiếu chưa có thủ kho thì người được phân bước 4 phụ trách kho xuất. */
  private async swkAudience(order: Document, session: ClientSession): Promise<string[]> {
    if (order.warehouseKeeperId) return [(order.warehouseKeeperId as ObjectId).toHexString()];
    return this.stepAudience('sales.step.ship', session, { warehouseId: (order.warehouseId as ObjectId).toHexString() });
  }

  /** Bước đang chờ của phiếu và người được phân công (SAL-STEP-01) — dòng thời gian trên phiếu. */
  async stepOwners(id: string, user: RequestUser): Promise<SalesStepOwners> {
    const order = await this.db.collection('sales_orders').findOne(
      { _id: toObjectId(id), ...salesOrderScope(user) },
      { projection: { status: 1, confirmationStatus: 1, purpose: 1, requestedBy: 1, salesRepId: 1, warehouseKeeperId: 1, warehouseId: 1 } },
    );
    if (!order) throw new NotFoundException({ code: 'SALES_ORDER_NOT_FOUND', message: 'Không tìm thấy phiếu' });
    const pack = (users: ReadonlyArray<{ name: string }>) => ({ names: users.slice(0, 5).map((item) => item.name), more: Math.max(0, users.length - 5) });
    const status = String(order.status);
    const sale = !isNonSalePurpose(order.purpose);
    const confirmPending = order.confirmationStatus === 'PENDING' || order.confirmationStatus === 'REVISION_REQUESTED' || !order.confirmationStatus;
    // Người được phân công các bước chưa làm (để dòng thời gian hiện "Chờ: …" ở từng bước).
    const steps: SalesStepOwners['steps'] = {};
    if (status === 'DRAFT') steps.ISSUE = pack(await stepHolders(this.db, 'sales.step.issue'));
    if (sale && ['DRAFT', 'PENDING_APPROVAL', 'RESERVED'].includes(status) && confirmPending) steps.CONFIRM = pack(await this.confirmers(order, undefined));
    if (['DRAFT', 'PENDING_APPROVAL', 'RESERVED'].includes(status)) {
      const keeper = order.warehouseKeeperId
        ? await this.db.collection('users').findOne({ _id: order.warehouseKeeperId as ObjectId, status: 'ACTIVE' }, { projection: { displayName: 1, roles: 1, root: 1, permissionGrants: 1, permissionRevokes: 1 } })
        : null;
      steps.SHIP = { names: keeper && holdsStep(keeper, 'sales.step.ship') ? [String(keeper.displayName)] : [], more: 0 };
    }
    if (sale && ['DRAFT', 'PENDING_APPROVAL', 'RESERVED', 'SHIPPED'].includes(status)) steps.DELIVER = pack(await this.deliverers(order, undefined));
    const current = status === 'DRAFT' ? 'ISSUE'
      : status === 'PENDING_APPROVAL' ? 'APPROVAL'
      : status === 'RESERVED' ? (order.confirmationStatus === 'PENDING' ? 'CONFIRM' : 'SHIP')
      : status === 'SHIPPED' && sale ? 'DELIVER'
      : null;
    const owners = current && current !== 'APPROVAL' ? steps[current] ?? { names: [], more: 0 } : { names: [], more: 0 };
    return { step: current, ...owners, steps };
  }

  /** Id người được phân công bước `key` (SAL-STEP-01) — người nhận thông báo. */
  private async stepAudience(key: PermissionKey, session: ClientSession, options: { exclude?: readonly string[]; warehouseId?: string } = {}): Promise<string[]> {
    return (await stepHolders(this.db, key, { session, ...options })).map((user) => user.id);
  }

  /** Người xác nhận giao được phiếu này (bước 5): người có vai trò kho chỉ khi là thủ kho của phiếu. */
  private async deliverers(order: Document, session: ClientSession | undefined, exclude: readonly string[] = []): Promise<Array<{ id: string; name: string }>> {
    const keeperId = (order.warehouseKeeperId as ObjectId | undefined)?.toHexString();
    return (await stepHolders(this.db, 'sales.step.deliver', { session, exclude }))
      .filter((user) => !hasKeeperRole((user.doc.roles as string[] | undefined) ?? []) || user.id === keeperId)
      .map(({ id, name }) => ({ id, name }));
  }

  /** Người cần biết khi phiếu bị bỏ: NVKD đề nghị, NVKD phụ trách (tài khoản liên kết), thủ kho được giao — trừ chính người thao tác. */
  private async discardAudience(order: Document, request: AuthenticatedRequest, session: ClientSession): Promise<string[]> {
    const salesRep = order.salesRepId ? await this.db.collection('employees').findOne({ _id: order.salesRepId as ObjectId }, { session, projection: { userId: 1 } }) : null;
    const ids = [order.requestedBy, salesRep?.userId, order.warehouseKeeperId]
      .filter((value): value is ObjectId => value instanceof ObjectId)
      .map((value) => value.toHexString())
      .filter((value) => value !== request.user.sub);
    return [...new Set(ids)];
  }

  /**
   * Hủy phiếu đã phát hành nhưng chưa xuất kho (chờ duyệt / đã giữ hàng, chưa có SWK): trả hàng giữ chỗ về kho,
   * đóng yêu cầu duyệt đang chờ, giữ nguyên số phiếu với trạng thái "Đã hủy" để không mất dấu chứng từ.
   */
  async cancel(id: string, input: DiscardSalesOrder, request: AuthenticatedRequest, idempotencyKey: string | undefined) {
    return this.idempotency.execute(`sales-order-cancel:${id}`, idempotencyKey, input, (session) => this.cancelInSession(id, input, request, session));
  }

  /** Hủy phiếu chưa xuất trong giao dịch có sẵn — dùng cho thao tác trực tiếp và khi duyệt đề nghị (SAL-CHG-01). */
  async cancelInSession(id: string, input: DiscardSalesOrder, request: AuthenticatedRequest, session: ClientSession, via?: SalesChangeVia) {
    const orderId = toObjectId(id);
    const before = await this.db.collection('sales_orders').findOne({ _id: orderId }, { session });
    if (!before) throw new NotFoundException({ code: 'SALES_ORDER_NOT_FOUND', message: 'Không tìm thấy phiếu' });
    assertWarehouseAccess(request, (before.warehouseId as ObjectId).toHexString());
    if (before.status === 'DRAFT') {
      throw new ConflictException({ code: 'ORDER_STATE_CONFLICT', message: 'Phiếu nháp chưa phát hành — dùng "Xóa phiếu" thay vì hủy' });
    }
    if (!(CANCELLABLE_SALES_STATUSES as readonly string[]).includes(String(before.status))) {
      throw new ConflictException({ code: 'ORDER_NOT_CANCELLABLE', message: 'Chỉ hủy được phiếu đã phát hành nhưng chưa xuất kho (chưa có SWK)' });
    }
    if (before.version !== input.version) throw new ConflictException({ code: 'ORDER_STATE_CONFLICT', message: 'Phiếu đã được người khác cập nhật — tải lại rồi thử lại' });
    if (await this.db.collection('shipments').findOne({ salesOrderId: orderId }, { session, projection: { _id: 1 } })) {
      throw new ConflictException({ code: 'ORDER_NOT_CANCELLABLE', message: 'Phiếu đã có SWK / đã xuất kho — không hủy được, dùng trả hàng' });
    }
    await this.inventory.release(orderId, session);
    const now = new Date();
    const updated = await this.db.collection('sales_orders').findOneAndUpdate(
      { _id: orderId, version: input.version, status: before.status },
      {
        $set: {
          status: 'CANCELLED', statusBeforeCancel: before.status, cancelReason: input.reason,
          cancelledAt: now, cancelledBy: toObjectId(request.user.sub), cancelledByName: request.user.displayName, updatedAt: now,
        },
        $inc: { version: 1 },
      },
      { session, returnDocument: 'after' },
    );
    if (!updated) throw new ConflictException({ code: 'ORDER_STATE_CONFLICT', message: 'Phiếu đã được người khác cập nhật — tải lại rồi thử lại' });
    await this.db.collection('approval_requests').updateMany(
      { entityType: 'SalesOrder', entityId: orderId, status: 'PENDING' },
      { $set: { status: 'CANCELLED', decidedAt: now, decidedBy: toObjectId(request.user.sub) } },
      { session },
    );
    const targetUserIds = await this.discardAudience(before, request, session);
    const targetRoles = before.status === 'PENDING_APPROVAL' ? ['SALES_MANAGER'] : [];
    if (targetUserIds.length || targetRoles.length) {
      await this.notify(session, id, {
        ...(targetUserIds.length ? { targetUserIds } : {}),
        ...(targetRoles.length ? { targetRoles } : {}),
        level: 'WARNING',
        title: `Phiếu ${String(before.code)} đã bị hủy`,
        message: `${request.user.displayName} hủy phiếu xuất kho ${String(before.code)} (${orderParty(before)}): ${input.reason}`,
        // Phiếu đã hủy chỉ quản trị gốc mở được (DOC-HIDE-01) — người nhận về danh sách.
        href: '/sales/orders',
        template: 'SALES_ORDER_CANCELLED',
        params: { code: String(before.code), customer: orderParty(before), actor: request.user.displayName, reason: input.reason },
      });
    }
    await this.audit.record(
      {
        actorId: request.user.sub,
        actorEmail: request.user.email,
        correlationId: request.correlationId,
        action: 'SALES_ORDER_CANCELLED',
        entityType: 'SalesOrder',
        entityId: id,
        before: serializeDocument(before),
        after: serializeDocument(updated),
        metadata: { reason: input.reason },
      },
      session,
    );
    return serializeDocument(await this.releaseNumber(updated, request, session));
  }

  /**
   * Xóa hẳn phiếu nháp (chưa phát hành, hoặc bị kinh doanh trả về). Không còn trong danh sách; nội dung đầy đủ
   * giữ trong nhật ký hệ thống. Phiếu đã phát hành thì phải hủy (giữ số), không xóa.
   */
  async remove(id: string, input: DiscardSalesOrder, request: AuthenticatedRequest, idempotencyKey: string | undefined) {
    return this.idempotency.execute(`sales-order-delete:${id}`, idempotencyKey, input, (session) => this.removeInSession(id, input, request, session));
  }

  /** Xóa phiếu nháp trong giao dịch có sẵn — dùng cho thao tác trực tiếp và khi duyệt đề nghị (SAL-CHG-01). */
  async removeInSession(id: string, input: DiscardSalesOrder, request: AuthenticatedRequest, session: ClientSession, via?: SalesChangeVia) {
    const orderId = toObjectId(id);
    const before = await this.db.collection('sales_orders').findOne({ _id: orderId }, { session });
    if (!before) throw new NotFoundException({ code: 'SALES_ORDER_NOT_FOUND', message: 'Không tìm thấy phiếu' });
    assertWarehouseAccess(request, (before.warehouseId as ObjectId).toHexString());
    if (before.status !== 'DRAFT') {
      throw new ConflictException({ code: 'ORDER_NOT_DELETABLE', message: 'Chỉ xóa được phiếu nháp; phiếu đã phát hành thì dùng "Hủy phiếu"' });
    }
    if (before.version !== input.version) throw new ConflictException({ code: 'ORDER_STATE_CONFLICT', message: 'Phiếu đã được người khác cập nhật — tải lại rồi thử lại' });
    const [shipment, receivable] = await Promise.all([
      this.db.collection('shipments').findOne({ salesOrderId: orderId }, { session, projection: { _id: 1 } }),
      this.db.collection('receivables').findOne({ salesOrderId: orderId }, { session, projection: { _id: 1 } }),
    ]);
    if (shipment || receivable) throw new ConflictException({ code: 'ORDER_NOT_DELETABLE', message: 'Phiếu đã phát sinh xuất kho / công nợ — không xóa được' });
    await this.inventory.release(orderId, session);
    const deleted = await this.db.collection('sales_orders').deleteOne({ _id: orderId, version: input.version, status: 'DRAFT' }, { session });
    if (deleted.deletedCount !== 1) throw new ConflictException({ code: 'ORDER_STATE_CONFLICT', message: 'Phiếu đã được người khác cập nhật — tải lại rồi thử lại' });
    await this.db.collection('approval_requests').updateMany(
      { entityType: 'SalesOrder', entityId: orderId, status: 'PENDING' },
      { $set: { status: 'CANCELLED', decidedAt: new Date(), decidedBy: toObjectId(request.user.sub) } },
      { session },
    );
    const targetUserIds = await this.discardAudience(before, request, session);
    if (targetUserIds.length) {
      await this.notify(session, id, {
        targetUserIds,
        level: 'WARNING',
        title: `Phiếu nháp ${String(before.code)} đã bị xóa`,
        message: `${request.user.displayName} xóa phiếu nháp ${String(before.code)} (${orderParty(before)}): ${input.reason}`,
        href: '/sales/orders',
        template: 'SALES_ORDER_DELETED',
        params: { code: String(before.code), customer: orderParty(before), actor: request.user.displayName, reason: input.reason },
      });
    }
    await this.audit.record(
      {
        actorId: request.user.sub,
        actorEmail: request.user.email,
        correlationId: request.correlationId,
        action: 'SALES_ORDER_DELETED',
        entityType: 'SalesOrder',
        entityId: id,
        before: serializeDocument(before),
        metadata: { reason: input.reason, code: String(before.code) },
      },
      session,
    );
    return { id, code: String(before.code), deleted: true };
  }

  // ---------------------------------------------------------------------------------------------------------
  // Sửa / hủy phiếu sau phát hành (quyền sales.edit_issued / sales.void_shipped — mặc định Admin; kế toán, kho gửi đề nghị — SAL-CHG-01):
  // hủy phiếu đã giao bằng bút toán đảo, sửa phiếu ở mọi giai đoạn (chênh lệch tự vào thẻ kho / công nợ).

  /** Tổng số lượng (đơn vị cơ sở, gồm hàng tặng) theo mã hàng. */
  private quantitiesOf(lines: Array<{ productId: unknown; baseQuantity: unknown }>): Map<string, Decimal> {
    const result = new Map<string, Decimal>();
    for (const line of lines) {
      const key = String(line.productId);
      result.set(key, (result.get(key) ?? new Decimal(0)).add(decimalString(line.baseQuantity)));
    }
    return result;
  }

  /** Số lượng khách đã trả lại theo phiếu BH này (phiếu nhập trả hàng TH… chưa hủy — phiếu hủy đã đảo thẻ kho). */
  private async returnedQuantities(orderCode: string, session: ClientSession): Promise<Map<string, Decimal>> {
    const returns = await this.db.collection('stock_returns').find({ kind: { $in: ['CUSTOMER', 'SAMPLE'] }, salesOrderCode: orderCode, status: { $ne: 'VOIDED' } }, { session }).toArray();
    return this.quantitiesOf(returns.flatMap((row) => (row.lines as Array<{ productId: unknown; quantity: unknown }>).map((line) => ({ productId: line.productId, baseQuantity: line.quantity }))));
  }

  /**
   * Hủy phiếu đã xuất kho / đã giao (quyền sales.void_shipped): nhập lại kho phần hàng khách chưa trả, công nợ của phiếu chuyển "Đã hủy";
   * tiền đã thu thành dòng "khách trả trước" (công nợ âm) để dư nợ / hạn mức của khách đúng. Giữ số, có nhật ký.
   */
  async rootVoid(id: string, input: DiscardSalesOrder, request: AuthenticatedRequest, idempotencyKey: string | undefined) {
    return this.idempotency.execute(`sales-order-void:${id}`, idempotencyKey, input, (session) => this.voidInSession(id, input, request, session));
  }

  /** Hủy phiếu đã giao trong giao dịch có sẵn — dùng cho thao tác trực tiếp và khi duyệt đề nghị (SAL-CHG-01). */
  async voidInSession(id: string, input: DiscardSalesOrder, request: AuthenticatedRequest, session: ClientSession, via?: SalesChangeVia) {
    const orderId = toObjectId(id);
    const before = await this.db.collection('sales_orders').findOne({ _id: orderId }, { session });
    if (!before) throw new NotFoundException({ code: 'SALES_ORDER_NOT_FOUND', message: 'Không tìm thấy phiếu' });
    if (!['SHIPPED', 'PARTIALLY_SHIPPED', 'DELIVERED'].includes(String(before.status))) {
      throw new ConflictException({ code: 'ORDER_STATE_CONFLICT', message: 'Phiếu chưa xuất kho — dùng "Hủy phiếu" / "Xóa phiếu" thông thường' });
    }
    if (before.version !== input.version) throw new ConflictException({ code: 'ORDER_STATE_CONFLICT', message: 'Phiếu đã được người khác cập nhật — tải lại rồi thử lại' });
    // Phần hàng mẫu chưa về đã chốt (hỏng / tiêu hao / chuyển bán) không còn để nhập lại kho.
    if (before.loanStatus === 'CLOSED') throw new ConflictException({ code: 'LOAN_CLOSED', message: 'Phiếu hàng mẫu / kiểm định đã chốt phần chưa trả — không hủy được' });
    const code = String(before.code);
    const shipment = await this.db.collection('shipments').findOne({ salesOrderId: orderId }, { session });
    const shipped = this.quantitiesOf(before.lines as Array<{ productId: unknown; baseQuantity: unknown }>);
    const returned = await this.returnedQuantities(code, session);
    const back = [...shipped].map(([productId, quantity]) => ({ productId, quantity: quantity.sub(returned.get(productId) ?? 0) })).filter((line) => line.quantity.gt(0));
    if (back.length) {
      await this.inventory.applyPhysicalMovement({
        warehouseId: (before.warehouseId as ObjectId).toHexString(),
        referenceType: 'Shipment',
        referenceId: String(shipment?.code ?? before.warehouseSlipNo ?? code),
        movementType: 'SALES_VOID',
        direction: 'IN',
        category: 'SALES_REVERSAL_IN',
        lines: back.map((line) => ({ productId: line.productId, quantity: line.quantity.toString() })),
        reason: `Hủy phiếu ${code} sau khi giao: ${input.reason}`,
        actorId: request.user.sub,
        extra: { salesOrderCode: code },
      }, session);
    }
    const now = new Date();
    if (shipment) await this.db.collection('shipments').updateOne({ _id: shipment._id }, { $set: { status: 'CANCELLED', cancelledAt: now, cancelReason: input.reason, updatedAt: now } }, { session });
    const receivableFilter = { salesOrderId: orderId, sourceType: { $ne: 'SALES_VOID_CREDIT' }, status: { $ne: 'VOIDED' } };
    // Phiếu giảm nợ trả hàng đang trừ vào phiếu này (D1) tự hủy trước: tiền hàng trả không thành "khách trả trước".
    const returnSlips = await voidReturnCreditsOf(
      this.db,
      (await this.db.collection('receivables').find(receivableFilter, { session, projection: { _id: 1 } }).toArray()).map((row) => row._id as ObjectId),
      code,
      { id: toObjectId(request.user.sub), name: request.user.displayName },
      session,
      new Date(),
      orderId,
    );
    // Đơn thanh toán ngay (AR-PAYNOW-01): phiếu thu tự động hủy theo phiếu — không thành khoản khách trả trước.
    await voidPayNowReceipts(this.db, orderId, `Hủy phiếu ${code}: ${input.reason}`, { id: toObjectId(request.user.sub), name: request.user.displayName }, session, now);
    const receivables = await this.db.collection('receivables').find(receivableFilter, { session }).toArray();
    let credited = new Decimal(0);
    for (const receivable of receivables) {
      const paid = new Decimal(decimalString(receivable.paidAmount));
      await this.db.collection('receivables').updateOne(
        { _id: receivable._id },
        { $set: { status: 'VOIDED', statusBeforeVoid: receivable.status, voidedAt: now, voidReason: input.reason, updatedAt: now }, $inc: { version: 1 } },
        { session },
      );
      if (paid.gt(0)) {
        credited = credited.add(paid);
        const farFuture = new Date(now);
        farFuture.setUTCFullYear(farFuture.getUTCFullYear() + 10);
        await this.db.collection('receivables').insertOne({
          _id: new ObjectId(),
          code: await this.sequences.next('AR', session),
          partnerId: receivable.partnerId,
          salesOrderId: orderId,
          salesOrderCode: code,
          sourceType: 'SALES_VOID_CREDIT',
          amount: decimal(`-${paid.toString()}`),
          paidAmount: decimal('0'),
          status: 'OPEN',
          dueDate: farFuture,
          note: `Tiền đã thu của phiếu ${code} (đã hủy sau khi giao) — khách trả trước`,
          version: 1,
          createdAt: now,
          updatedAt: now,
        }, { session });
      }
    }
    const updated = await this.db.collection('sales_orders').findOneAndUpdate(
      { _id: orderId, version: input.version },
      {
        $set: {
          status: 'CANCELLED', statusBeforeCancel: before.status, cancelReason: input.reason,
          cancelledAt: now, cancelledBy: toObjectId(request.user.sub), cancelledByName: request.user.displayName, voidedAfterShipment: true, updatedAt: now,
        },
        ...(before.loanStatus ? { $unset: { loanStatus: '' } } : {}),
        $inc: { version: 1 },
      },
      { session, returnDocument: 'after' },
    );
    if (!updated) throw new ConflictException({ code: 'ORDER_STATE_CONFLICT', message: 'Phiếu đã được người khác cập nhật — tải lại rồi thử lại' });
    if (before.customerId) await releaseHoldIfCleared(this.db, before.customerId as ObjectId, session, now);
    const targetUserIds = await this.discardAudience(before, request, session);
    await this.notify(session, id, {
      targetRoles: ['ACCOUNTANT'],
      ...(targetUserIds.length ? { targetUserIds } : {}),
      level: 'WARNING',
      title: `Phiếu ${code} đã bị hủy`,
      message: `${request.user.displayName} hủy phiếu ${code} (${orderParty(before)}) sau khi giao: ${input.reason}`,
      href: '/sales/orders',
      template: 'SALES_ORDER_CANCELLED',
      params: { code, customer: orderParty(before), actor: request.user.displayName, reason: input.reason },
    });
    await this.audit.record({
      actorId: request.user.sub, actorEmail: request.user.email, correlationId: request.correlationId,
      action: 'SALES_ORDER_VOIDED', entityType: 'SalesOrder', entityId: id,
      before: serializeDocument(before), after: serializeDocument(updated),
      metadata: { reason: input.reason, restocked: back.map((line) => ({ productId: line.productId, quantity: line.quantity.toString() })), credited: credited.toString(), ...(returnSlips.length ? { returnCreditsVoided: returnSlips } : {}), ...(via ? { changeRequest: via } : {}) },
    }, session);
    return serializeDocument(await this.releaseNumber(updated, request, session));
  }

  /**
   * Sửa phiếu đã phát hành (chờ duyệt / giữ hàng / đã xuất / đã giao): tính lại phiếu; giữ chỗ được làm lại;
   * phiếu đã xuất kho thì chênh lệch số lượng vào thẻ kho ("Nhập lại / Xuất bổ sung do sửa phiếu BH") và công nợ theo tổng mới.
   */
  async rootUpdate(id: string, input: UpdateSalesOrder, request: AuthenticatedRequest, idempotencyKey: string | undefined) {
    return this.idempotency.execute(`sales-order-root-edit:${id}`, idempotencyKey, input, (session) => this.editIssuedInSession(id, input, request, session));
  }

  /** Sửa phiếu đã phát hành trong giao dịch có sẵn — dùng cho thao tác trực tiếp và khi duyệt đề nghị (SAL-CHG-01). */
  async editIssuedInSession(id: string, input: UpdateSalesOrder, request: AuthenticatedRequest, session: ClientSession, via?: SalesChangeVia) {
    const orderId = toObjectId(id);
    const before = await this.db.collection('sales_orders').findOne({ _id: orderId, version: input.version }, { session });
    if (!before) throw new ConflictException({ code: 'ORDER_STATE_CONFLICT', message: 'Phiếu đã được người khác cập nhật — tải lại rồi thử lại' });
    if (before.status === 'DRAFT') throw new ConflictException({ code: 'ORDER_STATE_CONFLICT', message: 'Phiếu nháp sửa theo cách thông thường' });
    if (before.status === 'CANCELLED') throw new ConflictException({ code: 'ORDER_STATE_CONFLICT', message: 'Phiếu đã hủy không sửa được' });
    const shipped = ['SHIPPED', 'PARTIALLY_SHIPPED', 'DELIVERED'].includes(String(before.status));
    const { version: _version, codeMode: _codeMode, ...payload } = input;
    const { fields, keeper, orderDate, unset } = await this.composeOrder(payload, session, { allowBlockedCustomer: true, allowRepOverride: true });
    const warehouseChanged = String(fields.warehouseId) !== String(before.warehouseId);
    const customerChanged = String(fields.customerId ?? '') !== String(before.customerId ?? '');
    if (shipped && warehouseChanged) throw new ConflictException({ code: 'ORDER_STATE_CONFLICT', message: 'Phiếu đã xuất kho: không đổi kho xuất (hủy phiếu rồi lập lại)' });
    // Đổi loại phiếu (SAL-TYPE-01): bán → hàng mẫu / kiểm định / xuất tặng được cả khi đã xuất (VD phiếu kiểm định lỡ lập thành
    // phiếu bán); hàng mẫu đã xuất → bán thì dùng "Chốt phần chưa trả → Đại lý mua luôn"; hàng mẫu / kiểm định → xuất tặng chỉ
    // khi chưa có lần nhập lại nào.
    const beforePurpose = purposeOf(before);
    const afterPurpose = purposeOf(fields);
    const purposeChanged = beforePurpose !== afterPurpose;
    if (before.loanStatus === 'CLOSED') throw new ConflictException({ code: 'LOAN_CLOSED', message: 'Phiếu hàng mẫu / kiểm định đã chốt phần chưa trả — không sửa được' });
    if (shipped && purposeChanged && isNonSalePurpose(beforePurpose) && !isNonSalePurpose(afterPurpose)) {
      throw new ConflictException({
        code: 'PURPOSE_CHANGE_NOT_ALLOWED',
        message: beforePurpose === 'GIFT'
          ? 'Phiếu xuất tặng đã xuất kho không chuyển thành phiếu bán được — hủy phiếu rồi lập phiếu bán'
          : 'Phiếu hàng mẫu / kiểm định đã xuất kho không chuyển thành phiếu bán được — dùng "Chốt phần chưa trả → Đại lý mua luôn"',
      });
    }
    if (shipped && purposeChanged && isLoanPurpose(beforePurpose) && !isLoanPurpose(afterPurpose)) {
      const loanReturns = await this.db.collection('stock_returns').countDocuments({ kind: 'SAMPLE', salesOrderCode: String(before.code), status: { $ne: 'VOIDED' } }, { session });
      if (loanReturns) {
        throw new ConflictException({ code: 'PURPOSE_CHANGE_NOT_ALLOWED', message: 'Phiếu đã có hàng mang về nhập lại — không đổi sang xuất tặng được; dùng "Chốt phần chưa trả → Hỏng / tiêu hao / tặng"' });
      }
    }
    if (shipped && purposeChanged && !isNonSalePurpose(beforePurpose)) {
      const customerReturns = await this.db.collection('stock_returns').countDocuments({ kind: 'CUSTOMER', salesOrderCode: String(before.code), status: { $ne: 'VOIDED' } }, { session });
      if (customerReturns) throw new ConflictException({ code: 'PURPOSE_CHANGE_NOT_ALLOWED', message: 'Phiếu đã có hàng khách trả — không đổi sang phiếu hàng mẫu / kiểm định / xuất tặng được' });
    }
    let codeChange: { code?: string; codeMode?: 'AUTO' | 'MANUAL' } = {};
    const manualCode = input.code ? this.manualCode(input.code, orderDate) : undefined;
    if (manualCode && manualCode !== before.code) {
      if (shipped) throw new ConflictException({ code: 'ORDER_STATE_CONFLICT', message: 'Phiếu đã xuất kho: không đổi số phiếu (số SWK, thẻ kho, công nợ đang dùng số này)' });
      codeChange = { code: await this.assertCodeFree(manualCode, session, request, orderId), codeMode: 'MANUAL' };
    }
    const code = codeChange.code ?? String(before.code);
    const now = new Date();
    const newLines = fields.lines as Array<{ productId: ObjectId; baseQuantity: unknown; gift?: boolean }>;
    if (before.status === 'RESERVED') {
      await this.inventory.release(orderId, session);
      await this.inventory.reserve(orderId, String(fields.warehouseId), newLines.map((line) => ({ productId: line.productId.toHexString(), baseQuantity: decimalString(line.baseQuantity), gift: Boolean(line.gift) })), request.user.sub, session);
    }
    if (shipped) {
      const oldQty = this.quantitiesOf(before.lines as Array<{ productId: unknown; baseQuantity: unknown }>);
      const newQty = this.quantitiesOf(newLines);
      const returned = await this.returnedQuantities(code, session);
      for (const [productId, quantity] of returned) {
        if ((newQty.get(productId) ?? new Decimal(0)).lt(quantity)) {
          const sku = (before.lines as Array<{ productId: unknown; sku: string }>).find((line) => String(line.productId) === productId)?.sku ?? productId;
          throw new ConflictException({ code: 'ORDER_RETURNED_EXCEEDS', message: `Khách đã trả ${quantity.toString()} ${sku} theo phiếu này — số lượng mới không được nhỏ hơn` });
        }
      }
      const deltas = [...new Set([...oldQty.keys(), ...newQty.keys()])].map((productId) => ({ productId, delta: (newQty.get(productId) ?? new Decimal(0)).sub(oldQty.get(productId) ?? 0) }));
      const shipment = await this.db.collection('shipments').findOne({ salesOrderId: orderId }, { session });
      const movement = (direction: 'IN' | 'OUT', lines: Array<{ productId: string; delta: Decimal }>) => this.inventory.applyPhysicalMovement({
        warehouseId: (before.warehouseId as ObjectId).toHexString(),
        referenceType: 'Shipment',
        referenceId: String(shipment?.code ?? before.warehouseSlipNo ?? code),
        movementType: 'SALES_ADJUSTMENT',
        direction,
        category: direction === 'IN' ? 'SALES_REVERSAL_IN' : 'SALES_EXTRA_OUT',
        lines: lines.map((line) => ({ productId: line.productId, quantity: line.delta.abs().toString() })),
        reason: `Sửa phiếu ${code} sau phát hành${via ? ` (đề nghị ${via.code})` : ''}`,
        actorId: request.user.sub,
        extra: { salesOrderCode: code },
      }, session);
      const backIn = deltas.filter((line) => line.delta.lt(0));
      const extraOut = deltas.filter((line) => line.delta.gt(0));
      if (backIn.length) await movement('IN', backIn);
      if (extraOut.length) await movement('OUT', extraOut);
      if (purposeChanged) {
        // Đổi nhãn thẻ kho của lần xuất (và các lần nhập lại hàng mẫu) theo loại phiếu mới — số lượng không đổi.
        const slipRef = String(shipment?.code ?? before.warehouseSlipNo ?? code);
        if (isNonSalePurpose(afterPurpose)) {
          await this.db.collection('inventory_movements').updateMany({ referenceType: 'Shipment', referenceId: slipRef, movementType: 'SALES_SHIPMENT' }, { $set: { category: nonSaleOutCategory(afterPurpose) } }, { session });
        }
        if (isLoanPurpose(afterPurpose)) {
          await this.db.collection('inventory_movements').updateMany({ movementType: 'LOAN_RETURN', salesOrderCode: code }, { $set: { category: loanInCategory(afterPurpose) } }, { session });
          await this.db.collection('stock_returns').updateMany({ kind: 'SAMPLE', salesOrderCode: code }, { $set: { category: loanInCategory(afterPurpose), purpose: afterPurpose } }, { session });
        }
      }
      const loanFields = isLoanPurpose(afterPurpose) ? { loanStatus: this.loanStatusOf(this.quantitiesOf(newLines), returned) } : {};
      if (shipment) {
        await this.db.collection('shipments').updateOne(
          { _id: shipment._id },
          {
            $set: { lines: fields.lines, ...(fields.customerId ? { customerId: fields.customerId } : {}), ...(isNonSalePurpose(afterPurpose) ? { purpose: afterPurpose } : {}), updatedAt: now },
            ...(fields.customerId ? {} : { $unset: { customerId: '' } }),
          },
          { session },
        );
      }
      Object.assign(fields, loanFields);
      // Đơn thanh toán ngay (AR-PAYNOW-01): hủy phiếu thu tự động trước, ghi lại theo số mới sau khi cập nhật chứng từ.
      const payNowVoided = await voidPayNowReceipts(this.db, orderId, `Sửa phiếu ${code} — ghi lại phiếu thu theo số mới`, { id: toObjectId(request.user.sub), name: request.user.displayName }, session, now);
      const receivable = await this.db.collection('receivables').findOne({ salesOrderId: orderId, sourceType: { $ne: 'SALES_VOID_CREDIT' }, status: { $ne: 'VOIDED' } }, { session });
      if (receivable && isNonSalePurpose(afterPurpose)) {
        // Chuyển thành phiếu hàng mẫu / kiểm định / xuất tặng: không còn gì phải thu.
        if (new Decimal(decimalString(receivable.paidAmount)).gt(0)) {
          throw new ConflictException({ code: 'ORDER_PAID_EXCEEDS_TOTAL', message: 'Phiếu đã thu tiền — xử lý phiếu thu trước khi chuyển thành phiếu hàng mẫu / kiểm định / xuất tặng' });
        }
        await this.db.collection('receivables').updateOne(
          { _id: receivable._id },
          { $set: { status: 'VOIDED', statusBeforeVoid: receivable.status, voidedAt: now, voidReason: `Chuyển thành phiếu ${PURPOSE_LABEL_VI[afterPurpose].toLowerCase()}`, updatedAt: now }, $inc: { version: 1 } },
          { session },
        );
      } else if (receivable) {
        const paid = new Decimal(decimalString(receivable.paidAmount));
        const amount = new Decimal(decimalString(fields.grandTotal));
        if (paid.gt(amount)) throw new ConflictException({ code: 'ORDER_PAID_EXCEEDS_TOTAL', message: `Đã thu ${paid.toFixed(0)} đ, lớn hơn tổng mới ${amount.toFixed(0)} đ — xử lý phiếu thu trước` });
        if (customerChanged && paid.gt(0)) throw new ConflictException({ code: 'ORDER_STATE_CONFLICT', message: 'Phiếu đã thu tiền: không đổi khách hàng' });
        const status = paid.eq(amount) ? 'PAID' : paid.gt(0) ? 'PARTIALLY_PAID' : receivable.status === 'OVERDUE' ? 'OVERDUE' : 'OPEN';
        await this.db.collection('receivables').updateOne(
          { _id: receivable._id },
          { $set: { amount: decimal(amount.toString()), status, partnerId: fields.customerId, salesOrderCode: code, updatedAt: now }, $inc: { version: 1 } },
          { session },
        );
        if (payNowVoided.length && Number(fields.paymentTermDays ?? -1) === 0 && 'payNowMethod' in fields && !before.payNowUndone) {
          const current = await this.db.collection('receivables').findOne({ _id: receivable._id }, { session });
          if (current) await postPayNowReceipt(this.db, this.sequences, { receivable: current, order: { ...before, ...fields, code }, receivedAt: payNowVoided[0]!.receivedAt as Date, actor: PAY_NOW_ACTOR }, session, now);
        }
      }
    }
    const overridden = this.hasPriceOverride(input) && !before.priceOverrideRequestId
      ? { priceOverrideApprovedByName: request.user.displayName, priceOverrideReason: 'Sửa phiếu sau phát hành' }
      : {};
    // Phiếu đã phát hành, chưa xuất, đổi loại: hàng mẫu / kiểm định bỏ bước đối chiếu khách; thành phiếu bán thì phải đối chiếu lại.
    const confirmation = purposeChanged && !shipped && before.status === 'RESERVED'
      ? { confirmationStatus: isNonSalePurpose(afterPurpose) ? 'NOT_REQUIRED' : 'PENDING' }
      : {};
    const updated = await this.db.collection('sales_orders').findOneAndUpdate(
      { _id: orderId, version: input.version },
      {
        $set: { ...fields, ...codeChange, ...overridden, ...confirmation, rootEditedAt: now, rootEditedByName: request.user.displayName, updatedAt: now, updatedByName: request.user.displayName },
        $unset: {
          ...unset,
          ...(keeper ? {} : { warehouseKeeperId: '', warehouseKeeperName: '' }),
          // Không còn là hàng mẫu / kiểm định (VD chuyển sang xuất tặng): bỏ tình trạng hàng mang về.
          ...(before.loanStatus && !isLoanPurpose(afterPurpose) ? { loanStatus: '' } : {}),
        },
        $inc: { version: 1 },
      },
      { session, returnDocument: 'after' },
    ).catch((error: unknown) => this.codeConflict(error, codeChange.code ?? ''));
    if (!updated) throw new ConflictException({ code: 'ORDER_STATE_CONFLICT', message: 'Phiếu đã được người khác cập nhật — tải lại rồi thử lại' });
    // Dòng hàng đổi → tính lại phần nợ nhóm tách riêng của chứng từ và phân bổ lại tiền đã thu của khách (CN-SEG-01).
    if (shipped && fields.customerId) await reallocatePartner(this.db, fields.customerId as ObjectId, session, now);
    if (customerChanged && before.customerId) await releaseHoldIfCleared(this.db, before.customerId as ObjectId, session, now);
    await this.notify(session, id, {
      targetRoles: ['ACCOUNTANT'],
      level: 'WARNING',
      title: `Phiếu ${code} đã được sửa`,
      message: `${request.user.displayName} sửa phiếu ${code} (${orderParty(fields)})${shipped ? ' — tồn kho và công nợ đã điều chỉnh theo chênh lệch' : ''}.`,
      href: `/sales/orders/${id}`,
      template: 'SALES_ORDER_ROOT_EDITED',
      params: { code, customer: orderParty(fields), actor: request.user.displayName },
    });
    await this.audit.record({
      actorId: request.user.sub, actorEmail: request.user.email, correlationId: request.correlationId,
      action: 'SALES_ORDER_ROOT_EDITED', entityType: 'SalesOrder', entityId: id,
      before: serializeDocument(before), after: serializeDocument(updated),
      ...(via || purposeChanged ? { metadata: { ...(via ? { changeRequest: via } : {}), ...(purposeChanged ? { purpose: { from: beforePurpose, to: afterPurpose } } : {}) } } : {}),
    }, session);
    return serializeDocument(updated);
  }

  /** Tình trạng hàng mẫu theo số đã xuất và số đã về (đơn vị cơ bản). */
  private loanStatusOf(shipped: Map<string, Decimal>, returned: Map<string, Decimal>): 'OUT' | 'PARTIAL' | 'RETURNED' {
    const anyBack = [...returned.values()].some((quantity) => quantity.gt(0));
    const allBack = [...shipped].every(([productId, quantity]) => (returned.get(productId) ?? new Decimal(0)).gte(quantity));
    return allBack ? 'RETURNED' : anyBack ? 'PARTIAL' : 'OUT';
  }

  /** Phiếu hàng mẫu / kiểm định đã xuất kho, còn hàng ở ngoài — điều kiện chung của nhập lại / chốt. */
  private async openLoan(id: string, version: number, request: AuthenticatedRequest, session: ClientSession) {
    const order = await this.db.collection('sales_orders').findOne({ _id: toObjectId(id) }, { session });
    if (!order) throw new NotFoundException({ code: 'SALES_ORDER_NOT_FOUND', message: 'Không tìm thấy phiếu' });
    assertWarehouseAccess(request, (order.warehouseId as ObjectId).toHexString());
    if (!isLoanPurpose(order.purpose)) {
      throw new ConflictException({
        code: 'NOT_A_LOAN',
        message: order.purpose === 'GIFT' ? 'Phiếu xuất tặng không theo dõi hàng mang về' : 'Chỉ phiếu hàng mẫu / kiểm định nhập lại theo cách này — hàng khách trả dùng phiếu trả hàng',
      });
    }
    if (!['SHIPPED', 'PARTIALLY_SHIPPED', 'DELIVERED'].includes(String(order.status))) throw new ConflictException({ code: 'ORDER_STATE_CONFLICT', message: 'Phiếu chưa xuất kho' });
    if (order.version !== version) throw new ConflictException({ code: 'ORDER_STATE_CONFLICT', message: 'Phiếu đã được người khác cập nhật — tải lại rồi thử lại' });
    if (order.loanStatus === 'RETURNED' || order.loanStatus === 'CLOSED') {
      throw new ConflictException({ code: 'LOAN_CLOSED', message: order.loanStatus === 'RETURNED' ? 'Hàng của phiếu đã về đủ' : 'Phiếu đã chốt phần chưa trả' });
    }
    const code = String(order.code);
    const shipped = this.quantitiesOf(order.lines as Array<{ productId: unknown; baseQuantity: unknown }>);
    const returned = await this.returnedQuantities(code, session);
    const remaining = new Map([...shipped].map(([productId, quantity]) => [productId, quantity.sub(returned.get(productId) ?? 0)] as const).filter(([, quantity]) => quantity.gt(0)));
    return { order, purpose: order.purpose as LoanPurpose, code, shipped, returned, remaining };
  }

  /** Ghi nhập lại hàng mẫu / kiểm định: thẻ kho "Hàng mẫu nhập lại" / "Nhập lại sau kiểm định" + phiếu TH loại SAMPLE (không qua kế toán). */
  private async postLoanReturn(
    loan: { order: Document; purpose: LoanPurpose; code: string },
    lines: Array<{ productId: string; quantity: Decimal }>,
    note: string,
    request: AuthenticatedRequest,
    session: ClientSession,
    extra: Document = {},
  ) {
    const { order, purpose, code } = loan;
    const category = loanInCategory(purpose);
    const returnCode = await nextReturnInCode(this.db, this.sequences, session);
    await this.inventory.applyPhysicalMovement({
      warehouseId: (order.warehouseId as ObjectId).toHexString(),
      referenceType: 'StockReturn',
      referenceId: returnCode,
      movementType: 'LOAN_RETURN',
      direction: 'IN',
      category,
      lines: lines.map((line) => ({ productId: line.productId, quantity: line.quantity.toString() })),
      reason: note,
      actorId: request.user.sub,
      extra: { salesOrderCode: code },
    }, session);
    const [warehouse, products] = await Promise.all([
      this.db.collection('warehouses').findOne({ _id: order.warehouseId as ObjectId }, { session, projection: { name: 1 } }),
      this.db.collection('products').find({ _id: { $in: lines.map((line) => new ObjectId(line.productId)) } }, { session, projection: { sku: 1, name: 1, baseUnit: 1 } }).toArray(),
    ]);
    const productById = new Map(products.map((product) => [(product._id as ObjectId).toHexString(), product]));
    const document = {
      _id: new ObjectId(),
      code: returnCode,
      kind: 'SAMPLE',
      purpose,
      category,
      salesOrderCode: code,
      salesOrderId: order._id,
      partnerName: orderParty(order),
      ...(order.salesRepId ? { salesRepId: order.salesRepId } : {}),
      warehouseId: order.warehouseId,
      warehouseName: String(warehouse?.name ?? ''),
      note,
      ...extra,
      lines: lines.map((line) => {
        const product = productById.get(line.productId);
        return { productId: new ObjectId(line.productId), sku: String(product?.sku ?? ''), productName: String(product?.name ?? ''), unit: String(product?.baseUnit ?? ''), quantity: decimal(line.quantity.toString()) };
      }),
      createdBy: toObjectId(request.user.sub, 'actorId'),
      createdByName: request.user.displayName,
      createdAt: new Date(),
    };
    await this.db.collection('stock_returns').insertOne(document, { session });
    return document;
  }

  /** Thủ kho nhập lại hàng mẫu / hàng kiểm định NVKD mang về (một phần hoặc đủ) — SAL-TYPE-01. */
  async loanReturn(id: string, input: LoanReturn, request: AuthenticatedRequest, idempotencyKey: string | undefined) {
    return this.idempotency.execute(`sales-loan-return:${id}`, idempotencyKey, input, async (session) => {
      const loan = await this.openLoan(id, input.version, request, session);
      const quantities = new Map<string, Decimal>();
      for (const line of input.lines) {
        const key = toObjectId(line.productId, 'productId').toHexString();
        quantities.set(key, (quantities.get(key) ?? new Decimal(0)).add(line.quantity));
      }
      for (const [productId, quantity] of quantities) {
        const left = loan.remaining.get(productId) ?? new Decimal(0);
        if (quantity.gt(left)) {
          const sku = (loan.order.lines as Array<{ productId: unknown; sku: string }>).find((line) => String(line.productId) === productId)?.sku ?? productId;
          throw new ConflictException({ code: 'LOAN_RETURN_EXCEEDS', message: `Mã ${sku} chỉ còn ${left.toString()} chưa về theo phiếu ${loan.code}`, details: [{ path: ['lines'] }] });
        }
      }
      const label = loan.purpose === 'INSPECTION' ? 'hàng kiểm định' : 'hàng mẫu';
      const returnDoc = await this.postLoanReturn(loan, [...quantities].map(([productId, quantity]) => ({ productId, quantity })), input.note || `Nhập lại ${label} theo ${loan.code}`, request, session);
      for (const [productId, quantity] of quantities) loan.returned.set(productId, (loan.returned.get(productId) ?? new Decimal(0)).add(quantity));
      const loanStatus = this.loanStatusOf(loan.shipped, loan.returned);
      const now = new Date();
      const updated = await this.db.collection('sales_orders').findOneAndUpdate(
        { _id: loan.order._id, version: input.version },
        { $set: { loanStatus, updatedAt: now }, $inc: { version: 1 } },
        { session, returnDocument: 'after' },
      );
      if (!updated) throw new ConflictException({ code: 'ORDER_STATE_CONFLICT', message: 'Phiếu đã được người khác cập nhật — tải lại rồi thử lại' });
      await this.audit.record({
        actorId: request.user.sub, actorEmail: request.user.email, correlationId: request.correlationId,
        action: 'SALES_LOAN_RETURNED', entityType: 'SalesOrder', entityId: id,
        metadata: { returnCode: returnDoc.code, lines: [...quantities].map(([productId, quantity]) => ({ productId, quantity: quantity.toString() })), loanStatus },
      }, session);
      return { ...serializeDocument(updated), returnCode: returnDoc.code };
    });
  }

  /**
   * Chốt phần hàng mẫu / kiểm định chưa về (SAL-TYPE-01): CONSUMED = hỏng / tiêu hao khi kiểm định / tặng — không nhập lại;
   * SOLD = đại lý giữ mua luôn — ghi nhập lại phần còn ở ngoài rồi lập phiếu BH bán bình thường (form điền sẵn), tồn kho đúng.
   */
  /**
   * Kế toán "Bỏ ghi thu tự động" (AR-PAYNOW-01): đơn thanh toán ngay nhưng khách thực tế chưa trả — hủy phiếu thu tự động, chứng từ
   * mở lại với hạn = ngày giao (thành quá hạn như công nợ thường). Sửa phiếu sau đó không tự ghi thu lại.
   */
  async undoPayNow(id: string, reason: string, request: AuthenticatedRequest, idempotencyKey: string | undefined) {
    return this.idempotency.execute(`sales-order-paynow-undo:${id}`, idempotencyKey, { id, reason }, async (session) => {
      const orderId = toObjectId(id);
      const order = await this.db.collection('sales_orders').findOne({ _id: orderId }, { session });
      if (!order) throw new NotFoundException({ code: 'SALES_ORDER_NOT_FOUND', message: 'Không tìm thấy phiếu' });
      const now = new Date();
      const actor = { id: toObjectId(request.user.sub), name: request.user.displayName };
      const voided = await voidPayNowReceipts(this.db, orderId, `Bỏ ghi thu tự động: ${reason}`, actor, session, now);
      if (!voided.length) throw new ConflictException({ code: 'PAY_NOW_RECEIPT_NOT_FOUND', message: `Phiếu ${String(order.code)} không có phiếu thu tự động còn hiệu lực` });
      await this.db.collection('sales_orders').updateOne(
        { _id: orderId },
        { $set: { payNowUndone: { at: now, byName: actor.name, reason }, updatedAt: now }, $inc: { version: 1 } },
        { session },
      );
      const codes = voided.map((payment) => String(payment.code));
      await this.audit.record(
        { actorId: request.user.sub, actorEmail: request.user.email, correlationId: request.correlationId, action: 'SALES_PAY_NOW_UNDONE', entityType: 'SalesOrder', entityId: id, metadata: { payments: codes, reason } },
        session,
      );
      return { id, voided: codes };
    });
  }

  async loanClose(id: string, input: LoanClose, request: AuthenticatedRequest, idempotencyKey: string | undefined) {
    return this.idempotency.execute(`sales-loan-close:${id}`, idempotencyKey, input, async (session) => {
      const loan = await this.openLoan(id, input.version, request, session);
      if (!loan.remaining.size) throw new ConflictException({ code: 'LOAN_CLOSED', message: 'Hàng của phiếu đã về đủ' });
      const remainder = [...loan.remaining].map(([productId, quantity]) => {
        const line = (loan.order.lines as Array<{ productId: unknown; sku: string; productName: string }>).find((item) => String(item.productId) === productId);
        return { productId: new ObjectId(productId), sku: String(line?.sku ?? ''), productName: String(line?.productName ?? ''), quantity: decimal(quantity.toString()) };
      });
      let returnCode: string | undefined;
      if (input.outcome === 'SOLD') {
        const returnDoc = await this.postLoanReturn(
          loan,
          [...loan.remaining].map(([productId, quantity]) => ({ productId, quantity })),
          `Chuyển bán phần hàng mẫu chưa về theo ${loan.code}: ${input.reason}`,
          request,
          session,
          { soldConversion: true },
        );
        returnCode = returnDoc.code;
      }
      const now = new Date();
      const updated = await this.db.collection('sales_orders').findOneAndUpdate(
        { _id: loan.order._id, version: input.version },
        {
          $set: {
            loanStatus: 'CLOSED', loanCloseOutcome: input.outcome, loanCloseReason: input.reason, loanClosedAt: now,
            loanClosedBy: toObjectId(request.user.sub), loanClosedByName: request.user.displayName, loanRemainder: remainder, updatedAt: now,
          },
          $inc: { version: 1 },
        },
        { session, returnDocument: 'after' },
      );
      if (!updated) throw new ConflictException({ code: 'ORDER_STATE_CONFLICT', message: 'Phiếu đã được người khác cập nhật — tải lại rồi thử lại' });
      await this.audit.record({
        actorId: request.user.sub, actorEmail: request.user.email, correlationId: request.correlationId,
        action: 'SALES_LOAN_CLOSED', entityType: 'SalesOrder', entityId: id,
        metadata: { outcome: input.outcome, reason: input.reason, remainder: remainder.map((line) => ({ sku: line.sku, quantity: decimalString(line.quantity) })), ...(returnCode ? { returnCode } : {}) },
      }, session);
      return { ...serializeDocument(updated), ...(returnCode ? { returnCode } : {}) };
    });
  }

  /**
   * Dư nợ xét hạn mức: khoản phải thu chưa thu + phiếu bán đã xuất kho chưa giao (chưa ghi công nợ — AR-DLV-01),
   * để hạn mức không bị nới khi công nợ chuyển sang ghi lúc giao thành công.
   */
  private async exposure(customerId: ObjectId, session?: ClientSession): Promise<string> {
    const [rows, pending] = await Promise.all([
      this.db.collection('receivables').aggregate(
        [
          { $match: { partnerId: customerId, status: { $in: ['OPEN', 'PARTIALLY_PAID', 'OVERDUE'] } } },
          { $group: { _id: null, total: { $sum: { $subtract: ['$amount', '$paidAmount'] } } } },
        ],
        session ? { session } : {},
      ).toArray(),
      pendingDeliveryOf(this.db, customerId, session),
    ]);
    return new Decimal(decimalString(rows[0]?.total ?? Decimal128.fromString('0'))).add(pending.amount).toString();
  }

  async submit(id: string, version: number, request: AuthenticatedRequest, idempotencyKey: string | undefined) {
    return this.idempotency.execute(
      `sales-order-submit:${id}`,
      idempotencyKey,
      { id, version },
      async (session) => {
          const orderId = toObjectId(id);
          const order = await this.db.collection('sales_orders').findOne(
            { _id: orderId, version, status: 'DRAFT' },
            { session },
          );
          if (!order) throw new ConflictException({ code: 'ORDER_STATE_CONFLICT', message: 'Phiếu không còn ở trạng thái nháp để phát hành' });
          if (!order.warehouseKeeperId) {
            throw new BadRequestException({ code: 'KEEPER_REQUIRED', message: 'Chọn thủ kho xuất hàng trước khi phát hành phiếu BH' });
          }
          // Thủ kho đã chọn phải còn được phân công bước 4 lúc phát hành (SAL-STEP-01).
          await this.loadKeeper((order.warehouseKeeperId as ObjectId).toHexString(), order.warehouseId as ObjectId, session, true);
          if (isNonSale(order)) return this.submitLoan(order, request, session);
          const customer = await this.loadCustomer(order.customerId as ObjectId, session);
          this.assertCustomerCanOrder(customer);
          const settings = await this.db.collection<{ _id: string } & Document>('settings').findOne({ _id: 'approval' }, { session });
          const highestDiscount = (order.lines as Array<{ discountRate: unknown }>).reduce(
            (highest, line) => Decimal.max(highest, decimalString(line.discountRate)),
            new Decimal(0),
          );
          const evaluation = evaluateApproval({
            orderTotal: decimalString(order.grandTotal),
            highestDiscountRate: highestDiscount.toString(),
            currentExposure: await this.exposure(order.customerId as ObjectId, session),
            creditLimit: decimalString(customer.creditLimit),
            orderApprovalThreshold: String(settings?.orderValueThreshold ?? '100000000'),
            discountApprovalThreshold: String(settings?.discountRateThreshold ?? '15'),
          });

          if (evaluation.required) {
            await this.db.collection('approval_requests').insertOne(
              {
                _id: new ObjectId(),
                entityType: 'SalesOrder',
                entityId: orderId,
                status: 'PENDING',
                reasons: evaluation.reasons,
                requestedBy: toObjectId(request.user.sub),
                requestedAt: new Date(),
              },
              { session },
            );
            await this.db.collection('sales_orders').updateOne(
              { _id: orderId, version },
              { $set: { status: 'PENDING_APPROVAL', approvalStatus: 'PENDING', issuedAt: new Date(), issuedBy: toObjectId(request.user.sub), issuedByName: request.user.displayName, updatedAt: new Date() }, $unset: { confirmationNote: '' }, $inc: { version: 1 } },
              { session },
            );
            await this.outbox.enqueue(
              {
                eventType: 'APPROVAL_REQUESTED',
                aggregateType: 'SalesOrder',
                aggregateId: id,
                payload: {
                  targetRoles: ['ADMIN', 'SALES_MANAGER', 'DIRECTOR'],
                  level: 'WARNING',
                  title: `Đơn bán ${String(order.code)} chờ phê duyệt`,
                  message: `Đơn của ${orderParty(order)} cần được xem xét trước khi giữ hàng.`,
                  href: `/sales/orders/${id}`,
                  reasons: evaluation.reasons,
                  template: 'SALES_APPROVAL_REQUESTED',
                  params: { code: String(order.code), customer: orderParty(order) },
                },
              },
              session,
            );
          } else {
            await this.inventory.reserve(
              orderId,
              (order.warehouseId as ObjectId).toHexString(),
              order.lines as Array<{ productId: string; baseQuantity: string }>,
              request.user.sub,
              session,
            );
            await this.db.collection('sales_orders').updateOne(
              { _id: orderId, version },
              {
                $set: { status: 'RESERVED', approvalStatus: 'NOT_REQUIRED', confirmationStatus: 'PENDING', issuedAt: new Date(), issuedBy: toObjectId(request.user.sub), issuedByName: request.user.displayName, updatedAt: new Date() },
                $unset: { confirmationNote: '' },
                $inc: { version: 1 },
              },
              { session },
            );
            await this.notify(session, id, {
              ...(await this.confirmationAudience(order, session)),
              level: 'INFO',
              title: `Phiếu ${String(order.code)} chờ đối chiếu với khách`,
              message: `Kiểm tra mã hàng, số lượng với ${orderParty(order)} trước khi chuyển kho xuất hàng.`,
              href: `/sales/orders/${id}`,
              template: 'SALES_CONFIRMATION_PENDING',
              params: { code: String(order.code), customer: orderParty(order) },
            });
          }
          await this.audit.record(
            {
              actorId: request.user.sub,
              actorEmail: request.user.email,
              correlationId: request.correlationId,
              action: evaluation.required ? 'SALES_ORDER_SUBMITTED_FOR_APPROVAL' : 'SALES_ORDER_AUTO_APPROVED',
              entityType: 'SalesOrder',
              entityId: id,
              metadata: { reasons: evaluation.reasons },
            },
            session,
          );
          return { id, status: evaluation.required ? 'PENDING_APPROVAL' : 'RESERVED', approval: evaluation };
      },
    );
  }

  /**
   * Phát hành phiếu hàng mẫu / kiểm định (SAL-TYPE-01): không khách nên không xét hạn mức / duyệt ngoại lệ, không qua bước KD đối chiếu —
   * giữ hàng rồi chuyển thẳng thủ kho lập SWK.
   */
  private async submitLoan(order: Document, request: AuthenticatedRequest, session: ClientSession) {
    const orderId = order._id as ObjectId;
    const id = orderId.toHexString();
    await this.inventory.reserve(orderId, (order.warehouseId as ObjectId).toHexString(), order.lines as Array<{ productId: string; baseQuantity: string }>, request.user.sub, session);
    const now = new Date();
    await this.db.collection('sales_orders').updateOne(
      { _id: orderId, version: order.version },
      {
        $set: { status: 'RESERVED', approvalStatus: 'NOT_REQUIRED', confirmationStatus: 'NOT_REQUIRED', issuedAt: now, issuedBy: toObjectId(request.user.sub), issuedByName: request.user.displayName, updatedAt: now },
        $unset: { confirmationNote: '' },
        $inc: { version: 1 },
      },
      { session },
    );
    await this.notify(session, id, {
      targetUserIds: await this.swkAudience(order, session),
      level: 'INFO',
      title: `Phiếu ${String(order.code)} chờ bạn lập SWK`,
      message: `Lập phiếu SWK và xuất hàng cho ${orderParty(order)}.`,
      href: '/inventory/shipments',
      template: 'SALES_READY_FOR_SWK',
      params: { code: String(order.code), customer: orderParty(order) },
    });
    await this.audit.record({
      actorId: request.user.sub, actorEmail: request.user.email, correlationId: request.correlationId,
      action: 'SALES_ORDER_AUTO_APPROVED', entityType: 'SalesOrder', entityId: id,
      metadata: { reasons: [], purpose: purposeOf(order) },
    }, session);
    return { id, status: 'RESERVED', approval: { required: false, reasons: [] } };
  }

  async approve(id: string, version: number, request: AuthenticatedRequest, idempotencyKey: string | undefined) {
    return this.idempotency.execute(
      `sales-order-approve:${id}`,
      idempotencyKey,
      { id, version },
      async (session) => {
          const orderId = toObjectId(id);
          const order = await this.db.collection('sales_orders').findOne(
            { _id: orderId, version, status: 'PENDING_APPROVAL', approvalStatus: 'PENDING' },
            { session },
          );
          if (!order) throw new ConflictException({ code: 'ORDER_STATE_CONFLICT', message: 'Đơn không còn chờ duyệt' });
          await this.inventory.reserve(
            orderId,
            (order.warehouseId as ObjectId).toHexString(),
            order.lines as Array<{ productId: string; baseQuantity: string }>,
            request.user.sub,
            session,
          );
          await Promise.all([
            this.db.collection('sales_orders').updateOne(
              { _id: orderId, version },
              { $set: { status: 'RESERVED', approvalStatus: 'APPROVED', confirmationStatus: 'PENDING', approvedAt: new Date(), approvedBy: toObjectId(request.user.sub), approvedByName: request.user.displayName, updatedAt: new Date() }, $unset: { confirmationNote: '' }, $inc: { version: 1 } },
              { session },
            ),
            this.db.collection('approval_requests').updateOne(
              { entityType: 'SalesOrder', entityId: orderId, status: 'PENDING' },
              { $set: { status: 'APPROVED', decidedAt: new Date(), decidedBy: toObjectId(request.user.sub) } },
              { session },
            ),
          ]);
          await this.audit.record(
            {
              actorId: request.user.sub,
              actorEmail: request.user.email,
              correlationId: request.correlationId,
              action: 'SALES_ORDER_APPROVED',
              entityType: 'SalesOrder',
              entityId: id,
            },
            session,
          );
          await this.notify(session, id, {
            ...(await this.confirmationAudience(order, session)),
            level: 'INFO',
            title: `Phiếu ${String(order.code)} đã duyệt, chờ đối chiếu với khách`,
            message: `Kiểm tra mã hàng, số lượng với ${orderParty(order)} trước khi chuyển kho xuất hàng.`,
            href: `/sales/orders/${id}`,
            template: 'SALES_APPROVED_CONFIRMATION_PENDING',
            params: { code: String(order.code), customer: orderParty(order) },
          });
          return { id, status: 'RESERVED' };
      },
    );
  }

  /**
   * Bước 3: kho lập phiếu xuất kho bán hàng số SWK, trừ tồn. Công nợ và doanh thu ghi khi xác nhận giao thành công
   * (AR-DLV-01, 28/10/2026 — thủ kho có thể lập SWK để chuẩn bị hàng, vài ngày / vài tuần sau mới giao).
   */
  async ship(id: string, input: WarehouseIssue, request: AuthenticatedRequest, idempotencyKey: string | undefined) {
    const { version } = input;
    return this.idempotency.execute(
      `sales-order-ship:${id}`,
      idempotencyKey,
      input,
      async (session) => {
          const orderId = toObjectId(id);
          const order = await this.db.collection('sales_orders').findOne({ _id: orderId, version, status: 'RESERVED' }, { session });
          if (!order) throw new ConflictException({ code: 'ORDER_STATE_CONFLICT', message: 'Phiếu chưa sẵn sàng xuất kho' });
          if (!isAssignedKeeper(request.user, order)) {
            throw new ForbiddenException({ code: 'NOT_ASSIGNED_KEEPER', message: `Phiếu ${String(order.code)} được giao cho thủ kho ${String(order.warehouseKeeperName ?? 'khác')}` });
          }
          if (order.confirmationStatus && !['CONFIRMED', 'NOT_REQUIRED'].includes(String(order.confirmationStatus))) {
            throw new ConflictException({ code: 'CUSTOMER_NOT_CONFIRMED', message: 'Nhân viên kinh doanh chưa xác nhận khách đã đối chiếu phiếu BH' });
          }
          // Phiếu không phải bán: thẻ kho ghi "Hàng mẫu xuất" / "Xuất kiểm định" / "Hàng tặng", không công nợ (SAL-TYPE-01);
          // chỉ hàng mẫu / kiểm định theo dõi hàng mang về.
          const nonSalePurpose = isNonSalePurpose(order.purpose) ? order.purpose : null;
          const loanPurpose = isLoanPurpose(order.purpose) ? order.purpose : null;
          const customer = nonSalePurpose ? null : await this.db.collection('partners').findOne({ _id: order.customerId }, { session });
          if (!nonSalePurpose && !customer) throw new NotFoundException({ code: 'CUSTOMER_NOT_FOUND', message: 'Không tìm thấy khách hàng' });
          // Phiếu kho cùng số với phiếu BH (yêu cầu của Ban Giám đốc 12/10/2026): BH2026100104 → SWK2026100104.
          const shipmentCode = await this.warehouseSlipCode(String(order.code), session);
          await this.inventory.shipReserved(
            orderId,
            (order.warehouseId as ObjectId).toHexString(),
            order.lines as Array<{ productId: string; baseQuantity: string; gift?: boolean }>,
            request.user.sub,
            shipmentCode,
            session,
            String(order.code),
            nonSalePurpose ? nonSaleOutCategory(nonSalePurpose) : undefined,
          );
          const now = new Date();
          const shipmentId = new ObjectId();
          await Promise.all([
            this.db.collection('shipments').insertOne(
              {
                _id: shipmentId,
                code: shipmentCode,
                salesOrderId: orderId,
                warehouseId: order.warehouseId,
                ...(order.customerId ? { customerId: order.customerId } : {}),
                ...(nonSalePurpose ? { purpose: nonSalePurpose } : {}),
                lines: order.lines,
                status: 'SHIPPED',
                shippedAt: now,
                shippedBy: toObjectId(request.user.sub),
                shippedByName: request.user.displayName,
                receiverName: input.receiverName,
                carrier: input.carrier,
                note: input.note,
                version: 1,
                createdAt: now,
                updatedAt: now,
              },
              { session },
            ),
            this.db.collection('sales_orders').updateOne(
              { _id: orderId, version },
              {
                $set: {
                  status: 'SHIPPED', shippedAt: now, updatedAt: now, warehouseSlipNo: shipmentCode, shippedByName: request.user.displayName,
                  ...(loanPurpose ? { loanStatus: 'OUT' } : {}),
                  ...(input.receiverName ? { receiverName: input.receiverName } : {}),
                  ...(input.carrier ? { carrier: input.carrier } : {}),
                  ...(input.note ? { warehouseNote: input.note } : {}),
                },
                $inc: { version: 1 },
              },
              { session },
            ),
          ]);
          await this.audit.record(
            {
              actorId: request.user.sub,
              actorEmail: request.user.email,
              correlationId: request.correlationId,
              action: 'SALES_ORDER_SHIPPED',
              entityType: 'SalesOrder',
              entityId: id,
              metadata: { shipmentCode, ...(nonSalePurpose ? { purpose: nonSalePurpose } : {}) },
            },
            session,
          );
          if (!nonSalePurpose) {
            await this.notify(session, id, {
              targetUserIds: (await this.deliverers(order, session, [request.user.sub])).map((user) => user.id),
              level: 'INFO',
              title: `Phiếu ${String(order.code)} đã xuất kho (${shipmentCode}) — chờ xác nhận giao hàng`,
              message: `Xác nhận khi ${orderParty(order)} đã nhận hàng.`,
              href: `/sales/orders/${id}`,
              template: 'SALES_DELIVERY_PENDING',
              params: { code: String(order.code), slip: shipmentCode, customer: orderParty(order) },
            });
          }
          return { id, status: 'SHIPPED', shipmentCode };
      },
    );
  }

  /**
   * Bước 2: nhân viên kinh doanh đối chiếu phiếu BH với khách (mã hàng, số lượng, giá).
   * Khách đồng ý → chuyển kho lập phiếu SWK. Cần sửa → nhả hàng đã giữ, trả phiếu về kế toán ở trạng thái nháp.
   */
  async confirmCustomer(id: string, input: CustomerConfirmation, request: AuthenticatedRequest, idempotencyKey: string | undefined) {
    return this.idempotency.execute(
      `sales-order-confirm:${id}`,
      idempotencyKey,
      input,
      async (session) => {
        const orderId = toObjectId(id);
        const order = await this.db.collection('sales_orders').findOne(
          { _id: orderId, version: input.version, status: 'RESERVED', confirmationStatus: 'PENDING' },
          { session },
        );
        if (!order) throw new ConflictException({ code: 'ORDER_STATE_CONFLICT', message: 'Phiếu không còn chờ đối chiếu với khách' });
        const now = new Date();
        const evidence = await this.linkEvidence(orderId, input.evidenceIds, input.decision, session);
        if (input.decision === 'CONFIRMED' && evidence.length === 0) {
          throw new BadRequestException({ code: 'EVIDENCE_REQUIRED', message: 'Cần đính kèm ít nhất 1 ảnh chụp màn hình xác nhận trước khi chuyển kho' });
        }
        if (input.decision === 'CONFIRMED') {
          await this.db.collection('sales_orders').updateOne(
            { _id: orderId, version: input.version },
            {
              $set: { confirmationStatus: 'CONFIRMED', confirmedAt: now, confirmedBy: toObjectId(request.user.sub), confirmedByName: request.user.displayName, updatedAt: now, ...(input.note ? { confirmationNote: input.note } : {}) },
              $push: { confirmationEvidence: { $each: evidence } },
              $inc: { version: 1 },
            } as Document,
            { session },
          );
          await this.notify(session, id, {
            targetUserIds: await this.swkAudience(order, session),
            level: 'INFO',
            title: `Phiếu ${String(order.code)} đã đối chiếu xong — chờ bạn lập SWK`,
            message: `Lập phiếu SWK và xuất hàng cho ${orderParty(order)}.`,
            href: '/inventory/shipments',
            template: 'SALES_READY_FOR_SWK',
            params: { code: String(order.code), customer: orderParty(order) },
          });
        } else {
          await this.inventory.release(orderId, session);
          await this.db.collection('sales_orders').updateOne(
            { _id: orderId, version: input.version },
            {
              $set: {
                status: 'DRAFT', approvalStatus: 'NOT_REQUIRED', confirmationStatus: 'REVISION_REQUESTED', confirmationNote: input.note,
                revisionRequestedAt: now, revisionRequestedBy: toObjectId(request.user.sub), revisionRequestedByName: request.user.displayName, updatedAt: now,
              },
              ...(evidence.length ? { $push: { confirmationEvidence: { $each: evidence } } } : {}),
              $inc: { version: 1 },
            } as Document,
            { session },
          );
          await this.notify(session, id, {
            targetUserIds: await this.stepAudience('sales.step.issue', session, { exclude: [request.user.sub] }),
            level: 'WARNING',
            title: `Phiếu ${String(order.code)} cần sửa`,
            message: `${request.user.displayName}: ${input.note ?? ''}`,
            href: `/sales/orders/${id}`,
            template: 'SALES_REVISION_REQUESTED',
            params: { code: String(order.code), actor: request.user.displayName, note: input.note ?? '' },
          });
        }
        await this.audit.record(
          {
            actorId: request.user.sub,
            actorEmail: request.user.email,
            correlationId: request.correlationId,
            action: input.decision === 'CONFIRMED' ? 'SALES_ORDER_CUSTOMER_CONFIRMED' : 'SALES_ORDER_REVISION_REQUESTED',
            entityType: 'SalesOrder',
            entityId: id,
            metadata: { note: input.note, evidence: evidence.map((item) => ({ id: item.id, fileName: item.fileName, sha256: item.sha256 })) },
          },
          session,
        );
        return { id, decision: input.decision, evidence };
      },
    );
  }

  /**
   * Bước 5 — xác nhận giao hàng thành công (SAL-STEP-01): người được phân công bước 5; người có vai trò kho chỉ phiếu mình là thủ kho,
   * người khác được phân bước 5 xác nhận mọi phiếu đã xuất. Lưu người xác nhận.
   * Phiếu bán: ghi doanh thu và công nợ tại đây (AR-DLV-01, 28/10/2026), hạn thanh toán = ngày giao + số ngày nợ; báo kế toán.
   */
  async deliver(id: string, version: number, request: AuthenticatedRequest, idempotencyKey: string | undefined) {
    return this.idempotency.execute(
      `sales-order-deliver:${id}`,
      idempotencyKey,
      { id, version },
      async (session) => {
        const orderId = toObjectId(id);
        const now = new Date();
        const order = await this.db.collection('sales_orders').findOne({ _id: orderId }, { session });
        if (order && !canDeliverSalesOrder(request.user, order)) {
          throw new ForbiddenException({ code: 'NOT_ASSIGNED_KEEPER', message: `Phiếu ${String(order.code)} được giao cho thủ kho ${String(order.warehouseKeeperName ?? 'khác')}` });
        }
        const deliveredBy = { deliveredBy: toObjectId(request.user.sub), deliveredByName: request.user.displayName };
        const updated = await this.db.collection('sales_orders').updateOne(
          { _id: orderId, version, status: 'SHIPPED' },
          { $set: { status: 'DELIVERED', deliveredAt: now, ...deliveredBy, updatedAt: now }, $inc: { version: 1 } },
          { session },
        );
        if (!order || updated.modifiedCount !== 1) {
          throw new ConflictException({ code: 'ORDER_STATE_CONFLICT', message: 'Chỉ xác nhận giao cho đơn đã xuất kho' });
        }
        const shipment = await this.db.collection('shipments').findOneAndUpdate(
          { salesOrderId: orderId, status: 'SHIPPED' },
          { $set: { status: 'DELIVERED', deliveredAt: now, ...deliveredBy, updatedAt: now } },
          { session, returnDocument: 'after' },
        );
        const receivable = await this.postOrderReceivable(order, (shipment?._id as ObjectId | undefined) ?? null, now, session);
        // Đơn thanh toán ngay (AR-PAYNOW-01): ghi luôn phiếu thu — tiền thu khi giao hàng.
        const payNow = receivable?.payNow ? await postPayNowReceipt(this.db, this.sequences, { receivable: receivable.document, order, receivedAt: now, actor: PAY_NOW_ACTOR }, session, now) : null;
        await this.audit.record(
          {
            actorId: request.user.sub,
            actorEmail: request.user.email,
            correlationId: request.correlationId,
            action: 'SALES_ORDER_DELIVERED',
            entityType: 'SalesOrder',
            entityId: id,
            metadata: {
              byAssignedKeeper: (order.warehouseKeeperId as ObjectId | undefined)?.toHexString() === request.user.sub,
              ...(receivable ? { receivableId: receivable.id.toHexString(), dueDate: receivable.dueDate.toISOString() } : {}),
              ...(payNow ? { payNowReceipt: String(payNow.code) } : {}),
            },
          },
          session,
        );
        if (receivable) {
          await this.notify(session, id, {
            targetRoles: ['ACCOUNTANT'],
            level: 'INFO',
            title: payNow
              ? `Phiếu ${String(order.code)} đã giao thành công — thanh toán ngay, đã tự ghi thu ${decimalString(payNow.amount)} đ (${String(payNow.code)})`
              : `Phiếu ${String(order.code)} đã giao thành công — ghi công nợ ${decimalString(order.grandTotal)} đ`,
            message: payNow
              ? `${orderParty(order)} · ${payNow.method === 'CASH' ? 'tiền mặt' : 'chuyển khoản'} — chưa nhận được tiền thì "Bỏ ghi thu tự động" trên phiếu`
              : `${orderParty(order)} · hạn thanh toán ${vnDate(receivable.dueDate)}`,
            href: `/sales/orders/${id}`,
            template: 'SALES_DELIVERED_RECEIVABLE',
            params: { code: String(order.code), customer: orderParty(order), amount: decimalString(order.grandTotal), due: vnDate(receivable.dueDate) },
          });
        }
        return { id, status: 'DELIVERED', ...(receivable ? { receivableId: receivable.id.toHexString() } : {}) };
      },
    );
  }

  /**
   * Ghi khoản phải thu của phiếu bán khi giao thành công (AR-DLV-01). Bỏ qua phiếu không phải bán (mẫu / kiểm định / tặng)
   * và phiếu đã có khoản phải thu (SWK lập trước 28/10/2026 — khi đó công nợ ghi lúc xuất kho).
   */
  private async postOrderReceivable(order: Document, shipmentId: ObjectId | null, at: Date, session: ClientSession): Promise<{ id: ObjectId; dueDate: Date; payNow: boolean; document: Document } | null> {
    if (isNonSalePurpose(order.purpose) || !order.customerId) return null;
    const orderId = order._id as ObjectId;
    const existing = await this.db.collection('receivables').findOne(
      { salesOrderId: orderId, sourceType: { $ne: 'SALES_VOID_CREDIT' }, status: { $ne: 'VOIDED' } },
      { session, projection: { _id: 1 } },
    );
    if (existing) return null;
    const customer = await this.db.collection('partners').findOne({ _id: order.customerId as ObjectId }, { session, projection: { paymentTermDays: 1 } });
    const dueDate = new Date(at);
    const termDays = Number(order.paymentTermDays ?? customer?.paymentTermDays ?? 0);
    dueDate.setUTCDate(dueDate.getUTCDate() + termDays);
    const grandTotal = decimalString(order.grandTotal);
    // Phần nợ của nhóm công nợ tách riêng (CN-SEG-01 — VD quạt & vợt muỗi): theo dõi riêng, không tính quá hạn.
    const segments = orderSegments(orderLinesForSegments(order), String(order.taxRate ?? '8'), grandTotal, rulesFor(String(order.customerId), await loadSegmentRules(this.db, session)));
    const id = new ObjectId();
    const document: Document = {
      _id: id,
      code: await this.sequences.next('AR', session),
      partnerId: order.customerId,
      salesOrderCode: order.code,
      salesOrderId: orderId,
      ...(shipmentId ? { shipmentId } : {}),
      amount: decimal(grandTotal),
      paidAmount: decimal('0'),
      dueDate,
      // Phiếu 0 đ: không có gì phải thu.
      status: new Decimal(grandTotal).isZero() ? 'PAID' : 'OPEN',
      ...(segments.length ? { segments: segments.map((part) => ({ code: part.code, amount: decimal(part.amount), paid: decimal('0') })) } : {}),
      createdAt: at,
      updatedAt: at,
      version: 1,
    };
    await this.db.collection('receivables').insertOne(document, { session });
    return { id, dueDate, payNow: termDays === 0 && Boolean(order.payNowMethod) && new Decimal(grandTotal).gt(0), document };
  }

  // ------------------------------------------------------------------------------------------------
  // Ảnh bằng chứng đối chiếu với khách (VD: ảnh chụp tin nhắn Zalo "xuất đi em, đúng rồi").

  /** Tải lên một ảnh (thân request là dữ liệu ảnh nhị phân). Ảnh ở trạng thái chờ cho tới khi gắn vào lần xác nhận. */
  async uploadEvidence(id: string, body: unknown, fileNameHeader: string | undefined, request: AuthenticatedRequest): Promise<AttachmentMeta> {
    const orderId = toObjectId(id);
    const order = await this.db.collection('sales_orders').findOne({ _id: orderId }, { projection: { code: 1, status: 1, confirmationStatus: 1 } });
    if (!order) throw new NotFoundException({ code: 'SALES_ORDER_NOT_FOUND', message: 'Không tìm thấy phiếu' });
    if (order.status !== 'RESERVED' || order.confirmationStatus !== 'PENDING') {
      throw new ConflictException({ code: 'ORDER_STATE_CONFLICT', message: 'Chỉ đính kèm bằng chứng khi phiếu đang chờ đối chiếu với khách' });
    }
    const document = await this.evidence.accept(body, fileNameHeader, {
      entityType: 'SalesOrder',
      entityId: orderId,
      code: String(order.code),
      purpose: EVIDENCE_PURPOSE,
      keyPrefix: 'sales-evidence',
      auditPrefix: 'SALES_ORDER_EVIDENCE',
      href: `/sales/orders/${id}`,
      fallbackName: `bang-chung-${String(order.code)}`,
      limit: MAX_PENDING_EVIDENCE,
      status: 'PENDING',
      expiresAt: new Date(Date.now() + PENDING_EVIDENCE_TTL_MS),
    }, request);
    return this.evidence.meta(document);
  }

  /** Đọc ảnh bằng chứng — người xem phải có quyền xem phiếu (thủ kho chỉ xem phiếu được giao). */
  async readEvidence(id: string, attachmentId: string, user: RequestUser) {
    const orderId = toObjectId(id);
    const visible = await this.db.collection('sales_orders').countDocuments({ _id: orderId, ...salesOrderScope(user) });
    const attachment = visible
      ? await this.db.collection('attachments').findOne({ _id: toObjectId(attachmentId, 'attachmentId'), entityId: orderId, purpose: EVIDENCE_PURPOSE })
      : null;
    if (!attachment) throw new NotFoundException({ code: 'ATTACHMENT_NOT_FOUND', message: 'Không tìm thấy ảnh' });
    return this.evidence.read(attachment);
  }

  /** Xóa ảnh đã tải lên nhưng chưa dùng để xác nhận (ảnh đã gắn vào phiếu là vết, không xóa được). */
  async deletePendingEvidence(id: string, attachmentId: string, request: AuthenticatedRequest) {
    const filter = {
      _id: toObjectId(attachmentId, 'attachmentId'),
      entityId: toObjectId(id),
      purpose: EVIDENCE_PURPOSE,
      status: 'PENDING',
      ...(request.user.roles.includes('ADMIN') ? {} : { uploadedBy: toObjectId(request.user.sub) }),
    };
    const attachment = await this.db.collection('attachments').findOne(filter, { projection: { storage: 1 } });
    if (attachment) await this.evidence.removeStored(attachment);
    const result = attachment ? await this.db.collection('attachments').deleteOne(filter) : { deletedCount: 0 };
    if (result.deletedCount !== 1) {
      throw new NotFoundException({ code: 'ATTACHMENT_NOT_FOUND', message: 'Ảnh không tồn tại hoặc đã được dùng để xác nhận' });
    }
    return { id: attachmentId, deleted: true };
  }

  /** Gắn các ảnh đã tải lên vào lần đối chiếu: chuyển sang "đã gắn" (không còn tự xóa) và trả về thông tin lưu trên phiếu. */
  private async linkEvidence(orderId: ObjectId, evidenceIds: string[], decision: 'CONFIRMED' | 'REVISION_REQUESTED', session: ClientSession) {
    const ids = [...new Set(evidenceIds)].map((value) => toObjectId(value, 'evidenceIds'));
    if (!ids.length) return [];
    const rows = await this.db.collection('attachments')
      .find({ _id: { $in: ids }, entityId: orderId, purpose: EVIDENCE_PURPOSE, status: 'PENDING' }, { session, projection: { data: 0 } })
      .toArray();
    if (rows.length !== ids.length) {
      throw new BadRequestException({ code: 'EVIDENCE_INVALID', message: 'Ảnh bằng chứng không hợp lệ hoặc đã hết hạn, hãy tải lại' });
    }
    const now = new Date();
    await this.db.collection('attachments').updateMany(
      { _id: { $in: ids } },
      { $set: { status: 'LINKED', linkedAt: now, decision }, $unset: { expiresAt: '' } },
      { session },
    );
    return rows.map((row) => ({ ...this.evidence.meta(row), uploadedAt: row.uploadedAt as Date, decision }));
  }
}
