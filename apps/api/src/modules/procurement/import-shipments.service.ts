import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  containerPlan,
  containerPlanLabel,
  landedCost,
  packingLine,
  toVnd,
  weightedAverageCost,
  type AllocationMethod,
  type CreateImportShipment,
  type ReceiveImportShipment,
  type UpdateImportShipment,
} from '@inoxpran/contracts';
import Decimal from 'decimal.js';
import { ObjectId, type ClientSession, type Db, type Document } from 'mongodb';
import { AuditService } from '../../common/audit.service';
import { decimal, decimalString, serializeDocument, toObjectId } from '../../common/domain';
import { IdempotencyService } from '../../common/idempotency.service';
import { pageOf, type PageRequest } from '../../common/paging';
import type { AuthenticatedRequest } from '../../common/request-context';
import { SequenceService } from '../../common/sequence.service';
import { MONGO_DATABASE } from '../../common/tokens';
import { OPEN_SHIPMENT_STATUSES, packingInputOf, ProcurementService } from './procurement.service';

type LineInput = { purchaseOrderId: string; productId: string; quantity: string };
const SHIPPABLE_ORDER_STATUSES = ['APPROVED', 'PARTIALLY_RECEIVED'];
const key = (purchaseOrderId: unknown, productId: unknown) => `${String(purchaseOrderId)}:${String(productId)}`;

/**
 * Lô hàng nhập (container / B/L) từ công ty mẹ: gom dòng của một hoặc nhiều đơn mua cùng kho nhận, theo dõi
 * PLANNED → IN_TRANSIT → ARRIVED → RECEIVED, chi phí nhập (VND) phân bổ vào giá vốn, nhận hàng cả lô.
 * Số lượng trong lô chưa nhận được giữ chỗ: tổng các lô đang mở + đã nhận không vượt số đặt của dòng đơn mua.
 */
@Injectable()
export class ImportShipmentsService {
  constructor(
    @Inject(MONGO_DATABASE) private readonly db: Db,
    private readonly procurement: ProcurementService,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly sequences: SequenceService,
  ) {}

  private actor(request: AuthenticatedRequest) {
    return { actorId: request.user.sub, actorEmail: request.user.email, correlationId: request.correlationId };
  }

  /** Số lượng (đơn vị cơ bản) đang nằm trong các lô chưa nhận, theo dòng đơn mua; bỏ qua lô `exceptId`. */
  private async reserved(orderIds: ObjectId[], exceptId?: ObjectId, session?: ClientSession): Promise<Map<string, Decimal>> {
    const rows = await this.db.collection('import_shipments').find(
      { purchaseOrderIds: { $in: orderIds }, status: { $in: OPEN_SHIPMENT_STATUSES }, ...(exceptId ? { _id: { $ne: exceptId } } : {}) },
      { projection: { lines: 1 }, ...(session ? { session } : {}) },
    ).toArray();
    const map = new Map<string, Decimal>();
    for (const row of rows) {
      for (const line of row.lines as Document[]) {
        const id = key(line.purchaseOrderId, line.productId);
        map.set(id, (map.get(id) ?? new Decimal(0)).add(decimalString(line.quantity)));
      }
    }
    return map;
  }

  /** Dòng đơn mua còn có thể đưa vào lô (đặt − đã nhận − đang ở lô khác). */
  async draft(purchaseOrderId: string) {
    const order = await this.db.collection('purchase_orders').findOne({ _id: toObjectId(purchaseOrderId, 'purchaseOrderId') });
    if (!order) throw new NotFoundException({ code: 'PURCHASE_ORDER_NOT_FOUND', message: 'Không tìm thấy đơn mua' });
    if (!SHIPPABLE_ORDER_STATUSES.includes(String(order.status))) throw new ConflictException({ code: 'ORDER_STATE_CONFLICT', message: 'Đơn mua chưa duyệt hoặc đã nhận đủ — chưa lập lô hàng được' });
    const reserved = await this.reserved([order._id as ObjectId]);
    const products = await this.productsFor((order.lines as Document[]).map((line) => line.productId as ObjectId));
    const lines = (order.lines as Document[]).map((line) => {
      const remaining = new Decimal(decimalString(line.baseQuantity)).sub(decimalString(line.receivedBaseQuantity)).sub(reserved.get(key(order._id, line.productId)) ?? 0);
      const product = products.get((line.productId as ObjectId).toHexString());
      return {
        purchaseOrderId: (order._id as ObjectId).toHexString(),
        purchaseOrderCode: order.code,
        productId: (line.productId as ObjectId).toHexString(),
        sku: line.sku,
        productName: line.productName,
        baseUnit: product?.baseUnit ?? line.unit,
        remaining: Decimal.max(remaining, 0).toString(),
        valueVnd: Number(this.valueVnd(order, line, Decimal.max(remaining, 0).toString())),
        cbm: packingLine(packingInputOf(product, Decimal.max(remaining, 0).toString())).cbm,
      };
    }).filter((line) => Number(line.remaining) > 0);
    return { order: serializeDocument(order), lines };
  }

  private async productsFor(ids: ObjectId[], session?: ClientSession) {
    const rows = await this.db.collection('products').find({ _id: { $in: ids } }, session ? { session } : {}).toArray();
    return new Map(rows.map((row) => [row._id.toHexString(), row]));
  }

  /** Giá trị VND của `quantity` (đơn vị cơ bản) thuộc một dòng đơn mua, theo đơn giá và tỷ giá của đơn. */
  private valueVnd(order: Document, line: Document, quantity: string): string {
    const base = new Decimal(decimalString(line.baseQuantity));
    if (base.lte(0)) return '0';
    const amount = new Decimal(quantity).mul(decimalString(line.unitCost)).mul(decimalString(line.quantity)).div(base);
    const currency = String(order.currency ?? 'VND');
    return currency === 'VND' ? toVnd(amount.toFixed(4)) : toVnd(amount.toFixed(4), decimalString(order.exchangeRate ?? '0'));
  }

  /** Kiểm tra dòng lô: đơn mua đã duyệt, cùng kho nhận, không vượt số còn có thể giao. */
  private async normalizeLines(lines: LineInput[], exceptId: ObjectId | undefined, session: ClientSession) {
    const orderIds = [...new Set(lines.map((line) => line.purchaseOrderId))].map((id) => toObjectId(id, 'purchaseOrderId'));
    const orders = await this.db.collection('purchase_orders').find({ _id: { $in: orderIds } }, { session }).toArray();
    if (orders.length !== orderIds.length) throw new NotFoundException({ code: 'PURCHASE_ORDER_NOT_FOUND', message: 'Không tìm thấy đơn mua' });
    const warehouses = new Set(orders.map((order) => String(order.warehouseId)));
    if (warehouses.size !== 1) throw new BadRequestException({ code: 'SHIPMENT_MIXED_WAREHOUSE', message: 'Các đơn mua trong một lô hàng phải cùng kho nhận' });
    for (const order of orders) {
      if (!SHIPPABLE_ORDER_STATUSES.includes(String(order.status))) throw new ConflictException({ code: 'ORDER_STATE_CONFLICT', message: `Đơn mua ${String(order.code)} chưa duyệt hoặc đã nhận đủ` });
    }
    const reserved = await this.reserved(orderIds, exceptId, session);
    const merged = new Map<string, LineInput>();
    for (const line of lines) {
      const id = key(line.purchaseOrderId, line.productId);
      const previous = merged.get(id);
      merged.set(id, previous ? { ...line, quantity: new Decimal(previous.quantity).add(line.quantity).toString() } : line);
    }
    return {
      warehouseId: orders[0]?.warehouseId as ObjectId,
      orderIds,
      lines: [...merged.values()].map((line) => {
        const order = orders.find((row) => (row._id as ObjectId).toHexString() === line.purchaseOrderId);
        const ordered = (order?.lines as Document[]).find((row) => (row.productId as ObjectId).toHexString() === line.productId);
        if (!order || !ordered) throw new ConflictException({ code: 'PRODUCT_NOT_IN_ORDER', message: 'Sản phẩm không thuộc đơn mua' });
        const available = new Decimal(decimalString(ordered.baseQuantity)).sub(decimalString(ordered.receivedBaseQuantity)).sub(reserved.get(key(line.purchaseOrderId, line.productId)) ?? 0);
        if (new Decimal(line.quantity).gt(available)) {
          throw new ConflictException({ code: 'SHIPMENT_EXCEEDS_ORDER', message: `${String(ordered.sku)}: số lượng trong lô vượt số còn lại của đơn ${String(order.code)} (${available.toString()})` });
        }
        return { purchaseOrderId: order._id as ObjectId, purchaseOrderCode: order.code, productId: ordered.productId as ObjectId, sku: ordered.sku, productName: ordered.productName, quantity: decimal(line.quantity) };
      }),
    };
  }

  private costsOf(input: { costs?: Array<{ type: string; amount: string; invoiceNo?: string | undefined; note?: string | undefined }> | undefined }) {
    return input.costs?.map((cost) => ({ ...cost, amount: decimal(cost.amount) }));
  }

  async create(input: CreateImportShipment, request: AuthenticatedRequest, idempotencyKey: string | undefined) {
    return this.idempotency.execute(`import-shipment-create:${request.user.sub}`, idempotencyKey, input, async (session) => {
      const normalized = await this.normalizeLines(input.lines, undefined, session);
      const now = new Date();
      const { lines: _lines, costs: _costs, ...fields } = input;
      const document = {
        _id: new ObjectId(),
        code: await this.sequences.next('IS', session),
        ...fields,
        status: 'PLANNED',
        warehouseId: normalized.warehouseId,
        purchaseOrderIds: normalized.orderIds,
        lines: normalized.lines,
        costs: this.costsOf(input) ?? [],
        allocationMethod: input.allocationMethod ?? 'VALUE',
        createdBy: toObjectId(request.user.sub),
        version: 1,
        createdAt: now,
        updatedAt: now,
      };
      await this.db.collection('import_shipments').insertOne(document, { session });
      await this.audit.record({ ...this.actor(request), action: 'IMPORT_SHIPMENT_CREATED', entityType: 'ImportShipment', entityId: document._id.toHexString(), after: serializeDocument(document) }, session);
      return serializeDocument(document);
    });
  }

  async update(id: string, input: UpdateImportShipment, request: AuthenticatedRequest) {
    const shipmentId = toObjectId(id);
    const session = this.db.client.startSession();
    try {
      let result: Document | null = null;
      await session.withTransaction(async () => {
        const before = await this.db.collection('import_shipments').findOne({ _id: shipmentId }, { session });
        if (!before) throw new NotFoundException({ code: 'SHIPMENT_NOT_FOUND', message: 'Không tìm thấy lô hàng' });
        if (!OPEN_SHIPMENT_STATUSES.includes(String(before.status))) throw new ConflictException({ code: 'SHIPMENT_STATE_CONFLICT', message: 'Lô hàng đã nhận hoặc đã hủy, không sửa được' });
        const { version, lines, costs, status, ...fields } = input;
        const set: Document = { ...fields, updatedAt: new Date() };
        if (costs) set.costs = this.costsOf({ costs });
        if (lines) {
          if (before.status !== 'PLANNED') throw new ConflictException({ code: 'SHIPMENT_STATE_CONFLICT', message: 'Lô hàng đã khởi hành, không đổi dòng hàng được' });
          const normalized = await this.normalizeLines(lines, shipmentId, session);
          Object.assign(set, { lines: normalized.lines, purchaseOrderIds: normalized.orderIds, warehouseId: normalized.warehouseId });
        }
        if (status) {
          const order = ['PLANNED', 'IN_TRANSIT', 'ARRIVED'];
          if (status !== 'CANCELLED' && order.indexOf(status) < order.indexOf(String(before.status))) {
            throw new ConflictException({ code: 'SHIPMENT_STATE_CONFLICT', message: 'Không lùi trạng thái lô hàng' });
          }
          set.status = status;
          if (status === 'IN_TRANSIT' && !before.departedAt) set.departedAt = new Date();
          if (status === 'ARRIVED' && !before.arrivedAt) set.arrivedAt = new Date();
          if (status === 'CANCELLED') Object.assign(set, { cancelledAt: new Date(), cancelledBy: toObjectId(request.user.sub) });
        }
        result = await this.db.collection('import_shipments').findOneAndUpdate(
          { _id: shipmentId, version },
          { $set: set, $inc: { version: 1 } },
          { returnDocument: 'after', session },
        );
        if (!result) throw new ConflictException({ code: 'VERSION_CONFLICT', message: 'Lô hàng đã được người khác cập nhật, hãy tải lại rồi sửa' });
        await this.audit.record({ ...this.actor(request), action: status === 'CANCELLED' ? 'IMPORT_SHIPMENT_CANCELLED' : 'IMPORT_SHIPMENT_UPDATED', entityType: 'ImportShipment', entityId: id, before: serializeDocument(before), after: serializeDocument(result) }, session);
      });
      return serializeDocument(result as unknown as Document);
    } finally {
      await session.endSession();
    }
  }

  async list(filter: { status?: string | undefined; search?: string | undefined; purchaseOrderId?: string | undefined }, paging: PageRequest) {
    const query: Document = {};
    if (filter.status) query.status = filter.status;
    if (filter.purchaseOrderId) query.purchaseOrderIds = toObjectId(filter.purchaseOrderId, 'purchaseOrderId');
    if (filter.search) {
      const pattern = new RegExp(filter.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      query.$or = [{ code: pattern }, { containerNo: pattern }, { billOfLading: pattern }, { 'lines.purchaseOrderCode': pattern }, { 'lines.sku': pattern }];
    }
    const [rows, total] = await Promise.all([
      this.db.collection('import_shipments').find(query).sort({ createdAt: -1, _id: -1 }).skip(paging.skip).limit(paging.pageSize).toArray(),
      this.db.collection('import_shipments').countDocuments(query),
    ]);
    return pageOf(rows.map((row) => ({
      ...serializeDocument({ ...row, lines: undefined, costs: undefined }),
      lineCount: (row.lines as Document[]).length,
      purchaseOrderCodes: [...new Set((row.lines as Document[]).map((line) => String(line.purchaseOrderCode)))],
      costTotal: (row.costs as Document[]).reduce((sum, cost) => sum.add(decimalString(cost.amount)), new Decimal(0)).toFixed(0),
    })), total, paging);
  }

  /** Chi tiết lô + giá trị VND, đóng gói và giá vốn dự kiến (phân bổ chi phí theo phương pháp đang chọn). */
  async get(id: string) {
    const shipment = await this.db.collection('import_shipments').findOne({ _id: toObjectId(id) });
    if (!shipment) throw new NotFoundException({ code: 'SHIPMENT_NOT_FOUND', message: 'Không tìm thấy lô hàng' });
    return this.present(shipment);
  }

  private async present(shipment: Document, session?: ClientSession) {
    const lines = shipment.lines as Document[];
    const [orders, products, warehouse] = await Promise.all([
      this.db.collection('purchase_orders').find({ _id: { $in: shipment.purchaseOrderIds as ObjectId[] } }, session ? { session } : {}).toArray(),
      this.productsFor(lines.map((line) => line.productId as ObjectId), session),
      this.db.collection('warehouses').findOne({ _id: shipment.warehouseId as ObjectId }, { projection: { name: 1, code: 1 }, ...(session ? { session } : {}) }),
    ]);
    const orderById = new Map(orders.map((order) => [(order._id as ObjectId).toHexString(), order]));
    const presented = lines.map((line) => {
      const order = orderById.get((line.purchaseOrderId as ObjectId).toHexString());
      const ordered = (order?.lines as Document[] | undefined)?.find((row) => (row.productId as ObjectId).equals(line.productId as ObjectId));
      const product = products.get((line.productId as ObjectId).toHexString());
      const quantity = decimalString(line.quantity);
      const packing = packingLine(packingInputOf(product, quantity));
      return {
        purchaseOrderId: (line.purchaseOrderId as ObjectId).toHexString(),
        purchaseOrderCode: String(line.purchaseOrderCode),
        productId: (line.productId as ObjectId).toHexString(),
        sku: String(line.sku),
        productName: String(line.productName),
        baseUnit: String(product?.baseUnit ?? ordered?.unit ?? ''),
        quantity,
        ...(line.receivedQuantity !== undefined ? { receivedQuantity: decimalString(line.receivedQuantity) } : {}),
        unitCost: ordered ? decimalString(ordered.unitCost) : '0',
        currency: String(order?.currency ?? 'VND'),
        exchangeRate: order?.exchangeRate ? decimalString(order.exchangeRate) : '1',
        valueVnd: order && ordered ? this.valueVnd(order, ordered, quantity) : '0',
        cartons: packing.cartons,
        cbm: packing.cbm,
        grossKg: packing.grossKg,
        netKg: packing.netKg,
        print: product ? { nameZh: product.nameZh, nameEn: product.nameEn, specZh: product.specZh, specEn: product.specEn, hsCode: product.hsCode, supplierItemCode: product.supplierItemCode, packSize: product.packSize } : {},
      };
    });
    const costs = (shipment.costs as Document[]).map((cost) => ({ ...serializeDocument(cost), type: String(cost.type), amount: decimalString(cost.amount) }));
    const landed = shipment.landed
      ? serializeDocument(shipment.landed)
      : landedCost(
          presented.map((line) => ({ key: key(line.purchaseOrderId, line.productId), quantity: line.quantity, valueVnd: line.valueVnd, cbm: line.cbm })),
          costs.map((cost) => ({ type: String(cost.type), amountVnd: String(cost.amount) })),
          shipment.allocationMethod as AllocationMethod,
        );
    const totals = presented.reduce((sum, line) => ({
      valueVnd: sum.valueVnd.add(line.valueVnd), cartons: sum.cartons + line.cartons, cbm: sum.cbm + line.cbm, grossKg: sum.grossKg + line.grossKg,
    }), { valueVnd: new Decimal(0), cartons: 0, cbm: 0, grossKg: 0 });
    return {
      ...serializeDocument({ ...shipment, landed: undefined }),
      warehouseName: warehouse ? `${String(warehouse.code)} — ${String(warehouse.name)}` : undefined,
      purchaseOrders: orders.map((order) => ({ id: (order._id as ObjectId).toHexString(), code: order.code, supplierName: order.supplierName, currency: order.currency ?? 'VND', exchangeRate: order.exchangeRate ? decimalString(order.exchangeRate) : '1', supplier: order.supplierId })),
      lines: presented,
      costs,
      landed,
      totals: {
        valueVnd: totals.valueVnd.toFixed(0),
        cartons: totals.cartons,
        cbm: Math.round(totals.cbm * 10_000) / 10_000,
        grossKg: Math.round(totals.grossKg * 100) / 100,
        container: shipment.containerType ? String(shipment.containerType) : containerPlanLabel(containerPlan(totals.cbm, totals.grossKg)),
      },
    };
  }

  /**
   * Nhận hàng cả lô: mỗi đơn mua một phiếu nhập kho (GR) gắn lô; phân bổ chi phí nhập theo số thực nhận;
   * cập nhật giá vốn bình quân gia quyền của từng mã (ghi nhật ký PRODUCT_COST_UPDATED trên hồ sơ sản phẩm).
   */
  async receive(id: string, input: ReceiveImportShipment, request: AuthenticatedRequest, idempotencyKey: string | undefined) {
    return this.idempotency.execute(`import-shipment-receive:${id}`, idempotencyKey, input, async (session) => {
      const shipmentId = toObjectId(id);
      const shipment = await this.db.collection('import_shipments').findOne({ _id: shipmentId, version: input.version }, { session });
      if (!shipment) throw new ConflictException({ code: 'VERSION_CONFLICT', message: 'Lô hàng đã được cập nhật, hãy tải lại rồi nhận hàng' });
      if (!['IN_TRANSIT', 'ARRIVED'].includes(String(shipment.status))) throw new ConflictException({ code: 'SHIPMENT_STATE_CONFLICT', message: 'Chỉ nhận hàng khi lô đang vận chuyển hoặc đã cập cảng' });
      const shipmentLines = shipment.lines as Document[];
      const received = new Map(input.lines.map((line) => [key(line.purchaseOrderId, line.productId), line]));
      for (const line of shipmentLines) {
        const actual = received.get(key(line.purchaseOrderId, line.productId));
        if (actual && new Decimal(actual.quantity).gt(decimalString(line.quantity))) {
          throw new ConflictException({ code: 'RECEIPT_EXCEEDS_SHIPMENT', message: `${String(line.sku)}: số thực nhận vượt số trong lô` });
        }
      }
      const productIds = shipmentLines.map((line) => line.productId as ObjectId);
      // Tồn trước khi nhập (mọi kho) để tính giá vốn bình quân.
      const stockBefore = new Map((await this.db.collection('inventory_balances').aggregate([
        { $match: { productId: { $in: productIds } } },
        { $group: { _id: '$productId', onHand: { $sum: '$onHand' } } },
      ], { session }).toArray()).map((row) => [(row._id as ObjectId).toHexString(), decimalString(row.onHand)]));

      const receiptCodes: string[] = [];
      for (const orderId of shipment.purchaseOrderIds as ObjectId[]) {
        const lines = shipmentLines
          .filter((line) => (line.purchaseOrderId as ObjectId).equals(orderId))
          .map((line) => {
            const actual = received.get(key(line.purchaseOrderId, line.productId));
            return { productId: (line.productId as ObjectId).toHexString(), quantity: actual?.quantity ?? '0', locationCode: actual?.locationCode };
          })
          .filter((line) => Number(line.quantity) > 0);
        if (!lines.length) continue;
        const order = await this.db.collection('purchase_orders').findOne({ _id: orderId, status: { $in: SHIPPABLE_ORDER_STATUSES } }, { session });
        if (!order) throw new ConflictException({ code: 'ORDER_STATE_CONFLICT', message: 'Đơn mua của lô không còn nhận hàng được' });
        const receipt = await this.procurement.postReceipt({ order, lines, supplierDocumentReference: input.supplierDocumentReference, importShipmentId: shipmentId }, request, session);
        receiptCodes.push(receipt.code);
      }
      if (!receiptCodes.length) throw new BadRequestException({ code: 'RECEIPT_EMPTY', message: 'Nhập ít nhất một số lượng thực nhận' });

      // Giá vốn trên số thực nhận (giá trị và CBM tỷ lệ theo số nhận / số trong lô).
      const presented = await this.present(shipment, session);
      const receivedLines = presented.lines.map((line) => {
        const actual = Number(received.get(key(line.purchaseOrderId, line.productId))?.quantity ?? 0);
        const ratio = Number(line.quantity) > 0 ? actual / Number(line.quantity) : 0;
        return { line, actual, valueVnd: String(Math.round(Number(line.valueVnd) * ratio)), cbm: line.cbm * ratio };
      }).filter((row) => row.actual > 0);
      const landed = landedCost(
        receivedLines.map((row) => ({ key: key(row.line.purchaseOrderId, row.line.productId), quantity: String(row.actual), valueVnd: row.valueVnd, cbm: row.cbm })),
        presented.costs.map((cost) => ({ type: String(cost.type), amountVnd: String(cost.amount) })),
        shipment.allocationMethod as AllocationMethod,
      );
      const costUpdates: Array<{ productId: ObjectId; sku: string; before?: string; after: string }> = [];
      if (input.updateStandardCost) {
        const perProduct = new Map<string, { sku: string; quantity: Decimal; landed: Decimal }>();
        for (const row of receivedLines) {
          const share = landed.lines.find((item) => item.key === key(row.line.purchaseOrderId, row.line.productId));
          const current = perProduct.get(row.line.productId) ?? { sku: row.line.sku, quantity: new Decimal(0), landed: new Decimal(0) };
          perProduct.set(row.line.productId, { sku: current.sku, quantity: current.quantity.add(row.actual), landed: current.landed.add(share?.landedVnd ?? 0) });
        }
        for (const [productId, totals] of perProduct) {
          const product = await this.db.collection('products').findOne({ _id: new ObjectId(productId) }, { session });
          if (!product) continue;
          const before = product.standardCost !== undefined ? decimalString(product.standardCost) : undefined;
          const unitLanded = totals.landed.div(totals.quantity).toFixed(2);
          const after = weightedAverageCost(stockBefore.get(productId) ?? '0', before, totals.quantity.toString(), unitLanded);
          await this.db.collection('products').updateOne({ _id: product._id }, { $set: { standardCost: decimal(after), updatedAt: new Date() }, $inc: { version: 1 } }, { session });
          await this.audit.record({
            ...this.actor(request),
            action: 'PRODUCT_COST_UPDATED',
            entityType: 'Product',
            entityId: productId,
            before: { standardCost: before },
            after: { standardCost: after },
            metadata: { importShipment: shipment.code, receivedQuantity: totals.quantity.toString(), landedUnitCost: unitLanded, onHandBefore: stockBefore.get(productId) ?? '0' },
          }, session);
          costUpdates.push({ productId: product._id, sku: totals.sku, ...(before !== undefined ? { before } : {}), after });
        }
      }
      const now = new Date();
      const result = await this.db.collection('import_shipments').findOneAndUpdate(
        { _id: shipmentId, version: input.version },
        {
          $set: {
            status: 'RECEIVED',
            receivedAt: now,
            receivedBy: toObjectId(request.user.sub),
            receiptCodes,
            lines: shipmentLines.map((line) => ({ ...line, receivedQuantity: decimal(received.get(key(line.purchaseOrderId, line.productId))?.quantity ?? '0') })),
            landed,
            costUpdates,
            updatedAt: now,
          },
          $inc: { version: 1 },
        },
        { returnDocument: 'after', session },
      );
      await this.audit.record({ ...this.actor(request), action: 'IMPORT_SHIPMENT_RECEIVED', entityType: 'ImportShipment', entityId: id, metadata: { receiptCodes, costUpdates: costUpdates.map((row) => ({ sku: row.sku, before: row.before, after: row.after })) } }, session);
      return this.present(result as Document, session);
    });
  }
}
