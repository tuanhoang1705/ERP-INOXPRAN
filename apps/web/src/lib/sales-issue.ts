import { m } from '$lib/paraglide/messages';
import { intlLocale } from '$lib/i18n';
/**
 * Tính toán tức thời cho form "Phiếu xuất kho bán hàng": mọi con số trên form (đơn giá, thành tiền, cộng tiền hàng,
 * tiền thuế, tổng thanh toán, tồn sau xuất, hạn mức) được tính ngay trên trình duyệt từ bảng giá của khách,
 * bằng đúng hàm priceLine()/summarizeDocument() máy chủ dùng khi lưu chứng từ — không chờ mạng, không lệch số.
 */
import type { SalesPriceSheet, SalesPriceSheetItem } from '@inoxpran/contracts';
import { priceLine, summarizeDocument, toScaled, type DocumentSummary, type LineAmounts } from '$shared/sales-math';

export interface IssueProduct {
  id: string;
  sku: string;
  baseUnit: string;
  unitConversions: Array<{ unit: string; factorToBase: string }>;
}

export interface IssueLineInput {
  productId: string;
  unit: string;
  quantity: string | number | null | undefined;
  gift: boolean;
  /** Đơn giá chưa thuế sửa tay (đã được cấp quyền) cho 1 đơn vị bán; bỏ trống = giá theo bảng giá. */
  overrideUnitPrice?: string | undefined;
}

export interface ComputedLine extends LineAmounts {
  index: number;
  productId: string;
  quantity: string;
  conversionFactor: string;
  basis: SalesPriceSheetItem;
  /** CK tổng áp cho dòng (hàng tặng = 0, dòng sửa giá = 0). */
  discountRate: string;
  /** Dòng đang dùng đơn giá sửa tay. */
  overridden: boolean;
  /** Đơn giá chưa thuế theo bảng giá (để so với giá sửa tay). */
  originalUnitPrice: string;
}

export interface StockWarning {
  productId: string;
  tone: 'error' | 'warning';
  text: string;
}

export interface IssueComputation {
  /** Theo đúng vị trí dòng trên form; null = dòng chưa đủ dữ liệu để tính. */
  lines: Array<ComputedLine | null>;
  /** Lỗi nhập theo vị trí dòng (số lượng sai…). */
  lineErrors: Array<string | null>;
  summary: DocumentSummary;
  /** Tổng số lượng cần xuất (đơn vị cơ sở) theo mã, gồm cả hàng tặng. */
  demandByProduct: Map<string, number>;
  stockWarnings: StockWarning[];
  /** Hạn mức còn lại sau phiếu (null với khách lẻ trả ngay). */
  creditRemainingAfter: number | null;
  needsApproval: { overThreshold: boolean; overCredit: boolean };
  /** Có dòng đã chọn hàng nhưng chưa có trong bảng giá (đang tải). */
  pending: boolean;
}

/** Hệ số quy đổi đơn vị bán → đơn vị cơ sở. */
export function conversionFactor(product: IssueProduct, unit: string): string | null {
  if (unit === product.baseUnit) return '1';
  return product.unitConversions.find((item) => item.unit === unit)?.factorToBase ?? null;
}

/** Chuẩn hóa số lượng nhập: chuỗi số dương tối đa 4 số lẻ; trả về lỗi nếu không hợp lệ. */
export function normalizeQuantity(value: string | number | null | undefined): { quantity: string | null; error: string | null } {
  if (value === null || value === undefined || value === '') return { quantity: null, error: null };
  const text = typeof value === 'number' ? (Number.isFinite(value) ? String(value) : '') : value.trim().replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(text)) return { quantity: null, error: m.so_luong_khong_hop_le() };
  if (/\.\d{5,}$/.test(text)) return { quantity: null, error: m.so_luong_toi_da_4_chu() };
  if (toScaled(text) <= 0n) return { quantity: null, error: null };
  return { quantity: text, error: null };
}

const fmt = (value: number) => new Intl.NumberFormat(intlLocale(), { maximumFractionDigits: 4 }).format(value);

export function computeIssue(
  inputs: readonly IssueLineInput[],
  products: ReadonlyMap<string, IssueProduct>,
  sheet: SalesPriceSheet | null,
  vatRate: string,
): IssueComputation {
  const basisById = new Map((sheet?.items ?? []).map((item) => [item.productId, item]));
  const lines: Array<ComputedLine | null> = [];
  const lineErrors: Array<string | null> = [];
  let pending = false;

  inputs.forEach((input, index) => {
    const product = products.get(input.productId);
    const { quantity, error } = normalizeQuantity(input.quantity);
    lineErrors.push(product ? error : null);
    const basis = basisById.get(input.productId);
    const factor = product ? conversionFactor(product, input.unit) : null;
    if (product && !basis) pending = true;
    if (!product || !basis || !factor || !quantity || !sheet) {
      lines.push(null);
      return;
    }
    const overridden = !input.gift && Boolean(input.overrideUnitPrice) && Number(input.overrideUnitPrice) > 0;
    const discountRate = input.gift || overridden ? '0' : basis.discountRate;
    const options = { vatRate, pricesIncludeTax: sheet.pricesIncludeTax };
    const original = priceLine({ quantity, conversionFactor: factor, baseUnitPrice: basis.baseUnitPrice, discountRate: input.gift ? '0' : basis.discountRate, gift: input.gift }, options);
    const amounts = overridden
      ? priceLine({ quantity, conversionFactor: factor, baseUnitPrice: basis.baseUnitPrice, discountRate: '0', unitPriceOverride: input.overrideUnitPrice }, options)
      : original;
    lines.push({ ...amounts, index, productId: input.productId, quantity, conversionFactor: factor, basis, discountRate, overridden, originalUnitPrice: original.unitPrice });
  });

  const computed = lines.filter((line): line is ComputedLine => line !== null);
  const summary = summarizeDocument(computed, vatRate);

  const demandByProduct = new Map<string, number>();
  for (const line of computed) demandByProduct.set(line.productId, (demandByProduct.get(line.productId) ?? 0) + Number(line.baseQuantity));

  const stockWarnings: StockWarning[] = [];
  for (const [productId, demand] of demandByProduct) {
    const basis = basisById.get(productId);
    if (!basis) continue;
    const available = Number(basis.available);
    const minimum = Number(basis.minimumStock);
    if (demand > available) {
      stockWarnings.push({ productId, tone: 'error', text: m.can_xuat_ke_ca_hang_tang({ sku: basis.sku, p1: fmt(demand), p2: fmt(available) }) });
    } else if (minimum > 0 && available - demand <= minimum) {
      stockWarnings.push({ productId, tone: 'warning', text: m.sau_khi_xuat_con_cham_dinh({ sku: basis.sku, p1: fmt(available - demand), p2: fmt(minimum) }) });
    }
  }

  const grandTotal = Number(summary.grandTotal);
  // Khách lẻ hoặc hạn mức 0 (không cấp công nợ): thanh toán ngay, không xét vượt hạn mức — cùng quy tắc approval.engine.ts.
  const noCredit = sheet?.customer.tier === 'RETAIL' || Number(sheet?.customer.creditLimit ?? 0) <= 0;
  const creditRemainingAfter = sheet && !noCredit ? Number(sheet.customer.creditLimit) - Number(sheet.customer.exposure) - grandTotal : null;
  return {
    lines,
    lineErrors,
    summary,
    demandByProduct,
    stockWarnings,
    creditRemainingAfter,
    needsApproval: {
      overThreshold: Boolean(sheet) && computed.length > 0 && grandTotal >= Number(sheet?.approvalThreshold ?? Infinity),
      overCredit: creditRemainingAfter !== null && computed.length > 0 && creditRemainingAfter < 0,
    },
    pending,
  };
}
