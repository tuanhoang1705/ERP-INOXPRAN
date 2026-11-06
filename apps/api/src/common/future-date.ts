import { BadRequestException } from '@nestjs/common';
import { vnDate } from '@inoxpran/contracts';

/**
 * SEC-UI-01 (06/11/2026): ngày của chứng từ tiền (phiếu thu, trả tiền NCC, dòng sổ công nợ) và ngày tiếp nhận bảo hành không được
 * sau hôm nay (giờ Việt Nam). Web đã giới hạn `max = hôm nay`; máy chủ kiểm lại để gọi API thẳng cũng không ghi được ngày tương lai.
 * Nhận ngày "YYYY-MM-DD" hoặc thời điểm ISO (so theo ngày Việt Nam của thời điểm đó).
 */
export function assertNotFutureDay(value: string | Date, field: string, label = 'Ngày'): void {
  const day = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : vnDate(new Date(value));
  if (day > vnDate(new Date())) {
    throw new BadRequestException({ code: 'DATE_IN_FUTURE', message: `${label} không được sau hôm nay`, details: [{ path: [field] }] });
  }
}
