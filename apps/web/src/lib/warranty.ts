/**
 * Nhãn và tiện ích hiển thị của phân hệ bảo hành. Quy tắc nghiệp vụ (hạn bảo hành, 3 màu theo hẹn trả, luồng trạng thái)
 * nằm ở $shared/warranty — dùng chung với API.
 */
import type { Locale } from '$lib/paraglide/runtime';
import { m } from '$lib/paraglide/messages';
import type { SlaTone, WarrantyChannel, WarrantyCoverage, WarrantyExclusion, WarrantyPlan, WarrantyResolution, WarrantyStatus } from '$shared/warranty';

type Tone = '' | 'success' | 'warning' | 'danger' | 'neutral' | 'orange';
type Options = { locale?: Locale };

export const statusText = (status: WarrantyStatus, o: Options = {}): string =>
  ({
    RECEIVED: m.wr_st_received({}, o),
    QUOTE_PENDING: m.wr_st_quote_pending({}, o),
    PENDING_APPROVAL: m.wr_st_pending_approval({}, o),
    REPAIRING: m.wr_st_repairing({}, o),
    WAITING_PARTS: m.wr_st_waiting_parts({}, o),
    TESTING: m.wr_st_testing({}, o),
    READY: m.wr_st_ready({}, o),
    RETURNED: m.wr_st_returned({}, o),
    CANCELLED: m.wr_st_cancelled({}, o),
  })[status];

export const statusTone: Record<WarrantyStatus, Tone> = {
  RECEIVED: '',
  QUOTE_PENDING: 'orange',
  PENDING_APPROVAL: 'warning',
  REPAIRING: '',
  WAITING_PARTS: 'warning',
  TESTING: '',
  READY: 'success',
  RETURNED: 'neutral',
  CANCELLED: 'neutral',
};

export const coverageText = (coverage: WarrantyCoverage, o: Options = {}): string =>
  ({ IN_WARRANTY: m.wr_cov_in({}, o), OUT_OF_WARRANTY: m.wr_cov_out({}, o), NOT_COVERED: m.wr_cov_not({}, o) })[coverage];

export const coverageTone: Record<WarrantyCoverage, Tone> = { IN_WARRANTY: 'success', OUT_OF_WARRANTY: 'warning', NOT_COVERED: 'danger' };

export const exclusionText = (exclusion: WarrantyExclusion, o: Options = {}): string =>
  ({
    NO_INVOICE: m.wr_ex_no_invoice({}, o),
    PHYSICAL_DAMAGE: m.wr_ex_physical_damage({}, o),
    ELECTRICAL: m.wr_ex_electrical({}, o),
    LIQUID: m.wr_ex_liquid({}, o),
    UNAUTHORIZED_REPAIR: m.wr_ex_unauthorized_repair({}, o),
    MISUSE: m.wr_ex_misuse({}, o),
    OTHER: m.wr_ex_other({}, o),
  })[exclusion];

export const planText = (plan: WarrantyPlan, o: Options = {}): string =>
  ({ REPAIR: m.wr_plan_repair({}, o), QUOTE: m.wr_plan_quote({}, o), REJECT: m.wr_plan_reject({}, o), EXCHANGE: m.wr_plan_exchange({}, o), REFUND: m.wr_plan_refund({}, o) })[plan];

export const resolutionText = (resolution: WarrantyResolution, o: Options = {}): string =>
  ({
    REPAIRED: m.wr_res_repaired({}, o),
    PART_REPLACED: m.wr_res_part_replaced({}, o),
    EXCHANGED: m.wr_res_exchanged({}, o),
    REFUNDED: m.wr_res_refunded({}, o),
    REJECTED: m.wr_res_rejected({}, o),
    RETURNED_UNREPAIRED: m.wr_res_returned_unrepaired({}, o),
  })[resolution];

export const channelText = (channel: WarrantyChannel, o: Options = {}): string =>
  ({ DEALER: m.wr_ch_dealer({}, o), WALK_IN: m.wr_ch_walk_in({}, o), ONSITE: m.wr_ch_onsite({}, o) })[channel];

export const toneText = (tone: SlaTone): string =>
  ({ overdue: m.wr_tone_overdue(), warning: m.wr_tone_warning(), normal: m.wr_tone_normal(), closed: m.wr_tone_closed() })[tone];

export const actionText = (action: string): string =>
  ({
    RECEIVE: m.wr_act_receive(),
    DIAGNOSE: m.wr_act_diagnose(),
    QUOTE_DECISION: m.wr_act_quote_decision(),
    APPROVE: m.wr_act_approve(),
    WAIT_PARTS: m.wr_act_wait_parts(),
    PARTS_ARRIVED: m.wr_act_parts_arrived(),
    REPAIR_DONE: m.wr_act_repair_done(),
    TEST: m.wr_act_test(),
    RESCHEDULE: m.wr_act_reschedule(),
    RETURN: m.wr_act_return(),
    CANCEL: m.wr_act_cancel(),
  })[action] ?? action;

export interface SlaView {
  tone: SlaTone;
  elapsedRatio: number;
  dueAt: string;
  warningAt: string;
  daysLeft: number;
  lateDays: number;
}

/** Dòng chữ thời gian hẹn: "Còn 3 ngày" / "Trễ 2 ngày" / "Trả đúng hẹn" / "Trả trễ 1 ngày". */
export function slaText(sla: SlaView): string {
  if (sla.tone === 'closed') return sla.lateDays > 0 ? m.wr_late_on_return({ days: sla.lateDays }) : m.wr_on_time();
  if (sla.tone === 'overdue') return m.wr_days_late({ days: sla.lateDays });
  return m.wr_days_left({ days: sla.daysLeft });
}

/** Vai trò được tiếp nhận / cập nhật phiếu (khớp WARRANTY_STAFF_ROLES của API; ADMIN luôn được). */
export const WARRANTY_STAFF = ['WARRANTY'];
/** Vai trò được duyệt từ chối / đổi mới / hoàn tiền. */
export const WARRANTY_APPROVERS = ['DIRECTOR'];
