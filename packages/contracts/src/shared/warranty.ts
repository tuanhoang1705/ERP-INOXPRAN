/**
 * Quy tắc bảo hành INOXPRAN, dùng chung cho API và giao diện (thuần TypeScript, không phụ thuộc thư viện).
 * Chốt ngày 03/10/2026: bảo hành 12 tháng cho mọi sản phẩm; bắt buộc có hóa đơn (ngày bắt đầu = ngày hóa đơn);
 * hẹn trả mặc định 7 ngày; chuyển vàng khi đã qua 70% thời gian hẹn, chuyển đỏ khi quá ngày hẹn.
 */

export const WARRANTY_DEFAULTS = { warrantyMonths: 12, turnaroundDays: 7, warningRatio: 0.7 } as const;

export const WARRANTY_STATUSES = [
  'RECEIVED',
  'QUOTE_PENDING',
  'PENDING_APPROVAL',
  'REPAIRING',
  'WAITING_PARTS',
  'TESTING',
  'READY',
  'RETURNED',
  'CANCELLED',
] as const;
export type WarrantyStatus = (typeof WARRANTY_STATUSES)[number];
export const CLOSED_WARRANTY_STATUSES: readonly WarrantyStatus[] = ['RETURNED', 'CANCELLED'];

export const WARRANTY_COVERAGES = ['IN_WARRANTY', 'OUT_OF_WARRANTY', 'NOT_COVERED'] as const;
export type WarrantyCoverage = (typeof WARRANTY_COVERAGES)[number];

/** Lý do không thuộc diện bảo hành. NO_INVOICE do hệ thống tự gán khi không có hóa đơn. */
export const WARRANTY_EXCLUSIONS = ['NO_INVOICE', 'PHYSICAL_DAMAGE', 'ELECTRICAL', 'LIQUID', 'UNAUTHORIZED_REPAIR', 'MISUSE', 'OTHER'] as const;
export type WarrantyExclusion = (typeof WARRANTY_EXCLUSIONS)[number];

/** Hướng xử lý sau khi kiểm tra. REJECT / EXCHANGE / REFUND cần Giám đốc duyệt. */
export const WARRANTY_PLANS = ['REPAIR', 'QUOTE', 'REJECT', 'EXCHANGE', 'REFUND'] as const;
export type WarrantyPlan = (typeof WARRANTY_PLANS)[number];
export const PLANS_NEEDING_APPROVAL: readonly WarrantyPlan[] = ['REJECT', 'EXCHANGE', 'REFUND'];

export const WARRANTY_RESOLUTIONS = ['REPAIRED', 'PART_REPLACED', 'EXCHANGED', 'REFUNDED', 'REJECTED', 'RETURNED_UNREPAIRED'] as const;
export type WarrantyResolution = (typeof WARRANTY_RESOLUTIONS)[number];

export const WARRANTY_CHANNELS = ['DEALER', 'WALK_IN', 'ONSITE'] as const;
export type WarrantyChannel = (typeof WARRANTY_CHANNELS)[number];

/** Thao tác hợp lệ theo trạng thái (giao diện hiện nút, API kiểm tra lại). */
export const WARRANTY_ACTIONS_BY_STATUS: Record<WarrantyStatus, readonly string[]> = {
  RECEIVED: ['DIAGNOSE', 'RESCHEDULE', 'CANCEL'],
  QUOTE_PENDING: ['QUOTE_DECISION', 'RESCHEDULE', 'CANCEL'],
  PENDING_APPROVAL: ['APPROVE', 'RESCHEDULE'],
  REPAIRING: ['WAIT_PARTS', 'REPAIR_DONE', 'RESCHEDULE'],
  WAITING_PARTS: ['PARTS_ARRIVED', 'RESCHEDULE'],
  TESTING: ['TEST', 'RESCHEDULE'],
  READY: ['RETURN'],
  RETURNED: [],
  CANCELLED: [],
};

/** Từ lần bảo hành thứ 3 trong thời hạn mà vẫn lỗi: đề xuất đổi mới / hoàn tiền (Luật 19/2023, Điều 30 khoản 2 điểm đ). */
export const REPEAT_REPAIR_THRESHOLD = 3;

/** Ảnh trên phiếu bảo hành: tình trạng khi nhận, phiếu đã ký khi trả, ảnh khác (linh kiện thay, hóa đơn...). */
export const WARRANTY_PHOTO_KINDS = ['RECEIPT', 'SIGNED_FORM', 'OTHER'] as const;
export type WarrantyPhotoKind = (typeof WARRANTY_PHOTO_KINDS)[number];
export const MAX_WARRANTY_PHOTOS = 12;

/** Kết quả đổi / hoàn: hàng lỗi khách trả nhập vào kho hàng lỗi (chờ trả nhà cung cấp / hủy). */
export const RESOLUTIONS_RETURNING_DEFECT: readonly WarrantyResolution[] = ['EXCHANGED', 'REFUNDED'];

const DAY_MS = 86_400_000;
const VN_OFFSET_MS = 7 * 3_600_000;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export function isDateOnly(value: unknown): value is string {
  return typeof value === 'string' && DATE_ONLY.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

/** Ngày YYYY-MM-DD theo giờ Việt Nam. */
export function vnDate(at: Date): string {
  return new Date(at.getTime() + VN_OFFSET_MS).toISOString().slice(0, 10);
}

/** Thời điểm kết thúc ngày (23:59:59.999 giờ Việt Nam). */
export function endOfVnDay(day: string): Date {
  return new Date(Date.parse(`${day}T00:00:00Z`) - VN_OFFSET_MS + DAY_MS - 1);
}

export function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Cộng tháng; ngày không có ở tháng đích (VD 31/01 + 1 tháng) lùi về ngày cuối tháng. */
export function addMonths(day: string, months: number): string {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  const targetMonthIndex = month - 1 + months;
  const targetYear = year + Math.floor(targetMonthIndex / 12);
  const targetMonth = ((targetMonthIndex % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  return new Date(Date.UTC(targetYear, targetMonth, Math.min(date, lastDay))).toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

/**
 * Ngày hết bảo hành (hết ngày này vẫn còn bảo hành). Thời hạn tính bằng tháng kết thúc vào ngày tương ứng của tháng
 * cuối (Bộ luật Dân sự 2015, Điều 147–148): hóa đơn 03/10/2026, 12 tháng → hết ngày 03/10/2027.
 * Cộng thêm số ngày các lần bảo hành trước vì thời gian thực hiện bảo hành không tính vào thời hạn (Luật 19/2023, Điều 30).
 */
export function warrantyExpiry(startDate: string, months: number, extensionDays = 0): string {
  return addDays(addMonths(startDate, months), extensionDays);
}

export interface CoverageInput {
  invoiceDate?: string | null;
  receivedDate: string;
  months?: number;
  extensionDays?: number;
}

export interface CoverageResult {
  coverage: WarrantyCoverage;
  exclusion?: WarrantyExclusion;
  startsOn?: string;
  expiresOn?: string;
}

/** Bắt buộc có hóa đơn mới được bảo hành; có hóa đơn thì so ngày tiếp nhận với ngày hết bảo hành. */
export function coverageFor(input: CoverageInput): CoverageResult {
  if (!input.invoiceDate) return { coverage: 'NOT_COVERED', exclusion: 'NO_INVOICE' };
  const expiresOn = warrantyExpiry(input.invoiceDate, input.months ?? WARRANTY_DEFAULTS.warrantyMonths, input.extensionDays ?? 0);
  return { coverage: input.receivedDate <= expiresOn ? 'IN_WARRANTY' : 'OUT_OF_WARRANTY', startsOn: input.invoiceDate, expiresOn };
}

/** Số ngày bảo hành còn lại tính tới một ngày (âm = đã hết). */
export function remainingWarrantyDays(expiresOn: string, onDate: string): number {
  return daysBetween(onDate, expiresOn);
}

export type SlaTone = 'normal' | 'warning' | 'overdue' | 'closed';

export interface SlaInput {
  receivedAt: Date | string;
  promisedDate: string;
  now: Date;
  closedAt?: Date | string | null;
  warningRatio?: number;
}

export interface SlaState {
  tone: SlaTone;
  /** Tỉ lệ thời gian hẹn đã trôi qua (0–1+). */
  elapsedRatio: number;
  dueAt: Date;
  warningAt: Date;
  /** Số ngày còn lại tới hạn (làm tròn lên); 0 khi đã quá hạn. */
  daysLeft: number;
  /** Số ngày trễ (đang quá hạn, hoặc lúc trả khách). */
  lateDays: number;
}

/**
 * Màu phiếu theo hẹn trả: không màu khi chưa qua 70% thời gian hẹn, vàng khi đã qua 70%, đỏ khi quá cuối ngày hẹn.
 * Thời gian hẹn tính từ lúc tiếp nhận tới hết ngày hẹn trả (giờ Việt Nam).
 */
export function slaState(input: SlaInput): SlaState {
  const start = new Date(input.receivedAt).getTime();
  const dueAt = endOfVnDay(input.promisedDate);
  const window = Math.max(dueAt.getTime() - start, 1);
  const ratio = input.warningRatio ?? WARRANTY_DEFAULTS.warningRatio;
  const warningAt = new Date(start + window * ratio);
  if (input.closedAt) {
    const closed = new Date(input.closedAt).getTime();
    return { tone: 'closed', elapsedRatio: (closed - start) / window, dueAt, warningAt, daysLeft: 0, lateDays: Math.max(0, Math.ceil((closed - dueAt.getTime()) / DAY_MS)) };
  }
  const now = input.now.getTime();
  const elapsedRatio = (now - start) / window;
  if (now > dueAt.getTime()) {
    return { tone: 'overdue', elapsedRatio, dueAt, warningAt, daysLeft: 0, lateDays: Math.ceil((now - dueAt.getTime()) / DAY_MS) };
  }
  return {
    tone: elapsedRatio >= ratio ? 'warning' : 'normal',
    elapsedRatio,
    dueAt,
    warningAt,
    daysLeft: Math.ceil((dueAt.getTime() - now) / DAY_MS),
    lateDays: 0,
  };
}

/** Số ngày giữ máy của một lần bảo hành (cộng vào thời hạn bảo hành cho các lần sau). */
export function serviceDays(receivedAt: Date | string, returnedAt: Date | string): number {
  return Math.max(0, daysBetween(vnDate(new Date(receivedAt)), vnDate(new Date(returnedAt))));
}
