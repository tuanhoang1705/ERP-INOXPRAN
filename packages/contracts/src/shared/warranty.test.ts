import { describe, expect, it } from 'vitest';
import { addMonths, coverageFor, defaultPlanFor, plansForCoverage, serviceDays, slaState, warrantyEditableStages, warrantyExpiry, WARRANTY_ACTIONS_BY_STATUS, WARRANTY_STATUSES } from './warranty';

describe('hạn bảo hành', () => {
  it('12 tháng kết thúc vào ngày tương ứng của tháng cuối (BLDS 2015 Điều 147–148)', () => {
    expect(warrantyExpiry('2026-10-03', 12)).toBe('2027-10-03');
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2027-02-28', 12)).toBe('2028-02-28');
  });

  it('cộng thêm thời gian các lần bảo hành trước', () => {
    expect(warrantyExpiry('2026-10-03', 12, 11)).toBe('2027-10-14');
  });

  it('không hóa đơn, nhân viên chọn sửa có tính phí (mặc định): không thuộc diện bảo hành', () => {
    expect(coverageFor({ invoiceDate: null, receivedDate: '2026-10-03' })).toEqual({ coverage: 'NOT_COVERED', exclusion: 'NO_INVOICE' });
    expect(coverageFor({ invoiceDate: null, receivedDate: '2026-10-03', noInvoiceWarranty: false })).toEqual({ coverage: 'NOT_COVERED', exclusion: 'NO_INVOICE' });
  });

  it('không hóa đơn, nhân viên xác nhận vẫn bảo hành (WAR-NOINV-01)', () => {
    expect(coverageFor({ invoiceDate: null, receivedDate: '2026-10-28', noInvoiceWarranty: true })).toEqual({ coverage: 'IN_WARRANTY', invoiceless: true });
    expect(coverageFor({ invoiceDate: null, receivedDate: '2026-10-28', noInvoiceWarranty: true, declaredPurchaseDate: '2026-03-01' }))
      .toEqual({ coverage: 'IN_WARRANTY', invoiceless: true, startsOn: '2026-03-01', expiresOn: '2027-03-01', declaredExpired: false });
    // Ngày khách khai đã quá 12 tháng: vẫn theo lựa chọn của nhân viên, chỉ cảnh báo.
    expect(coverageFor({ invoiceDate: null, receivedDate: '2026-10-28', noInvoiceWarranty: true, declaredPurchaseDate: '2025-06-01' }))
      .toMatchObject({ coverage: 'IN_WARRANTY', invoiceless: true, declaredExpired: true });
  });

  it('còn / hết bảo hành theo ngày tiếp nhận', () => {
    expect(coverageFor({ invoiceDate: '2025-10-03', receivedDate: '2026-10-03' })).toMatchObject({ coverage: 'IN_WARRANTY', expiresOn: '2026-10-03' });
    expect(coverageFor({ invoiceDate: '2025-10-03', receivedDate: '2026-10-04' })).toMatchObject({ coverage: 'OUT_OF_WARRANTY' });
    expect(coverageFor({ invoiceDate: '2025-10-03', receivedDate: '2026-10-10', extensionDays: 7 })).toMatchObject({ coverage: 'IN_WARRANTY', expiresOn: '2026-10-10' });
  });
});

describe('màu theo hẹn trả (vàng khi qua 70% thời gian hẹn)', () => {
  // Tiếp nhận 08:00 ngày 01/10 (giờ VN), hẹn trả 07/10 → hết hạn 23:59:59 ngày 07/10.
  const receivedAt = new Date('2026-10-01T08:00:00+07:00');
  const base = { receivedAt, promisedDate: '2026-10-07' };
  const window = new Date('2026-10-07T23:59:59.999+07:00').getTime() - receivedAt.getTime();

  it('chưa qua 70%: không màu', () => {
    const state = slaState({ ...base, now: new Date(receivedAt.getTime() + window * 0.69) });
    expect(state.tone).toBe('normal');
    expect(state.daysLeft).toBeGreaterThan(0);
  });

  it('qua 70%: vàng', () => {
    expect(slaState({ ...base, now: new Date(receivedAt.getTime() + window * 0.71) }).tone).toBe('warning');
    expect(slaState({ ...base, now: new Date('2026-10-07T23:00:00+07:00') }).tone).toBe('warning');
  });

  it('quá cuối ngày hẹn: đỏ, đếm số ngày trễ', () => {
    const state = slaState({ ...base, now: new Date('2026-10-09T10:00:00+07:00') });
    expect(state.tone).toBe('overdue');
    expect(state.lateDays).toBe(2);
  });

  it('đã trả khách: không tô màu, ghi số ngày trễ khi trả', () => {
    expect(slaState({ ...base, now: new Date('2026-10-20T00:00:00+07:00'), closedAt: '2026-10-06T15:00:00+07:00' })).toMatchObject({ tone: 'closed', lateDays: 0 });
    expect(slaState({ ...base, now: new Date('2026-10-20T00:00:00+07:00'), closedAt: '2026-10-08T15:00:00+07:00' })).toMatchObject({ tone: 'closed', lateDays: 1 });
  });
});

describe('luồng trạng thái', () => {
  it('mọi trạng thái đều khai báo thao tác; phiếu đã đóng không còn thao tác', () => {
    for (const status of WARRANTY_STATUSES) expect(WARRANTY_ACTIONS_BY_STATUS[status]).toBeDefined();
    expect(WARRANTY_ACTIONS_BY_STATUS.RETURNED).toEqual([]);
    // WAR-EXCH-02 (11/11/2026): đổi mới đã duyệt chờ kế toán xuất phiếu BH & SWK; không hủy được như lúc chờ duyệt.
    expect(WARRANTY_ACTIONS_BY_STATUS.AWAITING_ISSUE).toEqual(['ISSUE_EXCHANGE', 'RETURN', 'RESCHEDULE']);
    expect(WARRANTY_ACTIONS_BY_STATUS.READY).toEqual(['RETURN']);
    expect(WARRANTY_ACTIONS_BY_STATUS.CANCELLED).toEqual([]);
  });

  it('số ngày giữ máy', () => {
    expect(serviceDays('2026-09-01T09:00:00+07:00', '2026-09-06T16:00:00+07:00')).toBe(5);
  });
});

describe('hướng xử lý theo diện bảo hành', () => {
  it('sửa chữa bảo hành miễn phí chọn được ở mọi diện / lý do sửa chữa (05/11/2026)', () => {
    expect(plansForCoverage('IN_WARRANTY')).toEqual(['REPAIR', 'EXCHANGE', 'REFUND']);
    expect(plansForCoverage('OUT_OF_WARRANTY')).toEqual(['REPAIR', 'QUOTE']);
    expect(plansForCoverage('NOT_COVERED')).toEqual(['REPAIR', 'QUOTE', 'REJECT']);
  });

  it('chọn sẵn: còn bảo hành thì sửa miễn phí, còn lại báo giá', () => {
    expect(defaultPlanFor('IN_WARRANTY')).toBe('REPAIR');
    expect(defaultPlanFor('OUT_OF_WARRANTY')).toBe('QUOTE');
    expect(defaultPlanFor('NOT_COVERED')).toBe('QUOTE');
  });
});

describe('giai đoạn sửa được của phiếu bảo hành (WAR-EDIT-01, 06/11/2026)', () => {
  it('chỉ giai đoạn phiếu đã đi qua; phiếu hủy không sửa', () => {
    expect(warrantyEditableStages({ status: 'RECEIVED' })).toEqual(['INTAKE']);
    expect(warrantyEditableStages({ status: 'REPAIRING', plan: 'REPAIR' })).toEqual(['INTAKE', 'DIAGNOSE']);
    expect(warrantyEditableStages({ status: 'TESTING', plan: 'REPAIR', result: { resolution: 'PART_REPLACED' } })).toEqual(['INTAKE', 'DIAGNOSE', 'REPAIR']);
    expect(warrantyEditableStages({ status: 'RETURNED', plan: 'REPAIR', result: { resolution: 'REPAIRED' }, test: { functional: true } })).toEqual(['INTAKE', 'DIAGNOSE', 'REPAIR', 'TEST', 'RETURN']);
    // Đổi mới / từ chối: không có giai đoạn sửa chữa, kiểm tra.
    expect(warrantyEditableStages({ status: 'RETURNED', plan: 'EXCHANGE', result: { resolution: 'EXCHANGED' } })).toEqual(['INTAKE', 'DIAGNOSE', 'RETURN']);
    expect(warrantyEditableStages({ status: 'AWAITING_ISSUE', plan: 'EXCHANGE', result: { resolution: 'EXCHANGED' } })).toEqual(['INTAKE', 'DIAGNOSE']);
    expect(warrantyEditableStages({ status: 'CANCELLED', plan: 'REPAIR' })).toEqual([]);
  });
});
