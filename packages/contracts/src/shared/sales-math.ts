/**
 * Phép tính tiền của phiếu xuất kho bán hàng, dùng chung cho API (khi lưu chứng từ) và form (tính tức thời trên trình duyệt)
 * nên hai nơi luôn ra cùng một con số. Module thuần TypeScript, không phụ thuộc thư viện, chạy được ở cả Node lẫn trình duyệt.
 *
 * Mọi phép tính dùng số nguyên BigInt (không sai số dấu phẩy động) và mỗi đại lượng chỉ làm tròn MỘT lần, nửa lên,
 * đúng như phiếu in từ phần mềm kế toán:
 *
 *   Đơn giá (chưa thuế) = làm tròn 2 số lẻ( giá niêm yết × (1 − CK%) ÷ (1 + thuế suất) )   ← bảng giá đã gồm thuế
 *   Thành tiền          = làm tròn 2 số lẻ( số lượng × đơn giá )                           ← in ra làm tròn tới đồng
 *   Cộng tiền hàng      = làm tròn tới đồng( Σ thành tiền )
 *   Tiền thuế GTGT      = làm tròn tới đồng( Σ thành tiền × thuế suất )
 *   Tổng thanh toán     = làm tròn tới đồng( Σ thành tiền × (1 + thuế suất) )
 *
 * Phiếu thật BH Giang Châu: 586.000 ÷ 1,08 = 542.592,59; Σ thành tiền = 74.842.592,30
 * → cộng tiền hàng 74.842.592, thuế 8% 5.987.407, tổng 80.830.000 (tổng lấy từ số chưa làm tròn nên lệch 1 đồng so với
 * cộng hai số đã làm tròn — giống hệt phiếu giấy). Đây là mẫu PXK-001 (một thuế suất cho cả phiếu).
 *
 * Mẫu PXK-002 (thuế suất từng dòng, 27/10/2026) — `allocateLineVat`: tổng thanh toán của mỗi thuế suất tính như PXK-001
 * (làm tròn một lần từ Σ thành tiền chưa làm tròn, khớp bảng giá đã gồm thuế), tiền thuế = tổng thanh toán − cộng tiền hàng,
 * rồi chia tiền thuế về từng dòng (thành tiền × thuế suất, làm tròn tới đồng theo phần lẻ lớn nhất) để cộng các dòng ra đúng
 * tiền thuế — không lệch đồng nào giữa cột thuế dòng, tiền thuế và tổng thanh toán.
 */

/** Thuế suất GTGT chọn trên phiếu. KCT = hàng không chịu thuế GTGT (không tính tiền thuế). */
export const VAT_RATES = ['3', '5', '8', '10', 'KCT'] as const;
export type VatRate = (typeof VAT_RATES)[number];

export const VAT_RATE_OPTIONS: ReadonlyArray<{ value: VatRate; label: string }> = [
  { value: '3', label: '3%' },
  { value: '5', label: '5%' },
  { value: '8', label: '8%' },
  { value: '10', label: '10%' },
  { value: 'KCT', label: 'KCT — không chịu thuế' },
];

export function isVatRate(value: unknown): value is VatRate {
  return typeof value === 'string' && (VAT_RATES as readonly string[]).includes(value);
}

/** Phần trăm thuế dùng để tính: KCT tính như 0. Chấp nhận cả thuế suất cũ lưu dạng số ("10"). */
export function vatPercent(rate: string | number | null | undefined): string {
  if (rate === null || rate === undefined || rate === '' || rate === 'KCT') return '0';
  const text = String(rate).trim();
  if (!/^\d+(\.\d+)?$/.test(text)) throw new Error(`Thuế suất GTGT không hợp lệ: ${text}`);
  return text;
}

/** Nhãn thuế suất in trên phiếu: "8 %" hoặc "KCT". */
export function vatLabel(rate: string | number | null | undefined, separator = ' '): string {
  if (rate === 'KCT') return 'KCT';
  if (rate === 'MIXED') return 'Theo từng dòng';
  return `${vatPercent(rate ?? '0')}${separator}%`;
}

// ---------------------------------------------------------------------------------------------------------------
// Số thập phân chính xác: mọi giá trị đầu vào được quy về số nguyên × 10^4.

const SCALE = 4;
const E = 10n ** BigInt(SCALE); // 1 đơn vị = 10^4
const PERCENT_BASE = 100n * E; // 100% = 10^6 (đơn vị 10^-4 phần trăm)

function plain(value: string | number): string {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`Số không hợp lệ: ${value}`);
    return Number.isInteger(value) ? String(value) : value.toFixed(10);
  }
  return value.trim();
}

/** "542592.59" → 5425925900n (× 10^4), làm tròn nửa lên nếu nhiều hơn 4 chữ số lẻ. */
export function toScaled(value: string | number): bigint {
  const text = plain(value);
  const match = /^([+-])?(\d*)(?:\.(\d*))?$/.exec(text);
  if (!match || (!match[2] && !match[3])) throw new Error(`Số không hợp lệ: ${String(value)}`);
  const integer = match[2] || '0';
  const fraction = match[3] ?? '';
  let result = BigInt(integer + fraction.padEnd(SCALE, '0').slice(0, SCALE));
  if ((fraction[SCALE] ?? '0') >= '5') result += 1n;
  return match[1] === '-' ? -result : result;
}

/** Chia làm tròn nửa lên (xa số 0), đúng kiểu ROUND_HALF_UP của phần mềm kế toán. */
function roundDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new Error('Mẫu số phải dương');
  if (numerator < 0n) return -roundDiv(-numerator, denominator);
  return (numerator * 2n + denominator) / (denominator * 2n);
}

/** Số nguyên đã nhân 10^places → chuỗi có đúng `places` chữ số lẻ. */
function fixed(value: bigint, places: number): string {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(places + 1, '0');
  const integer = digits.slice(0, digits.length - places);
  const fraction = digits.slice(digits.length - places);
  return `${negative ? '-' : ''}${integer}${places ? `.${fraction}` : ''}`;
}

/** Bỏ số 0 thừa ở phần lẻ: "15.0000" → "15", "0.5000" → "0.5". */
function trimmed(value: bigint, places: number): string {
  const text = fixed(value, places);
  return text.includes('.') ? text.replace(/\.?0+$/, '') : text;
}

/** Cộng chính xác các số tiền 2 số lẻ. */
export function sumMoney(values: ReadonlyArray<string | number>): string {
  const total = values.reduce<bigint>((sum, value) => sum + toScaled(value), 0n);
  return fixed(roundDiv(total, 100n), 2);
}

/** Làm tròn một số tiền tới đồng (nửa lên). */
export function roundDong(value: string | number): string {
  return fixed(roundDiv(toScaled(value), E), 0);
}

// ---------------------------------------------------------------------------------------------------------------
// Dòng hàng và tổng chứng từ

export interface LineBasis {
  /** Số lượng theo đơn vị bán (Cái, Thùng…). */
  quantity: string | number;
  /** Hệ số quy đổi đơn vị bán → đơn vị cơ sở. */
  conversionFactor: string | number;
  /** Giá niêm yết theo cấp khách cho 1 đơn vị cơ sở (đã gồm thuế nếu `pricesIncludeTax`). */
  baseUnitPrice: string | number;
  /** % chiết khấu tổng đã áp trần. */
  discountRate: string | number;
  /** Hàng tặng: đơn giá 0, không chiết khấu, vẫn xuất kho. */
  gift?: boolean | undefined;
  /**
   * Đơn giá chưa thuế sửa tay cho 1 đơn vị bán (đã được cấp quyền): thay cho giá bảng giá, không chiết khấu
   * (đơn giá trước CK = sau CK = giá sửa). Giá niêm yết (`listPrice`) vẫn là giá bảng giá để đối chiếu.
   */
  unitPriceOverride?: string | number | undefined;
}

export interface TaxOptions {
  vatRate: string;
  /** Giá niêm yết đã gồm thuế GTGT (bảng báo giá INOXPRAN) → đơn giá chưa thuế được tính ngược. */
  pricesIncludeTax: boolean;
}

export interface LineAmounts {
  /** Số lượng quy về đơn vị cơ sở (dùng trừ tồn). */
  baseQuantity: string;
  /** Giá niêm yết của 1 đơn vị bán, trước chiết khấu (đã gồm thuế nếu bảng giá gồm thuế). */
  listPrice: string;
  /** Đơn giá chưa thuế trước chiết khấu. */
  listUnitPrice: string;
  /** Đơn giá chưa thuế sau chiết khấu — cột "Đơn giá" trên phiếu. */
  unitPrice: string;
  /** Tiền hàng theo giá niêm yết chưa thuế. */
  subtotal: string;
  discountAmount: string;
  /** Thành tiền — cột "Thành tiền" trên phiếu (2 số lẻ, in ra làm tròn tới đồng). */
  netAmount: string;
  taxAmount: string;
  grossAmount: string;
}

export function priceLine(line: LineBasis, options: TaxOptions): LineAmounts {
  const quantity = toScaled(line.quantity);
  const factor = toScaled(line.conversionFactor);
  if (quantity < 0n) throw new Error('Số lượng không được âm');
  if (factor <= 0n) throw new Error('Hệ số quy đổi phải lớn hơn 0');
  const baseQuantity = trimmed(roundDiv(quantity * factor, E), SCALE);
  if (line.gift) {
    const zero = fixed(0n, 2);
    return { baseQuantity, listPrice: zero, listUnitPrice: zero, unitPrice: zero, subtotal: zero, discountAmount: zero, netAmount: zero, taxAmount: zero, grossAmount: zero };
  }

  const price = toScaled(line.baseUnitPrice) * factor; // giá / đơn vị bán, × 10^8
  const discount = toScaled(line.discountRate); // × 10^4 phần trăm
  const tax = toScaled(vatPercent(options.vatRate)); // × 10^4 phần trăm
  if (discount < 0n || discount > PERCENT_BASE) throw new Error('Chiết khấu phải từ 0 đến 100%');
  // Đơn vị trung gian: "xu" = 1/100 đồng. price / 10^8 đồng = price / 10^6 xu.
  const taxDivisor = options.pricesIncludeTax ? PERCENT_BASE + tax : PERCENT_BASE;
  const listPrice = roundDiv(price, PERCENT_BASE);
  const override = line.unitPriceOverride === undefined || line.unitPriceOverride === '' ? null : roundDiv(toScaled(line.unitPriceOverride), 100n);
  if (override !== null && override < 0n) throw new Error('Đơn giá sửa tay không được âm');
  const listUnitPrice = override ?? roundDiv(price, taxDivisor);
  const unitPrice = override ?? roundDiv(price * (PERCENT_BASE - discount), taxDivisor * PERCENT_BASE);

  const subtotal = roundDiv(quantity * listUnitPrice, E);
  const netAmount = roundDiv(quantity * unitPrice, E);
  const discountAmount = roundDiv(quantity * (listUnitPrice - unitPrice), E);
  const taxAmount = roundDiv(quantity * unitPrice * tax, E * PERCENT_BASE);
  const grossAmount = roundDiv(quantity * unitPrice * (PERCENT_BASE + tax), E * PERCENT_BASE);
  return {
    baseQuantity,
    listPrice: fixed(listPrice, 2),
    listUnitPrice: fixed(listUnitPrice, 2),
    unitPrice: fixed(unitPrice, 2),
    subtotal: fixed(subtotal, 2),
    discountAmount: fixed(discountAmount, 2),
    netAmount: fixed(netAmount, 2),
    taxAmount: fixed(taxAmount, 2),
    grossAmount: fixed(grossAmount, 2),
  };
}

export interface DocumentTotals {
  /** Cộng tiền hàng (làm tròn tới đồng). */
  netTotal: string;
  /** Tiền thuế GTGT (làm tròn tới đồng; KCT = 0). */
  taxTotal: string;
  /** Tổng tiền thanh toán (làm tròn tới đồng). */
  grandTotal: string;
}

/** Tổng chứng từ từ Σ thành tiền chưa làm tròn (2 số lẻ). */
export function documentTotals(netAmountSum: string | number, vatRate: string): DocumentTotals {
  const net = toScaled(netAmountSum);
  const tax = toScaled(vatPercent(vatRate));
  return {
    netTotal: fixed(roundDiv(net, E), 0),
    taxTotal: fixed(roundDiv(net * tax, E * PERCENT_BASE), 0),
    grandTotal: fixed(roundDiv(net * (PERCENT_BASE + tax), E * PERCENT_BASE), 0),
  };
}

/** Tiền thuế GTGT của một dòng: thành tiền × thuế suất, làm tròn tới đồng (KCT = 0). */
export function lineTax(netAmount: string | number, vatRate: string | number | null | undefined): string {
  return fixed(roundDiv(toScaled(netAmount) * toScaled(vatPercent(vatRate)), E * PERCENT_BASE), 0);
}

/** Tổng từ thuế đã lưu trên từng dòng: cộng tiền hàng = làm tròn Σ thành tiền; tiền thuế = Σ thuế dòng; tổng = cộng hai số. */
export function linesTotals(lines: ReadonlyArray<{ netAmount: string; taxAmount: string }>): DocumentTotals {
  const net = roundDiv(lines.reduce<bigint>((sum, line) => sum + toScaled(line.netAmount), 0n), E);
  const tax = lines.reduce<bigint>((sum, line) => sum + roundDiv(toScaled(line.taxAmount), E), 0n);
  return { netTotal: fixed(net, 0), taxTotal: fixed(tax, 0), grandTotal: fixed(net + tax, 0) };
}

/**
 * Một dòng theo đơn giá chưa thuế nhập tay (phiếu giảm nợ trả hàng): tiền hàng = SL × đơn giá (làm tròn tới đồng), thuế = SL × đơn
 * giá × thuế suất (làm tròn tới đồng), thành tiền = hai số cộng lại.
 */
export function pricedLineAmounts(quantity: string | number, unitPrice: string | number, vatRate: string | number | null | undefined): { netAmount: string; taxAmount: string; amount: string } {
  const net = roundDiv(toScaled(quantity) * toScaled(unitPrice), E * 100n); // xu (2 số lẻ)
  const netDong = roundDiv(net, 100n);
  const tax = roundDiv(net * toScaled(vatPercent(vatRate)), 100n * PERCENT_BASE);
  return { netAmount: fixed(netDong, 0), taxAmount: fixed(tax, 0), amount: fixed(netDong + tax, 0) };
}

/** Thuế suất chung của phiếu: một thuế suất cho mọi dòng → thuế suất đó; nhiều thuế suất → "MIXED". */
export function commonVatRate(rates: ReadonlyArray<string>, fallback: string): string {
  const unique = [...new Set(rates)];
  return unique.length === 0 ? fallback : unique.length === 1 ? (unique[0] as string) : 'MIXED';
}

/**
 * Mẫu PXK-002 — thuế suất từng dòng, không lệch đồng nào:
 *   cộng tiền hàng   = làm tròn( Σ thành tiền )
 *   tổng thanh toán  = Σ theo thuế suất làm tròn( Σ thành tiền cùng thuế suất × (1 + thuế suất) )   ← như PXK-001, khớp bảng giá
 *   tiền thuế        = tổng thanh toán − cộng tiền hàng
 *   thuế từng dòng   = thành tiền × thuế suất làm tròn xuống, phần còn thiếu cộng 1 đồng cho dòng có phần lẻ lớn nhất
 * → Σ thuế dòng = tiền thuế, cộng tiền hàng + tiền thuế = tổng thanh toán; mỗi dòng lệch số chính xác dưới 1 đồng.
 * Dòng KCT / tặng (thành tiền 0) luôn thuế 0. Thuế dòng trả về dạng "273778.00" (đồng).
 */
export function allocateLineVat(lines: ReadonlyArray<{ netAmount: string; vatRate: string }>): DocumentTotals & { taxAmounts: string[] } {
  const nets = lines.map((line) => toScaled(line.netAmount)); // × 10^4 đồng
  const rates = lines.map((line) => toScaled(vatPercent(line.vatRate))); // × 10^4 phần trăm
  const netTotal = roundDiv(nets.reduce((sum, value) => sum + value, 0n), E);
  const groups = new Map<bigint, bigint>();
  nets.forEach((net, index) => groups.set(rates[index] as bigint, (groups.get(rates[index] as bigint) ?? 0n) + net));
  let grandTotal = 0n;
  for (const [rate, net] of groups) grandTotal += roundDiv(net * (PERCENT_BASE + rate), E * PERCENT_BASE);
  const taxTotal = grandTotal - netTotal;

  const denominator = E * PERCENT_BASE;
  const taxable = (index: number) => (nets[index] as bigint) > 0n && (rates[index] as bigint) > 0n;
  const taxes = nets.map((net, index) => (taxable(index) ? (net * (rates[index] as bigint)) / denominator : 0n));
  const eligible = nets
    .map((net, index) => ({ index, remainder: taxable(index) ? (net * (rates[index] as bigint)) % denominator : 0n }))
    .filter((item) => taxable(item.index));
  let difference = taxTotal - taxes.reduce((sum, value) => sum + value, 0n);
  if (eligible.length) {
    // Thiếu: cộng cho dòng phần lẻ lớn nhất trước; thừa: trừ ở dòng phần lẻ nhỏ nhất trước (cùng phần lẻ thì dòng trên trước).
    const up = [...eligible].sort((a, b) => (a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1));
    const down = [...up].reverse();
    for (let step = 0; difference !== 0n && step < 4 * eligible.length + 8; step += 1) {
      if (difference > 0n) {
        const target = up[step % up.length] as { index: number };
        taxes[target.index] = (taxes[target.index] as bigint) + 1n;
        difference -= 1n;
      } else {
        const target = down[step % down.length] as { index: number };
        if ((taxes[target.index] as bigint) <= 0n) continue;
        taxes[target.index] = (taxes[target.index] as bigint) - 1n;
        difference += 1n;
      }
    }
  }
  return {
    netTotal: fixed(netTotal, 0),
    taxTotal: fixed(taxTotal, 0),
    grandTotal: fixed(grandTotal, 0),
    taxAmounts: taxes.map((tax) => fixed(tax * 100n, 2)),
  };
}

export interface DocumentSummary extends DocumentTotals {
  /** Tiền hàng theo giá niêm yết chưa thuế (2 số lẻ). */
  subtotal: string;
  /** Tổng chiết khấu (2 số lẻ). */
  discountTotal: string;
  /** Σ thành tiền chưa làm tròn (2 số lẻ). */
  netAmountSum: string;
}

export function summarizeDocument(lines: ReadonlyArray<Pick<LineAmounts, 'subtotal' | 'discountAmount' | 'netAmount'>>, vatRate: string): DocumentSummary {
  const netAmountSum = sumMoney(lines.map((line) => line.netAmount));
  return {
    subtotal: sumMoney(lines.map((line) => line.subtotal)),
    discountTotal: sumMoney(lines.map((line) => line.discountAmount)),
    netAmountSum,
    ...documentTotals(netAmountSum, vatRate),
  };
}
