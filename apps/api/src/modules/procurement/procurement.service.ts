import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  containerPlan,
  containerPlanLabel,
  lineAmount,
  packingLine,
  packingTotals,
  sumAmounts,
  toVnd,
  type CreateGoodsReceipt,
  type CreatePurchaseOrder,
  type SupplierPayment,
  type UpdatePurchaseOrder,
} from '@inoxpran/contracts';
import Decimal from 'decimal.js';
import type { ClientSession, Db, Document } from 'mongodb';
import { ObjectId } from 'mongodb';
import { AuditService } from '../../common/audit.service';
import { decimal, decimalString, serializeDocument, toObjectId } from '../../common/domain';
import { IdempotencyService } from '../../common/idempotency.service';
import { OutboxService } from '../../common/outbox.service';
import type { AuthenticatedRequest } from '../../common/request-context';
import { SequenceService } from '../../common/sequence.service';
import { MONGO_DATABASE } from '../../common/tokens';
import { pageOf, type PageRequest } from '../../common/paging';
import { InventoryService } from '../inventory/inventory.service';

type LineInput = CreatePurchaseOrder['lines'][number];
/** Điều khoản hợp đồng nhập khẩu lưu trên đơn mua (giai đoạn 4). */
const TERM_FIELDS = ['supplierContractNo', 'contractDate', 'currency', 'exchangeRate', 'incoterm', 'paymentTerms', 'depositPercent', 'portOfLoading', 'portOfDischarge', 'shippingMethod', 'etd', 'eta', 'partialShipment', 'shippingMark'] as const;
/** Trạng thái lô hàng còn "đang đi" — số lượng trong lô được giữ chỗ, không đưa vào lô khác. */
export const OPEN_SHIPMENT_STATUSES = ['PLANNED', 'IN_TRANSIT', 'ARRIVED'];

/** Giá trị VND của tổng đơn (đơn ngoại tệ quy theo tỷ giá trên đơn). */
export function orderValueVnd(order: Document): string {
  const total = decimalString(order.total);
  const currency = String(order.currency ?? 'VND');
  return currency === 'VND' ? toVnd(total) : toVnd(total, decimalString(order.exchangeRate ?? '0'));
}

/** Thông tin đóng gói của sản phẩm cho một số lượng (đơn vị cơ bản). */
export function packingInputOf(product: Document | undefined, quantity: string) {
  const pack = (product?.unitConversions as Array<{ unit: string; factorToBase: unknown }> | undefined)?.find((item) => item.unit === 'Thùng');
  return {
    quantity,
    packSize: product?.packSize ?? (pack ? decimalString(pack.factorToBase) : undefined),
    cartonLengthCm: product?.cartonLengthCm,
    cartonWidthCm: product?.cartonWidthCm,
    cartonHeightCm: product?.cartonHeightCm,
    grossKgPerCarton: product?.grossKgPerCarton,
    netKgPerCarton: product?.netKgPerCarton,
  };
}

export interface ReceiptPosting {
  order: Document;
  lines: Array<{ productId: string; quantity: string; locationCode?: string | undefined }>;
  supplierDocumentReference?: string | undefined;
  importShipmentId?: ObjectId | undefined;
}

@Injectable()
export class ProcurementService {
  constructor(
    @Inject(MONGO_DATABASE) private readonly db: Db,
    private readonly inventory: InventoryService,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly outbox: OutboxService,
    private readonly sequences: SequenceService,
  ) {}

  private actor(request: AuthenticatedRequest) {
    return { actorId: request.user.sub, actorEmail: request.user.email, correlationId: request.correlationId };
  }

  async list(status?: string, search?: string, paging: PageRequest | null = null, supplierId?: string) {
    const filter: Document = status ? { status } : {};
    if (supplierId) filter.supplierId = toObjectId(supplierId, 'supplierId');
    if (search) {
      const pattern = { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
      filter.$or = [{ code: pattern }, { supplierName: pattern }, { supplierContractNo: pattern }];
    }
    const cursor = this.db.collection('purchase_orders').find(filter).sort({ createdAt: -1, _id: -1 });
    if (!paging) return (await cursor.limit(250).toArray()).map(serializeDocument);
    const [rows, total] = await Promise.all([cursor.skip(paging.skip).limit(paging.pageSize).toArray(), this.db.collection('purchase_orders').countDocuments(filter)]);
    return pageOf(rows.map((row) => ({ ...serializeDocument(row), currency: row.currency ?? 'VND', totalVnd: orderValueVnd(row) })), total, paging);
  }

  async get(id: string) {
    const order = await this.db.collection('purchase_orders').findOne({ _id: toObjectId(id) });
    if (!order) throw new NotFoundException({ code: 'PURCHASE_ORDER_NOT_FOUND', message: 'Không tìm thấy đơn mua' });
    const lines = order.lines as Document[];
    const [products, supplier] = await Promise.all([
      this.db.collection('products').find({ _id: { $in: lines.map((line) => line.productId as ObjectId) } }).toArray(),
      this.db.collection('partners').findOne({ _id: order.supplierId as ObjectId }, { projection: { name: 1, code: 1, address: 1, phone: 1, taxCode: 1, email: 1 } }),
    ]);
    const productById = new Map(products.map((product) => [product._id.toHexString(), product]));
    const inputOf = (line: Document) => packingInputOf(productById.get((line.productId as ObjectId).toHexString()), decimalString(line.baseQuantity));
    const packing = packingTotals(lines.map(inputOf));
    const payments = (order.payments as Document[] | undefined) ?? [];
    return {
      ...serializeDocument(order),
      currency: order.currency ?? 'VND',
      totalVnd: orderValueVnd(order),
      supplier: supplier ? serializeDocument(supplier) : null,
      lines: lines.map((line) => {
        const product = productById.get((line.productId as ObjectId).toHexString());
        return {
          ...serializeDocument(line),
          packing: packingLine(inputOf(line)),
          print: product
            ? { nameZh: product.nameZh, nameEn: product.nameEn, specZh: product.specZh, specEn: product.specEn, hsCode: product.hsCode, supplierItemCode: product.supplierItemCode, packSize: product.packSize, baseUnit: product.baseUnit }
            : {},
        };
      }),
      packing: { ...packing, container: containerPlanLabel(containerPlan(packing.cbm, packing.grossKg)) },
      payments: payments.map(serializeDocument),
      paidTotal: sumAmounts(payments.map((payment) => decimalString(payment.amount))),
    };
  }

  /** Dòng hàng: quy đổi đơn vị, thành tiền theo tiền tệ của đơn (đơn giá tới 4 chữ số lẻ, thành tiền 2 số lẻ). */
  private async normalizeLines(inputLines: LineInput[], session: ClientSession) {
    const lines = [];
    for (const line of inputLines) {
      const productId = toObjectId(line.productId, 'productId');
      const product = await this.db.collection('products').findOne({ _id: productId, status: 'ACTIVE' }, { session });
      if (!product) throw new NotFoundException({ code: 'PRODUCT_NOT_FOUND', message: 'Không tìm thấy sản phẩm' });
      const conversion = line.unit === product.baseUnit
        ? { factorToBase: '1' }
        : (product.unitConversions as Array<{ unit: string; factorToBase: { toString(): string } }>).find(
            (item) => item.unit === line.unit,
          );
      if (!conversion) throw new ConflictException({ code: 'UNIT_NOT_CONFIGURED', message: `Đơn vị ${line.unit} chưa được cấu hình` });
      const conversionFactor = typeof conversion.factorToBase === 'string' ? conversion.factorToBase : decimalString(conversion.factorToBase);
      const baseQuantity = new Decimal(line.quantity).mul(conversionFactor);
      lines.push({
        productId,
        sku: product.sku,
        productName: product.name,
        unit: line.unit,
        quantity: decimal(line.quantity),
        baseQuantity: decimal(baseQuantity.toDecimalPlaces(4).toString()),
        receivedBaseQuantity: decimal('0'),
        unitCost: decimal(line.unitCost),
        lineTotal: decimal(lineAmount(line.quantity, line.unitCost)),
        ...(line.note ? { note: line.note } : {}),
      });
    }
    const total = sumAmounts(lines.map((line) => decimalString(line.lineTotal)));
    return { lines, total };
  }

  private async loadParties(supplierId: ObjectId, warehouseId: ObjectId, session: ClientSession) {
    const [supplier, warehouse] = await Promise.all([
      this.db.collection('partners').findOne({ _id: supplierId, kind: { $in: ['SUPPLIER', 'BOTH'] }, status: 'ACTIVE' }, { session }),
      this.db.collection('warehouses').findOne({ _id: warehouseId, active: true }, { session }),
    ]);
    if (!supplier) throw new NotFoundException({ code: 'SUPPLIER_NOT_FOUND', message: 'Không tìm thấy nhà cung cấp' });
    if (!warehouse) throw new NotFoundException({ code: 'WAREHOUSE_NOT_FOUND', message: 'Không tìm thấy kho' });
    return supplier;
  }

  private terms(input: Partial<Record<(typeof TERM_FIELDS)[number], unknown>>): Document {
    const result: Document = {};
    for (const field of TERM_FIELDS) {
      const value = input[field];
      if (value === undefined) continue;
      result[field] = field === 'exchangeRate' || field === 'depositPercent' ? decimal(String(value)) : value;
    }
    if (result.currency === 'VND') delete result.exchangeRate;
    return result;
  }

  async create(input: CreatePurchaseOrder, request: AuthenticatedRequest, key: string | undefined) {
    return this.idempotency.execute(`purchase-order-create:${request.user.sub}`, key, input, async (session) => {
      const supplierId = toObjectId(input.supplierId, 'supplierId');
      const warehouseId = toObjectId(input.warehouseId, 'warehouseId');
      const supplier = await this.loadParties(supplierId, warehouseId, session);
      const normalized = await this.normalizeLines(input.lines, session);
      const now = new Date();
      const document = {
        _id: new ObjectId(),
        code: await this.sequences.next('PO', session),
        supplierId,
        supplierCode: supplier.code,
        supplierName: supplier.name,
        warehouseId,
        expectedDate: input.expectedDate,
        note: input.note,
        ...this.terms(input),
        currency: input.currency ?? 'VND',
        status: 'DRAFT',
        approvalStatus: 'NOT_REQUIRED',
        lines: normalized.lines,
        total: decimal(normalized.total),
        createdBy: toObjectId(request.user.sub),
        version: 1,
        createdAt: now,
        updatedAt: now,
      };
      await this.db.collection('purchase_orders').insertOne(document, { session });
      await this.audit.record(
        { ...this.actor(request), action: 'PURCHASE_ORDER_CREATED', entityType: 'PurchaseOrder', entityId: document._id.toHexString(), after: serializeDocument(document) },
        session,
      );
      return serializeDocument(document);
    });
  }

  /** Sửa đơn nháp: điều khoản, nhà cung cấp / kho, dòng hàng (gửi lại toàn bộ). */
  async update(id: string, input: UpdatePurchaseOrder, request: AuthenticatedRequest) {
    const orderId = toObjectId(id);
    const before = await this.db.collection('purchase_orders').findOne({ _id: orderId });
    if (!before) throw new NotFoundException({ code: 'PURCHASE_ORDER_NOT_FOUND', message: 'Không tìm thấy đơn mua' });
    if (before.status !== 'DRAFT') throw new ConflictException({ code: 'ORDER_STATE_CONFLICT', message: 'Chỉ sửa được đơn mua ở trạng thái nháp' });
    const session = this.db.client.startSession();
    try {
      let result: Document | null = null;
      await session.withTransaction(async () => {
        const set: Document = { updatedAt: new Date(), ...this.terms(input) };
        if (input.expectedDate !== undefined) set.expectedDate = input.expectedDate;
        if (input.note !== undefined) set.note = input.note;
        const supplierId = input.supplierId ? toObjectId(input.supplierId, 'supplierId') : (before.supplierId as ObjectId);
        const warehouseId = input.warehouseId ? toObjectId(input.warehouseId, 'warehouseId') : (before.warehouseId as ObjectId);
        if (input.supplierId || input.warehouseId) {
          const supplier = await this.loadParties(supplierId, warehouseId, session);
          Object.assign(set, { supplierId, supplierCode: supplier.code, supplierName: supplier.name, warehouseId });
        }
        if (input.lines) {
          const normalized = await this.normalizeLines(input.lines, session);
          Object.assign(set, { lines: normalized.lines, total: decimal(normalized.total) });
        }
        const unset: Document = Object.fromEntries((input.clear ?? []).filter((field) => !(field in set)).map((field) => [field, '']));
        if (set.currency === 'VND') unset.exchangeRate = '';
        const currency = String(set.currency ?? before.currency ?? 'VND');
        const rate = 'exchangeRate' in unset ? undefined : (set.exchangeRate ?? before.exchangeRate);
        if (currency !== 'VND' && !rate) throw new BadRequestException({ code: 'EXCHANGE_RATE_REQUIRED', message: 'Đơn ngoại tệ phải có tỷ giá quy đổi VND' });
        result = await this.db.collection('purchase_orders').findOneAndUpdate(
          { _id: orderId, version: input.version, status: 'DRAFT' },
          { $set: set, $inc: { version: 1 }, ...(Object.keys(unset).length ? { $unset: unset } : {}) },
          { returnDocument: 'after', session },
        );
        if (!result) throw new ConflictException({ code: 'VERSION_CONFLICT', message: 'Đơn mua đã được người khác cập nhật, hãy tải lại rồi sửa' });
        await this.audit.record({ ...this.actor(request), action: 'PURCHASE_ORDER_UPDATED', entityType: 'PurchaseOrder', entityId: id, before: serializeDocument(before), after: serializeDocument(result) }, session);
      });
      return serializeDocument(result as unknown as Document);
    } finally {
      await session.endSession();
    }
  }

  async submit(id: string, version: number, request: AuthenticatedRequest, key: string | undefined) {
    return this.idempotency.execute(`purchase-order-submit:${id}`, key, { id, version }, async (session) => {
      const orderId = toObjectId(id);
      const order = await this.db.collection('purchase_orders').findOne({ _id: orderId, version, status: 'DRAFT' }, { session });
      if (!order) throw new ConflictException({ code: 'ORDER_STATE_CONFLICT', message: 'Đơn mua không còn ở trạng thái nháp' });
      const settings = await this.db.collection<{ _id: string } & Document>('settings').findOne({ _id: 'approval' }, { session });
      // Ngưỡng duyệt tính theo VND (đơn ngoại tệ quy đổi theo tỷ giá trên đơn).
      const requiresApproval = new Decimal(orderValueVnd(order)).gte(String(settings?.purchaseOrderThreshold ?? '50000000'));
      const status = requiresApproval ? 'PENDING_APPROVAL' : 'APPROVED';
      await this.db.collection('purchase_orders').updateOne(
        { _id: orderId, version },
        { $set: { status, approvalStatus: requiresApproval ? 'PENDING' : 'NOT_REQUIRED', updatedAt: new Date() }, $inc: { version: 1 } },
        { session },
      );
      if (requiresApproval) {
        await this.db.collection('approval_requests').insertOne(
          { _id: new ObjectId(), entityType: 'PurchaseOrder', entityId: orderId, status: 'PENDING', reasons: ['ORDER_VALUE_THRESHOLD'], requestedBy: toObjectId(request.user.sub), requestedAt: new Date() },
          { session },
        );
        await this.outbox.enqueue(
          {
            eventType: 'APPROVAL_REQUESTED',
            aggregateType: 'PurchaseOrder',
            aggregateId: id,
            payload: {
              targetRoles: ['ADMIN', 'DIRECTOR'],
              level: 'WARNING',
              title: `Đơn mua ${String(order.code)} chờ phê duyệt`,
              message: `Đơn mua từ ${String(order.supplierName)} vượt ngưỡng duyệt đang cấu hình.`,
              href: `/procurement/${id}`,
              reasons: ['ORDER_VALUE_THRESHOLD'],
              template: 'PURCHASE_APPROVAL_REQUESTED',
              params: { code: String(order.code), supplier: String(order.supplierName) },
            },
          },
          session,
        );
      }
      await this.audit.record(
        { ...this.actor(request), action: requiresApproval ? 'PURCHASE_ORDER_SUBMITTED_FOR_APPROVAL' : 'PURCHASE_ORDER_AUTO_APPROVED', entityType: 'PurchaseOrder', entityId: id },
        session,
      );
      return { id, status };
    });
  }

  async approve(id: string, version: number, request: AuthenticatedRequest, key: string | undefined) {
    return this.idempotency.execute(`purchase-order-approve:${id}`, key, { id, version }, async (session) => {
      const orderId = toObjectId(id);
      const result = await this.db.collection('purchase_orders').findOneAndUpdate(
        { _id: orderId, version, status: 'PENDING_APPROVAL' },
        { $set: { status: 'APPROVED', approvalStatus: 'APPROVED', approvedBy: toObjectId(request.user.sub), approvedAt: new Date(), updatedAt: new Date() }, $inc: { version: 1 } },
        { returnDocument: 'after', session },
      );
      if (!result) throw new ConflictException({ code: 'ORDER_STATE_CONFLICT', message: 'Đơn mua không còn chờ duyệt' });
      await this.db.collection('approval_requests').updateOne(
        { entityType: 'PurchaseOrder', entityId: orderId, status: 'PENDING' },
        { $set: { status: 'APPROVED', decidedBy: toObjectId(request.user.sub), decidedAt: new Date() } },
        { session },
      );
      await this.audit.record({ ...this.actor(request), action: 'PURCHASE_ORDER_APPROVED', entityType: 'PurchaseOrder', entityId: id }, session);
      return serializeDocument(result);
    });
  }

  /** Hủy đơn chưa nhận hàng và không có lô hàng đang đi. */
  async cancel(id: string, version: number, request: AuthenticatedRequest, key: string | undefined) {
    return this.idempotency.execute(`purchase-order-cancel:${id}`, key, { id, version }, async (session) => {
      const orderId = toObjectId(id);
      const order = await this.db.collection('purchase_orders').findOne({ _id: orderId, version, status: { $in: ['DRAFT', 'PENDING_APPROVAL', 'APPROVED'] } }, { session });
      if (!order) throw new ConflictException({ code: 'ORDER_STATE_CONFLICT', message: 'Đơn mua không còn hủy được (đã nhận hàng hoặc đã hủy)' });
      if ((order.lines as Document[]).some((line) => new Decimal(decimalString(line.receivedBaseQuantity)).gt(0))) {
        throw new ConflictException({ code: 'ORDER_STATE_CONFLICT', message: 'Đơn mua đã nhận hàng, không hủy được' });
      }
      if (await this.db.collection('import_shipments').findOne({ purchaseOrderIds: orderId, status: { $in: OPEN_SHIPMENT_STATUSES } }, { session, projection: { code: 1 } })) {
        throw new ConflictException({ code: 'ORDER_HAS_OPEN_SHIPMENT', message: 'Đơn mua đang có lô hàng chưa nhận — hủy lô hàng trước' });
      }
      const result = await this.db.collection('purchase_orders').findOneAndUpdate(
        { _id: orderId, version },
        { $set: { status: 'CANCELLED', cancelledBy: toObjectId(request.user.sub), cancelledAt: new Date(), updatedAt: new Date() }, $inc: { version: 1 } },
        { returnDocument: 'after', session },
      );
      await this.db.collection('approval_requests').updateMany({ entityType: 'PurchaseOrder', entityId: orderId, status: 'PENDING' }, { $set: { status: 'CANCELLED', decidedAt: new Date() } }, { session });
      await this.audit.record({ ...this.actor(request), action: 'PURCHASE_ORDER_CANCELLED', entityType: 'PurchaseOrder', entityId: id }, session);
      return serializeDocument(result as Document);
    });
  }

  /** Ghi nhận tiền đã trả nhà cung cấp (đặt cọc / thanh toán) theo tiền tệ của đơn. */
  async addPayment(id: string, input: SupplierPayment, request: AuthenticatedRequest) {
    const order = await this.db.collection('purchase_orders').findOne({ _id: toObjectId(id) });
    if (!order) throw new NotFoundException({ code: 'PURCHASE_ORDER_NOT_FOUND', message: 'Không tìm thấy đơn mua' });
    if (['DRAFT', 'CANCELLED'].includes(String(order.status))) throw new ConflictException({ code: 'ORDER_STATE_CONFLICT', message: 'Đơn nháp / đã hủy chưa ghi nhận thanh toán' });
    const payment = {
      id: new ObjectId().toHexString(),
      ...input,
      amount: decimal(input.amount),
      recordedBy: toObjectId(request.user.sub),
      recordedByName: request.user.displayName,
      recordedAt: new Date(),
    };
    await this.db.collection('purchase_orders').updateOne({ _id: order._id }, { $push: { payments: payment } as Document, $set: { updatedAt: new Date() } });
    await this.audit.record({ ...this.actor(request), action: 'SUPPLIER_PAYMENT_RECORDED', entityType: 'PurchaseOrder', entityId: id, metadata: { ...input, currency: order.currency ?? 'VND' } });
    return serializeDocument(payment);
  }

  async removePayment(id: string, paymentId: string, request: AuthenticatedRequest) {
    const order = await this.db.collection('purchase_orders').findOne({ _id: toObjectId(id), 'payments.id': paymentId });
    if (!order) throw new NotFoundException({ code: 'PAYMENT_NOT_FOUND', message: 'Không tìm thấy khoản thanh toán' });
    const payment = (order.payments as Document[]).find((row) => row.id === paymentId);
    await this.db.collection('purchase_orders').updateOne({ _id: order._id }, { $pull: { payments: { id: paymentId } } as Document, $set: { updatedAt: new Date() } });
    await this.audit.record({ ...this.actor(request), action: 'SUPPLIER_PAYMENT_DELETED', entityType: 'PurchaseOrder', entityId: id, ...(payment ? { before: serializeDocument(payment) } : {}) });
    return { id: paymentId, deleted: true };
  }

  /**
   * Lập phiếu nhập kho cho một đơn mua trong phiên giao dịch có sẵn (dùng chung: nhận hàng thường và nhận cả lô hàng nhập).
   * Số lượng theo đơn vị cơ bản; không vượt số đặt còn lại.
   */
  async postReceipt(input: ReceiptPosting, request: AuthenticatedRequest, session: ClientSession) {
    const { order } = input;
    const orderId = order._id as ObjectId;
    const orderLines = order.lines as Array<{ productId: ObjectId; baseQuantity: unknown; receivedBaseQuantity: unknown }>;
    const movementLines = input.lines.map((receiptLine) => {
      const ordered = orderLines.find((line) => line.productId.equals(toObjectId(receiptLine.productId)));
      if (!ordered) throw new ConflictException({ code: 'PRODUCT_NOT_IN_ORDER', message: 'Sản phẩm không thuộc đơn mua' });
      const next = new Decimal(decimalString(ordered.receivedBaseQuantity)).add(receiptLine.quantity);
      if (next.gt(decimalString(ordered.baseQuantity))) {
        throw new ConflictException({ code: 'RECEIPT_EXCEEDS_ORDER', message: 'Số lượng nhập vượt quá số lượng đặt' });
      }
      ordered.receivedBaseQuantity = decimal(next.toDecimalPlaces(4).toString());
      return receiptLine;
    });
    const receiptCode = await this.sequences.next('GR', session);
    await this.inventory.applyPhysicalMovement(
      {
        warehouseId: (order.warehouseId as ObjectId).toHexString(),
        referenceType: 'GoodsReceipt',
        referenceId: receiptCode,
        movementType: 'PURCHASE_RECEIPT',
        direction: 'IN',
        lines: movementLines,
        actorId: request.user.sub,
      },
      session,
    );
    const fullyReceived = orderLines.every((line) => new Decimal(decimalString(line.receivedBaseQuantity)).eq(decimalString(line.baseQuantity)));
    const now = new Date();
    const receipt = {
      _id: new ObjectId(),
      code: receiptCode,
      purchaseOrderId: orderId,
      supplierId: order.supplierId,
      warehouseId: order.warehouseId,
      supplierDocumentReference: input.supplierDocumentReference,
      ...(input.importShipmentId ? { importShipmentId: input.importShipmentId } : {}),
      lines: movementLines.map((line) => ({ ...line, productId: toObjectId(line.productId) })),
      status: 'POSTED',
      postedBy: toObjectId(request.user.sub),
      postedAt: now,
      createdAt: now,
    };
    await this.db.collection('goods_receipts').insertOne(receipt, { session });
    const updated = await this.db.collection('purchase_orders').updateOne(
      { _id: orderId, version: order.version },
      { $set: { lines: orderLines, status: fullyReceived ? 'RECEIVED' : 'PARTIALLY_RECEIVED', updatedAt: now }, $inc: { version: 1 } },
      { session },
    );
    if (updated.modifiedCount !== 1) throw new ConflictException({ code: 'VERSION_CONFLICT', message: 'Đơn mua vừa được cập nhật, hãy tải lại rồi nhận hàng' });
    await this.audit.record(
      { ...this.actor(request), action: 'GOODS_RECEIPT_POSTED', entityType: 'GoodsReceipt', entityId: receipt._id.toHexString(), after: serializeDocument(receipt) },
      session,
    );
    return receipt;
  }

  async receive(input: CreateGoodsReceipt, request: AuthenticatedRequest, key: string | undefined) {
    return this.idempotency.execute(`goods-receipt:${input.purchaseOrderId}`, key, input, async (session) => {
      const orderId = toObjectId(input.purchaseOrderId, 'purchaseOrderId');
      const order = await this.db.collection('purchase_orders').findOne({ _id: orderId, status: { $in: ['APPROVED', 'PARTIALLY_RECEIVED'] } }, { session });
      if (!order) throw new ConflictException({ code: 'ORDER_STATE_CONFLICT', message: 'Đơn mua chưa sẵn sàng nhập kho' });
      const receipt = await this.postReceipt({ order, lines: input.lines, supplierDocumentReference: input.supplierDocumentReference }, request, session);
      return serializeDocument(receipt);
    });
  }
}
