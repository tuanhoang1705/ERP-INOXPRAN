import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { vatPercent, type CreateSampleReturn, type CreateStockReturn, type InventoryCategory, type VatRate } from '@inoxpran/contracts';
import Decimal from 'decimal.js';
import type { ClientSession, Db, Document } from 'mongodb';
import { ObjectId } from 'mongodb';
import { AuditService } from '../../common/audit.service';
import { decimal, decimalString, serializeDocument, toObjectId } from '../../common/domain';
import { IdempotencyService } from '../../common/idempotency.service';
import { OutboxService } from '../../common/outbox.service';
import { pageOf, type PageRequest } from '../../common/paging';
import type { AuthenticatedRequest } from '../../common/request-context';
import { SequenceService } from '../../common/sequence.service';
import { MONGO_DATABASE } from '../../common/tokens';
import { InventoryService } from './inventory.service';

/**
 * Phiếu trả hàng (docs/inventory-excel-mapping.md):
 * - Khách trả (TH…): nhập kho theo loại 滞销退货 / 套餐搭配退回 / 进口不良 / 使用不良; hàng lỗi thường nhập kho hàng lỗi.
 * - Trả nhà máy (XT…): xuất kho 库存退货返厂, chặn xuất quá tồn khả dụng.
 * Chỉ ghi kho (thẻ kho + nhật ký); điều chỉnh công nợ / hóa đơn do kế toán xử lý riêng.
 * Có số phiếu gốc (BH / đơn mua) thì mã hàng phải thuộc phiếu và không trả quá số đã xuất / đã nhận.
 */
@Injectable()
export class StockReturnsService {
  constructor(
    @Inject(MONGO_DATABASE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly sequences: SequenceService,
    private readonly idempotency: IdempotencyService,
    private readonly inventory: InventoryService,
    private readonly outbox: OutboxService,
  ) {}

  /**
   * Giá trị hàng khách trả theo giá đã bán trên phiếu BH gốc: đơn giá sau CK (chưa VAT) của mã = tiền hàng ÷ số lượng
   * (đơn vị cơ bản) các dòng bán; hàng tặng = 0. VAT theo thuế suất của phiếu.
   */
  private valuation(order: Document, quantities: Map<string, Decimal>) {
    const sold = new Map<string, { quantity: Decimal; net: Decimal }>();
    for (const line of order.lines as Document[]) {
      if (line.gift) continue;
      const key = (line.productId as ObjectId).toHexString();
      const current = sold.get(key) ?? { quantity: new Decimal(0), net: new Decimal(0) };
      sold.set(key, { quantity: current.quantity.add(decimalString(line.baseQuantity)), net: current.net.add(decimalString(line.netAmount)) });
    }
    let net = new Decimal(0);
    for (const [productId, quantity] of quantities) {
      const line = sold.get(productId);
      if (line && line.quantity.gt(0)) net = net.add(line.net.div(line.quantity).mul(quantity));
    }
    const roundedNet = net.toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
    const rate = vatPercent(String(order.taxRate ?? '0') as VatRate);
    const tax = roundedNet.mul(rate).div(100).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
    return { net: roundedNet.toFixed(0), tax: tax.toFixed(0), total: roundedNet.add(tax).toFixed(0) };
  }

  async list(kind: string | undefined, paging: PageRequest) {
    // SAMPLE = hàng mẫu / hàng kiểm định nhập lại theo phiếu (SAL-TYPE-01).
    const filter: Document = kind === 'CUSTOMER' || kind === 'SUPPLIER' || kind === 'SAMPLE' ? { kind } : {};
    const [rows, total] = await Promise.all([
      this.db.collection('stock_returns').find(filter).sort({ createdAt: -1, _id: -1 }).skip(paging.skip).limit(paging.pageSize).toArray(),
      this.db.collection('stock_returns').countDocuments(filter),
    ]);
    return pageOf(rows.map((row) => this.view(row)), total, paging);
  }

  async get(id: string) {
    const row = await this.db.collection('stock_returns').findOne({ _id: toObjectId(id) });
    if (!row) throw new NotFoundException({ code: 'STOCK_RETURN_NOT_FOUND', message: 'Không tìm thấy phiếu trả hàng' });
    return this.view(row);
  }

  private view(row: Document) {
    const serialized = serializeDocument(row);
    return { ...serialized, lines: (row.lines as Document[]).map((line) => ({ ...serializeDocument(line), quantity: decimalString(line.quantity) })) };
  }

  /** Số đã xuất (phiếu BH) hoặc đã nhận (đơn mua) theo mã hàng, trừ số đã trả ở các phiếu trước. */
  private async remainingBySource(kind: 'CUSTOMER' | 'SUPPLIER', source: Document, sourceField: 'salesOrderCode' | 'purchaseOrderCode', session: ClientSession) {
    const remaining = new Map<string, Decimal>();
    for (const line of source.lines as Document[]) {
      const key = (line.productId as ObjectId).toHexString();
      const quantity = kind === 'CUSTOMER' ? line.baseQuantity : line.receivedBaseQuantity;
      remaining.set(key, (remaining.get(key) ?? new Decimal(0)).add(decimalString(quantity ?? '0')));
    }
    const previous = await this.db.collection('stock_returns').find({ kind, [sourceField]: source.code }, { session }).toArray();
    for (const row of previous) {
      for (const line of row.lines as Document[]) {
        const key = (line.productId as ObjectId).toHexString();
        remaining.set(key, (remaining.get(key) ?? new Decimal(0)).sub(decimalString(line.quantity)));
      }
    }
    return remaining;
  }

  async markAccounted(id: string, note: string, request: AuthenticatedRequest) {
    const before = await this.db.collection('stock_returns').findOne({ _id: toObjectId(id) });
    if (!before) throw new NotFoundException({ code: 'STOCK_RETURN_NOT_FOUND', message: 'Không tìm thấy phiếu trả hàng' });
    const after = await this.db.collection('stock_returns').findOneAndUpdate(
      { _id: before._id, accountingStatus: 'PENDING' },
      { $set: { accountingStatus: 'DONE', accountingNote: note, accountingBy: toObjectId(request.user.sub), accountingByName: request.user.displayName, accountingAt: new Date() } },
      { returnDocument: 'after' },
    );
    if (!after) throw new ConflictException({ code: 'STOCK_RETURN_NOT_PENDING', message: 'Phiếu không ở trạng thái chờ kế toán xử lý' });
    await this.audit.record({
      actorId: request.user.sub,
      actorEmail: request.user.email,
      correlationId: request.correlationId,
      action: 'CUSTOMER_RETURN_ACCOUNTED',
      entityType: 'StockReturn',
      entityId: id,
      before: serializeDocument(before),
      after: serializeDocument(after),
    });
    return this.view(after);
  }

  /**
   * Nhập lại hàng mẫu không có phiếu xuất hàng mẫu (NVKD mượn trước khi dùng ERP — SAL-TYPE-01 bổ sung 17/10/2026):
   * thẻ kho "Hàng mẫu nhập lại" (SAMPLE_IN), phiếu TH loại hàng mẫu ghi người mượn; không có bước kế toán.
   */
  async createSample(input: CreateSampleReturn, request: AuthenticatedRequest, idempotencyKey: string | undefined) {
    return this.idempotency.execute(`sample-return:${request.user.sub}`, idempotencyKey, input, async (session) => {
      const borrower = await this.db.collection('employees').findOne({ _id: toObjectId(input.borrowerId, 'borrowerId') }, { session });
      if (!borrower) throw new NotFoundException({ code: 'EMPLOYEE_NOT_FOUND', message: 'Không tìm thấy nhân viên mượn hàng', details: [{ path: ['borrowerId'] }] });
      const warehouse = await this.db.collection('warehouses').findOne({ _id: toObjectId(input.warehouseId, 'warehouseId'), active: true }, { session });
      if (!warehouse) throw new NotFoundException({ code: 'WAREHOUSE_NOT_FOUND', message: 'Không tìm thấy kho hoạt động', details: [{ path: ['warehouseId'] }] });
      const quantities = new Map<string, Decimal>();
      for (const line of input.lines) {
        const key = toObjectId(line.productId, 'productId').toHexString();
        quantities.set(key, (quantities.get(key) ?? new Decimal(0)).add(line.quantity));
      }
      const products = await this.db.collection('products').find({ _id: { $in: [...quantities.keys()].map((id) => new ObjectId(id)) } }, { session }).toArray();
      if (products.length !== quantities.size) throw new NotFoundException({ code: 'PRODUCT_NOT_FOUND', message: 'Có mã hàng không tồn tại', details: [{ path: ['lines'] }] });
      const productById = new Map(products.map((product) => [(product._id as ObjectId).toHexString(), product]));
      const code = await this.sequences.next('TH', session, 4, new Date(), 'compact');
      const lines = [...quantities].map(([productId, quantity]) => ({ productId, quantity: quantity.toString() }));
      const partnerName = `Hàng mẫu — ${String(borrower.name)} (không có phiếu xuất mẫu)`;
      await this.inventory.applyPhysicalMovement(
        {
          warehouseId: (warehouse._id as ObjectId).toHexString(),
          referenceType: 'StockReturn',
          referenceId: code,
          movementType: 'LOAN_RETURN',
          direction: 'IN',
          category: 'SAMPLE_IN',
          lines,
          reason: input.note,
          actorId: request.user.sub,
          extra: { borrowerName: String(borrower.name) },
        },
        session,
      );
      const document = {
        _id: new ObjectId(),
        code,
        kind: 'SAMPLE',
        purpose: 'SAMPLE',
        category: 'SAMPLE_IN' as InventoryCategory,
        noSlip: true,
        partnerName,
        salesRepId: borrower._id,
        borrowerName: String(borrower.name),
        warehouseId: warehouse._id,
        warehouseName: String(warehouse.name),
        note: input.note,
        lines: lines.map((line) => {
          const product = productById.get(line.productId) as Document;
          return { productId: product._id, sku: String(product.sku), productName: String(product.name), unit: String(product.baseUnit), quantity: decimal(line.quantity) };
        }),
        createdBy: toObjectId(request.user.sub, 'actorId'),
        createdByName: request.user.displayName,
        createdAt: new Date(),
      };
      await this.db.collection('stock_returns').insertOne(document, { session });
      await this.audit.record(
        {
          actorId: request.user.sub, actorEmail: request.user.email, correlationId: request.correlationId,
          action: 'SAMPLE_RETURN_POSTED', entityType: 'StockReturn', entityId: document._id.toHexString(), after: serializeDocument(document),
        },
        session,
      );
      return this.view(document);
    });
  }

  async create(input: CreateStockReturn, request: AuthenticatedRequest, idempotencyKey: string | undefined) {
    return this.idempotency.execute(`stock-return:${request.user.sub}`, idempotencyKey, input, async (session) => {
      const customer = input.kind === 'CUSTOMER';
      // Đối tác vừa là khách vừa là NCC (BOTH) cũng hiện trong ô chọn — nhận cả hai.
      const partner = await this.db.collection('partners').findOne({ _id: toObjectId(input.partnerId, 'partnerId'), kind: { $in: [customer ? 'CUSTOMER' : 'SUPPLIER', 'BOTH'] } }, { session });
      if (!partner) {
        throw new NotFoundException({ code: customer ? 'CUSTOMER_NOT_FOUND' : 'SUPPLIER_NOT_FOUND', message: customer ? 'Không tìm thấy khách hàng' : 'Không tìm thấy nhà cung cấp', details: [{ path: ['partnerId'] }] });
      }
      const warehouse = await this.db.collection('warehouses').findOne({ _id: toObjectId(input.warehouseId, 'warehouseId'), active: true }, { session });
      if (!warehouse) throw new NotFoundException({ code: 'WAREHOUSE_NOT_FOUND', message: 'Không tìm thấy kho hoạt động', details: [{ path: ['warehouseId'] }] });

      // Gộp dòng trùng mã hàng.
      const quantities = new Map<string, Decimal>();
      for (const line of input.lines) {
        const key = toObjectId(line.productId, 'productId').toHexString();
        quantities.set(key, (quantities.get(key) ?? new Decimal(0)).add(line.quantity));
      }
      const products = await this.db.collection('products').find({ _id: { $in: [...quantities.keys()].map((id) => new ObjectId(id)) } }, { session }).toArray();
      if (products.length !== quantities.size) throw new NotFoundException({ code: 'PRODUCT_NOT_FOUND', message: 'Có mã hàng không tồn tại', details: [{ path: ['lines'] }] });
      const productById = new Map(products.map((product) => [(product._id as ObjectId).toHexString(), product]));

      const sourceCode = customer ? input.salesOrderCode : input.purchaseOrderCode;
      let salesOrder: Document | null = null;
      if (sourceCode) {
        const source = customer
          ? await this.db.collection('sales_orders').findOne({ code: sourceCode }, { session })
          : await this.db.collection('purchase_orders').findOne({ code: sourceCode }, { session });
        const owner = source ? (customer ? source.customerId : source.supplierId) as ObjectId | undefined : undefined;
        if (!source || !owner?.equals(partner._id as ObjectId)) {
          throw new BadRequestException({
            code: customer ? 'RETURN_ORDER_NOT_FOUND' : 'RETURN_PURCHASE_NOT_FOUND',
            message: customer ? `Không có phiếu bán ${sourceCode} của khách ${String(partner.code)}` : `Không có đơn mua ${sourceCode} của nhà cung cấp ${String(partner.code)}`,
            details: [{ path: [customer ? 'salesOrderCode' : 'purchaseOrderCode'] }],
          });
        }
        if (customer) salesOrder = source;
        if (customer && !source.shippedAt) {
          throw new ConflictException({ code: 'RETURN_ORDER_NOT_SHIPPED', message: `Phiếu ${sourceCode} chưa xuất kho nên chưa thể trả hàng`, details: [{ path: ['salesOrderCode'] }] });
        }
        const remaining = await this.remainingBySource(input.kind, source, customer ? 'salesOrderCode' : 'purchaseOrderCode', session);
        for (const [productId, quantity] of quantities) {
          const left = remaining.get(productId);
          const sku = String(productById.get(productId)?.sku ?? productId);
          if (!left) throw new BadRequestException({ code: 'RETURN_PRODUCT_NOT_IN_SOURCE', message: `Mã ${sku} không có trong ${sourceCode}`, details: [{ path: ['lines'] }] });
          if (quantity.gt(left)) {
            throw new BadRequestException({ code: 'RETURN_EXCEEDS_SOURCE', message: `Mã ${sku} chỉ còn trả được ${left.toString()} theo ${sourceCode}`, details: [{ path: ['lines'] }] });
          }
        }
      }

      const category: InventoryCategory = customer ? input.category : 'FACTORY_RETURN_OUT';
      const code = await this.sequences.next(customer ? 'TH' : 'XT', session, 4, new Date(), 'compact');
      const lines = [...quantities].map(([productId, quantity]) => ({ productId, quantity: quantity.toString() }));
      await this.inventory.applyPhysicalMovement(
        {
          warehouseId: (warehouse._id as ObjectId).toHexString(),
          referenceType: 'StockReturn',
          referenceId: code,
          movementType: customer ? 'CUSTOMER_RETURN' : 'SUPPLIER_RETURN',
          direction: customer ? 'IN' : 'OUT',
          category,
          lines,
          reason: input.note,
          actorId: request.user.sub,
          extra: { partnerId: partner._id, ...(customer && input.salesOrderCode ? { salesOrderCode: input.salesOrderCode } : {}) },
        },
        session,
      );
      const now = new Date();
      // Hàng tặng / combo trả lại không có giá bán → không tính giá trị.
      const value = customer && category !== 'GIFT_RETURN_IN' && salesOrder ? this.valuation(salesOrder, quantities) : undefined;
      // Khách trả có ảnh hưởng tiền (trừ hàng tặng / combo trả lại): chờ kế toán giảm công nợ / xuất hóa đơn điều chỉnh.
      // Trả theo phiếu giá 0 đ (15/10/2026) không có gì phải điều chỉnh.
      const needsAccounting = customer && category !== 'GIFT_RETURN_IN' && !(value && new Decimal(value.total).isZero());
      const document = {
        _id: new ObjectId(),
        code,
        kind: input.kind,
        category,
        partnerId: partner._id,
        partnerCode: String(partner.code),
        partnerName: String(partner.name),
        warehouseId: warehouse._id,
        warehouseName: String(warehouse.name),
        ...(customer && input.salesOrderCode ? { salesOrderCode: input.salesOrderCode } : {}),
        ...(!customer && input.purchaseOrderCode ? { purchaseOrderCode: input.purchaseOrderCode } : {}),
        note: input.note,
        ...(value ? { value } : {}),
        ...(needsAccounting ? { accountingStatus: 'PENDING' } : {}),
        lines: lines.map((line) => {
          const product = productById.get(line.productId) as Document;
          return { productId: product._id, sku: String(product.sku), productName: String(product.name), unit: String(product.baseUnit), quantity: decimal(line.quantity) };
        }),
        createdBy: toObjectId(request.user.sub, 'actorId'),
        createdByName: request.user.displayName,
        createdAt: now,
      };
      await this.db.collection('stock_returns').insertOne(document, { session });
      if (needsAccounting) {
        await this.outbox.enqueue(
          {
            eventType: 'NOTIFICATION_REQUESTED',
            aggregateType: 'StockReturn',
            aggregateId: document._id.toHexString(),
            payload: {
              category: 'INVENTORY',
              targetRoles: ['ACCOUNTANT'],
              level: 'INFO',
              title: `Khách trả hàng ${code} — cần điều chỉnh công nợ`,
              message: `${String(partner.name)} trả hàng${input.kind === 'CUSTOMER' && input.salesOrderCode ? ` theo ${input.salesOrderCode}` : ''}${value ? `, giá trị ${Number(value.total).toLocaleString('vi-VN')} đ` : ''}.`,
              href: '/inventory/returns',
              template: 'CUSTOMER_RETURN_POSTED',
              params: { code, customer: String(partner.name), order: (customer && input.salesOrderCode) || '', amount: value?.total ?? '', category },
            },
          },
          session,
        );
      }
      await this.audit.record(
        {
          actorId: request.user.sub,
          actorEmail: request.user.email,
          correlationId: request.correlationId,
          action: customer ? 'CUSTOMER_RETURN_POSTED' : 'SUPPLIER_RETURN_POSTED',
          entityType: 'StockReturn',
          entityId: document._id.toHexString(),
          after: serializeDocument(document),
        },
        session,
      );
      return this.view(document);
    });
  }
}
