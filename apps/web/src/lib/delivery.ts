/**
 * Hộp xác nhận "Hoàn thành giao hàng?" (AR-DLV-01, 28/10/2026): công nợ và doanh thu của phiếu bán ghi khi xác nhận đã giao,
 * nên hỏi lại trước khi ghi — dùng chung cho trang phiếu và trang Giao hàng.
 */
import { m } from '$lib/paraglide/messages';
import { date, todayIso, vnd } from '$lib/format';
import { isNonSalePurpose, partyName } from '$lib/slip-type';
import { addDays } from '$shared/warranty';

type DeliverableOrder = Parameters<typeof partyName>[0] & { code: string; grandTotal: string; paymentTermDays?: number | undefined; purpose?: string | undefined };

export function deliveryConfirmation(order: DeliverableOrder): { title: string; message: string; confirmLabel: string } {
  const head = m.giao_xac_nhan_dau({ code: order.code, customer: partyName(order), amount: vnd(order.grandTotal) });
  const tail = isNonSalePurpose(order.purpose)
    ? m.giao_xac_nhan_khong_cong_no()
    : order.paymentTermDays !== undefined
      ? m.giao_xac_nhan_cong_no({ due: date(addDays(todayIso(), order.paymentTermDays)) })
      : m.giao_xac_nhan_cong_no_theo_khach();
  return { title: m.giao_xac_nhan_tieu_de(), message: `${head}\n\n${tail}`, confirmLabel: m.giao_xac_nhan_nut() };
}
