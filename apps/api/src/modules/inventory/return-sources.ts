import { isNonSalePurpose, type StockReturnSourceOption, type StockReturnSourceState } from '@inoxpran/contracts';
import Decimal from 'decimal.js';
import type { Document, ObjectId } from 'mongodb';
import { decimalString } from '../../common/domain';

/**
 * Ô "Số phiếu BH gốc" của phiếu khách trả (RET-SRC-PICK-01, 19/11/2026 — người dùng: "ô này chỉ nhập đúng số phiếu thôi, bất tiện"):
 * chọn khách xong, bấm vào ô là ra các phiếu BH đã xuất kho của khách (mới nhất trước), gõ số phiếu / mã hàng / tên hàng để lọc.
 * Số còn trả được tính như lúc ghi phiếu (`StockReturnsService.prepare`): số đã xuất theo mã (đơn vị cơ bản, gồm cả dòng tặng)
 * trừ các phiếu khách trả chưa hủy ghi cùng số phiếu BH. Phiếu bán chưa xác nhận giao thành công chưa nhận trả (AR-DLV-01).
 */

/** Số phiếu BH gần nhất của một khách đưa vào gợi ý (phiếu cũ hơn vẫn gõ tay được). */
export const RETURN_SOURCE_LIMIT = 300;

/** Số đã xuất (phiếu BH) / đã nhận (đơn mua) theo mã hàng, trừ số đã trả ở các phiếu trả `previous`. */
export function remainingQuantities(
  sourceLines: readonly Document[],
  quantityOf: (line: Document) => unknown,
  previous: readonly Document[],
): Map<string, Decimal> {
  const remaining = new Map<string, Decimal>();
  for (const line of sourceLines) {
    const key = (line.productId as ObjectId).toHexString();
    remaining.set(key, (remaining.get(key) ?? new Decimal(0)).add(decimalString(quantityOf(line) ?? '0')));
  }
  for (const row of previous) {
    for (const line of (row.lines as Document[] | undefined) ?? []) {
      const key = (line.productId as ObjectId).toHexString();
      remaining.set(key, (remaining.get(key) ?? new Decimal(0)).sub(decimalString(line.quantity)));
    }
  }
  return remaining;
}

/** Phiếu bán đã xuất kho nhưng chưa giao thành công thì chưa nhận trả; phiếu đổi bảo hành xuất kho là nhận trả được. */
export function sourceState(order: Document, lines: StockReturnSourceOption['lines']): StockReturnSourceState {
  if (!isNonSalePurpose(order.purpose) && order.status === 'SHIPPED') return 'NOT_DELIVERED';
  return lines.some((line) => new Decimal(line.remaining).gt(0)) ? 'RETURNABLE' : 'FULLY_RETURNED';
}

/**
 * Dựng danh sách gợi ý từ phiếu BH của khách (`orders`, đã sắp mới nhất trước) và các phiếu khách trả chưa hủy ghi các số phiếu đó
 * (`returns`). `unitOf` = đơn vị cơ bản của mã hàng.
 */
export function returnSourceOptions(
  orders: readonly Document[],
  returns: readonly Document[],
  unitOf: (productId: string) => string | undefined,
): StockReturnSourceOption[] {
  const returnsByCode = new Map<string, Document[]>();
  for (const row of returns) {
    const code = String(row.salesOrderCode);
    returnsByCode.set(code, [...(returnsByCode.get(code) ?? []), row]);
  }
  return orders.map((order) => {
    const orderLines = (order.lines as Document[] | undefined) ?? [];
    const shipped = remainingQuantities(orderLines, (line) => line.baseQuantity, []);
    const remaining = remainingQuantities(orderLines, (line) => line.baseQuantity, returnsByCode.get(String(order.code)) ?? []);
    const lines: StockReturnSourceOption['lines'] = [];
    for (const line of orderLines) {
      const productId = (line.productId as ObjectId).toHexString();
      if (lines.some((row) => row.productId === productId)) continue;
      lines.push({
        productId,
        sku: String(line.sku ?? ''),
        productName: String(line.productName ?? ''),
        unit: unitOf(productId) ?? String(line.unit ?? ''),
        shipped: (shipped.get(productId) ?? new Decimal(0)).toFixed(),
        remaining: Decimal.max(0, remaining.get(productId) ?? 0).toFixed(),
      });
    }
    return {
      code: String(order.code),
      date: ((order.orderDate as Date | undefined) ?? (order.createdAt as Date)).toISOString(),
      state: sourceState(order, lines),
      ...(order.purpose === 'WARRANTY' ? { warranty: true } : {}),
      lines,
    };
  });
}
