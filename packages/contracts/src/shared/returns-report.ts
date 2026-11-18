/**
 * Báo cáo Doanh số & hàng trả (RPT-RET-01, 18/11/2026): hàng khách trả về được tách theo việc đã giảm công nợ hay chưa.
 * - A  = doanh số giao (phiếu BH bán đã giao, theo ngày giao, gồm VAT — trùng "Doanh thu" trang chủ).
 * - B  = hàng khách trả (phiếu NK khách trả chưa hủy, theo ngày nhận hàng) = B1 + B2 + B3.
 * - B1 = đã giảm công nợ (kế toán lập phiếu giảm nợ "Trả hàng") — giá trị = số tiền đã ghi giảm.
 * - B2 = kế toán xác nhận không giảm công nợ (đổi hàng, bảo hành…) — giá trị theo phiếu BH gốc.
 * - B3 = hàng đã về kho, chờ kế toán xử lý — giá trị theo phiếu BH gốc.
 * Hàng tặng / combo trả lại không tính tiền (chỉ đếm số lượng). Phiếu trả không có phiếu BH gốc và chưa được kế toán định giá
 * thì "chưa định giá" (đếm số phiếu, không cộng tiền).
 */

/** Trạng thái công nợ của một phiếu NK khách trả. NO_MONEY = hàng tặng trả lại / phiếu 0 đ, không phải điều chỉnh công nợ. */
export type ReturnDebtState = 'CREDITED' | 'NOT_CREDITED' | 'PENDING' | 'NO_MONEY';
export const RETURN_DEBT_STATES: readonly ReturnDebtState[] = ['CREDITED', 'NOT_CREDITED', 'PENDING', 'NO_MONEY'];

/** Xếp loại khách theo tỷ lệ trả trong khoảng xem. */
export type ReturnRating = 'NORMAL' | 'WATCH' | 'WARNING' | 'HIGH_RISK';
/** Đánh giá tỷ lệ trả toàn công ty theo tháng. */
export type ReturnMonthTone = 'OK' | 'WATCH' | 'OVER';
/** Ô của bảng "theo tháng bán": đã hết khoảng thời gian / đang tính / chưa đến. */
export type ReturnBucketState = 'DONE' | 'RUNNING' | 'NOT_YET';
/** Khoảng xem của các tab Theo khách hàng / mã hàng / NVKD. */
export type ReturnsScope = 'month' | '90' | '180';
export const RETURNS_SCOPES: readonly ReturnsScope[] = ['month', '90', '180'];

/** Ngưỡng ban đầu (đề xuất 18/11/2026) — chốt lại sau 2–3 tháng có số liệu thật. Đơn vị: %. */
export const RETURN_THRESHOLDS = {
  /** Toàn công ty theo tháng: ≤ 6% đạt, ≤ 9% theo dõi, trên 9% vượt ngưỡng. */
  company: { ok: 6, watch: 9 },
  /** Từng khách: dưới 5% bình thường, 5–10% theo dõi, trên 10% cảnh báo. */
  customer: { watch: 5, warning: 10 },
  /** Rủi ro cao: trên 10% và (quá hạn trên 60 ngày hoặc trả nợ bằng hàng trên 30%). */
  highRisk: { overdueDays: 60, debtByReturns: 30 },
  /** Phiếu NK chờ kế toán quá số ngày này thì báo đỏ. */
  pendingDays: 7,
} as const;

/** Khoảng ngày của bảng theo tháng bán: 0–30, 31–60, 61–90, trên 90 ngày sau ngày giao. */
export const RETURN_LAG_BUCKETS: ReadonlyArray<{ from: number; to: number | null }> = [
  { from: 0, to: 30 },
  { from: 31, to: 60 },
  { from: 61, to: 90 },
  { from: 91, to: null },
];

export function returnLagBucket(days: number): number {
  const index = RETURN_LAG_BUCKETS.findIndex((bucket) => bucket.to === null || days <= bucket.to);
  return index < 0 ? RETURN_LAG_BUCKETS.length - 1 : index;
}

export function returnMonthTone(rate: number | null): ReturnMonthTone | null {
  if (rate === null) return null;
  if (rate <= RETURN_THRESHOLDS.company.ok) return 'OK';
  if (rate <= RETURN_THRESHOLDS.company.watch) return 'WATCH';
  return 'OVER';
}

/**
 * Xếp loại khách. Không có doanh số trong khoảng xem mà vẫn trả hàng (trả hàng mua từ trước) = coi như tỷ lệ trên ngưỡng cảnh báo.
 * Không có hàng trả = bình thường.
 */
export function customerReturnRating(input: { rate: number | null; returns: number; maxDaysOverdue: number; debtByReturns: number | null }): ReturnRating {
  if (!(input.returns > 0)) return 'NORMAL';
  const rate = input.rate ?? Number.POSITIVE_INFINITY;
  if (rate > RETURN_THRESHOLDS.customer.warning) {
    const risky = input.maxDaysOverdue > RETURN_THRESHOLDS.highRisk.overdueDays
      || (input.debtByReturns !== null && input.debtByReturns > RETURN_THRESHOLDS.highRisk.debtByReturns);
    return risky ? 'HIGH_RISK' : 'WARNING';
  }
  if (rate >= RETURN_THRESHOLDS.customer.watch) return 'WATCH';
  return 'NORMAL';
}

/** Giá trị hàng trả tách theo công nợ (chuỗi số tiền, đồng). */
export interface ReturnsSplit {
  total: string;
  credited: string;
  notCredited: string;
  pending: string;
  /** Số phiếu NK (kể cả hàng tặng trả lại). */
  slips: number;
  creditedSlips: number;
  notCreditedSlips: number;
  pendingSlips: number;
  /** Phiếu chưa định giá (không có phiếu BH gốc, chưa được kế toán xử lý). */
  unvaluedSlips: number;
  /** Số lượng hàng tặng / combo trả lại (không tính tiền). */
  giftQuantity: string;
}

export interface ReturnsReportMonth {
  key: string;
  label: string;
  partial: boolean;
  sales: string;
  salesOrders: number;
  returns: ReturnsSplit;
  rate: number | null;
  tone: ReturnMonthTone | null;
  /** A − B1. */
  netSales: string;
  /** Thu tiền theo ngày thu (không gồm cước vận chuyển, giảm nợ trả hàng, bù trừ). */
  collected: string;
  /** Giảm nợ do trả hàng theo ngày ghi sổ công nợ. */
  returnCredits: string;
  /** returnCredits ÷ (collected + returnCredits), %. */
  debtByReturns: number | null;
}

export interface ReturnsReportCustomer {
  customerId: string;
  code: string;
  name: string;
  tier: string;
  regionName: string;
  salesRepName?: string;
  sales: string;
  returns: string;
  rate: number | null;
  slow: string;
  defect: string;
  credited: string;
  /** B2 + B3. */
  notCredited: string;
  pending: string;
  unvaluedSlips: number;
  slips: number;
  collected: string;
  returnCredits: string;
  debtByReturns: number | null;
  /** Dư nợ hiện tại (như hồ sơ khách). */
  outstanding: string;
  maxDaysOverdue: number;
  rating: ReturnRating;
}

export interface ReturnsReportProduct {
  productId: string;
  sku: string;
  name: string;
  unit: string;
  soldQuantity: string;
  returnedQuantity: string;
  rate: number | null;
  mainCategory: string;
  byCategory: Record<string, string>;
}

export interface ReturnsReportRep {
  id: string | null;
  name: string;
  customers: number;
  sales: string;
  returns: string;
  rate: number | null;
  credited: string;
  pending: string;
  slips: number;
}

export interface ReturnsReportCohortRow {
  key: string;
  label: string;
  sales: string;
  buckets: Array<{ value: string; rate: number | null; state: ReturnBucketState }>;
  returned: string;
  returnedRate: number | null;
  /** 100 − returnedRate; null khi tháng chưa có doanh số. */
  kept: number | null;
  /** Còn khoảng thời gian đang tính (số có thể tăng). */
  running: boolean;
}

export interface ReturnsReport {
  month: { key: string; label: string; from: string; to: string; partial: boolean };
  window: { scope: ReturnsScope; from: string; to: string; label: string };
  generatedAt: string;
  filters: { region?: string; salesRepId?: string; tier?: string; category?: string };
  summary: ReturnsReportMonth & {
    previousRate: number | null;
    /** A − B1 − B3: nếu phần chờ kế toán đều được giảm nợ. */
    expectedNetSales: string;
    /** Phiếu chờ kế toán (nhận trước cuối tháng) quá RETURN_THRESHOLDS.pendingDays ngày tính đến hôm nay. */
    pendingOverdueSlips: number;
  };
  months: ReturnsReportMonth[];
  warehouses: Array<{ id: string; name: string; defective: boolean; total: string; credited: string; notCredited: string; pending: string; slips: number }>;
  reasons: Array<{ category: string; value: string; quantity: string; slips: number; share: number | null }>;
  ledger: {
    opening: string;
    /** Phát sinh nợ trong tháng (chứng từ phải thu mới − chứng từ hủy trong tháng). */
    debits: string;
    collected: string;
    returnCredits: string;
    freight: string;
    /** Phần chênh còn lại (bình thường = 0): closing − (opening + debits − collected − returnCredits − freight). */
    other: string;
    closing: string;
    /** Phiếu NK nhận đến cuối tháng còn chờ kế toán (tính đến hôm nay). */
    pendingValue: string;
    pendingSlips: number;
    pendingOverdueSlips: number;
    /** closing − pendingValue. */
    expectedClosing: string;
    debtByReturns: number | null;
  };
  customers: ReturnsReportCustomer[];
  products: ReturnsReportProduct[];
  reps: ReturnsReportRep[];
  cohort: {
    rows: ReturnsReportCohortRow[];
    /** Phiếu trả không có phiếu BH gốc (hàng bán trước ERP) nhận trong 6 tháng — không xếp được tháng bán. */
    unlinkedValue: string;
    unlinkedSlips: number;
    lag: Array<{ value: string; share: number | null }>;
    lagTotal: string;
    medianDays: number | null;
  };
}

/** Một phiếu NK trong danh sách bấm xem từ báo cáo. */
export interface ReturnsReportSlip {
  id: string;
  code: string;
  receivedAt: string;
  customerId: string;
  customerCode: string;
  customerName: string;
  salesOrderCode?: string;
  salesOrderId?: string;
  preErpSalesCode?: string;
  deliveredAt?: string;
  days?: number;
  category: string;
  warehouseName: string;
  defective: boolean;
  /** null = chưa định giá. */
  value: string | null;
  state: ReturnDebtState;
  creditCode?: string;
  creditPostedOn?: string;
  pendingDays?: number;
  salesRepName?: string;
  note: string;
}
