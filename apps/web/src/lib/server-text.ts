/**
 * Dịch chữ do máy chủ sinh ra (cảnh báo dashboard, thông báo, nhãn kỳ) theo ngôn ngữ giao diện.
 * Máy chủ gửi kèm mã mẫu + tham số; bản tiếng Việt trong title/detail/message chỉ là dự phòng
 * cho bản ghi cũ hoặc mẫu chưa có bản dịch. Tên hàng, tên khách, ghi chú là dữ liệu nên giữ nguyên.
 */
import type { AppNotification, DashboardSummary, TextParams } from '@inoxpran/contracts';
import { m } from '$lib/paraglide/messages';
import { date, num, vnd } from '$lib/format';
import { planText } from '$lib/warranty';
import { WARRANTY_PLANS, type WarrantyPlan } from '$shared/warranty';

const isPlan = (value: string): value is WarrantyPlan => (WARRANTY_PLANS as readonly string[]).includes(value);

type DashboardAlert = DashboardSummary['alerts'][number];

const text = (params: TextParams, key: string) => String(params[key] ?? '');
const changeKind = (kind: string) => ({ EDIT: m.yc_loai_sua(), VOID: m.yc_loai_huy_da_giao(), CANCEL: m.yc_loai_huy(), DELETE: m.yc_loai_xoa() } as Record<string, string>)[kind] ?? kind;
const count = (params: TextParams, key: string) => Number(params[key] ?? 0);

export function alertText(alert: DashboardAlert): { title: string; detail: string } {
  const p = alert.params ?? {};
  switch (alert.template) {
    case 'OVERDUE_60': {
      const province = text(p, 'province');
      const others = count(p, 'others');
      return {
        title: m.cb_no_qua_han_60(),
        detail: `${text(p, 'name')}${province ? ` (${province})` : ''} — ${vnd(text(p, 'total'))}${others > 0 ? m.cb_va_dai_ly_khac({ count: others }) : ''}`,
      };
    }
    case 'LOW_STOCK': {
      const more = count(p, 'more');
      const remaining = m.cb_ton_con({ available: num(text(p, 'available')), minimum: num(text(p, 'minimum')), unit: text(p, 'unit') });
      return {
        title: m.cb_ton_duoi_dinh_muc(),
        detail: `${text(p, 'name')} ${text(p, 'sku')} — ${remaining}${more > 0 ? ` (+${more} SKU)` : ''}`,
      };
    }
    case 'APPROVAL_OVERDUE_24H':
      return { title: m.cb_duyet_qua_24h(), detail: m.cb_duyet_qua_24h_chi_tiet({ count: count(p, 'count') }) };
    case 'APPROVAL_PENDING':
      return { title: m.cb_cho_duyet(), detail: m.cb_cho_duyet_chi_tiet({ count: count(p, 'count') }) };
    case 'PROMOTION_EXPIRING':
      return { title: m.cb_km_sap_het_han(), detail: `${text(p, 'name')} — ${m.cb_con_ngay({ days: count(p, 'days') })}` };
    case 'WARRANTY_OVERDUE':
      return { title: m.cb_bh_qua_hen(), detail: m.cb_bh_qua_hen_chi_tiet({ count: count(p, 'count') }) };
    default:
      return { title: alert.title, detail: alert.detail };
  }
}

export function notificationText(notification: AppNotification): { title: string; message: string } {
  const p = notification.params ?? {};
  const code = text(p, 'code');
  const customer = text(p, 'customer');
  switch (notification.template) {
    case 'SALES_ISSUE_REQUESTED':
      return { title: m.tb_de_nghi_lap_phieu({ code }), message: m.tb_de_nghi_lap_phieu_chi_tiet({ requester: text(p, 'requester'), customer }) };
    case 'SALES_APPROVAL_REQUESTED':
      return { title: m.tb_don_ban_cho_duyet({ code }), message: m.tb_don_ban_cho_duyet_chi_tiet({ customer }) };
    case 'SALES_CONFIRMATION_PENDING':
      return { title: m.tb_cho_doi_chieu({ code }), message: m.tb_doi_chieu_chi_tiet({ customer }) };
    case 'SALES_APPROVED_CONFIRMATION_PENDING':
      return { title: m.tb_da_duyet_cho_doi_chieu({ code }), message: m.tb_doi_chieu_chi_tiet({ customer }) };
    case 'SALES_READY_FOR_SWK':
      return { title: m.tb_cho_lap_swk({ code }), message: m.tb_cho_lap_swk_chi_tiet({ customer }) };
    case 'PRICE_OVERRIDE_REQUESTED':
      return { title: m.tb_gia_xin_quyen({ requester: text(p, 'requester') }), message: m.tb_gia_xin_quyen_chi_tiet({ customer: text(p, 'customer') || '—', reason: text(p, 'reason') }) };
    case 'PRICE_OVERRIDE_DECIDED':
      return text(p, 'decision') === 'APPROVE'
        ? { title: m.tb_gia_da_cap({ approver: text(p, 'approver') }), message: m.tb_gia_da_cap_chi_tiet({ code }) }
        : { title: m.tb_gia_tu_choi({ approver: text(p, 'approver') }), message: text(p, 'note') };
    case 'SALES_CHANGE_REQUESTED':
      return { title: m.tb_yc_moi({ requester: text(p, 'requester'), kind: changeKind(text(p, 'kind')).toLowerCase(), order: text(p, 'order') }), message: text(p, 'reason') };
    case 'SALES_CHANGE_APPROVED':
      return { title: m.tb_yc_duyet({ code, approver: text(p, 'approver') }), message: m.tb_yc_duyet_chi_tiet({ kind: changeKind(text(p, 'kind')), order: text(p, 'order') }) };
    case 'SALES_CHANGE_REJECTED':
      return { title: m.tb_yc_tu_choi({ code }), message: `${text(p, 'approver')}: ${text(p, 'note')}` };
    case 'SALES_ORDER_ROOT_EDITED':
      return { title: m.tb_root_sua_phieu({ code }), message: m.tb_root_sua_phieu_chi_tiet({ actor: text(p, 'actor'), customer: text(p, 'customer') }) };
    case 'SALES_ORDER_CANCELLED':
      return { title: m.tb_bh_da_huy({ code }), message: m.tb_bh_da_huy_chi_tiet({ actor: text(p, 'actor'), code, customer: text(p, 'customer'), reason: text(p, 'reason') }) };
    case 'SALES_ORDER_DELETED':
      return { title: m.tb_bh_da_xoa({ code }), message: m.tb_bh_da_xoa_chi_tiet({ actor: text(p, 'actor'), code, customer: text(p, 'customer'), reason: text(p, 'reason') }) };
    case 'SALES_REVISION_REQUESTED':
      return { title: m.tb_can_sua({ code }), message: m.tb_can_sua_chi_tiet({ actor: text(p, 'actor'), note: text(p, 'note') }) };
    case 'EVIDENCE_MALWARE_BLOCKED':
      return {
        title: m.tb_chan_ma_doc({ code }),
        message: m.tb_chan_ma_doc_chi_tiet({ actor: text(p, 'actor'), fileName: text(p, 'fileName'), signature: text(p, 'signature') }),
      };
    case 'PURCHASE_APPROVAL_REQUESTED':
      return { title: m.tb_don_mua_cho_duyet({ code }), message: m.tb_don_mua_cho_duyet_chi_tiet({ supplier: text(p, 'supplier') }) };
    case 'OVERDUE_REVIEW':
      return {
        title: m.tb_ra_soat_cong_no({ date: date(text(p, 'date')) }),
        message: m.tb_ra_soat_cong_no_chi_tiet({
          reminder: count(p, 'reminder'),
          warning: count(p, 'warning'),
          danger: count(p, 'danger'),
          amount: vnd(text(p, 'overdue')),
        }),
      };
    case 'ORDERING_LOCKED_OVERDUE':
      return { title: m.tb_khoa_dat_hang(), message: text(p, 'partners') };
    case 'WARRANTY_APPROVAL_REQUESTED':
      return {
        title: m.tb_bh_cho_duyet({ code }),
        message: m.tb_bh_cho_duyet_chi_tiet({ customer, product: text(p, 'product'), proposal: isPlan(text(p, 'proposal')) ? planText(text(p, 'proposal') as WarrantyPlan) : text(p, 'proposal') }),
      };
    case 'WARRANTY_APPROVAL_DECIDED':
      return { title: text(p, 'approved') === 'yes' ? m.tb_bh_da_duyet({ code }) : m.tb_bh_khong_duyet({ code }), message: notification.message };
    case 'WARRANTY_DUE_SOON':
      return { title: m.tb_bh_sap_den_hen({ code }), message: m.tb_bh_sap_den_hen_chi_tiet({ customer, product: text(p, 'product'), date: date(text(p, 'promisedDate')), days: count(p, 'daysLeft') }) };
    case 'WARRANTY_OVERDUE':
      return { title: m.tb_bh_qua_hen({ code }), message: m.tb_bh_qua_hen_chi_tiet({ customer, product: text(p, 'product'), date: date(text(p, 'promisedDate')), days: count(p, 'lateDays') }) };
    case 'WARRANTY_STOCK_MOVED':
      return {
        title: text(p, 'exchange') ? m.tb_bh_doi_hang({ code, product: text(p, 'product'), exchange: text(p, 'exchange'), defect: text(p, 'defect') }) : m.tb_bh_nhap_hang_loi({ code, defect: text(p, 'defect') }),
        message: m.tb_bh_kho_chi_tiet({ customer, product: text(p, 'product') }),
      };
    case 'CRM_FOLLOW_UP_DUE':
      return { title: m.tb_crm_cham_soc({ count: count(p, 'count') }), message: m.tb_crm_cham_soc_chi_tiet({ overdue: count(p, 'overdue'), first: text(p, 'first') }) };
    case 'CUSTOMER_RETURN_POSTED':
      return {
        title: m.tb_khach_tra_hang({ code }),
        message: text(p, 'amount')
          ? m.tb_khach_tra_hang_gia_tri({ customer, order: text(p, 'order'), amount: vnd(text(p, 'amount')) })
          : m.tb_khach_tra_hang_chi_tiet({ customer }),
      };
    case 'STOCK_COUNT_VARIANCE':
      return {
        title: m.tb_kiem_ke_lech({ code, count: text(p, 'count') }),
        message: m.tb_kiem_ke_lech_chi_tiet({ warehouse: text(p, 'warehouse'), by: text(p, 'by'), count: text(p, 'count'), note: text(p, 'note') }),
      };
    case 'WARRANTY_SERVICE_BILLED':
      return { title: m.tb_bh_phi_dich_vu({ code, amount: vnd(text(p, 'amount')), receivable: text(p, 'receivable') }), message: customer };
    default:
      return { title: notification.title, message: notification.message };
  }
}

/** Đổi dd/mm/yyyy sang YYYY-MM-DD để định dạng lại theo ngôn ngữ giao diện. */
const isoDay = (day: string, month: string, year: string) => `${year}-${month}-${day}`;

/**
 * Nhãn kỳ do máy chủ trả về (common/domain.ts, reports.service.ts) có tập định dạng cố định;
 * nhãn lạ trả nguyên văn.
 */
export function periodText(label: string | null | undefined): string {
  if (!label) return '';
  if (label === '90 ngày gần nhất') return m.ky_90_ngay_gan_nhat();
  let match = /^Quý (\d)\/(\d{4})$/.exec(label);
  if (match) return m.ky_quy_nam({ quarter: match[1]!, year: match[2]! });
  match = /^Tháng (\d{1,2})\/(\d{4})$/.exec(label);
  if (match) return m.ky_thang_nam({ month: match[1]!, year: match[2]! });
  match = /^cùng kỳ tháng (\d{1,2})$/.exec(label);
  if (match) return m.ky_cung_ky_thang({ month: match[1]! });
  match = /^(\d{2})\/(\d{2})\/(\d{4}) – (\d{2})\/(\d{2})\/(\d{4})$/.exec(label);
  if (match) return `${date(isoDay(match[1]!, match[2]!, match[3]!))} – ${date(isoDay(match[4]!, match[5]!, match[6]!))}`;
  return label;
}
