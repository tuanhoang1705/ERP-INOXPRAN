import { allocateLineVat, salesIssueTemplate, vatPercent, zeroPriceKindOf, ZERO_PRICE_LABEL_VI, type ZeroPriceKind } from '@inoxpran/contracts';
import Decimal from 'decimal.js';
import type { Document } from 'mongodb';
import { decimalString } from '../../common/domain';
import type { LedgerRow } from './ledger';
import type { StatementDetailLine } from './statement-detail-workbook';

/**
 * Sổ công nợ khách theo dòng hàng (AR-XLS-03, 16/11/2026): mỗi dòng sổ chi tiết (buildLedger) tách thành các dòng hàng của
 * chứng từ gốc — phiếu BH (sales_orders.lines), chứng từ sổ cũ (historyLines), phiếu giảm nợ trả hàng (historyLines).
 * Tổng P các dòng của mỗi chứng từ luôn bằng đúng số tiền công nợ của chứng từ: lệch (sửa công nợ trên sổ, làm tròn) thì thêm một
 * dòng "Điều chỉnh công nợ" bằng phần chênh — nên (4) = (1) − (2) − (3) luôn bằng còn nợ cuối kỳ của sổ chi tiết.
 */

export interface StatementDetailSources {
  partner: { name: string; nameZh?: string | undefined };
  /** Theo id (hex). */
  receivables: ReadonlyMap<string, Document>;
  payments: ReadonlyMap<string, Document>;
  /** Phiếu BH theo id (hex). */
  orders: ReadonlyMap<string, Document>;
  /** Mã phiếu trả hàng theo id (hex). */
  returnCodes: ReadonlyMap<string, string>;
}

const ZERO_PRICE_LABEL_ZH: Record<ZeroPriceKind, string> = { GIFT: '赠品', EXCHANGE: '换货', COMPENSATION: '补货' };
const METHOD_TEXT: Record<string, string> = { BANK_TRANSFER: 'Chuyển khoản ngân hàng 货款通过银行转账', CASH: 'Tiền mặt 现金收款' };

const money = (value: unknown) => new Decimal(decimalString(value ?? '0'));
const num = (value: Decimal) => value.toDecimalPlaces(2).toNumber();
const present = (value: unknown) => value !== undefined && value !== null && value !== '';
const text = (value: unknown) => (present(value) ? String(value).trim() : undefined);
/** Ngày theo giờ Việt Nam (YYYY-MM-DD) của một mốc ISO. */
export const vnDayOf = (iso: string) => new Date(new Date(iso).getTime() + 7 * 3_600_000).toISOString().slice(0, 10);

export function buildStatementDetailLines(
  rows: readonly LedgerRow[],
  sources: StatementDetailSources,
  opening?: { date: string; amount: string },
): { lines: StatementDetailLine[]; vatRates: Set<string> } {
  const lines: StatementDetailLine[] = [];
  const vatRates = new Set<string>();
  const saleText = `Xuất bán ${sources.partner.name} 向${sources.partner.nameZh || sources.partner.name}销售产品`;

  if (opening && !money(opening.amount).isZero()) {
    lines.push({ date: opening.date, description: 'Số dư đầu kỳ 期初余额', amount: num(money(opening.amount)) });
  }

  /** Thêm các dòng của một chứng từ, rồi dòng điều chỉnh nếu tổng P lệch số tiền công nợ. */
  const pushDocument = (documentLines: StatementDetailLine[], expected: Decimal, base: Pick<StatementDetailLine, 'date' | 'documentNo' | 'invoiceNo'>) => {
    lines.push(...documentLines);
    const total = documentLines.reduce((sum, line) => sum.add(line.amount ?? 0), new Decimal(0));
    const gap = expected.minus(total).toDecimalPlaces(2);
    if (gap.abs().gte(0.01)) {
      lines.push({ ...base, description: documentLines.length ? 'Điều chỉnh công nợ chứng từ (sửa trên sổ công nợ / làm tròn) 调整' : 'Công nợ chứng từ 欠款', amount: num(gap) });
    }
  };

  for (const row of rows) {
    const date = vnDayOf(row.date);
    if (row.kind === 'DEBIT' || row.kind === 'VOID') {
      const doc = sources.receivables.get(row.refId);
      const amount = money(row.debit);
      const documentNo = text(doc?.salesOrderCode) ?? text(doc?.historyDocumentNo) ?? text(doc?.openingDocumentNo) ?? text(doc?.warrantyCode) ?? row.documentNo;
      const invoiceNo = text(doc?.historyInvoiceNo);
      const base = { date, documentNo, ...(invoiceNo ? { invoiceNo } : {}) };
      if (row.kind === 'VOID') {
        lines.push({ ...base, description: `Hủy chứng từ ${row.documentNo} 作废${doc?.voidReason ? ` — ${String(doc.voidReason)}` : ''}`, amount: num(amount) });
        continue;
      }
      const order = row.salesOrderId ? sources.orders.get(row.salesOrderId) : undefined;
      if (order) {
        pushDocument(orderLines(order, base, saleText, vatRates), amount, base);
        continue;
      }
      const history = (doc?.historyLines as Document[] | undefined) ?? [];
      const note = text(doc?.note);
      if (history.length && (doc?.sourceType === 'HISTORY_IMPORT' || doc?.sourceType === 'MANUAL')) {
        pushDocument(history.map((line) => historyLine(line, base, note ?? saleText, 1)), amount, base);
        continue;
      }
      const description = doc?.sourceType === 'OPENING_BALANCE' ? 'Công nợ đầu kỳ 期初欠款'
        : doc?.warrantyCode ? `Phí dịch vụ bảo hành ${String(doc.warrantyCode)} 保修服务费`
        : note ?? row.description;
      lines.push({ ...base, description, amount: num(amount) });
      continue;
    }

    const payment = sources.payments.get(row.refId);
    const extra = [text(payment?.reference), text(payment?.note)].filter(Boolean).join(' · ');
    const documentNo = text(payment?.historyDocumentNo) ?? text(payment?.code) ?? row.documentNo;
    if (row.kind === 'RECEIPT') {
      const method = METHOD_TEXT[String(payment?.method ?? '')] ?? '收款';
      lines.push({ date, documentNo, description: `Thu tiền khách hàng ${method}${extra ? ` — ${extra}` : ''}`, paid: num(money(row.receipt)) });
      continue;
    }
    if (row.kind === 'FREIGHT') {
      lines.push({ date, documentNo, description: `Phí vận chuyển khách trả 运费${extra ? ` — ${extra}` : ''}`, freight: num(money(row.freight)) });
      continue;
    }
    // RETURN: trả hàng (có dòng hàng) / giảm giá, trừ lương (một dòng) — P âm.
    const returnCode = payment?.stockReturnId ? sources.returnCodes.get(String(payment.stockReturnId)) : undefined;
    const base = { date, documentNo: returnCode ?? documentNo };
    const history = (payment?.historyLines as Document[] | undefined) ?? [];
    const amount = money(row.returns).neg();
    if (history.length) {
      const description = payment?.stockReturnId ? `Trả lại hàng bán 退货${returnCode ? ` (${returnCode})` : ''}` : text(payment?.note) ?? 'Trả lại hàng bán 退货';
      pushDocument(history.map((line) => historyLine(line, base, description, -1, vatRates)), amount, base);
    } else {
      lines.push({ ...base, description: extra ? `Giảm trừ công nợ 减免 — ${extra}` : 'Giảm trừ công nợ 减免', amount: num(amount) });
    }
  }
  return { lines, vatRates };
}

/**
 * Làm tròn từng giá trị về đồng sao cho tổng đúng `total` (phần thiếu / thừa cộng / trừ 1 đồng ở dòng có phần lẻ lớn / nhỏ nhất
 * trước) — thành tiền dòng có số lẻ (SL × đơn giá 2 số lẻ) mà tổng phiếu làm tròn đồng, như allocateLineVat.
 */
export function roundToTotal(values: readonly Decimal[], total: Decimal): Decimal[] {
  const rounded = values.map((value) => value.toDecimalPlaces(0, Decimal.ROUND_DOWN));
  let gap = total.minus(rounded.reduce((sum, value) => sum.add(value), new Decimal(0))).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber();
  const order = values.map((value, index) => ({ index, fraction: value.minus(rounded[index]!) })).filter((item) => values[item.index]!.gt(0));
  const up = [...order].sort((a, b) => b.fraction.comparedTo(a.fraction) || a.index - b.index);
  for (let step = 0; gap !== 0 && up.length && step < 4 * up.length + 8; step += 1) {
    const target = (gap > 0 ? up[step % up.length] : up[up.length - 1 - (step % up.length)])!;
    rounded[target.index] = rounded[target.index]!.add(gap > 0 ? 1 : -1);
    gap += gap > 0 ? -1 : 1;
  }
  return rounded;
}

/** Dòng hàng phiếu BH: M đơn giá chưa thuế sau chiết khấu, N thành tiền, O thuế của dòng (PXK-001 chia thuế cả phiếu về dòng). */
function orderLines(order: Document, base: Pick<StatementDetailLine, 'date' | 'documentNo'>, saleText: string, vatRates: Set<string>): StatementDetailLine[] {
  const source = (order.lines as Document[] | undefined) ?? [];
  const lineMode = salesIssueTemplate(order.templateCode as string | undefined).vatMode === 'LINE';
  const exact = source.map((line) => money(line.netAmount ?? line.lineTotal));
  const rateOf = (line: Document) => String(lineMode ? line.vatRate ?? order.taxRate ?? '0' : order.taxRate ?? '0');
  const vat = allocateLineVat(source.map((line, index) => ({ netAmount: exact[index]!.toFixed(2), vatRate: rateOf(line) })));
  // Cộng tiền hàng của phiếu làm tròn đồng: thành tiền từng dòng làm tròn cho đúng tổng → Σ P = tổng thanh toán của phiếu.
  const nets = roundToTotal(exact, new Decimal(vat.netTotal));
  const allocated = vat.taxAmounts;
  return source.map((line, index) => {
    const kind = zeroPriceKindOf({ gift: line.gift === true, zeroPriceKind: line.zeroPriceKind as ZeroPriceKind | undefined });
    const net = nets[index]!;
    const tax = lineMode && present(line.taxAmount) ? money(line.taxAmount) : new Decimal(allocated[index] ?? '0');
    const rate = rateOf(line);
    if (!kind && net.gt(0) && Number(vatPercent(rate)) > 0) vatRates.add(vatPercent(rate));
    return {
      ...base,
      description: kind ? `${ZERO_PRICE_LABEL_VI[kind]} ${ZERO_PRICE_LABEL_ZH[kind]}` : saleText,
      sku: text(line.sku),
      name: text(line.productName),
      unit: text(line.unit),
      quantity: num(money(line.quantity)),
      unitPrice: num(money(line.unitPrice)),
      net: num(net),
      tax: num(tax),
      amount: num(net.add(tax)),
    };
  });
}

/**
 * Dòng hàng lưu trong `historyLines` (sổ cũ: đơn giá chưa thuế, thành tiền gồm thuế; phiếu giảm nợ từ Phiếu trả hàng: thêm
 * netUnitPrice / netAmount / taxAmount). `sign` = −1 cho trả hàng: số lượng và tiền in số âm như mẫu.
 */
function historyLine(line: Document, base: Pick<StatementDetailLine, 'date' | 'documentNo' | 'invoiceNo'>, description: string, sign: 1 | -1, vatRates?: Set<string>): StatementDetailLine {
  const signed = (value: Decimal) => (sign < 0 ? value.abs().neg() : value);
  const quantity = present(line.quantity) ? signed(money(line.quantity)) : undefined;
  const unitPrice = present(line.netUnitPrice) ? money(line.netUnitPrice) : present(line.unitPrice) ? money(line.unitPrice) : undefined;
  const amount = present(line.amount) ? signed(money(line.amount)) : undefined;
  const net = present(line.netAmount) ? signed(money(line.netAmount))
    : quantity !== undefined && unitPrice !== undefined ? quantity.mul(unitPrice).toDecimalPlaces(2) : undefined;
  const tax = present(line.taxAmount) ? signed(money(line.taxAmount)) : amount !== undefined && net !== undefined ? amount.minus(net) : undefined;
  if (vatRates && present(line.vatRate) && Number(vatPercent(String(line.vatRate))) > 0) vatRates.add(vatPercent(String(line.vatRate)));
  return {
    ...base,
    description,
    sku: text(line.sku),
    name: text(line.productName),
    unit: text(line.unit),
    ...(quantity !== undefined ? { quantity: num(quantity) } : {}),
    ...(unitPrice !== undefined ? { unitPrice: num(unitPrice) } : {}),
    ...(net !== undefined ? { net: num(net) } : {}),
    ...(tax !== undefined ? { tax: num(tax) } : {}),
    ...(amount !== undefined ? { amount: num(amount) } : {}),
  };
}
