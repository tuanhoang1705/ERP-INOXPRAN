import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  STOCK_BACKDATE_FROM,
  STOCK_OPENING_CUTOFF,
  isNonSalePurpose,
  isVatRate,
  lineTax,
  pricedLineAmounts,
  vnDate,
  type CreateSampleReturn,
  type CreateStockReturn,
  type InventoryCategory,
  type StockReturnAccounting,
  type StockReturnAccountingDraft,
  type StockReturnChange,
  type ReturnCreditAllocationView,
  type StockReturnCreditInput,
  type StockReturnCreditPreview,
  type StockReturnCreditTarget,
  type StockReturnCreditTargetPreview,
  type UpdateStockReturn,
  type VatRate,
  type VoidStockReturn,
} from '@inoxpran/contracts';
import Decimal from 'decimal.js';
import type { ClientSession, Db, Document } from 'mongodb';
import { ObjectId } from 'mongodb';
import { AuditService } from '../../common/audit.service';
import { nextReturnInCode } from './return-codes';
import { decimal, decimalString, serializeDocument, toObjectId } from '../../common/domain';
import { IdempotencyService } from '../../common/idempotency.service';
import { OutboxService } from '../../common/outbox.service';
import { pageOf, type PageRequest } from '../../common/paging';
import type { AuthenticatedRequest, RequestUser } from '../../common/request-context';
import { SequenceService } from '../../common/sequence.service';
import { MONGO_DATABASE } from '../../common/tokens';
import { OPEN_RECEIVABLE_STATUSES, releaseHoldIfCleared } from '../receivables/overdue-review';
import { ReallocationError } from '../receivables/reallocate';
import { allocationView, planReturnCredit, postReturnCredit, returnLineAmount, voidReturnCredit, type ReturnCreditLine } from '../receivables/return-credit';
import { loadSegmentRules, planPartner, reallocatePartner, segmentContext } from '../receivables/segment-store';
import { lineSegment, rulesFor } from '../receivables/segments';
import { InventoryService } from './inventory.service';

/** Phiếu BH đã xuất kho (có giá bán để gợi ý đơn giá trả hàng). */
const SHIPPED_ORDER_STATUSES = ['SHIPPED', 'PARTIALLY_SHIPPED', 'DELIVERED'];

/** Đồng hồ máy người dùng có thể lệch vài phút: ngày nhận "bây giờ" gửi lên không bị coi là tương lai. */
const CLOCK_SKEW_MS = 5 * 60_000;
const minute = (value: Date) => Math.floor(value.getTime() / 60_000);

type MergedLine = { quantity: Decimal; notes: string[] };
type Prepared = {
  customer: boolean;
  partner: Document;
  warehouse: Document;
  merged: Map<string, MergedLine>;
  productById: Map<string, Document>;
  salesOrder: Document | null;
  category: InventoryCategory;
  sourceCode: string | undefined;
};

/** Thuế suất của một dòng phiếu BH: thuế dòng (27/10/2026), phiếu cũ theo thuế suất phiếu; thiếu = 0. */
function lineRateOf(line: Document, order: Document): string {
  const rate = String(line.vatRate ?? order.taxRate ?? '0');
  return rate === 'MIXED' ? '0' : rate;
}

/**
 * Phiếu trả hàng (docs/inventory-excel-mapping.md):
 * - Khách trả (TH…): nhập kho theo loại 滞销退货 / 套餐搭配退回 / 进口不良 / 使用不良; hàng lỗi thường nhập kho hàng lỗi.
 *   Từ 20/10/2026: ghi ngày giờ nhận hàng (thẻ kho + báo cáo tháng theo ngày này) và nguyên nhân / ghi chú từng dòng.
 * - Trả nhà máy (XT…): xuất kho 库存退货返厂, chặn xuất quá tồn khả dụng.
 * Chỉ ghi kho (thẻ kho + nhật ký); điều chỉnh công nợ / hóa đơn do kế toán xử lý riêng.
 * Có số phiếu gốc (BH / đơn mua) thì mã hàng phải thuộc phiếu và không trả quá số đã xuất / đã nhận.
 * Sửa / hủy phiếu đã lưu (20/10/2026): đảo thẻ kho cũ vào đúng ngày cũ rồi ghi lại — tồn kho, thẻ kho, báo cáo tháng luôn khớp.
 * Phiếu đã hủy coi như đã xóa (27/10/2026): chỉ quản trị gốc còn thấy (danh sách, chi tiết, thẻ kho — hidden-movements.ts).
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
   * (đơn vị cơ bản) các dòng bán; hàng tặng = 0. VAT theo thuế suất của dòng (phiếu cũ: của phiếu), tính từng mã như thuế dòng.
   */
  private valuation(order: Document, quantities: Map<string, Decimal>) {
    const sold = new Map<string, { quantity: Decimal; net: Decimal; rate: string }>();
    for (const line of order.lines as Document[]) {
      if (line.gift) continue;
      const key = (line.productId as ObjectId).toHexString();
      const current = sold.get(key) ?? { quantity: new Decimal(0), net: new Decimal(0), rate: lineRateOf(line, order) };
      sold.set(key, { ...current, quantity: current.quantity.add(decimalString(line.baseQuantity)), net: current.net.add(decimalString(line.netAmount)) });
    }
    let net = new Decimal(0);
    let tax = new Decimal(0);
    for (const [productId, quantity] of quantities) {
      const line = sold.get(productId);
      if (!line || line.quantity.lte(0)) continue;
      const value = line.net.div(line.quantity).mul(quantity).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
      net = net.add(value);
      tax = tax.add(lineTax(value.toFixed(2), line.rate));
    }
    const roundedNet = net.toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
    return { net: roundedNet.toFixed(0), tax: tax.toFixed(0), total: roundedNet.add(tax).toFixed(0) };
  }

  async list(kind: string | undefined, paging: PageRequest, user: RequestUser) {
    // SAMPLE = hàng mẫu / hàng kiểm định nhập lại theo phiếu (SAL-TYPE-01).
    const filter: Document = kind === 'CUSTOMER' || kind === 'SUPPLIER' || kind === 'SAMPLE' ? { kind } : {};
    if (!user.root) filter.status = { $ne: 'VOIDED' };
    const [rows, total] = await Promise.all([
      this.db.collection('stock_returns').find(filter).sort({ createdAt: -1, _id: -1 }).skip(paging.skip).limit(paging.pageSize).toArray(),
      this.db.collection('stock_returns').countDocuments(filter),
    ]);
    return pageOf(rows.map((row) => this.view(row)), total, paging);
  }

  async get(id: string, user: RequestUser) {
    const row = await this.load(id);
    if (row.status === 'VOIDED' && !user.root) throw new NotFoundException({ code: 'STOCK_RETURN_NOT_FOUND', message: 'Không tìm thấy phiếu trả hàng' });
    return this.view(row);
  }

  /** Kho của phiếu (kiểm tra phạm vi kho trước khi sửa / hủy). */
  async warehouseOf(id: string) {
    return ((await this.load(id)).warehouseId as ObjectId).toHexString();
  }

  private async load(id: string, session?: ClientSession) {
    const row = await this.db.collection('stock_returns').findOne({ _id: toObjectId(id) }, session ? { session } : {});
    if (!row) throw new NotFoundException({ code: 'STOCK_RETURN_NOT_FOUND', message: 'Không tìm thấy phiếu trả hàng' });
    return row;
  }

  private view(row: Document) {
    const serialized = serializeDocument(row);
    return {
      ...serialized,
      version: Number(row.version ?? 0),
      status: row.status === 'VOIDED' ? 'VOIDED' : 'POSTED',
      lines: (row.lines as Document[]).map((line) => ({ ...serializeDocument(line), quantity: decimalString(line.quantity) })),
    };
  }

  /** Số đã xuất (phiếu BH) hoặc đã nhận (đơn mua) theo mã hàng, trừ số đã trả ở các phiếu khác chưa hủy. */
  private async remainingBySource(
    kind: 'CUSTOMER' | 'SUPPLIER',
    source: Document,
    sourceField: 'salesOrderCode' | 'purchaseOrderCode',
    session: ClientSession,
    excludeId?: ObjectId,
  ) {
    const remaining = new Map<string, Decimal>();
    for (const line of source.lines as Document[]) {
      const key = (line.productId as ObjectId).toHexString();
      const quantity = kind === 'CUSTOMER' ? line.baseQuantity : line.receivedBaseQuantity;
      remaining.set(key, (remaining.get(key) ?? new Decimal(0)).add(decimalString(quantity ?? '0')));
    }
    const previous = await this.db
      .collection('stock_returns')
      .find({ kind, [sourceField]: source.code, status: { $ne: 'VOIDED' }, ...(excludeId ? { _id: { $ne: excludeId } } : {}) }, { session })
      .toArray();
    for (const row of previous) {
      for (const line of row.lines as Document[]) {
        const key = (line.productId as ObjectId).toHexString();
        remaining.set(key, (remaining.get(key) ?? new Decimal(0)).sub(decimalString(line.quantity)));
      }
    }
    return remaining;
  }

  /** Phiếu khách trả đang chờ kế toán xử lý công nợ. */
  private assertAccountingPending(row: Document) {
    if (row.kind !== 'CUSTOMER') throw new ConflictException({ code: 'STOCK_RETURN_NOT_CUSTOMER', message: 'Chỉ phiếu khách trả hàng mới xử lý công nợ' });
    if (row.status === 'VOIDED') throw new ConflictException({ code: 'STOCK_RETURN_VOIDED', message: `Phiếu ${String(row.code)} đã hủy` });
    if (row.accountingStatus !== 'PENDING') throw new ConflictException({ code: 'STOCK_RETURN_NOT_PENDING', message: 'Phiếu không ở trạng thái chờ kế toán xử lý' });
  }

  private receivedAtOfRow(row: Document): Date {
    return (row.receivedAt as Date | undefined) ?? (row.postedAt as Date | undefined) ?? (row.createdAt as Date);
  }

  /**
   * Gợi ý cho hộp thoại "Xử lý công nợ" (D1, 22/10/2026): đơn giá đã gồm VAT theo phiếu BH gốc (tiền hàng sau CK ÷ số lượng
   * × (1 + VAT)); không có phiếu gốc thì giá bán gần nhất cho khách; nhóm công nợ tách riêng của từng mã; khách đang nợ bao nhiêu.
   */
  async accountingDraft(id: string): Promise<StockReturnAccountingDraft> {
    const row = await this.load(id);
    this.assertAccountingPending(row);
    const partnerId = row.partnerId as ObjectId;
    const lines = row.lines as Document[];
    const productIds = lines.map((line) => line.productId as ObjectId);
    const [order, products, ctx, open] = await Promise.all([
      row.salesOrderCode ? this.db.collection('sales_orders').findOne({ code: row.salesOrderCode }) : Promise.resolve(null),
      this.db.collection('products').find({ _id: { $in: productIds } }, { projection: { categoryId: 1 } }).toArray(),
      segmentContext(this.db),
      this.db.collection('receivables').find({ partnerId, status: { $in: OPEN_RECEIVABLE_STATUSES } }, { projection: { amount: 1, paidAmount: 1 } }).toArray(),
    ]);
    const categoryOf = new Map(products.map((product) => [(product._id as ObjectId).toHexString(), product.categoryId ? String(product.categoryId) : undefined]));
    const rules = rulesFor(partnerId.toHexString(), ctx.rules);
    /**
     * Đơn giá CHƯA thuế + thuế suất của một mã trên một phiếu BH: tổng tiền hàng sau CK của các dòng bán (không tính hàng tặng)
     * ÷ số lượng; thuế suất của dòng (phiếu cũ: của phiếu).
     */
    const priceOn = (source: Document, productId: string) => {
      let quantity = new Decimal(0);
      let net = new Decimal(0);
      let rate: string | undefined;
      for (const line of source.lines as Document[]) {
        if (line.gift || (line.productId as ObjectId).toHexString() !== productId) continue;
        quantity = quantity.add(decimalString(line.baseQuantity));
        net = net.add(decimalString(line.netAmount));
        rate ??= lineRateOf(line, source);
      }
      if (quantity.lte(0)) return undefined;
      return { unitPrice: net.div(quantity).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2), vatRate: rate as string };
    };
    const pricing = await this.db.collection<{ _id: string } & Document>('settings').findOne({ _id: 'pricing' }, { projection: { defaultTaxRate: 1 } });
    const defaultRate = isVatRate(String(pricing?.defaultTaxRate ?? '8')) ? String(pricing?.defaultTaxRate ?? '8') : '8';
    const result: StockReturnAccountingDraft['lines'] = [];
    for (const line of lines) {
      const productId = (line.productId as ObjectId).toHexString();
      let suggested = order ? priceOn(order, productId) : undefined;
      let unitPrice = suggested?.unitPrice;
      let priceSource: 'ORDER' | 'LAST_SALE' | undefined = unitPrice ? 'ORDER' : undefined;
      let priceOrderCode = unitPrice && order ? String(order.code) : undefined;
      if (!unitPrice) {
        const last = await this.db.collection('sales_orders').find(
          { customerId: partnerId, status: { $in: SHIPPED_ORDER_STATUSES }, lines: { $elemMatch: { productId: line.productId, gift: { $ne: true } } } },
          { projection: { code: 1, lines: 1, taxRate: 1 } },
        ).sort({ shippedAt: -1, _id: -1 }).limit(1).next();
        suggested = last ? priceOn(last, productId) : undefined;
        unitPrice = suggested?.unitPrice;
        if (unitPrice && last) {
          priceSource = 'LAST_SALE';
          priceOrderCode = String(last.code);
        }
      }
      const segment = lineSegment({ sku: String(line.sku), categoryId: categoryOf.get(productId) }, rules);
      result.push({
        productId,
        sku: String(line.sku),
        productName: String(line.productName),
        unit: String(line.unit),
        quantity: decimalString(line.quantity),
        vatRate: suggested && isVatRate(suggested.vatRate) ? suggested.vatRate : defaultRate,
        ...(unitPrice ? { unitPrice, priceSource, priceOrderCode } : {}),
        ...(segment ? { segment } : {}),
      } as StockReturnAccountingDraft['lines'][number]);
    }
    const openDebt = open.reduce((sum, item) => sum.add(decimalString(item.amount)).minus(decimalString(item.paidAmount)), new Decimal(0));
    return {
      partnerId: partnerId.toHexString(),
      partnerName: String(row.partnerName),
      ...(row.salesOrderCode ? { salesOrderCode: String(row.salesOrderCode) } : {}),
      defaultPostedOn: vnDate(this.receivedAtOfRow(row)),
      openDebt: openDebt.toFixed(2),
      lines: result,
    };
  }

  /** Dòng phiếu giảm nợ từ đơn giá kế toán nhập: đủ mọi mã của phiếu, không thừa mã. */
  private creditLines(row: Document, input: StockReturnCreditInput): ReturnCreditLine[] {
    const prices = new Map<string, string>();
    for (const line of input.lines) prices.set(toObjectId(line.productId, 'productId').toHexString(), line.unitPrice);
    const lines = row.lines as Document[];
    const rates = new Map(input.lines.filter((line) => line.vatRate).map((line) => [toObjectId(line.productId, 'productId').toHexString(), line.vatRate as string]));
    const known = new Set(lines.map((line) => (line.productId as ObjectId).toHexString()));
    if ([...prices.keys()].some((productId) => !known.has(productId))) {
      throw new BadRequestException({ code: 'RETURN_CREDIT_PRODUCT_UNKNOWN', message: 'Có mã hàng không thuộc phiếu trả hàng', details: [{ path: ['lines'] }] });
    }
    return lines.map((line) => {
      const productId = (line.productId as ObjectId).toHexString();
      const unitPrice = prices.get(productId);
      if (unitPrice === undefined) throw new BadRequestException({ code: 'RETURN_CREDIT_PRICE_REQUIRED', message: `Nhập đơn giá cho mã ${String(line.sku)}`, details: [{ path: ['lines'] }] });
      const quantity = decimalString(line.quantity);
      const base = { productId: line.productId as ObjectId, sku: String(line.sku), productName: String(line.productName), unit: String(line.unit), quantity };
      const vatRate = rates.get(productId);
      // Thuế dòng (27/10/2026): đơn giá chưa thuế + thuế suất → tiền hàng + tiền thuế; gọi kiểu cũ: đơn giá đã gồm VAT.
      if (vatRate === undefined) return { ...base, unitPrice, amount: returnLineAmount(quantity, unitPrice) };
      const amounts = pricedLineAmounts(quantity, unitPrice, vatRate);
      const amount = new Decimal(amounts.amount);
      return {
        ...base,
        unitPrice: new Decimal(quantity).gt(0) ? amount.div(quantity).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2) : '0.00',
        amount: amount.toFixed(2),
        netUnitPrice: new Decimal(unitPrice).toFixed(2),
        vatRate,
        netAmount: new Decimal(amounts.netAmount).toFixed(2),
        taxAmount: new Decimal(amounts.taxAmount).toFixed(2),
      };
    });
  }

  /** Ngày ghi giảm nợ: trùng ngày nhận hàng thì lấy đúng giờ nhận; ngày khác lấy 12:00 (hôm nay: lúc ghi). Không ở tương lai. */
  private creditDate(row: Document, postedOn: string | undefined, now: Date): Date {
    const received = this.receivedAtOfRow(row);
    if (!postedOn || postedOn === vnDate(received)) return received;
    if (postedOn > vnDate(now)) throw new BadRequestException({ code: 'RETURN_CREDIT_IN_FUTURE', message: 'Ngày ghi giảm nợ không được sau hôm nay', details: [{ path: ['postedOn'] }] });
    if (postedOn === vnDate(now)) return now;
    return new Date(`${postedOn}T12:00:00+07:00`);
  }

  private async salesOrderIdOf(row: Document, session?: ClientSession) {
    if (!row.salesOrderCode) return undefined;
    const order = await this.db.collection('sales_orders').findOne({ code: row.salesOrderCode }, { projection: { _id: 1 }, ...(session ? { session } : {}) });
    return (order?._id as ObjectId | undefined) ?? undefined;
  }

  /** Nhóm công nợ kế toán chọn để trừ phải đang bật (CN-SEG-01); null = tổng công nợ. */
  private async assertSegment(code: string | null | undefined, session?: ClientSession) {
    if (!code) return;
    const rule = (await loadSegmentRules(this.db, session)).find((item) => item.code === code && item.active);
    if (!rule) throw new ConflictException({ code: 'SEGMENT_NOT_FOUND', message: `Không có nhóm công nợ ${code}` });
  }

  /** Xem trước phiếu giảm nợ: trừ vào chứng từ nào, bao nhiêu, phần dư thành khách trả trước (không ghi gì). */
  async accountingPreview(id: string, input: StockReturnCreditInput): Promise<StockReturnCreditPreview> {
    const row = await this.load(id);
    this.assertAccountingPending(row);
    this.creditDate(row, input.postedOn, new Date());
    await this.assertSegment(input.segment);
    const plan = await planReturnCredit(this.db, { partnerId: row.partnerId as ObjectId, salesOrderId: await this.salesOrderIdOf(row), lines: this.creditLines(row, input) }, undefined, input.segment ?? null);
    return { amount: plan.amount, segment: plan.segment, allocations: plan.allocations, credit: plan.credit };
  }

  /** Phiếu giảm nợ trả hàng đang hiệu lực của phiếu TH (đổi nơi trừ). */
  private async creditPayment(row: Document, session?: ClientSession) {
    const note = row.creditNote as Document | undefined;
    const payment = note?.paymentId ? await this.db.collection('payments').findOne({ _id: note.paymentId as ObjectId, kind: 'RETURN', status: 'POSTED' }, session ? { session } : {}) : null;
    if (!payment) throw new ConflictException({ code: 'RETURN_CREDIT_MISSING', message: `Phiếu ${String(row.code)} chưa có phiếu giảm nợ trả hàng đang hiệu lực` });
    return payment;
  }

  /** Phân bổ của phiếu giảm nợ → dạng hiển thị (số chứng từ, nhóm, hạn trả). */
  private creditAllocations(allocations: ReadonlyArray<Document>, receivables: Document[], payment: Document): ReturnCreditAllocationView[] {
    const byId = new Map(receivables.map((row) => [(row._id as ObjectId).toHexString(), row]));
    return allocations.flatMap((allocation) => {
      const row = byId.get(String(allocation.receivableId));
      const amount = new Decimal(decimalString(allocation.amount as never));
      if (!row || amount.isZero()) return [];
      const original = Boolean(payment.salesOrderId && (row.salesOrderId as ObjectId | undefined)?.equals(payment.salesOrderId as ObjectId));
      return [allocationView(row, (allocation.segment as string | null | undefined) ?? null, amount.toFixed(2), original)];
    });
  }

  /**
   * Xem trước "Đổi nơi trừ" phiếu giảm nợ đã ghi (AR-RET-01): tổng công nợ (null) hoặc nhóm X. Phiếu thành thu theo khách,
   * cả khách được phân bổ lại như khi gắn nhóm; phần đã thành khoản khách trả trước không đổi.
   */
  async creditTargetPreview(id: string, segment: string | null): Promise<StockReturnCreditTargetPreview> {
    const row = await this.load(id);
    const payment = await this.creditPayment(row);
    await this.assertSegment(segment);
    const paymentId = (payment._id as ObjectId).toHexString();
    let plan: Awaited<ReturnType<typeof planPartner>>;
    try {
      plan = await planPartner(this.db, payment.partnerId as ObjectId, await segmentContext(this.db), undefined, new Date(), new Map([[paymentId, { segment, mode: 'CUSTOMER' }]]));
    } catch (error) {
      if (error instanceof ReallocationError) throw new ConflictException({ code: error.code, message: error.message });
      throw error;
    }
    return {
      code: String(payment.code),
      segment,
      before: this.creditAllocations((payment.allocations as Document[] | undefined) ?? [], plan.receivables, payment),
      after: this.creditAllocations(plan.result.payments.get(paymentId) ?? [], plan.receivables, payment),
      credit: decimalString(payment.unappliedAmount ?? '0'),
      customerBefore: { normal: plan.before.normal, segment: plan.before.segment },
      customerAfter: { normal: plan.after.normal, segment: plan.after.segment },
    };
  }

  /** Đổi nơi trừ phiếu giảm nợ đã ghi: lưu nhóm được chọn (hoặc bỏ), chuyển thành thu theo khách rồi phân bổ lại cả khách. */
  async retargetCredit(id: string, input: StockReturnCreditTarget, request: AuthenticatedRequest, idempotencyKey?: string) {
    return this.idempotency.execute(`stock-return-credit-target:${id}`, idempotencyKey, input, async (session) => {
      const row = await this.load(id, session);
      const payment = await this.creditPayment(row, session);
      await this.assertSegment(input.segment, session);
      const current = (payment.segment as string | undefined) ?? null;
      if (current === input.segment) {
        throw new ConflictException({ code: 'RETURN_CREDIT_SAME_TARGET', message: input.segment ? `Phiếu giảm nợ đang trừ vào nhóm ${input.segment}` : 'Phiếu giảm nợ đang trừ vào tổng công nợ' });
      }
      const now = new Date();
      await this.db.collection('payments').updateOne(
        { _id: payment._id, status: 'POSTED' },
        input.segment
          ? { $set: { mode: 'CUSTOMER', segment: input.segment, retargetedAt: now, retargetedByName: request.user.displayName } }
          : { $set: { mode: 'CUSTOMER', retargetedAt: now, retargetedByName: request.user.displayName }, $unset: { segment: '' } },
        { session },
      );
      const { plan } = await reallocatePartner(this.db, payment.partnerId as ObjectId, session, now);
      const released = await releaseHoldIfCleared(this.db, payment.partnerId as ObjectId, session, now);
      const after = await this.db.collection('stock_returns').findOneAndUpdate(
        { _id: row._id },
        input.segment ? { $set: { 'creditNote.segment': input.segment, updatedAt: now } } : { $unset: { 'creditNote.segment': '' }, $set: { updatedAt: now } },
        { session, returnDocument: 'after' },
      );
      const paymentId = (payment._id as ObjectId).toHexString();
      await this.audit.record({
        actorId: request.user.sub,
        actorEmail: request.user.email,
        correlationId: request.correlationId,
        action: 'RETURN_CREDIT_RETARGETED',
        entityType: 'StockReturn',
        entityId: id,
        before: { segment: current, allocations: serializeDocument({ list: payment.allocations }).list },
        after: { segment: input.segment, allocations: plan.result.payments.get(paymentId) ?? [] },
        metadata: { payment: String(payment.code), note: input.note, customerBefore: plan.before, customerAfter: plan.after, partnerHoldReleased: released },
      }, session);
      return { ...this.view(after as Document), partnerHoldReleased: released };
    });
  }

  /**
   * Kế toán xử lý phiếu khách trả (D1, 22/10/2026): CREDIT → lập phiếu giảm nợ "Trả hàng" (receivables/return-credit.ts);
   * NONE → chỉ ghi nhận không giảm công nợ (đổi hàng, bảo hành, đã xử lý ngoài hệ thống).
   */
  async markAccounted(id: string, input: StockReturnAccounting, request: AuthenticatedRequest, idempotencyKey?: string) {
    return this.idempotency.execute(`stock-return-accounting:${id}`, idempotencyKey, input, async (session) => {
      const before = await this.load(id, session);
      this.assertAccountingPending(before);
      const now = new Date();
      const set: Document = { accountingStatus: 'DONE', accountingMode: input.mode, accountingNote: input.note, accountingBy: toObjectId(request.user.sub), accountingByName: request.user.displayName, accountingAt: now, updatedAt: now };
      let credit: Awaited<ReturnType<typeof postReturnCredit>> | null = null;
      if (input.mode === 'CREDIT') {
        const postedAt = this.creditDate(before, input.postedOn, now);
        await this.assertSegment(input.segment, session);
        credit = await postReturnCredit(this.db, this.sequences, {
          partnerId: before.partnerId as ObjectId,
          segment: input.segment ?? null,
          salesOrderId: await this.salesOrderIdOf(before, session),
          salesOrderCode: before.salesOrderCode as string | undefined,
          lines: this.creditLines(before, input),
          postedAt,
          stockReturnId: before._id as ObjectId,
          stockReturnCode: String(before.code),
          note: input.note,
          actorId: toObjectId(request.user.sub),
          actorName: request.user.displayName,
        }, session, now);
        set.creditNote = {
          paymentId: credit.payment._id, code: credit.payment.code, amount: decimal(credit.plan.amount), postedOn: vnDate(postedAt), credit: decimal(credit.plan.credit),
          ...(credit.plan.segment ? { segment: credit.plan.segment } : {}),
        };
      }
      const after = await this.db.collection('stock_returns').findOneAndUpdate(
        { _id: before._id, accountingStatus: 'PENDING', ...(before.version === undefined ? { version: { $exists: false } } : { version: before.version }) },
        // Không tăng phiên bản: kế toán không đổi nội dung kho của phiếu, kho đang mở phiếu vẫn sửa được (sửa sau đó tự hủy phiếu giảm nợ).
        { $set: set },
        { session, returnDocument: 'after' },
      );
      if (!after) throw new ConflictException({ code: 'VERSION_CONFLICT', message: `Phiếu ${String(before.code)} vừa được người khác sửa, vui lòng tải lại` });
      await this.audit.record(
        {
          actorId: request.user.sub,
          actorEmail: request.user.email,
          correlationId: request.correlationId,
          action: 'CUSTOMER_RETURN_ACCOUNTED',
          entityType: 'StockReturn',
          entityId: id,
          before: serializeDocument(before),
          after: serializeDocument(after),
          metadata: { mode: input.mode, ...(credit ? { payment: credit.payment.code, amount: credit.plan.amount, credit: credit.plan.credit, allocations: credit.plan.allocations.length, partnerHoldReleased: credit.released } : {}) },
        },
        session,
      );
      return { ...this.view(after), ...(credit ? { partnerHoldReleased: credit.released } : {}) };
    });
  }

  /** Phiếu TH có phiếu giảm nợ đang hiệu lực mà tiền / hàng / khách đổi (hoặc hủy phiếu): tự hủy phiếu giảm nợ. */
  private async voidCreditNote(row: Document, reason: string, request: AuthenticatedRequest, session: ClientSession, now: Date) {
    const note = row.creditNote as Document | undefined;
    if (!note?.paymentId) return null;
    await voidReturnCredit(this.db, note.paymentId as ObjectId, reason, { id: toObjectId(request.user.sub), name: request.user.displayName }, session, now);
    return { note: String(row.accountingNote ?? ''), byName: String(row.accountingByName ?? ''), at: row.accountingAt, creditCode: String(note.code), creditAmount: note.amount };
  }

  /**
   * Nhập lại hàng mẫu không có phiếu xuất hàng mẫu (NVKD mượn trước khi dùng ERP — SAL-TYPE-01 bổ sung 17/10/2026):
   * thẻ kho "Hàng mẫu nhập lại" (SAMPLE_IN), phiếu NK loại hàng mẫu ghi người mượn; không có bước kế toán.
   */
  async createSample(input: CreateSampleReturn, request: AuthenticatedRequest, idempotencyKey: string | undefined) {
    return this.idempotency.execute(`sample-return:${request.user.sub}`, idempotencyKey, input, async (session) => {
      const borrower = await this.db.collection('employees').findOne({ _id: toObjectId(input.borrowerId, 'borrowerId') }, { session });
      if (!borrower) throw new NotFoundException({ code: 'EMPLOYEE_NOT_FOUND', message: 'Không tìm thấy nhân viên mượn hàng', details: [{ path: ['borrowerId'] }] });
      const warehouse = await this.db.collection('warehouses').findOne({ _id: toObjectId(input.warehouseId, 'warehouseId'), active: true }, { session });
      if (!warehouse) throw new NotFoundException({ code: 'WAREHOUSE_NOT_FOUND', message: 'Không tìm thấy kho hoạt động', details: [{ path: ['warehouseId'] }] });
      const merged = this.mergeLines(input.lines);
      const productById = await this.products(merged, session);
      const code = await nextReturnInCode(this.db, this.sequences, session);
      const lines = this.stockLines(merged);
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
      const partnerName = `Hàng mẫu — ${String(borrower.name)} (không có phiếu xuất mẫu)`;
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
        lines: this.documentLines(merged, productById),
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

  /** Gộp dòng trùng mã hàng: cộng số lượng, nối các ghi chú khác nhau. */
  private mergeLines(lines: Array<{ productId: string; quantity: string; note?: string | undefined }>) {
    const merged = new Map<string, MergedLine>();
    for (const line of lines) {
      const key = toObjectId(line.productId, 'productId').toHexString();
      const current = merged.get(key) ?? { quantity: new Decimal(0), notes: [] };
      const note = line.note?.trim();
      merged.set(key, { quantity: current.quantity.add(line.quantity), notes: note && !current.notes.includes(note) ? [...current.notes, note] : current.notes });
    }
    return merged;
  }

  private async products(merged: Map<string, MergedLine>, session: ClientSession) {
    const products = await this.db.collection('products').find({ _id: { $in: [...merged.keys()].map((id) => new ObjectId(id)) } }, { session }).toArray();
    if (products.length !== merged.size) throw new NotFoundException({ code: 'PRODUCT_NOT_FOUND', message: 'Có mã hàng không tồn tại', details: [{ path: ['lines'] }] });
    return new Map(products.map((product) => [(product._id as ObjectId).toHexString(), product]));
  }

  private stockLines(merged: Map<string, MergedLine>) {
    return [...merged].map(([productId, line]) => ({ productId, quantity: line.quantity.toString(), ...(line.notes.length ? { note: line.notes.join('; ') } : {}) }));
  }

  private documentLines(merged: Map<string, MergedLine>, productById: Map<string, Document>) {
    return [...merged].map(([productId, line]) => {
      const product = productById.get(productId) as Document;
      return {
        productId: product._id,
        sku: String(product.sku),
        productName: String(product.name),
        unit: String(product.baseUnit),
        quantity: decimal(line.quantity.toString()),
        ...(line.notes.length ? { note: line.notes.join('; ') } : {}),
      };
    });
  }

  /**
   * Ngày giờ nhận hàng trả: bỏ trống = lúc ghi. Không ở tương lai, không trước mốc tồn đầu kỳ (hàng đó đã nằm trong tồn đầu kỳ).
   * Khi sửa phiếu mà ngày không đổi (cùng phút) thì giữ nguyên, không kiểm lại.
   */
  private receivedAtOf(value: string | undefined, now: Date, current?: Date): Date {
    if (!value) return current ?? now;
    const at = new Date(value);
    if (current && minute(at) === minute(current)) return current;
    if (at.getTime() > now.getTime() + CLOCK_SKEW_MS) {
      throw new BadRequestException({ code: 'RETURN_RECEIVED_IN_FUTURE', message: 'Ngày giờ nhận hàng không được sau thời điểm hiện tại', details: [{ path: ['receivedAt'] }] });
    }
    if (at < STOCK_BACKDATE_FROM) {
      const [year, month, day] = STOCK_OPENING_CUTOFF.split('-');
      throw new BadRequestException({
        code: 'RETURN_RECEIVED_BEFORE_OPENING',
        message: `Ngày nhận hàng phải sau ${day}/${month}/${year} — hàng nhận từ ngày đó trở về trước đã nằm trong tồn đầu kỳ`,
        details: [{ path: ['receivedAt'] }],
      });
    }
    return at;
  }

  /** Kiểm tra đối tác, kho, mã hàng, phiếu gốc (không trả quá số còn được trả, không tính phiếu `excludeId` đang sửa). */
  private async prepare(input: CreateStockReturn, session: ClientSession, excludeId?: ObjectId): Promise<Prepared> {
    const customer = input.kind === 'CUSTOMER';
    // Đối tác vừa là khách vừa là NCC (BOTH) cũng hiện trong ô chọn — nhận cả hai.
    const partner = await this.db.collection('partners').findOne({ _id: toObjectId(input.partnerId, 'partnerId'), kind: { $in: [customer ? 'CUSTOMER' : 'SUPPLIER', 'BOTH'] } }, { session });
    if (!partner) {
      throw new NotFoundException({ code: customer ? 'CUSTOMER_NOT_FOUND' : 'SUPPLIER_NOT_FOUND', message: customer ? 'Không tìm thấy khách hàng' : 'Không tìm thấy nhà cung cấp', details: [{ path: ['partnerId'] }] });
    }
    const warehouse = await this.db.collection('warehouses').findOne({ _id: toObjectId(input.warehouseId, 'warehouseId'), active: true }, { session });
    if (!warehouse) throw new NotFoundException({ code: 'WAREHOUSE_NOT_FOUND', message: 'Không tìm thấy kho hoạt động', details: [{ path: ['warehouseId'] }] });
    const merged = this.mergeLines(input.lines);
    const productById = await this.products(merged, session);

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
      // Phiếu bán chỉ có công nợ sau khi giao thành công (AR-DLV-01): khách trả hàng theo phiếu đã giao.
      if (customer && !isNonSalePurpose(source.purpose) && source.status === 'SHIPPED') {
        throw new ConflictException({ code: 'RETURN_ORDER_NOT_DELIVERED', message: `Phiếu ${sourceCode} chưa giao thành công — xác nhận đã giao rồi mới nhận trả hàng`, details: [{ path: ['salesOrderCode'] }] });
      }
      const remaining = await this.remainingBySource(input.kind, source, customer ? 'salesOrderCode' : 'purchaseOrderCode', session, excludeId);
      for (const [productId, line] of merged) {
        const left = remaining.get(productId);
        const sku = String(productById.get(productId)?.sku ?? productId);
        if (!left) throw new BadRequestException({ code: 'RETURN_PRODUCT_NOT_IN_SOURCE', message: `Mã ${sku} không có trong ${sourceCode}`, details: [{ path: ['lines'] }] });
        if (line.quantity.gt(left)) {
          throw new BadRequestException({ code: 'RETURN_EXCEEDS_SOURCE', message: `Mã ${sku} chỉ còn trả được ${left.toString()} theo ${sourceCode}`, details: [{ path: ['lines'] }] });
        }
      }
    }
    const category: InventoryCategory = customer ? input.category : 'FACTORY_RETURN_OUT';
    return { customer, partner, warehouse, merged, productById, salesOrder, category, sourceCode };
  }

  /** Ghi thẻ kho của phiếu theo nội dung hiện tại (nhập kho với khách trả, xuất kho với trả nhà máy). */
  private async post(code: string, ready: Prepared, note: string, occurredAt: Date | undefined, actorId: string, session: ClientSession) {
    await this.inventory.applyPhysicalMovement(
      {
        warehouseId: (ready.warehouse._id as ObjectId).toHexString(),
        referenceType: 'StockReturn',
        referenceId: code,
        movementType: ready.customer ? 'CUSTOMER_RETURN' : 'SUPPLIER_RETURN',
        direction: ready.customer ? 'IN' : 'OUT',
        category: ready.category,
        lines: this.stockLines(ready.merged),
        reason: note,
        actorId,
        extra: { partnerId: ready.partner._id, ...(ready.customer && ready.sourceCode ? { salesOrderCode: ready.sourceCode } : {}) },
        ...(occurredAt ? { occurredAt } : {}),
      },
      session,
    );
  }

  /** Giá trị theo phiếu BH gốc và việc có cần kế toán điều chỉnh công nợ hay không. */
  private money(ready: Prepared) {
    const quantities = new Map([...ready.merged].map(([productId, line]) => [productId, line.quantity]));
    // Hàng tặng / combo trả lại không có giá bán → không tính giá trị.
    const value = ready.customer && ready.category !== 'GIFT_RETURN_IN' && ready.salesOrder ? this.valuation(ready.salesOrder, quantities) : undefined;
    // Khách trả có ảnh hưởng tiền (trừ hàng tặng / combo trả lại): chờ kế toán giảm công nợ / xuất hóa đơn điều chỉnh.
    // Trả theo phiếu giá 0 đ (15/10/2026) không có gì phải điều chỉnh.
    const needsAccounting = ready.customer && ready.category !== 'GIFT_RETURN_IN' && !(value && new Decimal(value.total).isZero());
    return { value, needsAccounting };
  }

  async create(input: CreateStockReturn, request: AuthenticatedRequest, idempotencyKey: string | undefined) {
    return this.idempotency.execute(`stock-return:${request.user.sub}`, idempotencyKey, input, async (session) => {
      const now = new Date();
      const receivedAt = input.kind === 'CUSTOMER' ? this.receivedAtOf(input.receivedAt, now) : undefined;
      const ready = await this.prepare(input, session);
      // Khách trả hàng: số NK theo tháng nhận hàng (NK-01); trả nhà máy: XT.
      const code = ready.customer ? await nextReturnInCode(this.db, this.sequences, session, receivedAt ?? now) : await this.sequences.next('XT', session, 4, now, 'compact');
      await this.post(code, ready, input.note, receivedAt, request.user.sub, session);
      const { value, needsAccounting } = this.money(ready);
      const document = {
        _id: new ObjectId(),
        code,
        kind: input.kind,
        category: ready.category,
        partnerId: ready.partner._id,
        partnerCode: String(ready.partner.code),
        partnerName: String(ready.partner.name),
        warehouseId: ready.warehouse._id,
        warehouseName: String(ready.warehouse.name),
        ...(ready.customer && ready.sourceCode ? { salesOrderCode: ready.sourceCode } : {}),
        ...(!ready.customer && ready.sourceCode ? { purchaseOrderCode: ready.sourceCode } : {}),
        note: input.note,
        ...(receivedAt ? { receivedAt } : {}),
        postedAt: receivedAt ?? now,
        ...(value ? { value } : {}),
        ...(needsAccounting ? { accountingStatus: 'PENDING' } : {}),
        lines: this.documentLines(ready.merged, ready.productById),
        status: 'POSTED',
        version: 0,
        createdBy: toObjectId(request.user.sub, 'actorId'),
        createdByName: request.user.displayName,
        createdAt: now,
      };
      await this.db.collection('stock_returns').insertOne(document, { session });
      if (needsAccounting) {
        await this.notifyAccountant(document, 'CUSTOMER_RETURN_POSTED', {
          title: `Khách trả hàng ${code} — cần điều chỉnh công nợ`,
          message: `${String(ready.partner.name)} trả hàng${ready.sourceCode ? ` theo ${ready.sourceCode}` : ''}${value ? `, giá trị ${Number(value.total).toLocaleString('vi-VN')} đ` : ''}.`,
          params: { code, customer: String(ready.partner.name), order: (ready.customer && ready.sourceCode) || '', amount: value?.total ?? '', category: ready.category },
        }, session);
      }
      await this.audit.record(
        {
          actorId: request.user.sub,
          actorEmail: request.user.email,
          correlationId: request.correlationId,
          action: ready.customer ? 'CUSTOMER_RETURN_POSTED' : 'SUPPLIER_RETURN_POSTED',
          entityType: 'StockReturn',
          entityId: document._id.toHexString(),
          after: serializeDocument(document),
        },
        session,
      );
      return this.view(document);
    });
  }

  private async notifyAccountant(document: Document, template: 'CUSTOMER_RETURN_POSTED' | 'CUSTOMER_RETURN_CHANGED', text: { title: string; message: string; params: Record<string, string> }, session: ClientSession) {
    await this.outbox.enqueue(
      {
        eventType: 'NOTIFICATION_REQUESTED',
        aggregateType: 'StockReturn',
        aggregateId: (document._id as ObjectId).toHexString(),
        payload: { category: 'INVENTORY', targetRoles: ['ACCOUNTANT'], level: template === 'CUSTOMER_RETURN_CHANGED' ? 'WARNING' : 'INFO', title: text.title, message: text.message, href: '/inventory/returns', template, params: text.params },
      },
      session,
    );
  }

  /**
   * Phiếu được sửa / hủy: chưa hủy, đúng phiên bản đang xem. Hàng mẫu nhập lại theo phiếu xuất mẫu: sửa / hủy trên phiếu mượn mẫu.
   * Hàng mẫu nhập lại KHÔNG có phiếu xuất mẫu (27/10/2026): hủy được (nhập nhầm cả phiếu), không sửa — nhập lại phiếu đúng.
   */
  private assertRevisable(row: Document, version: number, action: 'EDIT' | 'VOID' = 'EDIT') {
    if (row.status === 'VOIDED') throw new ConflictException({ code: 'STOCK_RETURN_VOIDED', message: `Phiếu ${String(row.code)} đã hủy, không sửa được` });
    if (row.kind === 'SAMPLE' && !(action === 'VOID' && row.noSlip === true && !row.salesOrderCode)) {
      throw new ConflictException({
        code: 'STOCK_RETURN_SAMPLE_LOCKED',
        message: row.noSlip
          ? 'Phiếu hàng mẫu nhập lại không có phiếu xuất mẫu không sửa được — hủy phiếu rồi nhập lại phiếu đúng'
          : 'Phiếu hàng mẫu nhập lại theo phiếu xuất mẫu — sửa / hủy trên phiếu hàng mẫu gốc',
      });
    }
    if (Number(row.version ?? 0) !== version) {
      throw new ConflictException({ code: 'VERSION_CONFLICT', message: `Phiếu ${String(row.code)} vừa được người khác sửa, vui lòng tải lại` });
    }
  }

  /**
   * Đảo toàn bộ thẻ kho đang có của phiếu (số dư theo kho / mã / loại), ghi vào ngày phát sinh hiện tại của phiếu — báo cáo
   * tháng của ngày đó trở về đúng. Đảo phiếu khách trả = xuất lại khỏi kho: hàng đã bán / chuyển đi thì báo thiếu tồn, không sửa được.
   */
  private async reverse(row: Document, label: string, actorId: string, session: ClientSession) {
    await this.applyReversal(row, await this.planReversal(row, session), label, actorId, session);
  }

  /** Số dư thẻ kho hiện có của phiếu theo kho / mã / loại (đọc TRƯỚC khi ghi nội dung mới) và ngày phát sinh để đảo. */
  private async planReversal(row: Document, session: ClientSession) {
    const signed = { $cond: [{ $eq: ['$direction', 'IN'] }, '$quantity', { $multiply: ['$quantity', -1] }] };
    const groups = await this.db.collection('inventory_movements').aggregate(
      [
        { $match: { referenceType: 'StockReturn', referenceId: String(row.code) } },
        { $group: { _id: { warehouseId: '$warehouseId', productId: '$productId', category: '$category', movementType: '$movementType' }, net: { $sum: signed }, first: { $min: '$occurredAt' } } },
      ],
      { session },
    ).toArray();
    // Gộp dòng đảo trước (RETURN_CORRECTION) vào cùng kho / mã / loại với dòng gốc.
    const net = new Map<string, { warehouseId: ObjectId; productId: ObjectId; category?: InventoryCategory; quantity: Decimal; first: Date }>();
    for (const group of groups) {
      const id = group._id as { warehouseId: ObjectId; productId: ObjectId; category?: InventoryCategory };
      const key = `${id.warehouseId.toHexString()}:${id.productId.toHexString()}:${id.category ?? ''}`;
      const current = net.get(key) ?? { warehouseId: id.warehouseId, productId: id.productId, ...(id.category ? { category: id.category } : {}), quantity: new Decimal(0), first: group.first as Date };
      current.quantity = current.quantity.add(decimalString(group.net));
      if ((group.first as Date) < current.first) current.first = group.first as Date;
      net.set(key, current);
    }
    const postedAt = (row.postedAt as Date | undefined) ?? (row.receivedAt as Date | undefined) ?? ([...net.values()].map((entry) => entry.first).sort((a, b) => a.getTime() - b.getTime())[0]) ?? (row.createdAt as Date);
    const entries = [...net.values()].filter((entry) => !entry.quantity.isZero());
    // Nhập trước, xuất sau: đảo phiếu trả nhà máy (nhập lại) không bị chặn bởi thiếu tồn.
    entries.sort((a, b) => Number(a.quantity.gt(0)) - Number(b.quantity.gt(0)));
    return { postedAt, entries };
  }

  private async applyReversal(row: Document, plan: Awaited<ReturnType<StockReturnsService['planReversal']>>, label: string, actorId: string, session: ClientSession) {
    const { postedAt } = plan;
    for (const entry of plan.entries) {
      try {
        await this.inventory.applyPhysicalMovement(
          {
            warehouseId: entry.warehouseId.toHexString(),
            referenceType: 'StockReturn',
            referenceId: String(row.code),
            movementType: 'RETURN_CORRECTION',
            direction: entry.quantity.gt(0) ? 'OUT' : 'IN',
            ...(entry.category ? { category: entry.category } : {}),
            lines: [{ productId: entry.productId.toHexString(), quantity: entry.quantity.abs().toString() }],
            reason: label,
            actorId,
            extra: { ...(row.partnerId ? { partnerId: row.partnerId } : {}), correctionOf: String(row.code) },
            occurredAt: postedAt,
            anyProductStatus: true,
          },
          session,
        );
      } catch (error) {
        if ((error as { response?: { code?: string } }).response?.code === 'INSUFFICIENT_AVAILABLE_STOCK') {
          throw new ConflictException({
            code: 'STOCK_RETURN_REVERSE_NO_STOCK',
            message: `${(error as Error).message} để đảo phiếu ${String(row.code)} — hàng của phiếu đã được xuất / chuyển đi. Kiểm tra thẻ kho, hoặc ghi phiếu điều chỉnh thay vì sửa`,
          });
        }
        throw error;
      }
    }
  }

  private lineText(lines: Document[]) {
    return lines.map((line) => `${String(line.sku)} × ${decimalString(line.quantity)}${line.note ? ` (${String(line.note)})` : ''}`).join(', ');
  }

  private changesOf(row: Document, next: Document): StockReturnChange[] {
    const changes: StockReturnChange[] = [];
    const add = (field: StockReturnChange['field'], from: string, to: string) => {
      if (from !== to) changes.push({ field, from, to });
    };
    add('partner', `${String(row.partnerCode ?? '')} ${String(row.partnerName ?? '')}`.trim(), `${String(next.partnerCode)} ${String(next.partnerName)}`);
    add('category', String(row.category), String(next.category));
    add('warehouse', String(row.warehouseName), String(next.warehouseName));
    add('source', String(row.salesOrderCode ?? row.purchaseOrderCode ?? ''), String(next.salesOrderCode ?? next.purchaseOrderCode ?? ''));
    const before = (row.receivedAt as Date | undefined) ?? (row.postedAt as Date | undefined) ?? (row.createdAt as Date | undefined);
    if (next.receivedAt && (!before || minute(before) !== minute(next.receivedAt as Date))) {
      changes.push({ field: 'receivedAt', from: before ? before.toISOString() : '', to: (next.receivedAt as Date).toISOString() });
    }
    add('note', String(row.note ?? ''), String(next.note));
    add('lines', this.lineText(row.lines as Document[]), this.lineText(next.lines as Document[]));
    return changes;
  }

  /**
   * Sửa phiếu đã lưu (20/10/2026): kiểm tra lại như lúc lập (không tính chính phiếu này vào số đã trả), đảo thẻ kho cũ vào ngày cũ,
   * ghi lại theo nội dung mới vào ngày nhận mới; lưu lịch sử sửa. Chỉ đổi ghi chú chung thì không động vào thẻ kho.
   * Kế toán đã xử lý mà tiền / hàng / khách thay đổi → chuyển lại "chờ kế toán" và báo kế toán.
   */
  async update(id: string, input: UpdateStockReturn, request: AuthenticatedRequest, idempotencyKey: string | undefined) {
    return this.idempotency.execute(`stock-return-edit:${id}:${request.user.sub}`, idempotencyKey, input, async (session) => {
      const row = await this.load(id, session);
      this.assertRevisable(row, input.version);
      if (row.kind !== input.kind) throw new BadRequestException({ code: 'STOCK_RETURN_KIND_LOCKED', message: 'Không đổi được phiếu khách trả thành phiếu trả nhà máy (và ngược lại) — hủy phiếu rồi lập phiếu mới' });
      const now = new Date();
      const currentAt = (row.receivedAt as Date | undefined) ?? (row.postedAt as Date | undefined) ?? (row.createdAt as Date);
      const receivedAt = input.kind === 'CUSTOMER' ? this.receivedAtOf(input.receivedAt, now, currentAt) : undefined;
      const ready = await this.prepare(input, session, row._id as ObjectId);
      const { value, needsAccounting } = this.money(ready);
      const next: Document = {
        category: ready.category,
        partnerId: ready.partner._id,
        partnerCode: String(ready.partner.code),
        partnerName: String(ready.partner.name),
        warehouseId: ready.warehouse._id,
        warehouseName: String(ready.warehouse.name),
        [ready.customer ? 'salesOrderCode' : 'purchaseOrderCode']: ready.sourceCode,
        note: input.note,
        receivedAt,
        lines: this.documentLines(ready.merged, ready.productById),
      };
      const changes = this.changesOf(row, next);
      if (!changes.length) throw new BadRequestException({ code: 'STOCK_RETURN_UNCHANGED', message: 'Phiếu chưa có thay đổi nào' });
      // Thẻ kho chỉ ghi lại khi nội dung ảnh hưởng kho / thẻ kho thay đổi (không phải chỉ đổi ghi chú chung).
      const restock = changes.some((change) => change.field !== 'note');
      if (restock) {
        const plan = await this.planReversal(row, session);
        const label = `Sửa phiếu ${String(row.code)}: ${input.reason}`;
        // Khách trả: ghi nhập mới trước rồi mới đảo (đổi 2 → 3 cái chỉ cần thêm 1, không bắt đủ tồn để xuất lại cả 2).
        if (ready.customer) {
          await this.post(String(row.code), ready, input.note, receivedAt ?? currentAt, request.user.sub, session);
          await this.applyReversal(row, plan, label, request.user.sub, session);
        } else {
          await this.applyReversal(row, plan, label, request.user.sub, session);
          await this.post(String(row.code), ready, input.note, currentAt, request.user.sub, session);
        }
      }

      const moneyChanged = changes.some((change) => change.field !== 'note' && change.field !== 'warehouse' && change.field !== 'receivedAt')
        || JSON.stringify(row.value ?? null) !== JSON.stringify(value ?? null);
      const set: Document = { postedAt: receivedAt ?? currentAt, status: 'POSTED', updatedAt: now, editedAt: now, editedByName: request.user.displayName, value };
      const unset: Document = {};
      for (const [key, field] of Object.entries(next)) set[key] = field;
      for (const key of Object.keys(set)) {
        if (set[key] === undefined) {
          delete set[key];
          unset[key] = '';
        }
      }
      let notify = false;
      let creditVoided: string | undefined;
      // Kế toán đã từng điều chỉnh công nợ theo phiếu (đang DONE, hoặc đã mở lại chờ xử lý sau lần sửa trước) → luôn giữ "chờ kế toán".
      const adjusted = row.accountingStatus === 'DONE' || Boolean(row.previousAccounting);
      if (row.accountingStatus === 'DONE') {
        if (moneyChanged) {
          // Phiếu giảm nợ đã lập theo nội dung cũ tự hủy (công nợ trở lại như trước); kế toán xác nhận lại theo nội dung mới.
          const voided = await this.voidCreditNote(row, `Sửa phiếu ${String(row.code)}: ${input.reason}`, request, session, now);
          set.accountingStatus = 'PENDING';
          set.previousAccounting = voided ?? { note: String(row.accountingNote ?? ''), byName: String(row.accountingByName ?? ''), at: row.accountingAt };
          if (voided) {
            unset.creditNote = '';
            unset.accountingMode = '';
            creditVoided = voided.creditCode;
          }
          notify = true;
        }
      } else if (needsAccounting || adjusted) {
        set.accountingStatus = 'PENDING';
        notify = moneyChanged || row.accountingStatus !== 'PENDING';
      } else if (row.accountingStatus === 'PENDING') {
        unset.accountingStatus = '';
        notify = true;
      }
      for (const key of Object.keys(set)) delete unset[key];
      const revision = { action: 'EDIT', at: now, by: toObjectId(request.user.sub), byName: request.user.displayName, reason: input.reason, changes };
      const after = await this.db.collection('stock_returns').findOneAndUpdate(
        { _id: row._id, ...(row.version === undefined ? { version: { $exists: false } } : { version: row.version }) },
        { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}), $inc: { version: 1 }, $push: { revisions: revision } } as Document,
        { session, returnDocument: 'after' },
      );
      if (!after) throw new ConflictException({ code: 'VERSION_CONFLICT', message: `Phiếu ${String(row.code)} vừa được người khác sửa, vui lòng tải lại` });
      if (notify && ready.customer) {
        await this.notifyAccountant(after, 'CUSTOMER_RETURN_CHANGED', {
          title: `Phiếu khách trả ${String(row.code)} đã sửa — kiểm tra lại điều chỉnh công nợ`,
          message: `${String(after.partnerName)}: ${input.reason}${value ? ` · giá trị mới ${Number(value.total).toLocaleString('vi-VN')} đ` : ''}${creditVoided ? ` · phiếu giảm nợ ${creditVoided} đã tự hủy, xác nhận lại` : ''}.`,
          params: { code: String(row.code), customer: String(after.partnerName), action: 'EDIT', amount: value?.total ?? '', reason: input.reason, credit: creditVoided ?? '' },
        }, session);
      }
      await this.audit.record(
        {
          actorId: request.user.sub, actorEmail: request.user.email, correlationId: request.correlationId,
          action: ready.customer ? 'CUSTOMER_RETURN_EDITED' : 'SUPPLIER_RETURN_EDITED', entityType: 'StockReturn', entityId: id,
          before: serializeDocument(row), after: serializeDocument(after), metadata: { reason: input.reason, restocked: restock },
        },
        session,
      );
      return this.view(after);
    });
  }

  /** Hủy cả phiếu (nhập nhầm): đảo toàn bộ thẻ kho vào ngày của phiếu; phiếu chỉ còn quản trị gốc xem được, không tính vào số đã trả. */
  async void(id: string, input: VoidStockReturn, request: AuthenticatedRequest, idempotencyKey: string | undefined) {
    return this.idempotency.execute(`stock-return-void:${id}:${request.user.sub}`, idempotencyKey, input, async (session) => {
      const row = await this.load(id, session);
      this.assertRevisable(row, input.version, 'VOID');
      const now = new Date();
      await this.reverse(row, `Hủy phiếu ${String(row.code)}: ${input.reason}`, request.user.sub, session);
      const set: Document = { status: 'VOIDED', voidReason: input.reason, voidedAt: now, voidedBy: toObjectId(request.user.sub), voidedByName: request.user.displayName, updatedAt: now };
      const unset: Document = {};
      let notify = false;
      let creditVoided: string | undefined;
      const voided = row.accountingStatus === 'DONE' ? await this.voidCreditNote(row, `Hủy phiếu ${String(row.code)}: ${input.reason}`, request, session, now) : null;
      if (voided) {
        // Phiếu giảm nợ của phiếu tự hủy → công nợ trở lại như trước, không còn gì để kế toán xử lý.
        unset.accountingStatus = '';
        unset.accountingMode = '';
        unset.creditNote = '';
        set.previousAccounting = voided;
        creditVoided = voided.creditCode;
        notify = true;
      } else if (row.accountingStatus === 'DONE') {
        // Kế toán đã giảm công nợ ngoài ERP theo phiếu này → cần hủy / điều chỉnh lại.
        set.accountingStatus = 'PENDING';
        set.previousAccounting = { note: String(row.accountingNote ?? ''), byName: String(row.accountingByName ?? ''), at: row.accountingAt };
        notify = true;
      } else if (row.accountingStatus === 'PENDING' && row.previousAccounting) {
        // Đã mở lại sau khi kế toán xử lý: vẫn chờ kế toán hủy điều chỉnh đã ghi.
        notify = true;
      } else if (row.accountingStatus === 'PENDING') {
        unset.accountingStatus = '';
        notify = true;
      }
      const revision = { action: 'VOID', at: now, by: toObjectId(request.user.sub), byName: request.user.displayName, reason: input.reason, changes: [] };
      const after = await this.db.collection('stock_returns').findOneAndUpdate(
        { _id: row._id, ...(row.version === undefined ? { version: { $exists: false } } : { version: row.version }) },
        { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}), $inc: { version: 1 }, $push: { revisions: revision } } as Document,
        { session, returnDocument: 'after' },
      );
      if (!after) throw new ConflictException({ code: 'VERSION_CONFLICT', message: `Phiếu ${String(row.code)} vừa được người khác sửa, vui lòng tải lại` });
      if (notify && row.kind === 'CUSTOMER') {
        await this.notifyAccountant(after, 'CUSTOMER_RETURN_CHANGED', {
          title: `Phiếu khách trả ${String(row.code)} đã hủy${creditVoided ? ` — phiếu giảm nợ ${creditVoided} đã tự hủy` : row.accountingStatus === 'DONE' || row.previousAccounting ? ' — hủy điều chỉnh công nợ đã ghi' : ''}`,
          message: `${String(row.partnerName)}: ${input.reason}.`,
          params: { code: String(row.code), customer: String(row.partnerName), action: 'VOID', amount: '', reason: input.reason, credit: creditVoided ?? '' },
        }, session);
      }
      await this.audit.record(
        {
          actorId: request.user.sub, actorEmail: request.user.email, correlationId: request.correlationId,
          action: row.kind === 'CUSTOMER' ? 'CUSTOMER_RETURN_VOIDED' : row.kind === 'SAMPLE' ? 'SAMPLE_RETURN_VOIDED' : 'SUPPLIER_RETURN_VOIDED', entityType: 'StockReturn', entityId: id,
          before: serializeDocument(row), after: serializeDocument(after), metadata: { reason: input.reason, accountingWas: row.accountingStatus ?? null },
        },
        session,
      );
      return this.view(after);
    });
  }
}
