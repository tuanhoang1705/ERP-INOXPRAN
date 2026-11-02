import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  compareQuantities,
  compareSkus,
  stockCountSummary,
  type ErpStockLine,
  type SaveStockCountEntries,
  type StockCountConfirm,
  type StockCountErpFix,
  type StockCountRow,
  type StockCountStatus,
  type StockCountStep,
  type StockCountView,
  type StockCountWarehouseStock,
} from '@inoxpran/contracts';
import Decimal from 'decimal.js';
import type { ClientSession, Db, Document } from 'mongodb';
import { ObjectId } from 'mongodb';
import { assertWarehouseAccess } from '../../common/access';
import { AuditService } from '../../common/audit.service';
import { decimal, decimalString, toObjectId, vnParts } from '../../common/domain';
import { hideStatus, seesCancelled } from '../../common/hidden-documents';
import { IdempotencyService } from '../../common/idempotency.service';
import { OutboxService } from '../../common/outbox.service';
import { pageOf, type PageRequest } from '../../common/paging';
import type { AuthenticatedRequest } from '../../common/request-context';
import { SequenceService } from '../../common/sequence.service';
import { MONGO_DATABASE } from '../../common/tokens';
import { InventoryService } from './inventory.service';

const STEP_STATUS: Record<StockCountStep, StockCountStatus> = { SKU: 'SKU_CHECK', QTY: 'QTY_CHECK' };
const OPEN: StockCountStatus[] = ['SKU_CHECK', 'QTY_CHECK'];
/** Xem phiếu kiểm kê mọi kho (chỉ đọc): ngoài các vai trò này chỉ xem kho trong phạm vi được giao. */
const ALL_WAREHOUSE_VIEWERS = ['ADMIN', 'DIRECTOR', 'ACCOUNTANT', 'AUDITOR'];
const MIN_VARIANCE_NOTE = 10;

/**
 * Kiểm kê kho 2 bước (STK-01, 09/10/2026) — phiếu `KK…`:
 * 1. Kiểm tồn sản phẩm (SKU_CHECK): kho nhập danh sách mã còn hàng → Kiểm tra (so mã ERP có tồn) → chốt.
 * 2. Kiểm tồn số lượng (QTY_CHECK): kho nhập số thực đếm → Kiểm tra (so tồn thực tế ERP) → chốt kiểm kê.
 * Lệch thì kho sửa số đếm, hoặc sửa tồn ERP (bắt buộc lý do → thẻ kho "Kiểm kê thừa / thiếu" + nhật ký).
 * Chốt khi còn lệch: bắt buộc ghi chú, báo quản lý kho + Ban Giám đốc, cảnh báo trên báo cáo tồn kho tháng.
 * Không khóa kho khi kiểm kê: mã có xuất / nhập sau lúc bắt đầu được đánh dấu để kho biết lệch có thể do phát sinh.
 * KK-ALL-01 (31/10/2026): phiếu mới gộp mọi kho đang hoạt động (Kho Sơn Đồng + kho hàng lỗi) — so số đếm với tổng tồn các kho,
 * "Sửa ERP" chọn kho ghi phần chênh (mặc định kho chính). Chỉ một phiếu gộp đang mở. Phiếu một kho cũ vẫn đọc / làm tiếp như trước.
 */
@Injectable()
export class StockCountsService {
  constructor(
    @Inject(MONGO_DATABASE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly sequences: SequenceService,
    private readonly idempotency: IdempotencyService,
    private readonly inventory: InventoryService,
    private readonly outbox: OutboxService,
  ) {}

  private actor(request: AuthenticatedRequest) {
    return { actorId: request.user.sub, actorEmail: request.user.email, correlationId: request.correlationId };
  }

  private check(row: Document | undefined) {
    if (!row) return null;
    return {
      at: (row.at as Date).toISOString(), rows: row.rows as StockCountRow[], matched: Number(row.matched), mismatched: Number(row.mismatched),
      ...(row.byWarehouse ? { byWarehouse: row.byWarehouse as Record<string, StockCountWarehouseStock[]> } : {}),
    };
  }

  /** Các kho của phiếu: phiếu gộp lưu warehouseIds, phiếu cũ một kho. */
  private warehouseIdsOf(row: Document): ObjectId[] {
    return (row.warehouseIds as ObjectId[] | undefined) ?? [row.warehouseId as ObjectId];
  }

  private view(row: Document): StockCountView {
    const sku = (row.skuStep ?? {}) as Document;
    const qty = (row.qtyStep ?? {}) as Document;
    return {
      id: (row._id as ObjectId).toHexString(),
      code: String(row.code),
      warehouseId: row.warehouseId ? (row.warehouseId as ObjectId).toHexString() : null,
      scope: row.scope === 'ALL' ? 'ALL' : 'WAREHOUSE',
      warehouseIds: this.warehouseIdsOf(row).map((id) => id.toHexString()),
      warehouseCode: String(row.warehouseCode ?? ''),
      warehouseName: String(row.warehouseName ?? ''),
      period: String(row.period),
      status: row.status as StockCountStatus,
      version: Number(row.version),
      revision: Number(row.revision ?? 0),
      checkedRevision: row.checkedRevision === undefined || row.checkedRevision === null ? null : Number(row.checkedRevision),
      startedAt: (row.startedAt as Date).toISOString(),
      startedByName: String(row.startedByName ?? ''),
      skuStep: {
        entries: ((sku.entries as Document[] | undefined) ?? []).map((entry) => ({ productId: (entry.productId as ObjectId).toHexString(), sku: String(entry.sku) })),
        lastCheck: this.check(sku.lastCheck as Document | undefined),
        ...(sku.lockedAt ? { lockedAt: (sku.lockedAt as Date).toISOString(), lockedByName: String(sku.lockedByName ?? ''), lockNote: String(sku.lockNote ?? ''), lockMismatches: Number(sku.lockMismatches ?? 0) } : {}),
      },
      qtyStep: {
        entries: ((qty.entries as Document[] | undefined) ?? []).map((entry) => ({ productId: (entry.productId as ObjectId).toHexString(), sku: String(entry.sku), quantity: decimalString(entry.quantity) })),
        lastCheck: this.check(qty.lastCheck as Document | undefined),
      },
      adjustments: ((row.adjustments as Document[] | undefined) ?? []).map((item) => ({
        productId: (item.productId as ObjectId).toHexString(),
        sku: String(item.sku),
        step: item.step as StockCountStep,
        before: decimalString(item.before),
        after: decimalString(item.after),
        delta: decimalString(item.delta),
        reason: String(item.reason),
        byName: String(item.byName ?? ''),
        at: (item.at as Date).toISOString(),
        ...(item.warehouseName ? { warehouseName: String(item.warehouseName) } : {}),
      })),
      ...(row.closedAt ? { closedAt: (row.closedAt as Date).toISOString(), closedByName: String(row.closedByName ?? ''), closeNote: String(row.closeNote ?? '') } : {}),
      ...(row.variance ? { variance: { skuMismatches: Number((row.variance as Document).skuMismatches ?? 0), qtyMismatches: Number((row.variance as Document).qtyMismatches ?? 0) } } : {}),
      ...(row.cancelledAt ? { cancelledAt: (row.cancelledAt as Date).toISOString() } : {}),
    };
  }

  /** Thủ kho / quản lý kho chỉ thấy kho được giao; quản trị, Giám đốc, kế toán, kiểm soát thấy mọi kho. */
  private visibleFilter(request: AuthenticatedRequest): Document {
    if (request.user.roles.some((role) => ALL_WAREHOUSE_VIEWERS.includes(role))) return {};
    const scopes = request.user.warehouseScopes.filter((id) => ObjectId.isValid(id)).map((id) => new ObjectId(id));
    // Phiếu gộp: thấy khi phụ trách ít nhất một kho trong phiếu.
    return { $or: [{ warehouseId: { $in: scopes } }, { warehouseIds: { $in: scopes } }] };
  }

  async list(options: { warehouseId?: string | undefined; status?: string | undefined; period?: string | undefined }, paging: PageRequest, request: AuthenticatedRequest) {
    const filter: Document = { ...this.visibleFilter(request) };
    if (options.warehouseId) {
      const id = toObjectId(options.warehouseId, 'warehouseId');
      filter.$and = [{ $or: [{ warehouseId: id }, { warehouseIds: id }] }];
    }
    if (options.status === 'OPEN') filter.status = { $in: OPEN };
    else if (options.status) filter.status = options.status;
    if (options.period && /^\d{4}-\d{2}$/.test(options.period)) filter.period = options.period;
    // Phiếu kiểm kê đã hủy chỉ quản trị gốc thấy (DOC-HIDE-01); dòng thẻ kho đã điều chỉnh trước khi hủy vẫn giữ (tồn thật).
    const query = hideStatus(filter, request.user);
    const collection = this.db.collection('stock_counts');
    const [rows, total] = await Promise.all([
      collection.find(query).sort({ startedAt: -1, _id: -1 }).skip(paging.skip).limit(paging.pageSize).toArray(),
      collection.countDocuments(query),
    ]);
    return pageOf(rows.map((row) => this.view(row)), total, paging);
  }

  private async load(id: string, request: AuthenticatedRequest, session?: ClientSession) {
    const row = await this.db.collection('stock_counts').findOne({ _id: toObjectId(id), ...this.visibleFilter(request) }, session ? { session } : {});
    if (!row) throw new NotFoundException({ code: 'STOCK_COUNT_NOT_FOUND', message: 'Không tìm thấy phiếu kiểm kê' });
    return row;
  }

  async get(id: string, request: AuthenticatedRequest) {
    const row = await this.load(id, request);
    if (row.status === 'CANCELLED' && !seesCancelled(request.user)) throw new NotFoundException({ code: 'STOCK_COUNT_NOT_FOUND', message: 'Không tìm thấy phiếu kiểm kê' });
    return this.view(row);
  }

  /** Phiếu đang làm ở bước `step`, đúng phiên bản; người thao tác phải có quyền ở kho của phiếu. */
  private async editable(id: string, version: number, request: AuthenticatedRequest, status: StockCountStatus | StockCountStatus[], session?: ClientSession) {
    const row = await this.load(id, request, session);
    // Phiếu gộp: cần quyền ở ít nhất một kho của phiếu (kho ghi chênh lệch kiểm tra riêng khi sửa ERP).
    const ids = this.warehouseIdsOf(row).map((value) => value.toHexString());
    if (!ids.some((value) => this.hasWarehouse(request, value))) assertWarehouseAccess(request, ids[0]!);
    const allowed = Array.isArray(status) ? status : [status];
    if (!allowed.includes(row.status as StockCountStatus)) {
      throw new ConflictException({ code: 'STOCK_COUNT_STEP_LOCKED', message: row.status === 'CLOSED' || row.status === 'CANCELLED' ? 'Phiếu kiểm kê đã kết thúc' : 'Phiếu kiểm kê không ở bước này — tải lại phiếu' });
    }
    if (Number(row.version) !== version) throw new ConflictException({ code: 'VERSION_CONFLICT', message: 'Phiếu kiểm kê vừa được cập nhật ở nơi khác — tải lại phiếu' });
    return row;
  }

  /** Ghi cập nhật có khóa phiên bản; trả phiếu mới. */
  private async save(row: Document, update: Document, session?: ClientSession) {
    const after = await this.db.collection('stock_counts').findOneAndUpdate(
      { _id: row._id, version: row.version },
      { ...update, $inc: { version: 1, ...((update.$inc as Document | undefined) ?? {}) } },
      { returnDocument: 'after', ...(session ? { session } : {}) },
    );
    if (!after) throw new ConflictException({ code: 'VERSION_CONFLICT', message: 'Phiếu kiểm kê vừa được cập nhật ở nơi khác — tải lại phiếu' });
    return after;
  }

  private hasWarehouse(request: AuthenticatedRequest, warehouseId: string) {
    try {
      assertWarehouseAccess(request, warehouseId);
      return true;
    } catch {
      return false;
    }
  }

  /** KK-ALL-01: phiếu mới luôn gộp mọi kho đang hoạt động; chỉ một phiếu gộp đang mở. */
  async create(request: AuthenticatedRequest, idempotencyKey: string | undefined) {
    return this.idempotency.execute(`stock-count:${request.user.sub}`, idempotencyKey, { scope: 'ALL' }, async (session) => {
      // Gộp các kho đang hoạt động trong phạm vi người mở phiếu (quản trị / Giám đốc: mọi kho).
      const active = await this.db.collection('warehouses').find({ active: true }, { session, projection: { code: 1, name: 1, purpose: 1 } }).sort({ purpose: 1, code: 1 }).toArray();
      if (!active.length) throw new NotFoundException({ code: 'WAREHOUSE_NOT_FOUND', message: 'Không có kho đang hoạt động' });
      const warehouses = active.filter((warehouse) => this.hasWarehouse(request, (warehouse._id as ObjectId).toHexString()));
      if (!warehouses.length) assertWarehouseAccess(request, (active[0]!._id as ObjectId).toHexString());
      const existing = await this.db.collection('stock_counts').findOne({ open: true }, { session });
      if (existing) {
        throw new ConflictException({ code: 'STOCK_COUNT_OPEN_EXISTS', message: `Đang có phiếu kiểm kê ${String(existing.code)} chưa chốt — làm tiếp phiếu đó`, details: { id: (existing._id as ObjectId).toHexString(), code: existing.code } });
      }
      const now = new Date();
      const { year, month } = vnParts(now);
      const code = await this.sequences.next('KK', session, 4, now, 'compact');
      const document = {
        _id: new ObjectId(),
        code,
        scope: 'ALL',
        warehouseIds: warehouses.map((warehouse) => warehouse._id as ObjectId),
        warehouseCode: warehouses.map((warehouse) => String(warehouse.code)).join(' + '),
        warehouseName: 'Tất cả kho',
        period: `${year}-${String(month).padStart(2, '0')}`,
        status: 'SKU_CHECK',
        open: true,
        version: 1,
        revision: 0,
        checkedRevision: null,
        startedAt: now,
        startedBy: toObjectId(request.user.sub, 'actorId'),
        startedByName: request.user.displayName,
        skuStep: { entries: [] },
        qtyStep: { entries: [] },
        adjustments: [],
        createdAt: now,
        updatedAt: now,
      };
      try {
        await this.db.collection('stock_counts').insertOne(document, { session });
      } catch (error) {
        if ((error as { code?: number }).code === 11000) throw new ConflictException({ code: 'STOCK_COUNT_OPEN_EXISTS', message: 'Đang có phiếu kiểm kê chưa chốt' });
        throw error;
      }
      await this.audit.record({ ...this.actor(request), action: 'STOCK_COUNT_STARTED', entityType: 'StockCount', entityId: document._id.toHexString(), metadata: { code, warehouse: document.warehouseName } }, session);
      return this.view(document);
    });
  }

  /** Mã hàng có thật; trả map id → sản phẩm. */
  private async products(ids: string[], session?: ClientSession) {
    const unique = [...new Set(ids)];
    const rows = await this.db.collection('products').find({ _id: { $in: unique.map((id) => toObjectId(id, 'productId')) } }, { projection: { sku: 1, name: 1, status: 1, baseUnit: 1 }, ...(session ? { session } : {}) }).toArray();
    if (rows.length !== unique.length) throw new BadRequestException({ code: 'PRODUCT_NOT_FOUND', message: 'Có mã hàng không tồn tại trong danh mục', details: [{ path: ['entries'] }] });
    return new Map(rows.map((row) => [(row._id as ObjectId).toHexString(), row]));
  }

  /** Lưu nháp danh sách đang nhập (tự lưu); bỏ dòng trùng, giữ dòng mới nhất (đầu danh sách). */
  async saveEntries(id: string, input: SaveStockCountEntries, request: AuthenticatedRequest) {
    const row = await this.editable(id, input.version, request, STEP_STATUS[input.step]);
    const products = await this.products(input.entries.map((entry) => entry.productId));
    const seen = new Set<string>();
    const now = new Date();
    if (input.step === 'SKU') {
      const previous = new Map(((row.skuStep?.entries as Document[] | undefined) ?? []).map((entry) => [(entry.productId as ObjectId).toHexString(), entry.addedAt as Date]));
      const entries = input.entries.filter((entry) => !seen.has(entry.productId) && seen.add(entry.productId)).map((entry) => ({
        productId: new ObjectId(entry.productId), sku: String(products.get(entry.productId)?.sku), addedAt: previous.get(entry.productId) ?? now,
      }));
      return this.view(await this.save(row, { $set: { 'skuStep.entries': entries, updatedAt: now }, $inc: { revision: 1 } }));
    }
    const entries = input.entries.filter((entry) => !seen.has(entry.productId) && seen.add(entry.productId)).map((entry) => ({
      productId: new ObjectId(entry.productId), sku: String(products.get(entry.productId)?.sku), quantity: decimal(entry.quantity),
    }));
    return this.view(await this.save(row, { $set: { 'qtyStep.entries': entries, updatedAt: now }, $inc: { revision: 1 } }));
  }

  /**
   * Tồn thực tế ERP của các kho trong phiếu (mã có tồn > 0, cộng các mã được nhắc tới), gộp theo mã (KK-ALL-01: tổng mọi kho, kèm tồn
   * từng kho), và các mã có phát sinh sau lúc bắt đầu kiểm kê.
   */
  private async erpState(row: Document, productIds: string[], session?: ClientSession) {
    const options = session ? { session } : {};
    const warehouseIds = this.warehouseIdsOf(row);
    const [balances, warehouses] = await Promise.all([
      this.db.collection('inventory_balances').find({
        warehouseId: { $in: warehouseIds },
        $or: [{ onHand: { $gt: decimal('0') } }, { productId: { $in: productIds.map((id) => new ObjectId(id)) } }],
      }, options).toArray(),
      this.db.collection('warehouses').find({ _id: { $in: warehouseIds } }, { projection: { name: 1, purpose: 1 }, ...options }).toArray(),
    ]);
    const warehouseOf = new Map(warehouses.map((warehouse) => [(warehouse._id as ObjectId).toHexString(), warehouse]));
    const ids = [...new Set([...balances.map((balance) => (balance.productId as ObjectId).toHexString()), ...productIds])];
    const products = await this.db.collection('products').find({ _id: { $in: ids.map((id) => new ObjectId(id)) } }, { projection: { sku: 1 }, ...options }).toArray();
    const skuOf = new Map(products.map((product) => [(product._id as ObjectId).toHexString(), String(product.sku)]));
    const totals = new Map<string, number>();
    const byWarehouse: Record<string, StockCountWarehouseStock[]> = {};
    for (const balance of balances) {
      const productId = (balance.productId as ObjectId).toHexString();
      const warehouseId = (balance.warehouseId as ObjectId).toHexString();
      const onHand = Number(decimalString(balance.onHand));
      totals.set(productId, Math.round(((totals.get(productId) ?? 0) + onHand) * 10_000) / 10_000);
      const warehouse = warehouseOf.get(warehouseId);
      (byWarehouse[productId] ??= []).push({
        warehouseId, warehouseName: String(warehouse?.name ?? ''), defective: warehouse?.purpose === 'DEFECTIVE',
        onHand, reserved: Number(decimalString(balance.reserved ?? '0')),
      });
    }
    const erp: ErpStockLine[] = [...totals].map(([productId, onHand]) => ({ productId, sku: skuOf.get(productId) ?? '?', onHand }));
    const moved = new Set(
      // Phát sinh ghi lùi ngày (ngày nhận hàng trả, dòng đảo khi sửa / hủy phiếu — 20/10/2026) có recordedAt = lúc ghi thật.
      (await this.db.collection('inventory_movements').distinct('productId', { warehouseId: { $in: warehouseIds }, $or: [{ occurredAt: { $gt: row.startedAt } }, { recordedAt: { $gt: row.startedAt } }], referenceId: { $ne: row.code } }, options))
        .map((value) => (value as ObjectId).toHexString()),
    );
    return { erp, moved, skuOf, byWarehouse };
  }

  private compare(row: Document, step: StockCountStep, erp: ErpStockLine[], moved: Set<string>, skuOf: Map<string, string>): StockCountRow[] {
    if (step === 'SKU') {
      const counted = ((row.skuStep?.entries as Document[] | undefined) ?? []).map((entry) => ({ productId: (entry.productId as ObjectId).toHexString(), sku: String(entry.sku) }));
      return compareSkus(counted, erp, moved);
    }
    const entries = ((row.qtyStep?.entries as Document[] | undefined) ?? []).map((entry) => ({ productId: (entry.productId as ObjectId).toHexString(), sku: String(entry.sku), quantity: Number(decimalString(entry.quantity)) }));
    const locked = ((row.skuStep?.lockedProductIds as ObjectId[] | undefined) ?? []).map((value) => value.toHexString());
    return compareQuantities(entries, erp, locked, moved, (productId) => skuOf.get(productId) ?? productId);
  }

  /** "Kiểm tra": so với tồn ERP tại thời điểm bấm; lưu kết quả để chốt (chốt cần kết quả mới nhất). */
  async runCheck(id: string, input: { version: number; step: StockCountStep }, request: AuthenticatedRequest) {
    const row = await this.editable(id, input.version, request, STEP_STATUS[input.step]);
    const stepKey = input.step === 'SKU' ? 'skuStep' : 'qtyStep';
    const referenced = [
      ...(((row.skuStep?.entries as Document[] | undefined) ?? []).map((entry) => (entry.productId as ObjectId).toHexString())),
      ...(((row.qtyStep?.entries as Document[] | undefined) ?? []).map((entry) => (entry.productId as ObjectId).toHexString())),
      ...(((row.skuStep?.lockedProductIds as ObjectId[] | undefined) ?? []).map((value) => value.toHexString())),
    ];
    const { erp, moved, skuOf, byWarehouse } = await this.erpState(row, referenced);
    const rows = this.compare(row, input.step, erp, moved, skuOf);
    const summary = stockCountSummary(rows);
    const lastCheck = { at: new Date(), rows, matched: summary.matched, mismatched: summary.mismatched, ...(row.scope === 'ALL' ? { byWarehouse } : {}) };
    return this.view(await this.save(row, { $set: { [`${stepKey}.lastCheck`]: lastCheck, checkedRevision: row.revision, updatedAt: new Date() } }));
  }

  private requireFreshCheck(row: Document, step: StockCountStep) {
    const last = (step === 'SKU' ? row.skuStep?.lastCheck : row.qtyStep?.lastCheck) as Document | undefined;
    if (!last || row.checkedRevision === null || row.checkedRevision === undefined || Number(row.checkedRevision) !== Number(row.revision)) {
      throw new ConflictException({ code: 'STOCK_COUNT_RECHECK_REQUIRED', message: 'Danh sách hoặc tồn ERP đã thay đổi sau lần kiểm tra trước — bấm "Kiểm tra" lại rồi mới chốt' });
    }
    return last;
  }

  private requireVarianceNote(mismatched: number, input: StockCountConfirm) {
    if (mismatched <= 0) return;
    if (!input.acknowledgeVariance || (input.note?.trim().length ?? 0) < MIN_VARIANCE_NOTE) {
      throw new BadRequestException({ code: 'STOCK_COUNT_VARIANCE_NOTE_REQUIRED', message: `Còn ${mismatched} mã lệch — xác nhận và ghi chú lý do (tối thiểu ${MIN_VARIANCE_NOTE} ký tự) trước khi chốt`, details: [{ path: ['note'] }] });
    }
  }

  /** Sửa tồn ERP theo kiểm kê (bắt buộc lý do): thẻ kho "Kiểm kê thừa / thiếu" tham chiếu số phiếu KK + nhật ký trước / sau. */
  async erpFix(id: string, input: StockCountErpFix, request: AuthenticatedRequest, idempotencyKey: string | undefined) {
    return this.idempotency.execute(`stock-count-fix:${request.user.sub}`, idempotencyKey, { id, ...input }, async (session) => {
      const row = await this.editable(id, input.version, request, STEP_STATUS[input.step], session);
      const product = (await this.products([input.productId], session)).get(input.productId) as Document;
      if (product.status !== 'ACTIVE') throw new BadRequestException({ code: 'PRODUCT_INACTIVE', message: `Mã ${String(product.sku)} đã ngừng kinh doanh — mở lại mã trước khi điều chỉnh tồn` });
      // Phiếu gộp (KK-ALL-01): tồn đúng là tổng mọi kho; phần chênh ghi vào kho được chọn (mặc định kho chính, không phải kho lỗi).
      const warehouseIds = this.warehouseIdsOf(row);
      const balances = await this.db.collection('inventory_balances').find({ warehouseId: { $in: warehouseIds }, productId: product._id }, { session }).toArray();
      let targetWarehouse = row.scope === 'ALL' ? (input.warehouseId ? toObjectId(input.warehouseId, 'warehouseId') : null) : (row.warehouseId as ObjectId);
      if (!targetWarehouse) {
        const main = await this.db.collection('warehouses').findOne({ _id: { $in: warehouseIds }, purpose: { $ne: 'DEFECTIVE' } }, { session, sort: { code: 1 } });
        targetWarehouse = (main?._id as ObjectId | undefined) ?? warehouseIds[0]!;
      }
      if (!warehouseIds.some((value) => value.equals(targetWarehouse!))) {
        throw new BadRequestException({ code: 'WAREHOUSE_NOT_IN_COUNT', message: 'Kho ghi chênh lệch không thuộc phiếu kiểm kê', details: [{ path: ['warehouseId'] }] });
      }
      assertWarehouseAccess(request, targetWarehouse.toHexString());
      const warehouse = await this.db.collection('warehouses').findOne({ _id: targetWarehouse }, { session, projection: { name: 1 } });
      const sum = (rows: Document[], field: string) => rows.reduce<Decimal>((total, item) => total.add(decimalString(item[field] ?? '0')), new Decimal(0));
      const before = sum(balances, 'onHand');
      const own = balances.filter((item) => (item.warehouseId as ObjectId).equals(targetWarehouse!));
      const ownOnHand = sum(own, 'onHand');
      const ownReserved = sum(own, 'reserved');
      const target = new Decimal(input.targetOnHand);
      const delta = target.minus(before);
      if (delta.isZero()) throw new BadRequestException({ code: 'STOCK_COUNT_NO_CHANGE', message: `Tồn ERP của ${String(product.sku)} đã là ${before.toString()}`, details: [{ path: ['targetOnHand'] }] });
      if (ownOnHand.add(delta).lt(ownReserved) || ownOnHand.add(delta).lt(0)) {
        throw new ConflictException({
          code: 'STOCK_COUNT_BELOW_RESERVED',
          message: `${String(warehouse?.name ?? 'Kho')}: mã ${String(product.sku)} còn ${ownOnHand.toString()}, đang giữ chỗ ${ownReserved.toString()} — không giảm ${delta.abs().toString()} ở kho này; chọn kho khác hoặc sửa số đúng`,
          details: [{ path: ['targetOnHand'] }],
        });
      }
      const direction = delta.gt(0) ? 'IN' : 'OUT';
      const reason = `Kiểm kê ${String(row.code)}: ${input.reason}`;
      await this.inventory.applyPhysicalMovement({
        warehouseId: targetWarehouse.toHexString(),
        referenceType: 'StockCount',
        referenceId: String(row.code),
        movementType: direction === 'IN' ? 'ADJUSTMENT_IN' : 'ADJUSTMENT_OUT',
        direction,
        category: direction === 'IN' ? 'ADJUST_IN' : 'ADJUST_OUT',
        lines: [{ productId: input.productId, quantity: delta.abs().toString() }],
        reason,
        actorId: request.user.sub,
      }, session);
      const now = new Date();
      const adjustment = {
        productId: product._id, sku: String(product.sku), step: input.step, before: decimal(before.toString()), after: decimal(target.toString()), delta: decimal(delta.toString()),
        reason: input.reason, by: toObjectId(request.user.sub, 'actorId'), byName: request.user.displayName, at: now,
        warehouseId: targetWarehouse, warehouseName: String(warehouse?.name ?? ''),
      };
      const after = await this.save(row, { $push: { adjustments: adjustment }, $set: { updatedAt: now }, $inc: { revision: 1 } }, session);
      await this.audit.record({
        ...this.actor(request), action: 'STOCK_COUNT_ERP_ADJUSTED', entityType: 'StockCount', entityId: (row._id as ObjectId).toHexString(),
        before: { sku: String(product.sku), onHand: before.toString() }, after: { sku: String(product.sku), onHand: target.toString() },
        metadata: { code: row.code, warehouse: String(warehouse?.name ?? row.warehouseName), step: input.step, delta: delta.toString(), reason: input.reason },
      }, session);
      return this.view(after);
    });
  }

  /** Chốt bước 1 (danh sách mã còn hàng) → sang bước 2. Còn lệch thì phải xác nhận + ghi chú. */
  async lockSkus(id: string, input: StockCountConfirm, request: AuthenticatedRequest) {
    const row = await this.editable(id, input.version, request, 'SKU_CHECK');
    const last = this.requireFreshCheck(row, 'SKU');
    this.requireVarianceNote(Number(last.mismatched), input);
    const now = new Date();
    const lockedProductIds = ((row.skuStep?.entries as Document[] | undefined) ?? []).map((entry) => entry.productId as ObjectId);
    const after = await this.save(row, {
      $set: {
        status: 'QTY_CHECK', 'skuStep.lockedAt': now, 'skuStep.lockedBy': toObjectId(request.user.sub, 'actorId'), 'skuStep.lockedByName': request.user.displayName,
        'skuStep.lockNote': input.note?.trim() ?? '', 'skuStep.lockMismatches': Number(last.mismatched), 'skuStep.lockedProductIds': lockedProductIds, updatedAt: now,
      },
      $inc: { revision: 1 },
    });
    await this.audit.record({ ...this.actor(request), action: 'STOCK_COUNT_SKUS_LOCKED', entityType: 'StockCount', entityId: id, metadata: { code: row.code, skus: lockedProductIds.length, mismatches: Number(last.mismatched), note: input.note ?? '' } });
    return this.view(after);
  }

  /** "Trở lại" ở bước 2: mở lại bước 1 (giữ số đã đếm), phải kiểm tra và chốt lại. */
  async back(id: string, input: { version: number }, request: AuthenticatedRequest) {
    const row = await this.editable(id, input.version, request, 'QTY_CHECK');
    const after = await this.save(row, {
      $set: { status: 'SKU_CHECK', updatedAt: new Date() },
      $unset: { 'skuStep.lockedAt': '', 'skuStep.lockedBy': '', 'skuStep.lockedByName': '', 'skuStep.lockNote': '', 'skuStep.lockMismatches': '', 'skuStep.lockedProductIds': '' },
      $inc: { revision: 1 },
    });
    await this.audit.record({ ...this.actor(request), action: 'STOCK_COUNT_REOPENED', entityType: 'StockCount', entityId: id, metadata: { code: row.code } });
    return this.view(after);
  }

  /** Chốt kiểm kê. Còn lệch: bắt buộc ghi chú, báo quản lý kho + Ban Giám đốc, cảnh báo trên báo cáo tồn kho tháng. */
  async close(id: string, input: StockCountConfirm, request: AuthenticatedRequest, idempotencyKey: string | undefined) {
    return this.idempotency.execute(`stock-count-close:${request.user.sub}`, idempotencyKey, { id, ...input }, async (session) => {
      const row = await this.editable(id, input.version, request, 'QTY_CHECK', session);
      const last = this.requireFreshCheck(row, 'QTY');
      const mismatched = Number(last.mismatched);
      this.requireVarianceNote(mismatched, input);
      const now = new Date();
      const varianceRows = (last.rows as StockCountRow[]).filter((item) => item.state !== 'MATCH').slice(0, 1000);
      const after = await this.save(row, {
        $set: {
          status: 'CLOSED', closedAt: now, closedBy: toObjectId(request.user.sub, 'actorId'), closedByName: request.user.displayName, closeNote: input.note?.trim() ?? '', updatedAt: now,
          variance: { skuMismatches: Number(row.skuStep?.lockMismatches ?? 0), qtyMismatches: mismatched, total: mismatched, rows: varianceRows },
        },
        $unset: { open: '' },
      }, session);
      if (mismatched > 0) {
        await this.outbox.enqueue({
          eventType: 'NOTIFICATION_REQUESTED',
          aggregateType: 'StockCount',
          aggregateId: (row._id as ObjectId).toHexString(),
          payload: {
            category: 'INVENTORY',
            targetRoles: ['WAREHOUSE_MANAGER', 'DIRECTOR'],
            level: 'WARNING',
            title: `Kiểm kê ${String(row.code)} chốt còn lệch ${mismatched} mã`,
            message: `${String(row.warehouseName)}: ${request.user.displayName} chốt kiểm kê còn lệch ${mismatched} mã. Ghi chú: ${input.note?.trim() ?? ''}`,
            href: `/inventory/counts/${(row._id as ObjectId).toHexString()}`,
            template: 'STOCK_COUNT_VARIANCE',
            params: { code: String(row.code), warehouse: String(row.warehouseName), count: String(mismatched), by: request.user.displayName, note: input.note?.trim() ?? '' },
          },
        }, session);
      }
      await this.audit.record({
        ...this.actor(request), action: 'STOCK_COUNT_CLOSED', entityType: 'StockCount', entityId: (row._id as ObjectId).toHexString(),
        metadata: { code: row.code, warehouse: row.warehouseName, mismatches: mismatched, skuMismatches: Number(row.skuStep?.lockMismatches ?? 0), adjustments: ((row.adjustments as unknown[]) ?? []).length, note: input.note ?? '' },
      }, session);
      return this.view(after);
    });
  }

  /** Hủy phiếu chưa chốt (các lần sửa tồn ERP đã ghi vẫn giữ — đã có thẻ kho + nhật ký). */
  async cancel(id: string, input: { version: number }, request: AuthenticatedRequest) {
    const row = await this.editable(id, input.version, request, OPEN);
    if (!request.user.roles.some((role) => ['ADMIN', 'WAREHOUSE_MANAGER', 'WAREHOUSE'].includes(role))) throw new ForbiddenException({ code: 'ROLE_FORBIDDEN', message: 'Không có quyền hủy phiếu kiểm kê' });
    const after = await this.save(row, { $set: { status: 'CANCELLED', cancelledAt: new Date(), cancelledByName: request.user.displayName, updatedAt: new Date() }, $unset: { open: '' } });
    await this.audit.record({ ...this.actor(request), action: 'STOCK_COUNT_CANCELLED', entityType: 'StockCount', entityId: id, metadata: { code: row.code } });
    return this.view(after);
  }
}
