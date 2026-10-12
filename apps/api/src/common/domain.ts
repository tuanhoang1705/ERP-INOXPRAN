import { BadRequestException } from '@nestjs/common';
import { Decimal128, ObjectId, type Document } from 'mongodb';

export function toObjectId(value: string, fieldName = 'id'): ObjectId {
  if (!ObjectId.isValid(value)) {
    throw new BadRequestException({ code: 'INVALID_OBJECT_ID', message: `${fieldName} không hợp lệ` });
  }
  return new ObjectId(value);
}

export function decimal(value: string | number): Decimal128 {
  return Decimal128.fromString(String(value));
}

export function decimalString(value: unknown): string {
  if (value instanceof Decimal128) return value.toString();
  if (typeof value === 'number' || typeof value === 'string') return String(value);
  return '0';
}

export function serializeDocument<T extends Document>(document: T): Record<string, unknown> {
  const convert = (value: unknown): unknown => {
    if (value instanceof ObjectId) return value.toHexString();
    if (value instanceof Decimal128) return value.toString();
    if (value instanceof Date) return value.toISOString();
    if (Array.isArray(value)) return value.map(convert);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, convert(item)]));
    }
    return value;
  };

  const converted = convert(document) as Record<string, unknown>;
  if ('_id' in converted) {
    converted.id = converted._id;
    delete converted._id;
  }
  return converted;
}

/** Asia/Ho_Chi_Minh không có giờ mùa hè nên lệch cố định +7 giờ so với UTC. */
const VN_OFFSET_MS = 7 * 60 * 60 * 1000;

export function vnParts(date: Date): { year: number; month: number; day: number } {
  const shifted = new Date(date.getTime() + VN_OFFSET_MS);
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
}

/** Thời điểm 00:00 giờ Việt Nam của ngày đầu tháng, biểu diễn bằng UTC. `month` tính từ 1 và có thể tràn năm. */
export function vnMonthStart(year: number, month: number): Date {
  return new Date(Date.UTC(year, month - 1, 1) - VN_OFFSET_MS);
}

export function vnDayStart(date: Date): Date {
  const { year, month, day } = vnParts(date);
  return new Date(Date.UTC(year, month - 1, day) - VN_OFFSET_MS);
}

/** Đầu quý hiện tại theo giờ Việt Nam. */
export function vnQuarterStart(date: Date): { start: Date; label: string } {
  const { year, month } = vnParts(date);
  const quarter = Math.floor((month - 1) / 3);
  return { start: vnMonthStart(year, quarter * 3 + 1), label: `Quý ${quarter + 1}/${year}` };
}

/**
 * Cửa sổ tính doanh số lũy kế cho chiết khấu bậc (Giải thuật 2).
 * QUARTER: từ đầu quý hiện tại; ROLLING_90D: 90 ngày gần nhất (tránh "rơi bậc" đột ngột đầu quý).
 */
export function salesTierWindow(period: unknown, now = new Date()): { start: Date; label: string } {
  if (period === 'ROLLING_90D') {
    return { start: new Date(vnDayStart(now).getTime() - 89 * 86_400_000), label: '90 ngày gần nhất' };
  }
  return vnQuarterStart(now);
}
