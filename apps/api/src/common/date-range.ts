import { BadRequestException } from '@nestjs/common';
import { isDateOnly } from '@inoxpran/contracts';
import type { Document } from 'mongodb';

/**
 * Lọc danh sách theo khoảng ngày (LIST-DATE-01, 15/10/2026): `from` / `to` dạng YYYY-MM-DD theo giờ Việt Nam, tính trọn ngày
 * (từ 00:00 ngày `from` tới hết 23:59:59 ngày `to`). Bỏ trống một đầu = không giới hạn đầu đó. Sai dạng hoặc `from` > `to` → 400.
 */
export interface DateBounds {
  $gte?: Date;
  $lt?: Date;
}

const DAY_MS = 86_400_000;

export function vnDayBegin(day: string): Date {
  return new Date(`${day}T00:00:00+07:00`);
}

export function dateBounds(from?: string, to?: string): DateBounds | null {
  const start = from ? from.trim() : '';
  const end = to ? to.trim() : '';
  for (const [key, value] of [['from', start], ['to', end]] as const) {
    if (value && !isDateOnly(value)) {
      throw new BadRequestException({ code: 'DATE_RANGE_INVALID', message: 'Ngày lọc phải có dạng YYYY-MM-DD', details: [{ path: [key] }] });
    }
  }
  if (start && end && start > end) {
    throw new BadRequestException({ code: 'DATE_RANGE_INVALID', message: 'Từ ngày phải trước hoặc bằng đến ngày', details: [{ path: ['from'] }] });
  }
  if (!start && !end) return null;
  return {
    ...(start ? { $gte: vnDayBegin(start) } : {}),
    ...(end ? { $lt: new Date(vnDayBegin(end).getTime() + DAY_MS) } : {}),
  };
}

/** `{ [field]: { $gte, $lt } }` hoặc `{}` khi không lọc ngày — trộn thẳng vào bộ lọc Mongo. */
export function dateRangeFilter(field: string, from?: string, to?: string): Document {
  const bounds = dateBounds(from, to);
  return bounds ? { [field]: bounds } : {};
}
