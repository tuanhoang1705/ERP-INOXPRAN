import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { vnDate, type PayableEvent, type PayableOrderRow, type PayableStatement, type PayableSupplierRow, type PayableTotals } from '@inoxpran/contracts';
import Decimal from 'decimal.js';
import type { Db, Document } from 'mongodb';
import { ObjectId } from 'mongodb';
import { decimalString, toObjectId } from '../../common/domain';
import { MONGO_DATABASE } from '../../common/tokens';
import { orderPayable, unitCosts, valueOf, vndOf, type PayableLine } from './payables';

/** Đơn chưa xong nhận hàng: còn hàng phải nhận / còn tiền phải trả. */
const OPEN_ORDER_STATUSES = ['PENDING_APPROVAL', 'APPROVED', 'PARTIALLY_RECEIVED'];

interface LoadedOrder {
  doc: Document;
  id: string;
  currency: string;
  rate: string | undefined;
  lines: PayableLine[];
  payments: Document[];
  returns: Document[];
}

const zero = () => new Decimal(0);
/** Thời điểm của khoản đã trả: ghi trong đúng ngày trả thì lấy giờ ghi (xếp đúng thứ tự với phiếu nhập cùng ngày), còn lại 12:00. */
const paidAt = (payment: Document) => {
  const recorded = payment.recordedAt as Date | undefined;
  return recorded && vnDate(recorded) === String(payment.paidOn) ? recorded : new Date(`${String(payment.paidOn)}T12:00:00+07:00`);
};

/**
 * Sổ phải trả nhà cung cấp (D2, 22/10/2026) — đọc từ đơn mua, phiếu nhập kho, phiếu trả nhà máy theo đơn và tiền đã trả ghi
 * trên đơn (payables.ts). Không có bản ghi riêng nên luôn khớp chứng từ: sửa phiếu nhập / phiếu trả / xóa khoản trả là sổ đổi theo.
 */
@Injectable()
export class PayablesService {
  constructor(@Inject(MONGO_DATABASE) private readonly db: Db) {}

  /** Đơn mua đã gửi (bỏ nháp; đơn hủy chỉ giữ khi có tiền đã trả) + phiếu trả nhà máy theo đơn. */
  private async load(filter: Document): Promise<LoadedOrder[]> {
    const docs = await this.db.collection('purchase_orders').find({ status: { $ne: 'DRAFT' }, ...filter }).sort({ createdAt: 1, _id: 1 }).toArray();
    const kept = docs.filter((doc) => doc.status !== 'CANCELLED' || ((doc.payments as Document[] | undefined) ?? []).length > 0);
    const returns = kept.length
      ? await this.db.collection('stock_returns').find({ kind: 'SUPPLIER', status: { $ne: 'VOIDED' }, purchaseOrderCode: { $in: kept.map((doc) => String(doc.code)) } }).toArray()
      : [];
    return kept.map((doc) => ({
      doc,
      id: (doc._id as ObjectId).toHexString(),
      currency: String(doc.currency ?? 'VND'),
      rate: doc.exchangeRate === undefined ? undefined : decimalString(doc.exchangeRate),
      lines: (doc.lines as Document[]).map((line) => ({
        productId: (line.productId as ObjectId).toHexString(),
        baseQuantity: decimalString(line.baseQuantity),
        receivedBaseQuantity: decimalString(line.receivedBaseQuantity ?? '0'),
        lineTotal: decimalString(line.lineTotal),
      })),
      payments: (doc.payments as Document[] | undefined) ?? [],
      returns: returns.filter((row) => row.purchaseOrderCode === doc.code),
    }));
  }

  private static returned(order: LoadedOrder) {
    return order.returns.flatMap((row) => (row.lines as Document[]).map((line) => ({ productId: (line.productId as ObjectId).toHexString(), quantity: decimalString(line.quantity) })));
  }

  private static payable(order: LoadedOrder) {
    return orderPayable(
      { total: decimalString(order.doc.total), cancelled: order.doc.status === 'CANCELLED', lines: order.lines, payments: order.payments.map((payment) => ({ amount: decimalString(payment.amount) })) },
      PayablesService.returned(order),
    );
  }

  /** Cộng theo tiền tệ (VND quy đổi cộng theo tỷ giá từng đơn). */
  private static totals(orders: readonly LoadedOrder[]): PayableTotals[] {
    const byCurrency = new Map<string, { ordered: Decimal; received: Decimal; returned: Decimal; paid: Decimal; balance: Decimal; balanceVnd: Decimal }>();
    for (const order of orders) {
      const value = PayablesService.payable(order);
      const sum = byCurrency.get(order.currency) ?? { ordered: zero(), received: zero(), returned: zero(), paid: zero(), balance: zero(), balanceVnd: zero() };
      byCurrency.set(order.currency, {
        ordered: sum.ordered.add(value.ordered),
        received: sum.received.add(value.received),
        returned: sum.returned.add(value.returned),
        paid: sum.paid.add(value.paid),
        balance: sum.balance.add(value.balance),
        balanceVnd: sum.balanceVnd.add(vndOf(value.balance, order.currency, order.rate)),
      });
    }
    return [...byCurrency]
      .sort(([a], [b]) => (a === 'VND' ? -1 : b === 'VND' ? 1 : a.localeCompare(b)))
      .map(([currency, sum]) => ({
        currency,
        ordered: sum.ordered.toFixed(2),
        received: sum.received.toFixed(2),
        returned: sum.returned.toFixed(2),
        paid: sum.paid.toFixed(2),
        balance: sum.balance.toFixed(2),
        balanceVnd: sum.balanceVnd.toFixed(0),
      }));
  }

  private static isOpen(order: LoadedOrder) {
    return OPEN_ORDER_STATUSES.includes(String(order.doc.status)) || !PayablesService.payable(order).balance.isZero();
  }

  /** Danh sách nhà cung cấp có đơn mua: mỗi dòng một nhà cung cấp × tiền tệ. */
  async suppliers(search?: string): Promise<PayableSupplierRow[]> {
    const orders = await this.load({});
    const receipts = await this.db.collection('goods_receipts').find({ purchaseOrderId: { $in: orders.map((order) => order.doc._id as ObjectId) } }, { projection: { purchaseOrderId: 1, postedAt: 1 } }).toArray();
    const lastReceipt = new Map<string, Date>();
    for (const row of receipts) {
      const key = String(row.purchaseOrderId);
      if (!lastReceipt.has(key) || (row.postedAt as Date) > (lastReceipt.get(key) as Date)) lastReceipt.set(key, row.postedAt as Date);
    }
    const groups = new Map<string, LoadedOrder[]>();
    for (const order of orders) {
      const key = `${String(order.doc.supplierId)}|${order.currency}`;
      groups.set(key, [...(groups.get(key) ?? []), order]);
    }
    const pattern = search?.trim() ? new RegExp(search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') : null;
    const rows: PayableSupplierRow[] = [];
    for (const list of groups.values()) {
      const first = list[0] as LoadedOrder;
      const supplierCode = String(first.doc.supplierCode ?? '');
      const supplierName = String(first.doc.supplierName ?? '');
      if (pattern && !pattern.test(supplierCode) && !pattern.test(supplierName)) continue;
      const dates = list.flatMap((order) => [
        order.doc.createdAt as Date,
        ...(lastReceipt.has(order.id) ? [lastReceipt.get(order.id) as Date] : []),
        ...order.payments.map((payment) => paidAt(payment)),
        ...order.returns.map((row) => row.postedAt as Date),
      ]);
      const last = dates.reduce<Date | null>((max, value) => (value && (!max || value > max) ? value : max), null);
      rows.push({
        ...(PayablesService.totals(list)[0] as PayableTotals),
        supplierId: String(first.doc.supplierId),
        supplierCode,
        supplierName,
        openOrders: list.filter(PayablesService.isOpen).length,
        ...(last ? { lastActivity: last.toISOString() } : {}),
      });
    }
    return rows.sort((a, b) => Number(b.balanceVnd) - Number(a.balanceVnd) || a.supplierCode.localeCompare(b.supplierCode));
  }

  /** Sổ chi tiết một nhà cung cấp: tổng theo tiền tệ, từng đơn, các phát sinh (nhập kho / trả nhà máy / đã trả) kèm số dư lũy kế. */
  async statement(supplierId: string): Promise<PayableStatement> {
    const id = toObjectId(supplierId, 'supplierId');
    const supplier = await this.db.collection('partners').findOne({ _id: id, kind: { $in: ['SUPPLIER', 'BOTH'] } }, { projection: { code: 1, name: 1, phone: 1, taxCode: 1 } });
    if (!supplier) throw new NotFoundException({ code: 'SUPPLIER_NOT_FOUND', message: 'Không tìm thấy nhà cung cấp' });
    const orders = await this.load({ supplierId: id });
    const receipts = orders.length
      ? await this.db.collection('goods_receipts').find({ purchaseOrderId: { $in: orders.map((order) => order.doc._id as ObjectId) } }).toArray()
      : [];
    type Draft = Omit<PayableEvent, 'balance'> & { at: Date; rank: number; signed: Decimal };
    const drafts: Draft[] = [];
    for (const order of orders) {
      const costs = unitCosts(order.lines);
      const base = { orderId: order.id, orderCode: String(order.doc.code), currency: order.currency };
      for (const row of receipts.filter((receipt) => String(receipt.purchaseOrderId) === order.id)) {
        const value = valueOf((row.lines as Document[]).map((line) => ({ productId: String(line.productId), quantity: decimalString(line.quantity) })), costs);
        drafts.push({ ...base, at: row.postedAt as Date, rank: 0, signed: value, date: (row.postedAt as Date).toISOString(), kind: 'RECEIPT', code: String(row.code), increase: value.toFixed(2), decrease: '0.00', ...(row.supplierDocumentReference ? { reference: String(row.supplierDocumentReference) } : {}) });
      }
      for (const row of order.returns) {
        const value = valueOf((row.lines as Document[]).map((line) => ({ productId: String(line.productId), quantity: decimalString(line.quantity) })), costs);
        const at = (row.postedAt as Date | undefined) ?? (row.createdAt as Date);
        drafts.push({ ...base, at, rank: 1, signed: value.neg(), date: at.toISOString(), kind: 'RETURN', code: String(row.code), increase: '0.00', decrease: value.toFixed(2), ...(row.note ? { note: String(row.note) } : {}) });
      }
      for (const payment of order.payments) {
        const amount = new Decimal(decimalString(payment.amount));
        const at = paidAt(payment);
        drafts.push({
          ...base, at, rank: 2, signed: amount.neg(), date: at.toISOString(), kind: 'PAYMENT', code: String(order.doc.code), increase: '0.00', decrease: amount.toFixed(2),
          paymentKind: String(payment.kind),
          ...(payment.reference ? { reference: String(payment.reference) } : {}),
          ...(payment.note ? { note: String(payment.note) } : {}),
          ...(payment.recordedByName ? { byName: String(payment.recordedByName) } : {}),
        });
      }
    }
    drafts.sort((a, b) => a.at.getTime() - b.at.getTime() || a.rank - b.rank || a.code.localeCompare(b.code));
    const running = new Map<string, Decimal>();
    const events: PayableEvent[] = drafts.map(({ at: _at, rank: _rank, signed, ...event }) => {
      const balance = (running.get(event.currency) ?? zero()).add(signed);
      running.set(event.currency, balance);
      return { ...event, balance: balance.toFixed(2) };
    });
    const rows: PayableOrderRow[] = orders
      .map((order) => {
        const value = PayablesService.payable(order);
        return {
          id: order.id,
          code: String(order.doc.code),
          status: String(order.doc.status),
          currency: order.currency,
          ...(order.rate ? { exchangeRate: order.rate } : {}),
          ...(order.doc.supplierContractNo ? { supplierContractNo: String(order.doc.supplierContractNo) } : {}),
          ...(order.doc.paymentTerms ? { paymentTerms: String(order.doc.paymentTerms) } : {}),
          createdAt: (order.doc.createdAt as Date).toISOString(),
          ordered: value.ordered.toFixed(2),
          received: value.received.toFixed(2),
          returned: value.returned.toFixed(2),
          paid: value.paid.toFixed(2),
          balance: value.balance.toFixed(2),
          balanceVnd: vndOf(value.balance, order.currency, order.rate),
        };
      })
      .reverse();
    return {
      supplier: { id: supplierId, code: String(supplier.code), name: String(supplier.name), ...(supplier.phone ? { phone: String(supplier.phone) } : {}), ...(supplier.taxCode ? { taxCode: String(supplier.taxCode) } : {}) },
      totals: PayablesService.totals(orders),
      orders: rows,
      events,
    };
  }
}
