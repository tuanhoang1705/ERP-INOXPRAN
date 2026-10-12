/**
 * Giá vốn hàng nhập khẩu (lô hàng từ công ty mẹ): quy đổi ngoại tệ, phân bổ chi phí nhập vào từng dòng hàng,
 * giá vốn bình quân gia quyền sau khi nhập kho. Dùng chung API (khi chốt lô) và giao diện (xem trước phân bổ).
 *
 * Tính bằng số nguyên BigInt (không sai số dấu phẩy động):
 *   Giá trị dòng (VND)   = làm tròn tới đồng( số lượng × đơn giá ngoại tệ × tỷ giá )
 *   Chi phí phân bổ      = chi phí vốn hóa × tỷ trọng dòng (giá trị / CBM / số lượng), chia theo phương pháp phần dư lớn nhất
 *                          để tổng các dòng đúng bằng tổng chi phí (không lệch 1 đồng)
 *   Giá vốn nhập / đơn vị = (giá trị dòng + chi phí phân bổ) ÷ số lượng (2 số lẻ)
 *   Giá vốn bình quân mới = (tồn trước × giá vốn cũ + số nhập × giá vốn nhập) ÷ (tồn trước + số nhập)
 * Thuế GTGT hàng nhập khẩu được khấu trừ nên KHÔNG vào giá vốn.
 */
import { toScaled } from './sales-math';

const E = 10_000n;

function roundDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new Error('Mẫu số phải dương');
  if (numerator < 0n) return -roundDiv(-numerator, denominator);
  return (numerator * 2n + denominator) / (denominator * 2n);
}

function fixed(value: bigint, places: number): string {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(places + 1, '0');
  const integer = digits.slice(0, digits.length - places);
  const fraction = digits.slice(digits.length - places);
  return `${negative ? '-' : ''}${integer}${places ? `.${fraction}` : ''}`;
}

export const IMPORT_COST_TYPES = ['FREIGHT', 'INSURANCE', 'IMPORT_DUTY', 'IMPORT_VAT', 'CUSTOMS_FEE', 'PORT_FEE', 'TRUCKING', 'OTHER'] as const;
export type ImportCostType = (typeof IMPORT_COST_TYPES)[number];
/** Chi phí được cộng vào giá vốn (mọi loại trừ thuế GTGT nhập khẩu được khấu trừ). */
export const isCapitalizedCost = (type: string): boolean => type !== 'IMPORT_VAT';

export const ALLOCATION_METHODS = ['VALUE', 'CBM', 'QUANTITY'] as const;
export type AllocationMethod = (typeof ALLOCATION_METHODS)[number];

/** Số tiền ngoại tệ × tỷ giá (VND / 1 đơn vị ngoại tệ) → VND làm tròn tới đồng. VND thì tỷ giá = 1. */
export function toVnd(amount: string | number, rate: string | number = 1): string {
  return fixed(roundDiv(toScaled(amount) * toScaled(rate), E * E), 0);
}

/** Thành tiền theo tiền tệ chứng từ: số lượng × đơn giá, làm tròn 2 số lẻ. */
export function lineAmount(quantity: string | number, unitPrice: string | number): string {
  return fixed(roundDiv(toScaled(quantity) * toScaled(unitPrice), E * 100n), 2);
}

/** Cộng các số tiền (chuỗi) chính xác, giữ `places` số lẻ. */
export function sumAmounts(values: ReadonlyArray<string | number>, places = 2): string {
  const total = values.reduce<bigint>((sum, value) => sum + toScaled(value), 0n);
  return fixed(roundDiv(total, 10n ** BigInt(4 - places)), places);
}

/**
 * Chia một số tiền nguyên (đồng) theo tỷ trọng, tổng các phần đúng bằng số tiền (phương pháp phần dư lớn nhất).
 * Tỷ trọng đều bằng 0 thì chia đều.
 */
export function allocate(total: string | number, weights: ReadonlyArray<string | number>): string[] {
  if (!weights.length) return [];
  const amount = roundDiv(toScaled(total), E);
  const scaled = weights.map((weight) => {
    const value = toScaled(weight);
    return value > 0n ? value : 0n;
  });
  const sum = scaled.reduce((acc, value) => acc + value, 0n);
  const basis = sum > 0n ? scaled : scaled.map(() => 1n);
  const basisSum = sum > 0n ? sum : BigInt(scaled.length);
  const shares = basis.map((weight) => ({ floor: (amount * weight) / basisSum, remainder: (amount * weight) % basisSum }));
  let left = amount - shares.reduce((acc, share) => acc + share.floor, 0n);
  const order = shares.map((share, index) => ({ index, remainder: share.remainder })).sort((a, b) => (b.remainder > a.remainder ? 1 : b.remainder < a.remainder ? -1 : a.index - b.index));
  const result = shares.map((share) => share.floor);
  for (const item of order) {
    if (left <= 0n) break;
    result[item.index] = (result[item.index] ?? 0n) + 1n;
    left -= 1n;
  }
  return result.map((value) => value.toString());
}

export interface LandedLineInput {
  key: string;
  /** Số lượng theo đơn vị cơ bản. */
  quantity: string | number;
  /** Giá trị hàng của dòng đã quy VND. */
  valueVnd: string | number;
  cbm?: string | number | undefined;
}

export interface LandedLine {
  key: string;
  valueVnd: string;
  allocatedVnd: string;
  landedVnd: string;
  /** Giá vốn nhập mỗi đơn vị cơ bản (VND, 2 số lẻ). */
  unitCostVnd: string;
}

/** Phân bổ chi phí vốn hóa của lô vào từng dòng; CBM không đủ dữ liệu thì phân bổ theo giá trị. */
export function landedCost(lines: ReadonlyArray<LandedLineInput>, costs: ReadonlyArray<{ type: string; amountVnd: string | number }>, method: AllocationMethod): {
  lines: LandedLine[];
  capitalizedVnd: string;
  excludedVnd: string;
  methodUsed: AllocationMethod;
} {
  const capitalized = costs.filter((cost) => isCapitalizedCost(cost.type)).reduce<bigint>((sum, cost) => sum + roundDiv(toScaled(cost.amountVnd), E), 0n);
  const excluded = costs.filter((cost) => !isCapitalizedCost(cost.type)).reduce<bigint>((sum, cost) => sum + roundDiv(toScaled(cost.amountVnd), E), 0n);
  const cbmComplete = lines.length > 0 && lines.every((line) => Number(line.cbm ?? 0) > 0);
  const methodUsed: AllocationMethod = method === 'CBM' && !cbmComplete ? 'VALUE' : method;
  const weights = lines.map((line) => (methodUsed === 'CBM' ? line.cbm ?? 0 : methodUsed === 'QUANTITY' ? line.quantity : line.valueVnd));
  const shares = allocate(capitalized.toString(), weights);
  return {
    lines: lines.map((line, index) => {
      const value = roundDiv(toScaled(line.valueVnd), E);
      const allocated = BigInt(shares[index] ?? '0');
      const landed = value + allocated;
      const quantity = toScaled(line.quantity);
      return {
        key: line.key,
        valueVnd: value.toString(),
        allocatedVnd: allocated.toString(),
        landedVnd: landed.toString(),
        unitCostVnd: quantity > 0n ? fixed(roundDiv(landed * E * 100n, quantity), 2) : '0.00',
      };
    }),
    capitalizedVnd: capitalized.toString(),
    excludedVnd: excluded.toString(),
    methodUsed,
  };
}

/** Giá vốn bình quân gia quyền sau khi nhập thêm hàng (VND, 2 số lẻ). Tồn trước ≤ 0 hoặc chưa có giá vốn → lấy giá nhập. */
export function weightedAverageCost(onHandBefore: string | number, currentUnitCost: string | number | null | undefined, receivedQuantity: string | number, receivedUnitCost: string | number): string {
  const before = toScaled(onHandBefore);
  const received = toScaled(receivedQuantity);
  if (received <= 0n) return currentUnitCost === null || currentUnitCost === undefined ? fixed(roundDiv(toScaled(receivedUnitCost), 100n), 2) : fixed(roundDiv(toScaled(currentUnitCost), 100n), 2);
  if (before <= 0n || currentUnitCost === null || currentUnitCost === undefined || currentUnitCost === '') {
    return fixed(roundDiv(toScaled(receivedUnitCost), 100n), 2);
  }
  const numerator = before * toScaled(currentUnitCost) + received * toScaled(receivedUnitCost);
  return fixed(roundDiv(numerator * 100n, (before + received) * E), 2);
}
