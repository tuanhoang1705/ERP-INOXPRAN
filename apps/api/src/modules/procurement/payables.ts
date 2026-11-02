import Decimal from 'decimal.js';

/**
 * Sổ phải trả nhà cung cấp (D2, 22/10/2026) — phần tính thuần, không đọc CSDL:
 * - đơn giá mỗi mã theo đơn mua = thành tiền các dòng ÷ số lượng (đơn vị cơ bản), theo tiền tệ của đơn;
 * - đã nhận = số đã nhận × đơn giá; trả nhà máy theo đơn = số trả × đơn giá; đã trả = tiền ghi trên đơn;
 * - còn phải trả = đã nhận − trả lại − đã trả (âm = trả trước / đặt cọc nhiều hơn hàng đã nhận).
 */

export interface PayableLine {
  productId: string;
  baseQuantity: string;
  receivedBaseQuantity: string;
  lineTotal: string;
}

export interface PayableQuantity {
  productId: string;
  quantity: string;
}

/** Đơn giá theo đơn vị cơ bản của từng mã trên đơn (gộp các dòng cùng mã). */
export function unitCosts(lines: readonly PayableLine[]): Map<string, Decimal> {
  const sums = new Map<string, { quantity: Decimal; total: Decimal }>();
  for (const line of lines) {
    const current = sums.get(line.productId) ?? { quantity: new Decimal(0), total: new Decimal(0) };
    sums.set(line.productId, { quantity: current.quantity.add(line.baseQuantity), total: current.total.add(line.lineTotal) });
  }
  return new Map([...sums].map(([productId, sum]) => [productId, sum.quantity.gt(0) ? sum.total.div(sum.quantity) : new Decimal(0)]));
}

/** Giá trị một tập số lượng theo đơn giá của đơn, làm tròn 2 số lẻ (tiền tệ của đơn). */
export function valueOf(quantities: readonly PayableQuantity[], costs: ReadonlyMap<string, Decimal>): Decimal {
  return quantities.reduce((sum, row) => sum.add(new Decimal(row.quantity).mul(costs.get(row.productId) ?? 0)), new Decimal(0)).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

/** Quy VND theo tỷ giá trên đơn (VND giữ nguyên), làm tròn đồng; giữ dấu. */
export function vndOf(amount: Decimal.Value, currency: string, rate: string | undefined): string {
  const value = new Decimal(amount);
  return (currency === 'VND' ? value : value.mul(rate ?? 0)).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toFixed(0);
}

export interface OrderPayable {
  ordered: Decimal;
  received: Decimal;
  returned: Decimal;
  paid: Decimal;
  balance: Decimal;
}

export function orderPayable(
  order: { total: string; cancelled: boolean; lines: readonly PayableLine[]; payments: ReadonlyArray<{ amount: string }> },
  returned: readonly PayableQuantity[],
): OrderPayable {
  const costs = unitCosts(order.lines);
  const received = valueOf(order.lines.map((line) => ({ productId: line.productId, quantity: line.receivedBaseQuantity })), costs);
  const back = valueOf(returned, costs);
  const paid = order.payments.reduce((sum, payment) => sum.add(payment.amount), new Decimal(0));
  return { ordered: order.cancelled ? new Decimal(0) : new Decimal(order.total), received, returned: back, paid, balance: received.minus(back).minus(paid) };
}
