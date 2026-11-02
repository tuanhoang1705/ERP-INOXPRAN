import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  categoryAmount,
  categoryInfo,
  categoryOf,
  INVENTORY_CATEGORIES,
  isNonSale,
  MOVEMENT_TYPE_CATEGORY,
  monthlyBalance,
  orderParty,
  remainingPercent,
  type InventoryCategory,
  type InventoryJournalRow,
  type InventoryMonthlyReport,
  type InventoryMonthlyRow,
  type StockCountRow,
  type StockCountWarning,
  type StockDirection,
  vnDate,
} from '@inoxpran/contracts';
import type { Db, Document, ObjectId } from 'mongodb';
import { dateBounds, vnDayBegin } from '../../common/date-range';
import { decimalString, toObjectId, vnMonthStart, vnParts } from '../../common/domain';
import { pageOf, type PageRequest } from '../../common/paging';
import { MONGO_DATABASE } from '../../common/tokens';
import { hiddenMovementFilter } from './hidden-movements';
import { monthlyTemplateWorkbook } from './monthly-template-workbook';
import { addBodyRow, brandSheet, brandWorkbook, exportedAt, finalize, FORMATS, kpiStrip, tableHeader, titleBlock, toBuffer, totalRow, type BrandColumn } from '../../common/excel-brand';

const TRANSFERS = ['TRANSFER_IN', 'TRANSFER_OUT'];
const EXPORT_LIMIT = 20_000;
const round = (value: number) => Math.round(value * 10_000) / 10_000;
const naturalSku = (a: { sku: string }, b: { sku: string }) => a.sku.localeCompare(b.sku, 'en', { numeric: true });

/**
 * Báo cáo kho theo mẫu công ty: tồn kho tháng (`月库存明细单`) và nhật ký xuất nhập (`出库汇总`), có xuất Excel.
 * Tính từ thẻ kho (inventory_movements) theo loại phát sinh chuẩn ($shared/inventory-categories).
 * Xem cả công ty thì bỏ qua chuyển kho nội bộ (hai chiều triệt tiêu), cộng cả kho hàng lỗi như file Excel đang làm.
 */
/** Kỳ nhật ký xuất nhập: một tháng (YYYY-MM) hoặc khoảng ngày (YYYY-MM-DD). */
export interface JournalPeriod { month?: string | undefined; from?: string | undefined; to?: string | undefined }
/** Bộ lọc nhật ký xuất nhập; `viewer` không phải quản trị gốc thì ẩn dòng của phiếu trả hàng đã hủy. */
export interface JournalOptions { warehouseId?: string | undefined; category?: InventoryCategory | undefined; search?: string | undefined; viewer?: { root?: boolean | undefined } }

@Injectable()
export class InventoryReportsService {
  constructor(@Inject(MONGO_DATABASE) private readonly db: Db) {}

  private range(month: string) {
    const match = /^(\d{4})-(\d{2})$/.exec(month ?? '');
    const year = Number(match?.[1]);
    const monthNo = Number(match?.[2]);
    if (!match || monthNo < 1 || monthNo > 12) throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'Tháng phải có dạng YYYY-MM', details: [{ path: ['month'] }] });
    const now = vnParts(new Date());
    if (year * 12 + monthNo > now.year * 12 + now.month) throw new BadRequestException({ code: 'REPORT_MONTH_IN_FUTURE', message: 'Chưa đến tháng báo cáo', details: [{ path: ['month'] }] });
    return { year, monthNo, start: vnMonthStart(year, monthNo), end: vnMonthStart(year, monthNo + 1), current: year === now.year && monthNo === now.month };
  }

  /**
   * Kỳ của nhật ký xuất nhập (LIST-DATE-01): khoảng ngày `from` – `to` (giờ Việt Nam, tối đa 366 ngày) hoặc một tháng `month` như trước.
   */
  private journalPeriod(period: JournalPeriod) {
    if (period.from || period.to) {
      const bounds = dateBounds(period.from, period.to);
      const today = vnDate(new Date());
      const fromDay = period.from || today.slice(0, 7) + '-01';
      const toDay = period.to || today;
      const start = bounds?.$gte ?? vnDayBegin(fromDay);
      const end = bounds?.$lt ?? new Date(vnDayBegin(toDay).getTime() + 86_400_000);
      if (end.getTime() - start.getTime() > 366 * 86_400_000) {
        throw new BadRequestException({ code: 'DATE_RANGE_TOO_LONG', message: 'Khoảng ngày tối đa 366 ngày', details: [{ path: ['from'] }] });
      }
      const show = (value: string) => value.split('-').reverse().join('/');
      return {
        start, end,
        title: `${fromDay} 至 ${toDay} 仓库出入库汇总 — NHẬT KÝ XUẤT NHẬP KHO TỪ ${show(fromDay)} ĐẾN ${show(toDay)}`,
        sheetName: '出入库汇总',
        fileTag: `${fromDay}_${toDay}`,
      };
    }
    const month = period.month || vnDate(new Date()).slice(0, 7);
    const range = this.range(month);
    return {
      start: range.start, end: range.end,
      title: `${range.year}年${range.monthNo}月 仓库出入库汇总 — NHẬT KÝ XUẤT NHẬP KHO THÁNG ${range.monthNo}/${range.year}`,
      sheetName: `${range.monthNo}月出入库汇总`,
      fileTag: month,
    };
  }

  private async scope(warehouseId: string | undefined) {
    if (!warehouseId) return { filter: { movementType: { $nin: TRANSFERS } } as Document, warehouse: null };
    const warehouse = await this.db.collection('warehouses').findOne({ _id: toObjectId(warehouseId, 'warehouseId') });
    if (!warehouse) throw new NotFoundException({ code: 'WAREHOUSE_NOT_FOUND', message: 'Không tìm thấy kho' });
    return { filter: { warehouseId: warehouse._id } as Document, warehouse };
  }

  /** Phiếu kiểm kê trong kỳ đã chốt mà còn lệch (STK-01) — hiện cảnh báo trên báo cáo và file Excel. */
  private async countWarnings(month: string, warehouse: Document | null) {
    return this.db.collection('stock_counts')
      .find({ status: 'CLOSED', period: month, 'variance.total': { $gt: 0 }, ...(warehouse ? { $or: [{ warehouseId: warehouse._id }, { warehouseIds: warehouse._id }] } : {}) })
      .sort({ closedAt: 1 })
      .toArray();
  }

  private warningView(row: Document): StockCountWarning {
    return {
      id: (row._id as ObjectId).toHexString(),
      code: String(row.code),
      warehouseName: String(row.warehouseName ?? ''),
      closedAt: (row.closedAt as Date).toISOString(),
      closedByName: String(row.closedByName ?? ''),
      mismatches: Number((row.variance as Document)?.total ?? 0),
      note: String(row.closeNote ?? ''),
    };
  }

  async monthly(month: string, warehouseId?: string): Promise<InventoryMonthlyReport> {
    const range = this.range(month);
    const { filter, warehouse } = await this.scope(warehouseId);
    const movements = this.db.collection('inventory_movements');
    const [grouped, openings, rollbacks, rolledBackBatches] = await Promise.all([
      movements.aggregate([
        { $match: { ...filter, occurredAt: { $lt: range.end } } },
        {
          $group: {
            _id: { productId: '$productId', movementType: '$movementType', direction: '$direction', category: '$category', inMonth: { $gte: ['$occurredAt', range.start] } },
            quantity: { $sum: '$quantity' },
          },
        },
      ]).toArray(),
      movements.find({ ...filter, movementType: 'OPENING', occurredAt: { $lt: range.end } }, { projection: { productId: 1, referenceId: 1, initialQuantity: 1 } }).toArray(),
      movements.distinct('referenceId', { movementType: 'REVERSAL', referenceType: 'ImportBatchRollback', occurredAt: { $lt: range.end } }),
      // Lô điều chỉnh chỉ đổi số nhập ban đầu thì hoàn tác không sinh dòng REVERSAL — lấy thêm theo trạng thái lô.
      this.db.collection('import_batches').distinct('code', { status: 'ROLLED_BACK', rolledBackAt: { $lt: range.end } }),
    ]);

    type Acc = { opening: number; amounts: Partial<Record<InventoryCategory, number>>; purchased: number; initialOpening: number; unknownInitial: boolean };
    const byProduct = new Map<string, Acc>();
    const acc = (productId: ObjectId) => {
      const key = productId.toHexString();
      let entry = byProduct.get(key);
      if (!entry) {
        entry = { opening: 0, amounts: {}, purchased: 0, initialOpening: 0, unknownInitial: false };
        byProduct.set(key, entry);
      }
      return entry;
    };
    for (const row of grouped) {
      const id = row._id as { productId: ObjectId; movementType: string; direction: StockDirection; category?: string; inMonth: boolean };
      const quantity = Number(decimalString(row.quantity));
      const entry = acc(id.productId);
      const category = categoryOf(id);
      if (category === 'PURCHASE_IN') entry.purchased += categoryAmount(category, id.direction, quantity);
      // Tồn đầu kỳ nhập hệ thống (OPENING_IN — lô IMP lúc lên ERP, kể cả hoàn tác lô) là tồn trước khi dùng ERP: tính vào
      // "tồn cuối tháng trước" của tháng nhập, không phải nhập trong tháng — để "xuất kho tổng hợp" = xuất − nhập thật (31/10/2026).
      if (!id.inMonth || category === 'OPENING_IN') entry.opening += id.direction === 'IN' ? quantity : -quantity;
      else entry.amounts[category] = round((entry.amounts[category] ?? 0) + categoryAmount(category, id.direction, quantity));
    }
    // Số nhập ban đầu (初始入库): khai ở tồn đầu kỳ (Excel) + hàng mua đã nhập; tồn đầu kỳ không khai số này thì không tính %.
    const rolledBack = new Set([...rollbacks, ...rolledBackBatches].map(String));
    for (const opening of openings) {
      if (rolledBack.has(String(opening.referenceId))) continue;
      const entry = acc(opening.productId as ObjectId);
      if (opening.initialQuantity === undefined || opening.initialQuantity === null) entry.unknownInitial = true;
      else entry.initialOpening += Number(decimalString(opening.initialQuantity));
    }

    const productFilter: Document = warehouse
      ? { _id: { $in: [...byProduct.keys()].map((id) => toObjectId(id)) } }
      : { $or: [{ status: 'ACTIVE' }, { _id: { $in: [...byProduct.keys()].map((id) => toObjectId(id)) } }] };
    const products = await this.db.collection('products').find(productFilter, { projection: { sku: 1, name: 1, baseUnit: 1 } }).toArray();

    const balances = new Map<string, { onHand: number; reserved: number }>();
    if (range.current) {
      const rows = await this.db.collection('inventory_balances').aggregate([
        { $match: warehouse ? { warehouseId: warehouse._id } : {} },
        { $group: { _id: '$productId', onHand: { $sum: '$onHand' }, reserved: { $sum: '$reserved' } } },
      ]).toArray();
      for (const row of rows) balances.set((row._id as ObjectId).toHexString(), { onHand: Number(decimalString(row.onHand)), reserved: Number(decimalString(row.reserved)) });
    }

    const rows: InventoryMonthlyRow[] = products.map((product) => {
      const key = (product._id as ObjectId).toHexString();
      const entry = byProduct.get(key) ?? { opening: 0, amounts: {}, purchased: 0, initialOpening: 0, unknownInitial: false };
      const opening = round(entry.opening);
      const { netOut, closing } = monthlyBalance(opening, entry.amounts);
      const initial = entry.unknownInitial ? null : round(entry.initialOpening + entry.purchased);
      const balance = balances.get(key) ?? { onHand: 0, reserved: 0 };
      return {
        productId: key,
        sku: String(product.sku),
        productName: String(product.name),
        unit: String(product.baseUnit ?? ''),
        initialQuantity: initial && initial > 0 ? initial : null,
        remainingPercent: initial ? remainingPercent(closing, initial) : null,
        opening,
        amounts: entry.amounts,
        netOut,
        closing,
        available: range.current ? round(balance.onHand - balance.reserved) : null,
        ledgerMatches: range.current ? Math.abs(balance.onHand - closing) < 0.0001 : null,
      };
    }).sort(naturalSku);

    const totals = { opening: 0, amounts: {} as Partial<Record<InventoryCategory, number>>, netOut: 0, closing: 0 };
    for (const row of rows) {
      totals.opening = round(totals.opening + row.opening);
      totals.netOut = round(totals.netOut + row.netOut);
      totals.closing = round(totals.closing + row.closing);
      for (const [code, value] of Object.entries(row.amounts)) totals.amounts[code as InventoryCategory] = round((totals.amounts[code as InventoryCategory] ?? 0) + (value ?? 0));
    }
    const columns = INVENTORY_CATEGORIES.filter((item) => !('optional' in item) || (totals.amounts[item.code] ?? 0) !== 0 || rows.some((row) => (row.amounts[item.code] ?? 0) !== 0)).map((item) => item.code);
    return {
      month,
      warehouseId: warehouse ? (warehouse._id as ObjectId).toHexString() : null,
      warehouseName: warehouse ? String(warehouse.name) : 'Tất cả kho',
      current: range.current,
      columns,
      rows,
      totals,
      mismatches: rows.filter((row) => row.ledgerMatches === false).length,
      stockCountWarnings: (await this.countWarnings(month, warehouse)).map((row) => this.warningView(row)),
    };
  }

  /**
   * File tồn kho tháng giống mẫu TỒN KHO.xlsx của kho (30/10/2026) — xem monthly-template-workbook.ts. Cột 现货库存 lấy số đếm
   * của phiếu kiểm kê đã chốt mới nhất trong tháng ở mỗi kho (xem cả công ty thì cộng các kho).
   */
  async monthlyWorkbook(month: string, warehouseId: string | undefined): Promise<Buffer> {
    const report = await this.monthly(month, warehouseId);
    const range = this.range(month);
    const productIds = report.rows.map((row) => toObjectId(row.productId));
    const [products, counts] = await Promise.all([
      this.db.collection('products').find({ _id: { $in: productIds } }, { projection: { nameZh: 1 } }).toArray(),
      this.db.collection('stock_counts')
        // Xem một kho: chỉ phiếu của đúng kho đó (phiếu gộp cộng nhiều kho nên không so được với tồn một kho).
        .find({ status: 'CLOSED', period: month, ...(report.warehouseId ? { warehouseId: toObjectId(report.warehouseId), scope: { $ne: 'ALL' } } : {}) }, { projection: { code: 1, scope: 1, warehouseId: 1, closedAt: 1, 'qtyStep.lastCheck.rows': 1 } })
        .sort({ closedAt: -1 })
        .toArray(),
    ]);
    const chineseNames = new Map(products.filter((row) => row.nameZh).map((row) => [(row._id as ObjectId).toHexString(), String(row.nameZh)]));
    const counted = new Map<string, { counted: number | null; difference: number; codes: string[]; notCounted?: boolean }>();
    const seenWarehouses = new Set<string>();
    // Phiếu gộp mọi kho (KK-ALL-01) mới nhất trong tháng thay cho các phiếu từng kho.
    const latestAll = counts.find((count) => count.scope === 'ALL');
    for (const count of latestAll ? [latestAll] : counts) {
      const warehouseKey = String(count.warehouseId);
      if (seenWarehouses.has(warehouseKey)) continue;
      seenWarehouses.add(warehouseKey);
      for (const item of ((count.qtyStep as Document | undefined)?.lastCheck?.rows as StockCountRow[] | undefined) ?? []) {
        const entry = counted.get(item.productId) ?? { counted: null, difference: 0, codes: [] };
        const codes = [...entry.codes, String(count.code)];
        // ERP còn tồn mà không đếm (NOT_COUNTED) cũng là lệch: ghi chú "chưa đếm", không có số thực tế.
        if (item.counted === null || item.counted === undefined) {
          if (item.state === 'NOT_COUNTED') counted.set(item.productId, { ...entry, codes, notCounted: true });
          continue;
        }
        counted.set(item.productId, { ...entry, counted: round((entry.counted ?? 0) + item.counted), difference: round(entry.difference + (item.difference ?? 0)), codes });
      }
    }
    return monthlyTemplateWorkbook({ report, monthNo: range.monthNo, chineseNames, counted });
  }

  /** Bộ lọc loại phát sinh, kể cả dữ liệu cũ chưa ghi `category` (suy ra từ nghiệp vụ). */
  private categoryFilter(category: InventoryCategory): Document {
    const legacyTypes = Object.entries(MOVEMENT_TYPE_CATEGORY).filter(([, value]) => value === category).map(([type]) => type);
    return { $or: [{ category }, ...(legacyTypes.length ? [{ category: { $exists: false }, movementType: { $in: legacyTypes } }] : [])] };
  }

  async journal(period: JournalPeriod, options: JournalOptions, paging: PageRequest | null) {
    const range = this.journalPeriod(period);
    const filter: Document = { occurredAt: { $gte: range.start, $lt: range.end } };
    const and: Document[] = [];
    const hidden = await hiddenMovementFilter(this.db, options.viewer);
    if (hidden) and.push(hidden);
    if (options.warehouseId) filter.warehouseId = toObjectId(options.warehouseId, 'warehouseId');
    if (options.category) and.push(this.categoryFilter(options.category));
    if (options.search) {
      const pattern = { $regex: options.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
      const products = await this.db.collection('products').find({ $or: [{ sku: pattern }, { name: pattern }] }, { projection: { _id: 1 } }).limit(500).toArray();
      and.push({ $or: [{ productId: { $in: products.map((row) => row._id) } }, { referenceId: pattern }, { salesOrderCode: pattern }] });
    }
    if (and.length) filter.$and = and;
    const cursor = this.db.collection('inventory_movements').find(filter).sort({ occurredAt: 1, _id: 1 });
    const [movements, total] = paging
      ? await Promise.all([cursor.skip(paging.skip).limit(paging.pageSize).toArray(), this.db.collection('inventory_movements').countDocuments(filter)])
      : [await cursor.limit(EXPORT_LIMIT).toArray(), 0];
    const rows = await this.enrich(movements);
    return paging ? pageOf(rows, total, paging) : rows;
  }

  /** Bổ sung khách / NCC, phiếu BH, NVKD, thủ kho cho từng dòng thẻ kho. */
  private async enrich(movements: Document[]): Promise<InventoryJournalRow[]> {
    const ids = (values: unknown[]) => [...new Set(values.filter(Boolean).map(String))];
    const shipments = ids(movements.filter((row) => row.referenceType === 'Shipment').map((row) => row.referenceId));
    const receipts = ids(movements.filter((row) => row.referenceType === 'GoodsReceipt').map((row) => row.referenceId));
    const returns = ids(movements.filter((row) => row.referenceType === 'StockReturn').map((row) => row.referenceId));
    const tickets = ids(movements.filter((row) => row.referenceType === 'WarrantyTicket').map((row) => row.referenceId));
    const [products, warehouses, users, shipmentDocs, receiptDocs, returnDocs, ticketDocs] = await Promise.all([
      this.db.collection('products').find({ _id: { $in: movements.map((row) => row.productId as ObjectId) } }, { projection: { sku: 1, name: 1, baseUnit: 1 } }).toArray(),
      this.db.collection('warehouses').find({}, { projection: { code: 1 } }).toArray(),
      this.db.collection('users').find({ _id: { $in: movements.map((row) => row.actorId as ObjectId).filter(Boolean) } }, { projection: { displayName: 1 } }).toArray(),
      shipments.length ? this.db.collection('shipments').find({ code: { $in: shipments } }, { projection: { code: 1, salesOrderId: 1 } }).toArray() : [],
      receipts.length ? this.db.collection('goods_receipts').find({ code: { $in: receipts } }, { projection: { code: 1, purchaseOrderId: 1, supplierId: 1 } }).toArray() : [],
      returns.length ? this.db.collection('stock_returns').find({ code: { $in: returns } }, { projection: { code: 1, partnerCode: 1, partnerName: 1, salesOrderCode: 1 } }).toArray() : [],
      tickets.length ? this.db.collection('warranty_tickets').find({ code: { $in: tickets } }, { projection: { code: 1, customer: 1 } }).toArray() : [],
    ]);
    const orderCodes = ids([...movements.map((row) => row.salesOrderCode), ...returnDocs.map((row) => row.salesOrderCode)]);
    const orderIds = shipmentDocs.map((row) => row.salesOrderId as ObjectId).filter(Boolean);
    const orders = orderCodes.length || orderIds.length
      ? await this.db.collection('sales_orders').find({ $or: [{ code: { $in: orderCodes } }, { _id: { $in: orderIds } }] }, { projection: { code: 1, orderDate: 1, customerId: 1, customerCode: 1, customerName: 1, salesRepName: 1, purpose: 1, destination: 1 } }).toArray()
      : [];
    const partnerIds = [...orders.map((row) => row.customerId), ...receiptDocs.map((row) => row.supplierId)].filter(Boolean) as ObjectId[];
    const partners = partnerIds.length ? await this.db.collection('partners').find({ _id: { $in: partnerIds } }, { projection: { code: 1, name: 1, salesRepName: 1 } }).toArray() : [];
    const byId = <T extends Document>(rows: T[]) => new Map(rows.map((row) => [(row._id as ObjectId).toHexString(), row]));
    const productMap = byId(products);
    const warehouseMap = byId(warehouses);
    const userMap = byId(users);
    const partnerMap = byId(partners);
    const orderByCode = new Map(orders.map((row) => [String(row.code), row]));
    const orderById = byId(orders);
    const shipmentOrder = new Map(shipmentDocs.map((row) => [String(row.code), orderById.get((row.salesOrderId as ObjectId | undefined)?.toHexString() ?? '')]));
    const receiptMap = new Map(receiptDocs.map((row) => [String(row.code), row]));
    const returnMap = new Map(returnDocs.map((row) => [String(row.code), row]));
    const ticketMap = new Map(tickets.length ? ticketDocs.map((row) => [String(row.code), row]) : []);

    return movements.map((movement) => {
      const product = productMap.get((movement.productId as ObjectId).toHexString());
      const reference = String(movement.referenceId ?? '');
      const order = movement.salesOrderCode ? orderByCode.get(String(movement.salesOrderCode)) : shipmentOrder.get(reference)
        ?? (returnMap.get(reference)?.salesOrderCode ? orderByCode.get(String(returnMap.get(reference)?.salesOrderCode)) : undefined);
      const orderPartner = order?.customerId ? partnerMap.get((order.customerId as ObjectId).toHexString()) : undefined;
      const receipt = receiptMap.get(reference);
      const supplier = receipt?.supplierId ? partnerMap.get((receipt.supplierId as ObjectId).toHexString()) : undefined;
      const stockReturn = returnMap.get(reference);
      const ticket = ticketMap.get(reference);
      const partnerCode = stockReturn?.partnerCode ?? orderPartner?.code ?? order?.customerCode ?? supplier?.code ?? ticket?.customer?.code;
      // Phiếu hàng mẫu / kiểm định không có khách: hiện người mượn (SAL-TYPE-01).
      const partnerName = stockReturn?.partnerName ?? (order && isNonSale(order) ? orderParty(order) : order?.customerName) ?? orderPartner?.name ?? supplier?.name ?? ticket?.customer?.name;
      const quantity = Number(decimalString(movement.quantity));
      const category = categoryOf({ movementType: String(movement.movementType), direction: movement.direction as StockDirection, category: movement.category as string | undefined });
      return {
        id: (movement._id as ObjectId).toHexString(),
        occurredAt: (movement.occurredAt as Date).toISOString(),
        category,
        direction: movement.direction as StockDirection,
        quantity: categoryAmount(category, movement.direction as StockDirection, quantity),
        sku: String(product?.sku ?? ''),
        productName: String(product?.name ?? ''),
        unit: String(product?.baseUnit ?? movement.unit ?? ''),
        warehouseCode: String(warehouseMap.get((movement.warehouseId as ObjectId).toHexString())?.code ?? ''),
        documentNo: reference,
        documentType: String(movement.referenceType ?? ''),
        ...(order ? { salesOrderCode: String(order.code), salesOrderDate: (order.orderDate as Date | undefined)?.toISOString() } : {}),
        ...(partnerCode ? { partnerCode: String(partnerCode) } : {}),
        ...(partnerName ? { partnerName: String(partnerName) } : {}),
        ...(order?.salesRepName || orderPartner?.salesRepName ? { salesRepName: String(order?.salesRepName ?? orderPartner?.salesRepName) } : {}),
        ...(movement.actorId ? { keeperName: String(userMap.get((movement.actorId as ObjectId).toHexString())?.displayName ?? '') || undefined } : {}),
        ...(movement.reason ? { note: String(movement.reason) } : {}),
      } as InventoryJournalRow;
    });
  }

  /** Nhật ký xuất nhập kho (出入库汇总) theo bộ chuẩn Excel thương hiệu (XLS-01): tiêu đề Trung + Việt, cột nhập tô xanh, cột xuất tô cam. */
  async journalWorkbook(period: JournalPeriod, options: JournalOptions, preparedBy: string): Promise<Buffer> {
    const range = this.journalPeriod(period);
    const rows = (await this.journal(period, options, null)) as InventoryJournalRow[];
    const used = INVENTORY_CATEGORIES.filter((item) => !('optional' in item) || rows.some((row) => row.category === item.code));
    const vnDay = (value: string) => new Date(new Date(value).getTime() + 7 * 3_600_000);
    const columns: BrandColumn[] = [
      { key: 'stt', header: 'STT\n序号', width: 6, type: 'int' },
      { key: 'partner', header: 'Khách hàng / NCC\n客户', width: 30, wrap: true },
      { key: 'partnerCode', header: 'Mã KH\n客户编号', width: 11, type: 'code' },
      { key: 'orderDate', header: 'Ngày phiếu BH\n销售单日期', width: 12, type: 'date' },
      { key: 'order', header: 'Số phiếu BH\n销售单号', width: 16, type: 'code' },
      { key: 'outDate', header: 'Ngày xuất kho\n出仓日期', width: 12, type: 'date' },
      { key: 'outDoc', header: 'Số phiếu xuất\n出仓单号', width: 16 },
      { key: 'inDate', header: 'Ngày nhập kho\n入库日期', width: 12, type: 'date' },
      { key: 'inDoc', header: 'Số phiếu nhập\n入仓单号', width: 16 },
      { key: 'sku', header: 'Model\n产品型号', width: 13, type: 'code' },
      ...used.map((item): BrandColumn => ({ key: item.code, header: `${item.vi}\n${item.zh}`, width: 12, type: 'qty', tint: item.direction === 'IN' ? 'in' : 'out' })),
      { key: 'note', header: 'Ghi chú\n备注', width: 30, wrap: true },
      { key: 'keeper', header: 'Nhân viên kho\n仓管员', width: 18 },
      { key: 'rep', header: 'NV kinh doanh\n业务员', width: 18 },
      { key: 'warehouse', header: 'Kho\n仓库', width: 10 },
    ];
    const workbook = brandWorkbook();
    const sheet = brandSheet(workbook, range.sheetName, columns);
    let rowNo = titleBlock(sheet, columns.length, range.title, [
      `Người lập: ${preparedBy} · Xuất lúc ${exportedAt()} · ${rows.length} dòng${rows.length >= EXPORT_LIMIT ? ` (giới hạn ${EXPORT_LIMIT})` : ''}`,
    ]);
    const sum = (direction: StockDirection) => round(rows.filter((row) => row.direction === direction).reduce((total, row) => total + row.quantity, 0));
    rowNo = kpiStrip(sheet, rowNo, columns.length, [
      { label: 'SỐ DÒNG PHÁT SINH', value: rows.length, format: FORMATS.int },
      { label: 'TỔNG NHẬP 入库', value: sum('IN'), format: FORMATS.qty, tone: 'good' },
      { label: 'TỔNG XUẤT 出库', value: sum('OUT'), format: FORMATS.qty },
    ]);
    const header = rowNo;
    tableHeader(sheet, header, columns);
    sheet.getRow(header).height = 44;
    rows.forEach((row, index) => {
      addBodyRow(sheet, columns, {
        stt: index + 1,
        partner: row.partnerName ?? '',
        partnerCode: row.partnerCode ?? '',
        orderDate: row.salesOrderDate ? vnDay(row.salesOrderDate) : null,
        order: row.salesOrderCode ?? '',
        outDate: row.direction === 'OUT' ? vnDay(row.occurredAt) : null,
        outDoc: row.direction === 'OUT' ? row.documentNo : '',
        inDate: row.direction === 'IN' ? vnDay(row.occurredAt) : null,
        inDoc: row.direction === 'IN' ? row.documentNo : '',
        sku: row.sku,
        [row.category]: row.quantity,
        note: row.note ?? '',
        keeper: row.keeperName ?? '',
        rep: row.salesRepName ?? '',
        warehouse: row.warehouseCode,
      }, index);
    });
    const totals: Record<string, unknown> = { partner: 'TỔNG CỘNG 合计' };
    for (const item of used) totals[item.code] = round(rows.filter((row) => row.category === item.code).reduce((total, row) => total + row.quantity, 0));
    totalRow(sheet, columns, totals);
    finalize(sheet, header, header + rows.length, columns.length, { freezeColumns: 2 });
    return toBuffer(workbook);
  }
}
