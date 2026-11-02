import { m } from '$lib/paraglide/messages';
import { intlLocale } from '$lib/i18n';
/**
 * Tính toán tức thời cho form "Phiếu xuất kho bán hàng": mọi con số trên form (đơn giá, thành tiền, cộng tiền hàng,
 * tiền thuế, tổng thanh toán, tồn sau xuất, hạn mức) được tính ngay trên trình duyệt từ bảng giá của khách,
 * bằng đúng hàm priceLine()/summarizeDocument() máy chủ dùng khi lưu chứng từ — không chờ mạng, không lệch số.
 */
import type { SalesPriceSheet, SalesPriceSheetItem } from '@inoxpran/contracts';
import { allocateLineVat, priceLine, sumMoney, summarizeDocument, toScaled, type DocumentSummary, type LineAmounts } from '$shared/sales-math';
import { isZeroPriceLine, type ZeroPriceKind } from '$shared/sales-line-kind';

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
  zeroPriceKind?: ZeroPriceKind | undefined;
  /** Đơn giá chưa thuế sửa tay (đã được cấp quyền) cho 1 đơn vị bán; bỏ trống = giá theo bảng giá. */
  overrideUnitPrice?: string | undefined;
  /** Thuế suất GTGT của dòng — chỉ mẫu PXK-002 (thuế từng dòng, 27/10/2026); trống = thuế suất của phiếu. */
  vatRate?: string | undefined;
}

export interface ComputedLine extends LineAmounts {
  index: number;
  /** Thuế suất GTGT dùng để tính dòng. */
  vatRate: string;
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
  /** Thuế suất của phiếu (PXK-001) / mặc định cho dòng chưa chọn thuế suất (PXK-002). */
  vatRate: string,
  /** DOCUMENT = PXK-001 (một thuế suất cho cả phiếu); LINE = PXK-002 (thuế từng dòng, chia không lệch đồng). */
  vatMode: 'DOCUMENT' | 'LINE' = 'DOCUMENT',
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
    const gift = isZeroPriceLine(input);
    const overridden = !gift && Boolean(input.overrideUnitPrice) && Number(input.overrideUnitPrice) >= 0;
    const discountRate = gift || overridden ? '0' : basis.discountRate;
    const lineRate = vatMode === 'LINE' ? input.vatRate || vatRate : vatRate;
    const options = { vatRate: lineRate, pricesIncludeTax: sheet.pricesIncludeTax };
    const original = priceLine({ quantity, conversionFactor: factor, baseUnitPrice: basis.baseUnitPrice, discountRate: gift ? '0' : basis.discountRate, gift }, options);
    const amounts = overridden
      ? priceLine({ quantity, conversionFactor: factor, baseUnitPrice: basis.baseUnitPrice, discountRate: '0', unitPriceOverride: input.overrideUnitPrice }, options)
      : original;
    lines.push({ ...amounts, index, vatRate: lineRate, productId: input.productId, quantity, conversionFactor: factor, basis, discountRate, overridden, originalUnitPrice: original.unitPrice });
  });

  const computed = lines.filter((line): line is ComputedLine => line !== null);
  // Cùng cách máy chủ tính (pricing.service): PXK-001 thuế một lần cho cả phiếu; PXK-002 chia thuế về dòng (allocateLineVat).
  let summary: DocumentSummary;
  if (vatMode === 'LINE') {
    const allocation = allocateLineVat(computed.map((line) => ({ netAmount: line.netAmount, vatRate: line.vatRate })));
    computed.forEach((line, position) => {
      line.taxAmount = allocation.taxAmounts[position] as string;
      line.grossAmount = sumMoney([line.netAmount, line.taxAmount]);
    });
    summary = {
      subtotal: sumMoney(computed.map((line) => line.subtotal)),
      discountTotal: sumMoney(computed.map((line) => line.discountAmount)),
      netAmountSum: sumMoney(computed.map((line) => line.netAmount)),
      netTotal: allocation.netTotal,
      taxTotal: allocation.taxTotal,
      grandTotal: allocation.grandTotal,
    };
  } else summary = summarizeDocument(computed, vatRate);

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
  // Bảng của phiếu hàng mẫu / kiểm định không có khách → không xét hạn mức.
  const customer = sheet?.customer;
  const noCredit = !customer || customer.tier === 'RETAIL' || Number(customer.creditLimit ?? 0) <= 0;
  const creditRemainingAfter = customer && !noCredit ? Number(customer.creditLimit) - Number(customer.exposure) - grandTotal : null;
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
