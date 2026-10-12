import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { AttachmentMeta, CreateSalesOrder, CustomerConfirmation, DiscardSalesOrder, NotificationTemplate, SalesPriceSheet, SalesQuote, SalesQuoteRequest, TextParams, UpdateSalesOrder, WarehouseIssue, WarehouseKeeper } from '@inoxpran/contracts';
import { CANCELLABLE_SALES_STATUSES, salesIssueTemplate } from '@inoxpran/contracts';
import Decimal from 'decimal.js';
import type { ClientSession, Db, Document } from 'mongodb';
import { Decimal128, ObjectId } from 'mongodb';
import { assertWarehouseAccess } from '../../common/access';
import { AuditService } from '../../common/audit.service';
import { decimal, decimalString, serializeDocument, toObjectId, vnDayStart } from '../../common/domain';
import { EvidenceIntakeService } from '../../common/evidence-intake.service';
import { IdempotencyService } from '../../common/idempotency.service';
import { OutboxService } from '../../common/outbox.service';
import type { AuthenticatedRequest, RequestUser } from '../../common/request-context';
import { SequenceService } from '../../common/sequence.service';
import { MONGO_DATABASE } from '../../common/tokens';
import { pageOf, type PageRequest } from '../../common/paging';
import { InventoryService } from '../inventory/inventory.service';
import { evaluateApproval } from './approval.engine';
import { isAssignedKeeper, KEEPER_ROLES, salesOrderScope } from './keeper-scope';

const EVIDENCE_PURPOSE = 'CONFIRMATION_EVIDENCE';
/** Ảnh tải lên nhưng chưa gắn vào lần xác nhận nào: worker xóa cả file S3 và bản ghi sau 24 giờ. */
const PENDING_EVIDENCE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_PENDING_EVIDENCE = 20;
import { PricingService } from './pricing.service';

/** Vai trò được tự nhập / đổi số phiếu BH. */
const NUMBERING_ROLES = ['ACCOUNTANT', 'ADMIN'];

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
  ) {}

  async list(user: RequestUser, status?: string, search?: string, channel?: string, customerId?: string, confirmation?: string, paging: PageRequest | null = null) {
    const filter: Document = {};
    if (status) filter.status = status;
    if (confirmation) filter.confirmationStatus = confirmation;
    if (channel) filter.channel = channel;
    if (customerId) filter.customerId = toObjectId(customerId, 'customerId');
    if (search) {
      const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.$or = [
        { code: { $regex: escaped, $options: 'i' } },
        { warehouseSlipNo: { $regex: escaped, $options: 'i' } },
        { customerName: { $regex: escaped, $options: 'i' } },
        { customerCode: { $regex: escaped, $options: 'i' } },
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
    return serializeDocument(row);
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
    const priced = await this.pricing.priceLines(lines, customer, undefined, input.taxRate);
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
          listUnitPrice: line.listUnitPrice,
          unitPrice: line.unitPrice,
          discountRate: line.discountRate,
          tierDiscountRate: line.tierDiscountRate,
          salesTierDiscountRate: line.salesTierDiscountRate,
          promotionDiscountRate: line.promotionDiscountRate,
          ...(line.promotionCode ? { promotionCode: line.promotionCode } : {}),
          netAmount: line.netAmount,
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
  async priceSheet(customerId: string, warehouseId: string): Promise<SalesPriceSheet> {
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
      })),
    };
  }

  /** Tài khoản thủ kho đang hoạt động có phạm vi kho xuất — danh sách cho ô "Thủ kho xuất hàng" trên phiếu BH. */
  async warehouseKeepers(warehouseId: string): Promise<WarehouseKeeper[]> {
    const rows = await this.db.collection('users')
      .find(
        { status: 'ACTIVE', roles: { $in: KEEPER_ROLES }, warehouseScopes: toObjectId(warehouseId, 'warehouseId').toHexString() },
        { projection: { displayName: 1, title: 1, email: 1 } },
      )
      .sort({ displayName: 1 })
      .toArray();
    return rows.map((row) => ({
      id: (row._id as ObjectId).toHexString(),
      displayName: String(row.displayName),
      email: String(row.email),
      ...(row.title ? { title: String(row.title) } : {}),
    }));
  }

  private async loadKeeper(keeperId: string, warehouseId: ObjectId, session: ClientSession) {
    const keeper = await this.db.collection('users').findOne(
      { _id: toObjectId(keeperId, 'warehouseKeeperId'), status: 'ACTIVE', roles: { $in: KEEPER_ROLES } },
      { session, projection: { displayName: 1, warehouseScopes: 1 } },
    );
    if (!keeper) throw new BadRequestException({ code: 'KEEPER_NOT_FOUND', message: 'Không tìm thấy tài khoản thủ kho đang hoạt động' });
    if (!((keeper.warehouseScopes as string[] | undefined) ?? []).includes(warehouseId.toHexString())) {
      throw new BadRequestException({ code: 'KEEPER_WAREHOUSE_MISMATCH', message: `${String(keeper.displayName)} không phụ trách kho xuất đã chọn` });
    }
    return keeper;
  }

  /** Dựng nội dung phiếu xuất kho bán hàng từ dữ liệu nhập: thông tin người mua, nhân viên, giá và tổng tiền. */
  private async composeOrder(input: CreateSalesOrder, session: ClientSession) {
    const customerId = toObjectId(input.customerId, 'customerId');
    const warehouseId = toObjectId(input.warehouseId, 'warehouseId');
    const [customer, warehouse] = await Promise.all([
      this.loadCustomer(customerId, session),
      this.db.collection('warehouses').findOne({ _id: warehouseId, active: true, purpose: { $ne: 'DEFECTIVE' } }, { session }),
    ]);
    this.assertCustomerCanOrder(customer);
    if (!warehouse) throw new NotFoundException({ code: 'WAREHOUSE_NOT_FOUND', message: 'Không tìm thấy kho hoạt động' });
    const now = new Date();
    const orderDate = input.orderDate ? new Date(`${input.orderDate}T00:00:00+07:00`) : now;
    if (orderDate > now) {
      throw new BadRequestException({ code: 'ORDER_DATE_IN_FUTURE', message: 'Ngày chứng từ không được lớn hơn ngày hiện tại' });
    }
    if (input.requestedDeliveryDate && new Date(`${input.requestedDeliveryDate}T00:00:00+07:00`) < vnDayStart(orderDate)) {
      throw new BadRequestException({ code: 'DELIVERY_BEFORE_ORDER', message: 'Ngày giao dự kiến phải lớn hơn hoặc bằng ngày chứng từ' });
    }
    const template = salesIssueTemplate(input.templateCode);
    if (template.vatMode !== 'DOCUMENT') {
      throw new BadRequestException({ code: 'TEMPLATE_NOT_SUPPORTED', message: `Mẫu ${template.code} chưa được hỗ trợ tính thuế` });
    }
    if (!input.lines.some((line) => !line.gift)) {
      throw new BadRequestException({ code: 'ONLY_GIFT_LINES', message: 'Phiếu cần ít nhất một dòng hàng bán (không phải hàng tặng)' });
    }
    const salesRepId = input.salesRepId ? toObjectId(input.salesRepId, 'salesRepId') : (customer.salesRepId as ObjectId | undefined);
    const salesRep = salesRepId ? await this.db.collection('employees').findOne({ _id: salesRepId }, { session }) : null;
    if (input.salesRepId && !salesRep) {
      throw new NotFoundException({ code: 'SALES_REP_NOT_FOUND', message: 'Không tìm thấy nhân viên kinh doanh' });
    }
    const keeper = input.warehouseKeeperId ? await this.loadKeeper(input.warehouseKeeperId, warehouseId, session) : null;
    const priced = await this.pricing.priceLines(input.lines, customer, session, input.taxRate);
    return {
      customer,
      orderDate,
      keeper,
      fields: {
        customerId,
        customerCode: customer.code,
        customerName: customer.name,
        customerTier: customer.customerTier,
        province: customer.province,
        regionCode: customer.regionCode,
        buyer: { code: customer.code, name: customer.name, address: customer.address, phone: customer.phone, taxCode: customer.taxCode },
        contactName: input.contactName,
        description: input.description || `Bán hàng ${String(customer.name)}`,
        deliveryLocation: input.deliveryLocation,
        warehouseId,
        ...(keeper ? { warehouseKeeperId: keeper._id as ObjectId, warehouseKeeperName: String(keeper.displayName) } : {}),
        channel: input.channel,
        ...(salesRep ? { salesRepId: salesRep._id, salesRepName: salesRep.name } : {}),
        orderDate,
        paymentTermDays: input.paymentTermDays ?? Number(customer.paymentTermDays ?? 0),
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
          pricingSource: line.pricingSource,
          ...(line.promotionCode ? { promotionCode: line.promotionCode } : {}),
          quantity: decimal(line.quantity),
          baseQuantity: decimal(line.baseQuantity),
          listUnitPrice: decimal(line.listUnitPrice),
          unitPrice: decimal(line.unitPrice),
          discountRate: decimal(line.discountRate),
          tierDiscountRate: decimal(line.tierDiscountRate),
          salesTierDiscountRate: decimal(line.salesTierDiscountRate),
          promotionDiscountRate: decimal(line.promotionDiscountRate),
          netAmount: decimal(line.netAmount),
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
    await this.outbox.enqueue({ eventType: 'NOTIFICATION_REQUESTED', aggregateType: 'SalesOrder', aggregateId, payload: { category: 'SALES_ISSUE', ...payload } }, session);
  }

  /** Chỉ kế toán (và Admin) đặt / đổi số phiếu BH; nhân viên kinh doanh gửi đề nghị luôn nhận số tự sinh. */
  private assertCanNumber(request: AuthenticatedRequest) {
    if (!request.user.roles.some((role) => NUMBERING_ROLES.includes(role))) {
      throw new ForbiddenException({ code: 'SALES_ORDER_CODE_FORBIDDEN', message: 'Chỉ kế toán được tự nhập số phiếu BH' });
    }
  }

  /** Hai người lưu cùng một số tự nhập cùng lúc: chỉ mục duy nhất chặn người sau → báo trùng số thay vì lỗi chung. */
  private codeConflict(error: unknown, code: string): never {
    if ((error as { code?: number; keyPattern?: Record<string, unknown> } | null)?.code === 11000 && (error as { keyPattern?: Record<string, unknown> }).keyPattern?.code) {
      throw new ConflictException({ code: 'SALES_ORDER_CODE_EXISTS', message: `Số phiếu ${code} đã được dùng cho phiếu BH khác`, details: { code } });
    }
    throw error;
  }

  /** Số phiếu tự nhập không được trùng phiếu BH khác (kể cả phiếu đã hủy). */
  private async assertCodeFree(code: string, session: ClientSession, exceptId?: ObjectId): Promise<string> {
    const taken = await this.db.collection('sales_orders').findOne({ code, ...(exceptId ? { _id: { $ne: exceptId } } : {}) }, { session, projection: { _id: 1 } });
    if (taken) throw new ConflictException({ code: 'SALES_ORDER_CODE_EXISTS', message: `Số phiếu ${code} đã được dùng cho phiếu BH khác`, details: { code } });
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

  /** Số tự sinh BHyyyymm####; bỏ qua số đã bị dùng bởi phiếu tự nhập trùng định dạng. */
  private async nextAutoCode(orderDate: Date, session: ClientSession): Promise<string> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const code = await this.sequences.next('BH', session, 4, orderDate, 'compact');
      if (!(await this.db.collection('sales_orders').findOne({ code }, { session, projection: { _id: 1 } }))) return code;
    }
    throw new ConflictException({ code: 'SALES_ORDER_CODE_EXISTS', message: 'Không sinh được số phiếu BH mới, vui lòng thử lại' });
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
        const { fields, orderDate } = await this.composeOrder(input, session);
        const now = new Date();
        const requestedBySales = !request.user.roles.some((role) => ['ACCOUNTANT', 'ADMIN'].includes(role));
        if (input.code) {
          this.assertCanNumber(request);
          await this.assertNotOpeningDocument(input.code, toObjectId(input.customerId, 'customerId'), session);
        }
        const code = input.code ? await this.assertCodeFree(input.code, session) : await this.nextAutoCode(orderDate, session);
        const document = {
          _id: new ObjectId(),
          code,
          codeMode: input.code ? 'MANUAL' : 'AUTO',
          ...fields,
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
        if (requestedBySales) {
          await this.notify(session, document._id.toHexString(), {
            targetRoles: ['ACCOUNTANT'],
            level: 'INFO',
            title: `Đề nghị lập phiếu xuất kho ${document.code}`,
            message: `${request.user.displayName} đề nghị xuất bán cho ${String(fields.customerName)}.`,
            href: `/sales/orders/${document._id.toHexString()}`,
            template: 'SALES_ISSUE_REQUESTED',
            params: { code: document.code, requester: request.user.displayName, customer: String(fields.customerName) },
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
        const { fields, keeper, orderDate } = await this.composeOrder(payload, session);
        // Số phiếu khi sửa: bỏ trống = giữ số cũ; nhập số khác = đổi sang số tự nhập (kiểm tra trùng);
        // chọn lại "Tự sinh" trên phiếu đang mang số tự nhập = cấp số tự sinh mới.
        let codeChange: { code?: string; codeMode?: 'AUTO' | 'MANUAL' } = {};
        if (input.code && input.code !== before.code) {
          this.assertCanNumber(request);
          codeChange = { code: await this.assertCodeFree(input.code, session, orderId), codeMode: 'MANUAL' };
        } else if (!input.code && input.codeMode === 'AUTO' && before.codeMode === 'MANUAL') {
          this.assertCanNumber(request);
          codeChange = { code: await this.nextAutoCode(orderDate, session), codeMode: 'AUTO' };
        }
        // Số tự nhập (mới đặt, hoặc giữ nguyên nhưng đổi sang khách khác) không được trùng chứng từ công nợ đầu kỳ của khách.
        const finalManualCode = codeChange.codeMode === 'MANUAL' ? codeChange.code : !codeChange.code && before.codeMode === 'MANUAL' ? String(before.code) : undefined;
        if (finalManualCode && (codeChange.codeMode === 'MANUAL' || String(before.customerId) !== input.customerId)) {
          await this.assertNotOpeningDocument(finalManualCode, toObjectId(input.customerId, 'customerId'), session);
        }
        const updated = await this.db.collection('sales_orders').findOneAndUpdate(
          { _id: orderId, version: input.version, status: 'DRAFT' },
          {
            $set: { ...fields, ...codeChange, updatedAt: new Date(), updatedByName: request.user.displayName },
            ...(keeper ? {} : { $unset: { warehouseKeeperId: '', warehouseKeeperName: '' } }),
            $inc: { version: 1 },
          },
          { session, returnDocument: 'after' },
        ).catch((error: unknown) => this.codeConflict(error, codeChange.code ?? ''));
        if (!updated) throw new ConflictException({ code: 'ORDER_STATE_CONFLICT', message: 'Phiếu đã được người khác cập nhật' });
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
    return this.idempotency.execute(`sales-order-cancel:${id}`, idempotencyKey, input, async (session) => {
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
          message: `${request.user.displayName} hủy phiếu xuất kho ${String(before.code)} (${String(before.customerName)}): ${input.reason}`,
          href: `/sales/orders/${id}`,
          template: 'SALES_ORDER_CANCELLED',
          params: { code: String(before.code), customer: String(before.customerName), actor: request.user.displayName, reason: input.reason },
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
      return serializeDocument(updated);
    });
  }

  /**
   * Xóa hẳn phiếu nháp (chưa phát hành, hoặc bị kinh doanh trả về). Không còn trong danh sách; nội dung đầy đủ
   * giữ trong nhật ký hệ thống. Phiếu đã phát hành thì phải hủy (giữ số), không xóa.
   */
  async remove(id: string, input: DiscardSalesOrder, request: AuthenticatedRequest, idempotencyKey: string | undefined) {
    return this.idempotency.execute(`sales-order-delete:${id}`, idempotencyKey, input, async (session) => {
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
          message: `${request.user.displayName} xóa phiếu nháp ${String(before.code)} (${String(before.customerName)}): ${input.reason}`,
          href: '/sales/orders',
          template: 'SALES_ORDER_DELETED',
          params: { code: String(before.code), customer: String(before.customerName), actor: request.user.displayName, reason: input.reason },
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
    });
  }

  private async exposure(customerId: ObjectId, session?: ClientSession): Promise<string> {
    const rows = await this.db.collection('receivables').aggregate(
      [
        { $match: { partnerId: customerId, status: { $in: ['OPEN', 'PARTIALLY_PAID', 'OVERDUE'] } } },
        { $group: { _id: null, total: { $sum: { $subtract: ['$amount', '$paidAmount'] } } } },
      ],
      session ? { session } : {},
    ).toArray();
    return decimalString(rows[0]?.total ?? Decimal128.fromString('0'));
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
              { $set: { status: 'PENDING_APPROVAL', approvalStatus: 'PENDING', issuedAt: new Date(), issuedByName: request.user.displayName, updatedAt: new Date() }, $unset: { confirmationNote: '' }, $inc: { version: 1 } },
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
                  message: `Đơn của ${String(order.customerName)} cần được xem xét trước khi giữ hàng.`,
                  href: `/sales/orders/${id}`,
                  reasons: evaluation.reasons,
                  template: 'SALES_APPROVAL_REQUESTED',
                  params: { code: String(order.code), customer: String(order.customerName) },
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
                $set: { status: 'RESERVED', approvalStatus: 'NOT_REQUIRED', confirmationStatus: 'PENDING', issuedAt: new Date(), issuedByName: request.user.displayName, updatedAt: new Date() },
                $unset: { confirmationNote: '' },
                $inc: { version: 1 },
              },
              { session },
            );
            await this.notify(session, id, {
              targetRoles: ['SALES', 'SALES_MANAGER'],
              level: 'INFO',
              title: `Phiếu ${String(order.code)} chờ đối chiếu với khách`,
              message: `Kiểm tra mã hàng, số lượng với ${String(order.customerName)} trước khi chuyển kho xuất hàng.`,
              href: `/sales/orders/${id}`,
              template: 'SALES_CONFIRMATION_PENDING',
              params: { code: String(order.code), customer: String(order.customerName) },
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
            targetRoles: ['SALES', 'SALES_MANAGER'],
            level: 'INFO',
            title: `Phiếu ${String(order.code)} đã duyệt, chờ đối chiếu với khách`,
            message: `Kiểm tra mã hàng, số lượng với ${String(order.customerName)} trước khi chuyển kho xuất hàng.`,
            href: `/sales/orders/${id}`,
            template: 'SALES_APPROVED_CONFIRMATION_PENDING',
            params: { code: String(order.code), customer: String(order.customerName) },
          });
          return { id, status: 'RESERVED' };
      },
    );
  }

  /** Bước 3: kho lập phiếu xuất kho bán hàng số SWK, trừ tồn và phát sinh công nợ. */
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
          if (order.confirmationStatus && order.confirmationStatus !== 'CONFIRMED') {
            throw new ConflictException({ code: 'CUSTOMER_NOT_CONFIRMED', message: 'Nhân viên kinh doanh chưa xác nhận khách đã đối chiếu phiếu BH' });
          }
          const customer = await this.db.collection('partners').findOne({ _id: order.customerId }, { session });
          if (!customer) throw new NotFoundException({ code: 'CUSTOMER_NOT_FOUND', message: 'Không tìm thấy khách hàng' });
          const shipmentCode = await this.sequences.next('SWK', session, 4, new Date(), 'compact');
          await this.inventory.shipReserved(
            orderId,
            (order.warehouseId as ObjectId).toHexString(),
            order.lines as Array<{ productId: string; baseQuantity: string; gift?: boolean }>,
            request.user.sub,
            shipmentCode,
            session,
            String(order.code),
          );
          const now = new Date();
          const dueDate = new Date(now);
          dueDate.setUTCDate(dueDate.getUTCDate() + Number(order.paymentTermDays ?? customer.paymentTermDays ?? 0));
          const shipmentId = new ObjectId();
          const receivableId = new ObjectId();
          await Promise.all([
            this.db.collection('shipments').insertOne(
              {
                _id: shipmentId,
                code: shipmentCode,
                salesOrderId: orderId,
                warehouseId: order.warehouseId,
                customerId: order.customerId,
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
            this.db.collection('receivables').insertOne(
              {
                _id: receivableId,
                code: await this.sequences.next('AR', session),
                partnerId: order.customerId,
                salesOrderCode: order.code,
                salesOrderId: orderId,
                shipmentId,
                amount: decimal(decimalString(order.grandTotal)),
                paidAmount: decimal('0'),
                dueDate,
                status: 'OPEN',
                createdAt: now,
                updatedAt: now,
                version: 1,
              },
              { session },
            ),
            this.db.collection('sales_orders').updateOne(
              { _id: orderId, version },
              {
                $set: {
                  status: 'SHIPPED', shippedAt: now, updatedAt: now, warehouseSlipNo: shipmentCode, shippedByName: request.user.displayName,
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
              metadata: { shipmentCode, receivableId: receivableId.toHexString() },
            },
            session,
          );
          return { id, status: 'SHIPPED', shipmentCode, receivableId: receivableId.toHexString() };
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
              $set: { confirmationStatus: 'CONFIRMED', confirmedAt: now, confirmedByName: request.user.displayName, updatedAt: now, ...(input.note ? { confirmationNote: input.note } : {}) },
              $push: { confirmationEvidence: { $each: evidence } },
              $inc: { version: 1 },
            } as Document,
            { session },
          );
          await this.notify(session, id, {
            ...(order.warehouseKeeperId
              ? { targetUserIds: [(order.warehouseKeeperId as ObjectId).toHexString()] }
              : { targetRoles: ['WAREHOUSE', 'WAREHOUSE_MANAGER'] }),
            level: 'INFO',
            title: `Phiếu ${String(order.code)} đã đối chiếu xong — chờ bạn lập SWK`,
            message: `Lập phiếu SWK và xuất hàng cho ${String(order.customerName)}.`,
            href: '/inventory/shipments',
            template: 'SALES_READY_FOR_SWK',
            params: { code: String(order.code), customer: String(order.customerName) },
          });
        } else {
          await this.inventory.release(orderId, session);
          await this.db.collection('sales_orders').updateOne(
            { _id: orderId, version: input.version },
            {
              $set: {
                status: 'DRAFT', approvalStatus: 'NOT_REQUIRED', confirmationStatus: 'REVISION_REQUESTED', confirmationNote: input.note,
                revisionRequestedAt: now, revisionRequestedByName: request.user.displayName, updatedAt: now,
              },
              ...(evidence.length ? { $push: { confirmationEvidence: { $each: evidence } } } : {}),
              $inc: { version: 1 },
            } as Document,
            { session },
          );
          await this.notify(session, id, {
            targetRoles: ['ACCOUNTANT'],
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

  /** Nhiệm vụ 3.4: xác nhận đơn vị vận chuyển đã giao thành công. */
  async deliver(id: string, version: number, request: AuthenticatedRequest, idempotencyKey: string | undefined) {
    return this.idempotency.execute(
      `sales-order-deliver:${id}`,
      idempotencyKey,
      { id, version },
      async (session) => {
        const orderId = toObjectId(id);
        const now = new Date();
        const order = await this.db.collection('sales_orders').findOne({ _id: orderId }, { session, projection: { code: 1, warehouseKeeperId: 1, warehouseKeeperName: 1 } });
        if (order && !isAssignedKeeper(request.user, order)) {
          throw new ForbiddenException({ code: 'NOT_ASSIGNED_KEEPER', message: `Phiếu ${String(order.code)} được giao cho thủ kho ${String(order.warehouseKeeperName ?? 'khác')}` });
        }
        const updated = await this.db.collection('sales_orders').updateOne(
          { _id: orderId, version, status: 'SHIPPED' },
          { $set: { status: 'DELIVERED', deliveredAt: now, updatedAt: now }, $inc: { version: 1 } },
          { session },
        );
        if (updated.modifiedCount !== 1) {
          throw new ConflictException({ code: 'ORDER_STATE_CONFLICT', message: 'Chỉ xác nhận giao cho đơn đã xuất kho' });
        }
        await this.db.collection('shipments').updateOne(
          { salesOrderId: orderId, status: 'SHIPPED' },
          { $set: { status: 'DELIVERED', deliveredAt: now, updatedAt: now } },
          { session },
        );
        await this.audit.record(
          {
            actorId: request.user.sub,
            actorEmail: request.user.email,
            correlationId: request.correlationId,
            action: 'SALES_ORDER_DELIVERED',
            entityType: 'SalesOrder',
            entityId: id,
          },
          session,
        );
        return { id, status: 'DELIVERED' };
      },
    );
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
