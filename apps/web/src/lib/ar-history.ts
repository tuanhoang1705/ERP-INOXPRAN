import { m } from '$lib/paraglide/messages';

/** Trạng thái dòng sổ cũ khi nhập lịch sử công nợ (IMP-AR-01). Dòng sau ngày chốt không nhập (19/10/2026). */
export type ArEntryStatus = 'NHAP' | 'BO_QUA_DA_CO_ERP' | 'BO_QUA_NGHI_TRUNG' | 'SAU_CHOT_CHUA_CO';

export const arStatusTone: Record<ArEntryStatus, string> = { NHAP: 'neutral', BO_QUA_DA_CO_ERP: 'success', BO_QUA_NGHI_TRUNG: 'neutral', SAU_CHOT_CHUA_CO: 'warning' };

export function arStatusLabel(status: ArEntryStatus): string {
  if (status === 'BO_QUA_DA_CO_ERP') return m.ar_da_co_erp();
  if (status === 'BO_QUA_NGHI_TRUNG') return m.ar_nghi_trung();
  if (status === 'SAU_CHOT_CHUA_CO') return m.ar_chua_co_erp();
  return m.ar_nhap_kem();
}
