/**
 * Đóng gói & container — dùng chung cho hồ sơ sản phẩm, đơn mua nhập khẩu và packing list (API + giao diện).
 * Kích thước thùng tính bằng cm, thể tích bằng m³ (CBM), khối lượng bằng kg. Đây là số liệu vận chuyển để ước lượng
 * (không phải tiền) nên dùng số thực và làm tròn khi hiển thị: CBM 4 chữ số lẻ, kg 2 chữ số lẻ.
 */

/** Sức chứa thực tế thường dùng khi đặt hàng (không phải thể tích danh nghĩa của container). */
export const CONTAINER_TYPES = [
  { code: '20GP', cbm: 28, maxKg: 21_700 },
  { code: '40GP', cbm: 58, maxKg: 26_500 },
  { code: '40HQ', cbm: 68, maxKg: 26_500 },
] as const;
export type ContainerCode = (typeof CONTAINER_TYPES)[number]['code'];

const round = (value: number, digits: number) => {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
};

const positive = (value: string | number | null | undefined): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

/** Thể tích một thùng (m³) từ dài × rộng × cao (cm); thiếu kích thước nào thì trả null. */
export function cartonCbm(lengthCm?: string | number | null, widthCm?: string | number | null, heightCm?: string | number | null): number | null {
  const [l, w, h] = [positive(lengthCm), positive(widthCm), positive(heightCm)];
  if (l === null || w === null || h === null) return null;
  return round((l * w * h) / 1_000_000, 4);
}

/** Số thùng chẵn và số cái lẻ cho một số lượng (đơn vị cơ bản) theo quy cách số cái / thùng. */
export function cartonSplit(quantity: string | number, packSize?: string | number | null): { cartons: number; loose: number } {
  const qty = Math.max(0, Number(quantity) || 0);
  const pack = positive(packSize);
  if (pack === null) return { cartons: 0, loose: qty };
  return { cartons: Math.floor(qty / pack), loose: round(qty - Math.floor(qty / pack) * pack, 4) };
}

/** Số thùng cần để đóng hết số lượng (thùng lẻ tính là một thùng). */
export function cartonsNeeded(quantity: string | number, packSize?: string | number | null): number {
  const { cartons, loose } = cartonSplit(quantity, packSize);
  return loose > 0 && positive(packSize) !== null ? cartons + 1 : cartons;
}

export interface PackingInput {
  /** Số lượng theo đơn vị cơ bản. */
  quantity: string | number;
  packSize?: string | number | null | undefined;
  cartonLengthCm?: string | number | null | undefined;
  cartonWidthCm?: string | number | null | undefined;
  cartonHeightCm?: string | number | null | undefined;
  grossKgPerCarton?: string | number | null | undefined;
  netKgPerCarton?: string | number | null | undefined;
}

export interface PackingLine {
  cartons: number;
  cbm: number;
  grossKg: number;
  netKg: number;
  /** Thiếu quy cách thùng hoặc kích thước → số liệu dòng này chưa đủ để tính. */
  incomplete: boolean;
}

export function packingLine(input: PackingInput): PackingLine {
  const cartons = cartonsNeeded(input.quantity, input.packSize);
  const unitCbm = cartonCbm(input.cartonLengthCm, input.cartonWidthCm, input.cartonHeightCm);
  const gross = positive(input.grossKgPerCarton) ?? 0;
  const net = positive(input.netKgPerCarton) ?? 0;
  return {
    cartons,
    cbm: round(cartons * (unitCbm ?? 0), 4),
    grossKg: round(cartons * gross, 2),
    netKg: round(cartons * net, 2),
    incomplete: Number(input.quantity) > 0 && (positive(input.packSize) === null || unitCbm === null),
  };
}

export function packingTotals(lines: readonly PackingInput[]): PackingLine & { incompleteLines: number } {
  const rows = lines.map(packingLine);
  return {
    cartons: rows.reduce((sum, row) => sum + row.cartons, 0),
    cbm: round(rows.reduce((sum, row) => sum + row.cbm, 0), 4),
    grossKg: round(rows.reduce((sum, row) => sum + row.grossKg, 0), 2),
    netKg: round(rows.reduce((sum, row) => sum + row.netKg, 0), 2),
    incomplete: rows.some((row) => row.incomplete),
    incompleteLines: rows.filter((row) => row.incomplete).length,
  };
}

export interface ContainerPlan {
  containers: Array<{ code: ContainerCode; count: number }>;
  /** Tỷ lệ lấp đầy theo thể tích của phương án (0–1). */
  fill: number;
}

/**
 * Gợi ý số container theo thể tích (và khối lượng cả bì): ưu tiên một container nhỏ nhất đủ chứa,
 * nhiều hơn một 40HQ thì xếp 40HQ rồi phần còn lại vào container nhỏ nhất đủ chứa. Hàng ít (< 1/3 container 20')
 * thì không gợi ý container (gửi hàng lẻ LCL).
 */
export function containerPlan(totalCbm: number, totalKg = 0): ContainerPlan | null {
  if (!(totalCbm > 0)) return null;
  const smallest = CONTAINER_TYPES[0];
  if (totalCbm < smallest.cbm / 3 && totalKg < smallest.maxKg / 3) return null;
  const fits = (cbm: number, kg: number) => CONTAINER_TYPES.find((type) => cbm <= type.cbm && kg <= type.maxKg);
  const largest = CONTAINER_TYPES[2];
  const single = fits(totalCbm, totalKg);
  if (single) return { containers: [{ code: single.code, count: 1 }], fill: round(totalCbm / single.cbm, 4) };
  const full = Math.max(Math.floor(totalCbm / largest.cbm), Math.floor(totalKg / largest.maxKg));
  const restCbm = Math.max(0, totalCbm - full * largest.cbm);
  const restKg = Math.max(0, totalKg - full * largest.maxKg);
  const containers: ContainerPlan['containers'] = [{ code: largest.code, count: full }];
  let capacity = full * largest.cbm;
  if (restCbm > 0 || restKg > 0) {
    const rest = fits(restCbm, restKg) ?? largest;
    if (rest.code === largest.code) containers[0] = { code: largest.code, count: full + 1 };
    else containers.push({ code: rest.code, count: 1 });
    capacity += rest.cbm;
  }
  return { containers, fill: round(totalCbm / capacity, 4) };
}

export function containerPlanLabel(plan: ContainerPlan | null): string {
  if (!plan) return 'LCL';
  return plan.containers.map((item) => `${item.count} × ${item.code}`).join(' + ');
}
