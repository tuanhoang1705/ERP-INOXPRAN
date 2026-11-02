import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { AdjustmentCategory, CreateInventoryTransfer, InventoryCategory } from '@inoxpran/contracts';
import type { Db, ClientSession, Document } from 'mongodb';
import { Decimal128, ObjectId } from 'mongodb';
import Decimal from 'decimal.js';
import { dateBounds } from '../../common/date-range';
import { AuditService } from '../../common/audit.service';
import { decimal, decimalString, serializeDocument, toObjectId } from '../../common/domain';
import type { AuthenticatedRequest } from '../../common/request-context';
import { MONGO_DATABASE } from '../../common/tokens';
import { pageOf, type PageRequest } from '../../common/paging';
import { IdempotencyService } from '../../common/idempotency.service';
import { SequenceService } from '../../common/sequence.service';
import { defectiveWarehouseIds } from '../../common/warehouses';
import { hiddenMovementFilter } from './hidden-movements';

interface StockLine {
  productId: string;
  quantity: string;
  locationCode?: string | undefined;
  /** Tồn đầu kỳ từ Excel: số lượng nhập ban đầu (初始入库) để tính % tồn còn lại. */
  initialQuantity?: string | undefined;
  /** Nguyên nhân / ghi chú của dòng (phiếu trả hàng) — ghi lên dòng thẻ kho (lineNote). */
  note?: string | undefined;
}

interface ReservationLine {
  productId: string;
  baseQuantity: unknown;
  /** Dòng hàng tặng KM / combo → thẻ kho loại GIFT_OUT (cột 活动赠送·套餐搭配). */
  gift?: boolean;
}

@Injectable()
export class InventoryService {
  constructor(
    @Inject(MONGO_DATABASE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly sequences: SequenceService,
    private readonly idempotency: IdempotencyService,
  ) {}

  /**
   * Tồn kho theo kho / mã. `asOf` (YYYY-MM-DD, LIST-DATE-01): tồn cuối ngày đó theo giờ Việt Nam = tồn hiện tại trừ các phát sinh
   * thẻ kho sau thời điểm đó; xem ngày cũ thì không có số giữ chỗ và bỏ lọc "dưới định mức".
   * INV-ALL-01 (31/10/2026): không chọn kho = mỗi mã một dòng, cộng mọi kho; khả dụng / dưới định mức chỉ tính kho bán được, phần ở
   * kho hàng lỗi ghi riêng (defectiveOnHand). Xem kho hàng lỗi thì bỏ các mã đã hết (tồn 0).
   */
  async listBalances(warehouseId?: string, search?: string, lowOnly = false, paging: PageRequest | null = null, asOf?: string) {
    const asOfEnd = asOf ? dateBounds(asOf, asOf)?.$lt ?? null : null;
    if (asOfEnd) lowOnly = false;
    // Kho hàng lỗi không cảnh báo dưới định mức và không tính vào khả dụng.
    const defective = await defectiveWarehouseIds(this.db);
    const grouped = !warehouseId;
    const match: Document = {};
    if (warehouseId) {
      match.warehouseId = toObjectId(warehouseId, 'warehouseId');
      if (defective.some((id) => id.equals(match.warehouseId as ObjectId))) match.onHand = { $ne: 0 };
    }
    const isDefective = { $in: ['$warehouseId', defective] };
    const pipeline: Document[] = [
      { $match: match },
      ...(grouped
        ? [
            {
              $group: {
                _id: '$productId',
                onHand: { $sum: '$onHand' },
                reserved: { $sum: '$reserved' },
                defectiveOnHand: { $sum: { $cond: [isDefective, '$onHand', 0] } },
                sellable: { $sum: { $cond: [isDefective, 0, { $subtract: ['$onHand', '$reserved'] }] } },
                locationCode: { $max: { $cond: [isDefective, null, '$locationCode'] } },
                updatedAt: { $max: '$updatedAt' },
              },
            },
            { $addFields: { productId: '$_id' } },
          ]
        : []),
      {
        $lookup: {
          from: 'products',
          localField: 'productId',
          foreignField: '_id',
          as: 'product',
        },
      },
      { $unwind: '$product' },
    ];
    if (search) {
      pipeline.push({
        $match: {
          $or: [
            { 'product.sku': { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } },
            { 'product.name': { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } },
          ],
        },
      });
    }
    // Dưới định mức: còn khả dụng (tồn − giữ, chỉ kho bán được) ≤ định mức tối thiểu > 0.
    const lowMatch = grouped
      ? { $expr: { $and: [{ $gt: ['$product.minimumStock', 0] }, { $lte: ['$sellable', '$product.minimumStock'] }] } }
      : { warehouseId: { $nin: defective }, $expr: { $and: [{ $gt: ['$product.minimumStock', 0] }, { $lte: [{ $subtract: ['$onHand', '$reserved'] }, '$product.minimumStock'] }] } };
    if (lowOnly) pipeline.push({ $match: lowMatch });
    // Cùng mã ở nhiều kho (xem một kho thì không có): sắp thêm theo kho để phân trang ổn định.
    pipeline.push({ $sort: grouped ? { 'product.sku': 1 } : { 'product.sku': 1, warehouseId: 1 } });
    let documents: Document[];
    let counts = { total: 0, low: 0 };
    if (paging) {
      const [facet] = await this.db.collection('inventory_balances').aggregate([
        ...pipeline,
        { $facet: { rows: [{ $skip: paging.skip }, { $limit: paging.pageSize }], total: [{ $count: 'value' }], low: [{ $match: lowMatch }, { $count: 'value' }] } },
      ]).toArray();
      documents = (facet?.rows as Document[] | undefined) ?? [];
      counts = { total: Number((facet?.total as Document[] | undefined)?.[0]?.value ?? 0), low: Number((facet?.low as Document[] | undefined)?.[0]?.value ?? 0) };
    } else {
      documents = await this.db.collection('inventory_balances').aggregate([...pipeline, { $limit: 500 }]).toArray();
    }
    // Phát sinh sau cuối ngày xem (chỉ cho các dòng đang hiển thị): nhập cộng, xuất trừ. Gộp mã: cộng mọi kho, phần kho lỗi riêng.
    const after = new Map<string, number>();
    const defectiveAfter = new Map<string, number>();
    if (asOfEnd && documents.length) {
      const moved = await this.db.collection('inventory_movements').aggregate([
        {
          $match: {
            occurredAt: { $gte: asOfEnd },
            productId: { $in: documents.map((document) => document.productId as ObjectId) },
            ...(grouped ? {} : { warehouseId: { $in: [...new Set(documents.map((document) => String(document.warehouseId)))].map((id) => new ObjectId(id)) } }),
          },
        },
        { $group: { _id: { warehouseId: '$warehouseId', productId: '$productId' }, net: { $sum: { $cond: [{ $eq: ['$direction', 'IN'] }, '$quantity', { $multiply: ['$quantity', -1] }] } } } },
      ]).toArray();
      for (const row of moved) {
        const net = Number(decimalString(row.net));
        const key = grouped ? String(row._id.productId) : `${String(row._id.warehouseId)}:${String(row._id.productId)}`;
        after.set(key, (after.get(key) ?? 0) + net);
        if (grouped && defective.some((id) => id.equals(row._id.warehouseId as ObjectId))) defectiveAfter.set(key, (defectiveAfter.get(key) ?? 0) + net);
      }
    }
    const round4 = (value: number) => Math.round(value * 10_000) / 10_000;
    const rows = documents.map((document) => {
      const key = grouped ? String(document.productId) : `${String(document.warehouseId)}:${String(document.productId)}`;
      const current = Number(decimalString(document.onHand));
      const onHand = asOfEnd ? round4(current - (after.get(key) ?? 0)) : current;
      const reserved = asOfEnd ? 0 : Number(decimalString(document.reserved));
      const minimum = Number(decimalString(document.product.minimumStock));
      const defectiveOnHand = grouped ? round4(Number(decimalString(document.defectiveOnHand)) - (asOfEnd ? defectiveAfter.get(key) ?? 0 : 0)) : 0;
      const isDefectiveRow = !grouped && defective.some((id) => id.equals(document.warehouseId as ObjectId));
      // Khả dụng: gộp mã = phần kho bán được (tồn − hàng lỗi − giữ chỗ); một kho = tồn − giữ chỗ.
      const available = round4(onHand - reserved - defectiveOnHand);
      return {
        productId: (document.productId as ObjectId).toHexString(),
        warehouseId: grouped ? null : (document.warehouseId as ObjectId).toHexString(),
        sku: document.product.sku,
        productName: document.product.name,
        unit: document.product.baseUnit,
        onHand: String(onHand),
        reserved: String(reserved),
        available: String(available),
        ...(grouped ? { defectiveOnHand: String(defectiveOnHand) } : {}),
        ...(isDefectiveRow ? { defective: true } : {}),
        minimumStock: String(minimum),
        locationCode: (document.locationCode as string | null | undefined) ?? null,
        belowMinimum: minimum > 0 && available <= minimum && !isDefectiveRow,
        updatedAt: (document.updatedAt as Date).toISOString(),
      };
    });
    return paging ? pageOf(rows, counts.total, paging, { lowCount: counts.low }) : rows;
  }

  async listMovements(productId?: string, warehouseId?: string, paging: PageRequest | null = null, viewer: { root?: boolean | undefined } = {}) {
    const filter: Document = {};
    if (productId) filter.productId = toObjectId(productId, 'productId');
    if (warehouseId) filter.warehouseId = toObjectId(warehouseId, 'warehouseId');
    // Chứng từ đã hủy (phiếu trả hàng, phiếu BH hủy sau giao): các dòng bù trừ về 0, chỉ quản trị gốc thấy — tồn hiện tại vẫn đúng.
    Object.assign(filter, await hiddenMovementFilter(this.db, viewer));
    const cursor = this.db.collection('inventory_movements').find(filter).sort({ occurredAt: -1, _id: -1 });
    if (!paging) return (await cursor.limit(500).toArray()).map(serializeDocument);
    const [rows, total] = await Promise.all([cursor.skip(paging.skip).limit(paging.pageSize).toArray(), this.db.collection('inventory_movements').countDocuments(filter)]);
    if (!productId) return pageOf(rows.map(serializeDocument), total, paging);
    // Thẻ kho một mã: tồn sau dòng đầu trang = tồn hiện tại − phát sinh của các dòng mới hơn (các trang trước).
    const signed = { $cond: [{ $eq: ['$direction', 'IN'] }, '$quantity', { $multiply: ['$quantity', -1] }] };
    const [stock, newer] = await Promise.all([
      this.db.collection('inventory_balances').aggregate([{ $match: filter }, { $group: { _id: null, onHand: { $sum: '$onHand' } } }]).toArray(),
      paging.skip
        ? this.db.collection('inventory_movements').aggregate([{ $match: filter }, { $sort: { occurredAt: -1, _id: -1 } }, { $limit: paging.skip }, { $group: { _id: null, net: { $sum: signed } } }]).toArray()
        : Promise.resolve([]),
    ]);
    const onHand = new Decimal(decimalString(stock[0]?.onHand ?? '0'));
    const topBalance = onHand.sub(decimalString(newer[0]?.net ?? '0'));
    return pageOf(rows.map(serializeDocument), total, paging, { onHand: onHand.toString(), topBalance: topBalance.toString() });
  }

  async applyAdjustment(
    input: { warehouseId: string; reason: string; direction: 'IN' | 'OUT'; category?: AdjustmentCategory | undefined; lines: StockLine[] },
    request: AuthenticatedRequest,
    idempotencyKey: string | undefined,
  ) {
    return this.idempotency.execute(
      `inventory-adjustment:${request.user.sub}`,
      idempotencyKey,
      input,
      async (session) => {
          const reference = await this.sequences.next('ADJ', session);
          await this.applyPhysicalMovement(
            {
              warehouseId: input.warehouseId,
              referenceType: 'InventoryAdjustment',
              referenceId: reference,
              movementType: input.direction === 'IN' ? 'ADJUSTMENT_IN' : 'ADJUSTMENT_OUT',
              direction: input.direction,
              category: input.category ?? (input.direction === 'IN' ? 'ADJUST_IN' : 'ADJUST_OUT'),
              lines: input.lines,
              reason: input.reason,
              actorId: request.user.sub,
            },
            session,
          );
          await this.audit.record(
            {
              actorId: request.user.sub,
              actorEmail: request.user.email,
              correlationId: request.correlationId,
              action: 'INVENTORY_ADJUSTED',
              entityType: 'InventoryAdjustment',
              entityId: reference,
              after: input,
            },
            session,
          );
          return { reference, posted: true };
      },
    );
  }

  async transfer(
    input: CreateInventoryTransfer,
    request: AuthenticatedRequest,
    idempotencyKey: string | undefined,
  ) {
    return this.idempotency.execute(
      `inventory-transfer:${request.user.sub}`,
      idempotencyKey,
      input,
      async (session) => {
        const code = await this.sequences.next('TRF', session);
        const transferId = new ObjectId();
        await this.applyPhysicalMovement(
          {
            warehouseId: input.fromWarehouseId,
            referenceType: 'InventoryTransfer',
            referenceId: code,
            movementType: 'TRANSFER_OUT',
            direction: 'OUT',
            lines: input.lines.map((line) => ({
              productId: line.productId,
              quantity: line.quantity,
              locationCode: line.fromLocationCode,
            })),
            reason: input.reason,
            actorId: request.user.sub,
          },
          session,
        );
        await this.applyPhysicalMovement(
          {
            warehouseId: input.toWarehouseId,
            referenceType: 'InventoryTransfer',
            referenceId: code,
            movementType: 'TRANSFER_IN',
            direction: 'IN',
            lines: input.lines.map((line) => ({
              productId: line.productId,
              quantity: line.quantity,
              locationCode: line.toLocationCode,
            })),
            reason: input.reason,
            actorId: request.user.sub,
          },
          session,
        );

        const now = new Date();
        const document = {
          _id: transferId,
          code,
          fromWarehouseId: toObjectId(input.fromWarehouseId, 'fromWarehouseId'),
          toWarehouseId: toObjectId(input.toWarehouseId, 'toWarehouseId'),
          reason: input.reason,
          lines: input.lines.map((line) => ({
            productId: toObjectId(line.productId, 'productId'),
            quantity: decimal(line.quantity),
            fromLocationCode: line.fromLocationCode,
            toLocationCode: line.toLocationCode,
          })),
          status: 'POSTED',
          postedBy: toObjectId(request.user.sub, 'actorId'),
          postedAt: now,
          createdAt: now,
        };
        await this.db.collection('inventory_transfers').insertOne(document, { session });
        await this.audit.record(
          {
            actorId: request.user.sub,
            actorEmail: request.user.email,
            correlationId: request.correlationId,
            action: 'INVENTORY_TRANSFER_POSTED',
            entityType: 'InventoryTransfer',
            entityId: transferId.toHexString(),
            after: serializeDocument(document),
          },
          session,
        );
        return serializeDocument(document);
      },
    );
  }

  async applyPhysicalMovement(
    input: {
      warehouseId: string;
      referenceType: string;
      referenceId: string;
      movementType: string;
      direction: 'IN' | 'OUT';
      /** Loại phát sinh chuẩn ($shared/inventory-categories); bỏ trống thì báo cáo suy ra từ movementType. */
      category?: InventoryCategory | undefined;
      lines: StockLine[];
      reason?: string;
      actorId: string;
      /** Thông tin thêm ghi trên dòng thẻ kho (VD đối tác của phiếu trả hàng). */
      extra?: Document;
      /** Ngày phát sinh trên thẻ kho / báo cáo tháng (VD ngày nhận hàng trả, ngày của phiếu được đảo); mặc định lúc ghi. */
      occurredAt?: Date;
      /** Dòng đảo / sửa chứng từ cũ: vẫn ghi được cho mã đã ngừng kinh doanh. */
      anyProductStatus?: boolean;
    },
    session: ClientSession,
  ): Promise<void> {
    const warehouseId = toObjectId(input.warehouseId, 'warehouseId');
    const warehouse = await this.db.collection('warehouses').findOne({ _id: warehouseId, active: true }, { session });
    if (!warehouse) throw new NotFoundException({ code: 'WAREHOUSE_NOT_FOUND', message: 'Không tìm thấy kho hoạt động' });

    for (const line of input.lines) {
      const productId = toObjectId(line.productId, 'productId');
      const quantity = decimal(line.quantity);
      const product = await this.db.collection('products').findOne(input.anyProductStatus ? { _id: productId } : { _id: productId, status: 'ACTIVE' }, { session });
      if (!product) throw new NotFoundException({ code: 'PRODUCT_NOT_FOUND', message: 'Không tìm thấy sản phẩm' });

      if (input.direction === 'IN') {
        // Không chọn vị trí thì giữ vị trí lưu hiện có của mã hàng (chỉ đặt rỗng khi tạo dòng tồn mới).
        const created = { _id: new ObjectId(), reserved: decimal('0'), createdAt: new Date() };
        await this.db.collection('inventory_balances').updateOne(
          { warehouseId, productId },
          line.locationCode
            ? { $setOnInsert: created, $inc: { onHand: quantity }, $set: { locationCode: line.locationCode, updatedAt: new Date() } }
            : { $setOnInsert: { ...created, locationCode: null }, $inc: { onHand: quantity }, $set: { updatedAt: new Date() } },
          { upsert: true, session },
        );
      } else {
        const updated = await this.db.collection('inventory_balances').updateOne(
          {
            warehouseId,
            productId,
            $expr: { $gte: [{ $subtract: ['$onHand', '$reserved'] }, quantity] },
          },
          { $inc: { onHand: Decimal128.fromString(`-${line.quantity}`) }, $set: { updatedAt: new Date() } },
          { session },
        );
        if (updated.modifiedCount !== 1) {
          throw new ConflictException({
            code: 'INSUFFICIENT_AVAILABLE_STOCK',
            message: `Tồn khả dụng của ${String(product.sku)} không đủ`,
          });
        }
      }

      await this.db.collection('inventory_movements').insertOne(
        {
          _id: new ObjectId(),
          warehouseId,
          productId,
          movementType: input.movementType,
          direction: input.direction,
          ...(input.category ? { category: input.category } : {}),
          quantity,
          ...(line.initialQuantity ? { initialQuantity: decimal(line.initialQuantity) } : {}),
          unit: product.baseUnit,
          referenceType: input.referenceType,
          referenceId: input.referenceId,
          reason: input.reason,
          ...(line.note ? { lineNote: line.note } : {}),
          ...(input.extra ?? {}),
          actorId: toObjectId(input.actorId, 'actorId'),
          occurredAt: input.occurredAt ?? new Date(),
          ...(input.occurredAt ? { recordedAt: new Date() } : {}),
        },
        { session },
      );
    }
  }

  async reserve(
    orderId: ObjectId,
    warehouseIdValue: string,
    lines: ReservationLine[],
    actorId: string,
    session: ClientSession,
  ): Promise<void> {
    const warehouseId = toObjectId(warehouseIdValue, 'warehouseId');
    for (const line of lines) {
      const productId = toObjectId(line.productId, 'productId');
      const quantityValue = decimalString(line.baseQuantity);
      const quantity = decimal(quantityValue);
      const updated = await this.db.collection('inventory_balances').updateOne(
        {
          warehouseId,
          productId,
          $expr: { $gte: [{ $subtract: ['$onHand', '$reserved'] }, quantity] },
        },
        { $inc: { reserved: quantity }, $set: { updatedAt: new Date() } },
        { session },
      );
      if (updated.modifiedCount !== 1) {
        throw new ConflictException({ code: 'INSUFFICIENT_AVAILABLE_STOCK', message: 'Tồn khả dụng không đủ để giữ hàng' });
      }
      await this.db.collection('inventory_reservations').insertOne(
        {
          _id: new ObjectId(),
          salesOrderId: orderId,
          warehouseId,
          productId,
          quantity,
          status: 'ACTIVE',
          createdBy: toObjectId(actorId, 'actorId'),
          createdAt: new Date(),
        },
        { session },
      );
    }
  }

  /** Nhả toàn bộ hàng đang giữ của một phiếu (khi phiếu bị trả về sửa hoặc hủy). */
  async release(orderId: ObjectId, session: ClientSession): Promise<void> {
    const reservations = await this.db
      .collection('inventory_reservations')
      .find({ salesOrderId: orderId, status: 'ACTIVE' }, { session })
      .toArray();
    for (const reservation of reservations) {
      const quantity = decimalString(reservation.quantity);
      const updated = await this.db.collection('inventory_balances').updateOne(
        { warehouseId: reservation.warehouseId, productId: reservation.productId, reserved: { $gte: decimal(quantity) } },
        { $inc: { reserved: Decimal128.fromString(`-${quantity}`) }, $set: { updatedAt: new Date() } },
        { session },
      );
      if (updated.modifiedCount !== 1) {
        throw new ConflictException({ code: 'RESERVATION_MISMATCH', message: 'Số lượng giữ chỗ không còn hợp lệ' });
      }
      await this.db.collection('inventory_reservations').updateOne(
        { _id: reservation._id },
        { $set: { status: 'RELEASED', releasedAt: new Date() } },
        { session },
      );
    }
  }

  async shipReserved(
    orderId: ObjectId,
    warehouseIdValue: string,
    lines: ReservationLine[],
    actorId: string,
    shipmentCode: string,
    session: ClientSession,
    salesOrderCode?: string,
    /** Phiếu hàng mẫu / kiểm định: mọi dòng ghi loại này thay cho Xuất bán / Hàng tặng (SAL-TYPE-01). */
    category?: InventoryCategory,
  ): Promise<void> {
    const warehouseId = toObjectId(warehouseIdValue, 'warehouseId');
    for (const line of lines) {
      const productId = toObjectId(line.productId, 'productId');
      const quantityValue = decimalString(line.baseQuantity);
      const quantity = decimal(quantityValue);
      const negative = Decimal128.fromString(`-${quantityValue}`);
      const updated = await this.db.collection('inventory_balances').updateOne(
        {
          warehouseId,
          productId,
          onHand: { $gte: quantity },
          reserved: { $gte: quantity },
        },
        { $inc: { onHand: negative, reserved: negative }, $set: { updatedAt: new Date() } },
        { session },
      );
      if (updated.modifiedCount !== 1) {
        throw new ConflictException({ code: 'RESERVATION_MISMATCH', message: 'Tồn giữ chỗ không còn hợp lệ' });
      }
      await this.db.collection('inventory_reservations').updateOne(
        { salesOrderId: orderId, productId, status: 'ACTIVE' },
        { $set: { status: 'CONSUMED', consumedAt: new Date() } },
        { session },
      );
      await this.db.collection('inventory_movements').insertOne(
        {
          _id: new ObjectId(),
          warehouseId,
          productId,
          movementType: 'SALES_SHIPMENT',
          direction: 'OUT',
          category: category ?? (line.gift ? 'GIFT_OUT' : 'SALES_OUT'),
          quantity,
          referenceType: 'Shipment',
          referenceId: shipmentCode,
          ...(salesOrderCode ? { salesOrderCode } : {}),
          actorId: toObjectId(actorId, 'actorId'),
          occurredAt: new Date(),
        },
        { session },
      );
    }
  }
}
