/**
 * Đơn mua / hợp đồng nhập hàng phía giao diện: kiểu dữ liệu API trả về, tính tiền – đóng gói tức thời
 * (cùng hàm với máy chủ: $shared/landed-cost, $shared/packing) và nhãn điều khoản.
 */
import { containerPlan, containerPlanLabel, packingLine, packingTotals } from '$shared/packing';
import { lineAmount, sumAmounts, toVnd } from '$shared/landed-cost';
import { m } from '$lib/paraglide/messages';

export interface PurchaseLine {
  productId: string;
  sku: string;
  productName: string;
  unit: string;
  quantity: string;
  baseQuantity: string;
  receivedBaseQuantity: string;
  unitCost: string;
  lineTotal: string;
  note?: string;
  packing?: { cartons: number; cbm: number; grossKg: number; netKg: number; incomplete: boolean };
  print?: { nameZh?: string; nameEn?: string; specZh?: string; specEn?: string; hsCode?: string; supplierItemCode?: string; packSize?: number; baseUnit?: string };
}

export interface SupplierPaymentRow {
  id: string;
  kind: 'DEPOSIT' | 'BALANCE' | 'OTHER';
  amount: string;
  paidOn: string;
  reference?: string;
  note?: string;
  recordedByName?: string;
}

export interface PurchaseOrderDetail {
  id: string;
  code: string;
  supplierId: string;
  supplierCode: string;
  supplierName: string;
  warehouseId: string;
  expectedDate?: string;
  note?: string;
  status: string;
  approvalStatus: string;
  currency?: string;
  exchangeRate?: string;
  incoterm?: string;
  paymentTerms?: string;
  depositPercent?: string;
  supplierContractNo?: string;
  contractDate?: string;
  portOfLoading?: string;
  portOfDischarge?: string;
  shippingMethod?: string;
  etd?: string;
  eta?: string;
  partialShipment?: boolean;
  shippingMark?: string;
  lines: PurchaseLine[];
  total: string;
  totalVnd?: string;
  packing?: { cartons: number; cbm: number; grossKg: number; netKg: number; incompleteLines: number; container: string };
  payments?: SupplierPaymentRow[];
  paidTotal?: string;
  version: number;
  createdAt: string;
}

/** Thông tin sản phẩm cần cho dòng đơn mua (danh mục /products). */
export interface PurchaseProduct {
  id: string;
  sku: string;
  name: string;
  baseUnit: string;
  barcode?: string;
  supplierItemCode?: string;
  standardCost?: string;
  listPrice: string;
  purchaseCurrency?: string;
  purchasePrice?: string;
  packSize?: number;
  cartonLengthCm?: string;
  cartonWidthCm?: string;
  cartonHeightCm?: string;
  grossKgPerCarton?: string;
  netKgPerCarton?: string;
  unitConversions: Array<{ unit: string; factorToBase: string; barcode?: string }>;
  status?: string;
}

export interface DraftLine {
  productId: string;
  sku: string;
  productName: string;
  unit: string;
  quantity: string;
  unitCost: string;
  note: string;
}

export function conversionFactor(product: PurchaseProduct | undefined, unit: string): number {
  if (!product || unit === product.baseUnit) return 1;
  return Number(product.unitConversions.find((item) => item.unit === unit)?.factorToBase ?? 1);
}

const safe = (value: string) => (/^\d+(\.\d+)?$/.test(value.trim()) ? value.trim() : '0');

export function draftLineTotal(line: DraftLine): string {
  return lineAmount(safe(line.quantity), safe(line.unitCost));
}

export function draftPacking(line: DraftLine, product: PurchaseProduct | undefined) {
  return packingLine({
    quantity: Number(safe(line.quantity)) * conversionFactor(product, line.unit),
    packSize: product?.packSize ?? product?.unitConversions.find((item) => item.unit === 'Thùng')?.factorToBase,
    cartonLengthCm: product?.cartonLengthCm,
    cartonWidthCm: product?.cartonWidthCm,
    cartonHeightCm: product?.cartonHeightCm,
    grossKgPerCarton: product?.grossKgPerCarton,
    netKgPerCarton: product?.netKgPerCarton,
  });
}

export function draftTotals(lines: DraftLine[], products: Map<string, PurchaseProduct>, currency: string, rate: string) {
  const total = sumAmounts(lines.map(draftLineTotal));
  const packing = packingTotals(lines.map((line) => {
    const product = products.get(line.productId);
    return {
      quantity: Number(safe(line.quantity)) * conversionFactor(product, line.unit),
      packSize: product?.packSize ?? product?.unitConversions.find((item) => item.unit === 'Thùng')?.factorToBase,
      cartonLengthCm: product?.cartonLengthCm,
      cartonWidthCm: product?.cartonWidthCm,
      cartonHeightCm: product?.cartonHeightCm,
      grossKgPerCarton: product?.grossKgPerCarton,
      netKgPerCarton: product?.netKgPerCarton,
    };
  }));
  const vnd = currency === 'VND' ? toVnd(total) : /^\d+(\.\d+)?$/.test(rate) && Number(rate) > 0 ? toVnd(total, rate) : null;
  return { total, vnd, packing, container: containerPlanLabel(containerPlan(packing.cbm, packing.grossKg)) };
}

/** Số tiền theo tiền tệ: VND không số lẻ, ngoại tệ 2 số lẻ kèm mã tiền. */
export function money(amount: string | number | null | undefined, currency = 'VND'): string {
  const value = Number(amount ?? 0);
  if (currency === 'VND') return `${new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 0 }).format(Math.round(value))} ₫`;
  return `${new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(value)} ${currency}`;
}

export const shippingMethodLabel = (value: string | undefined): string =>
  ({ SEA: m.po_duong_bien(), AIR: m.po_duong_hang_khong(), ROAD: m.po_duong_bo(), RAIL: m.po_duong_sat(), EXPRESS: m.po_chuyen_phat() })[value ?? ''] ?? '—';
export const paymentKindLabel = (value: string): string => ({ DEPOSIT: m.po_dat_coc(), BALANCE: m.po_thanh_toan_con_lai(), OTHER: m.po_khac() })[value] ?? value;
