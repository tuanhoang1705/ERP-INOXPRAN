<script lang="ts">
  import { m } from '$lib/paraglide/messages';
  import type { WarrantyExchangeIssueInfo, WarrantyFaultCode, WarrantyFaultLine, WarrantyReturnSlipOption, WarrantyTicket } from '@inoxpran/contracts';
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { untrack } from 'svelte';
  import { CalendarClock, CircleAlert, CircleCheck, FilePen, Hourglass, Pencil, Plus, Printer, Trash2, TriangleAlert, X } from 'lucide-svelte';
  import WarrantyStageEditDialog from '$lib/components/WarrantyStageEditDialog.svelte';
  import Dialog from '$lib/components/Dialog.svelte';
  import SuggestInput, { type Suggestion } from '$lib/components/SuggestInput.svelte';
  import { categoryLabel } from '$lib/inventory';
  import WarrantyPhotos from '$lib/components/WarrantyPhotos.svelte';
  import WarrantyIntakeDialog from '$lib/components/WarrantyIntakeDialog.svelte';
  import NumberInput from '$lib/components/NumberInput.svelte';
  import StaffSelect from '$lib/components/StaffSelect.svelte';
  import { loadStaff, staffPick, type StaffOption } from '$lib/staff';
  import { api } from '$lib/api';
  import { date, dateTime, todayIso, vnd } from '$lib/format';
  import { hasRole } from '$lib/labels';
  import { can, session } from '$lib/session.svelte';
  import { canOpen } from '$lib/visibility';
  import {
    actionText, channelText, coverageTone, ticketCoverageText, exclusionText, planText, resolutionText, slaText, stageText, statusText, statusTone, toneText,
    WARRANTY_APPROVERS, WARRANTY_STAFF, type SlaView,
  } from '$lib/warranty';
  import {
    defaultPlanFor, plansForCoverage, remainingWarrantyDays, REPEAT_REPAIR_THRESHOLD, WARRANTY_ACTIONS_BY_STATUS, WARRANTY_EDIT_GRANT_HOURS, WARRANTY_EXCHANGE_ISSUE_PERMISSION, WARRANTY_EXCLUSIONS,
    warrantyEditableStages, type WarrantyCoverage, type WarrantyEditStage, type WarrantyExclusion, type WarrantyPlan,
  } from '$shared/warranty';

  type Ticket = WarrantyTicket & { sla: SlaView };
  type EditableLine = { faultCode: string; receivedDate: string; symptom: string; rootCause: string; action: string; partCode: string; note: string };

  let ticket = $state<Ticket | null>(null);
  let error = $state('');
  let notice = $state(page.url.searchParams.get('created') ? 'created' : '');
  let busy = $state(false);
  let note = $state('');
  let lines = $state<EditableLine[]>([]);
  let exclusion = $state<WarrantyExclusion | ''>('');
  let plan = $state<WarrantyPlan>('REPAIR');
  let quoteAmount = $state('');
  let resolution = $state<'REPAIRED' | 'PART_REPLACED'>('PART_REPLACED');
  let replacedParts = $state('');
  let cost = $state('0');
  let checks = $state({ functional: false, safety: false, performance: false });
  let receiverName = $state('');
  let rescheduleOpen = $state(false);
  let newDate = $state('');
  let reason = $state('');
  let cancelOpen = $state(false);
  let refundAmount = $state('');
  /** Trả khách hoàn tiền: số phiếu trả hàng đã nhập hàng lỗi (chỉ liên kết). Đổi mới nay qua kế toán xuất phiếu (WAR-EXCH-02). */
  let returnSlipCode = $state('');
  /** Gợi ý phiếu khách trả có mã sản phẩm này (05/11/2026) — tải khi phiếu sắp trả đổi mới / hoàn tiền. */
  let returnSlips = $state<WarrantyReturnSlipOption[]>([]);
  let returnSlipsFor = '';
  let returnSlipsLoading = $state(false);
  /** Người phụ trách phiếu BH đổi bảo hành (STAFF-PICK-01): NVKD hoặc nhân viên khác, trừ Admin. */
  let staff = $state<StaffOption[]>([]);
  let staffRequested = false;
  let exchangeStaffId = $state('');
  /** Kế toán xuất phiếu BH & SWK đổi bảo hành (WAR-EXCH-02, 11/11/2026): kho xuất, tồn khả dụng, thủ kho in SWK. */
  let issueInfo = $state<WarrantyExchangeIssueInfo | null>(null);
  let issueInfoFor = '';
  let issueKeeperId = $state('');
  let issuedNotice = $state<{ order: string; slip: string; keeper: string } | null>(null);
  let editOpen = $state(false);
  // ---------- WAR-EDIT-01 (06/11/2026): yêu cầu sửa phiếu theo giai đoạn ----------
  /** Hộp sửa tiếp nhận mở khóa (theo yêu cầu đã duyệt / người duyệt sửa thẳng). */
  let intakeUnlocked = $state(false);
  let intakeRequestId = $state('');
  let stagePickOpen = $state(false);
  let stagePick = $state<WarrantyEditStage>('INTAKE');
  let stageReason = $state('');
  let stageEditOpen = $state(false);
  let stageEditStage = $state<'DIAGNOSE' | 'REPAIR' | 'TEST' | 'RETURN'>('DIAGNOSE');
  let stageRequestId = $state('');
  let decideOpen = $state(false);
  let decideApproved = $state(true);
  let decideNote = $state('');
  let faultCodes = $state<WarrantyFaultCode[]>([]);

  const isStaff = $derived(hasRole(session.user?.roles, WARRANTY_STAFF));
  const isApprover = $derived(hasRole(session.user?.roles, WARRANTY_APPROVERS));
  /** Kế toán được phân bước 2 "KT phát hành" (quản trị gốc luôn có) — xuất phiếu BH & SWK đổi bảo hành. */
  const canIssue = $derived(Boolean(session.user) && can(WARRANTY_EXCHANGE_ISSUE_PERMISSION));
  const issueShort = $derived(Boolean(issueInfo && Number(issueInfo.available) < 1));
  const editableStages = $derived(ticket ? warrantyEditableStages(ticket) : []);
  const pendingEdit = $derived(ticket?.editRequests?.find((row) => row.status === 'PENDING') ?? null);
  const myEditGrant = $derived(ticket?.editRequests?.find((row) => row.status === 'GRANTED' && row.requestedById === session.user?.sub) ?? null);
  const actions = $derived(ticket ? WARRANTY_ACTIONS_BY_STATUS[ticket.status] : []);
  const effectiveCoverage = $derived<WarrantyCoverage>(exclusion ? 'NOT_COVERED' : (ticket?.coverage ?? 'NOT_COVERED'));
  // Sửa chữa bảo hành (miễn phí) chọn được ở mọi lý do sửa chữa (05/11/2026).
  const allowedPlans = $derived(plansForCoverage(effectiveCoverage));
  /** Sửa theo hướng "sửa chữa bảo hành (miễn phí)" → công ty chịu, kể cả máy hết hạn / có lý do sửa chữa; sửa theo báo giá → khách trả. */
  const companyPays = $derived(ticket?.plan ? ticket.plan === 'REPAIR' : ticket?.coverage === 'IN_WARRANTY');
  const returnSlipSuggestions = $derived<Suggestion[]>(returnSlips.map((slip) => ({
    value: slip.code,
    label: slip.partnerName,
    detail: [date(slip.date), `SL ${slip.quantity}`, categoryLabel(slip.category), slip.warehouseName, slip.legacyCode].filter(Boolean).join(' · '),
    ...(slip.linkedTickets.length ? { note: m.wr_phieu_tra_da_gan({ codes: slip.linkedTickets.join(', ') }) } : {}),
    muted: !slip.samePartner,
  })));
  const serviceNumber = $derived(ticket ? ticket.warranty.priorServiceCount + 1 : 1);
  const warrantyLeft = $derived(ticket?.warranty.expiresOn ? remainingWarrantyDays(ticket.warranty.expiresOn, todayIso()) : null);
  /** Mã lỗi của nhóm hàng của sản phẩm + mã dùng chung. */
  const productFaultCodes = $derived(faultCodes.filter((row) => row.active && (!row.categoryIds.length || row.categoryNames.includes(ticket?.product.categoryName ?? ''))));
  const faultName = (code: string | undefined) => (code ? faultCodes.find((row) => row.code === code)?.name : undefined);
  const resolutionNow = $derived(ticket?.result?.resolution);
  /** Phiếu đổi mới đã trả, hệ thống đã xuất hàng đổi nhưng chưa có phiếu BH & SWK (trả trước 02/11/2026). */
  const needsExchangeOrder = $derived(Boolean(ticket && ticket.status === 'RETURNED' && ticket.result?.resolution === 'EXCHANGED' && ticket.stock?.exchange && !ticket.exchangeOrder));
  const billable = $derived(Boolean(ticket?.result && ticket.result.chargedTo === 'CUSTOMER' && Number(ticket.result.cost) > 0 && ticket.result.resolution !== 'REJECTED'));

  /** Danh mục mã lỗi tải một lần (danh mục có thể trống — không dùng độ dài mảng làm cờ). */
  let faultCodesLoaded = false;
  async function load(id = page.params.id) {
    try {
      if (!faultCodesLoaded) {
        faultCodesLoaded = true;
        faultCodes = await api<WarrantyFaultCode[]>('/warranty/fault-codes?all=1').catch(() => []);
      }
      prepare(await api<Ticket>(`/warranty/tickets/${id}`));
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.wr_load_error();
    }
  }
  // Chỉ tải lại khi đổi phiếu (id). untrack: load() đọc / ghi state (faultCodes, ticket…) — nếu effect theo dõi các state đó thì
  // mỗi lần gán lại sẽ chạy lại effect. Lỗi 20/10/2026: danh mục mã lỗi production trống → `faultCodes = []` kích hoạt lại effect
  // → tải lặp vô hạn (~874 yêu cầu/phút) → bị giới hạn tần suất, báo "thao tác quá nhanh, thử lại sau".
  $effect(() => {
    const id = page.params.id;
    untrack(() => void load(id));
  });

  /** Đổ dữ liệu phiếu vào các form của bước tiếp theo. */
  function prepare(next: Ticket) {
    ticket = next;
    note = '';
    lines = next.lines.map((line) => ({ faultCode: line.faultCode ?? '', receivedDate: line.receivedDate, symptom: line.symptom, rootCause: line.rootCause ?? '', action: line.action ?? '', partCode: line.partCode ?? '', note: line.note ?? '' }));
    exclusion = next.exclusion && next.exclusion !== 'NO_INVOICE' ? next.exclusion : '';
    plan = defaultPlanFor(next.coverage);
    quoteAmount = next.quoteAmount ? String(Math.round(Number(next.quoteAmount))) : '';
    cost = (next.plan ? next.plan === 'QUOTE' : next.coverage !== 'IN_WARRANTY') ? quoteAmount || '0' : '0';
    replacedParts = next.result?.replacedParts ?? '';
    checks = { functional: false, safety: false, performance: false };
    receiverName = next.customer.name;
    newDate = next.promisedDate;
    reason = '';
    refundAmount = '';
    returnSlipCode = '';
    exchangeStaffId = '';
    // Danh sách người phụ trách chỉ tải khi kế toán sắp xuất phiếu BH đổi bảo hành, hoặc phiếu đã trả trước 02/11 cần lập phiếu.
    const issuing = next.status === 'AWAITING_ISSUE' && can(WARRANTY_EXCHANGE_ISSUE_PERMISSION);
    // Quản lý kho / Admin ghi "hàng đổi đã giao trước" (kèm phiếu trả hàng lỗi) ngay khi phiếu chờ kế toán.
    const deliveredBefore = next.status === 'AWAITING_ISSUE' && hasRole(session.user?.roles, WARRANTY_APPROVERS);
    const lateOrder = next.result?.resolution === 'EXCHANGED' && next.status === 'RETURNED' && next.stock?.exchange && !next.exchangeOrder && hasRole(session.user?.roles, WARRANTY_STAFF);
    if ((issuing || lateOrder) && !staffRequested) {
      staffRequested = true;
      void loadStaff().then((rows) => (staff = rows)).catch(() => (staffRequested = false));
    }
    if (issuing && issueInfoFor !== next.id) {
      issueInfoFor = next.id;
      void api<WarrantyExchangeIssueInfo>(`/warranty/tickets/${next.id}/exchange-issue`)
        .then((info) => {
          issueInfo = info;
          if (!info.keepers.some((keeper) => keeper.id === issueKeeperId)) issueKeeperId = info.keepers.length === 1 ? (info.keepers[0]?.id ?? '') : '';
        })
        .catch(() => (issueInfoFor = ''));
    }
    const returning = (next.status === 'READY' && next.result?.resolution === 'REFUNDED' && hasRole(session.user?.roles, WARRANTY_STAFF)) || issuing || deliveredBefore;
    if (returning && returnSlipsFor !== next.id) {
      returnSlipsFor = next.id;
      returnSlipsLoading = true;
      void api<WarrantyReturnSlipOption[]>(`/warranty/tickets/${next.id}/return-slips`)
        .then((rows) => (returnSlips = rows))
        .catch(() => (returnSlipsFor = ''))
        .finally(() => (returnSlipsLoading = false));
    }
  }

  $effect(() => {
    if (!allowedPlans.includes(plan)) plan = allowedPlans.includes(defaultPlanFor(effectiveCoverage)) ? defaultPlanFor(effectiveCoverage) : (allowedPlans[0] as WarrantyPlan);
  });

  /** Đổi lý do sửa chữa: chọn lại hướng xử lý mặc định (có lý do → báo giá), sửa miễn phí phải chủ động chọn. */
  function chooseExclusion(value: string) {
    exclusion = value as WarrantyExclusion | '';
    plan = defaultPlanFor(value ? 'NOT_COVERED' : (ticket?.coverage ?? 'NOT_COVERED'));
  }

  async function act(body: Record<string, unknown>) {
    if (!ticket) return;
    busy = true;
    error = '';
    try {
      const photos = ticket.photos;
      const next = await api<Ticket>(`/warranty/tickets/${ticket.id}/actions`, { method: 'POST', idempotentCommand: true, body: JSON.stringify({ version: ticket.version, ...body }) });
      // Phiếu đã hủy chỉ quản trị gốc còn mở được (DOC-HIDE-01): người khác về danh sách kèm thông báo.
      if (body.type === 'CANCEL' && !session.user?.root) {
        await goto(`/warranty?cancelled=${encodeURIComponent(ticket.code)}`);
        return;
      }
      // Kết quả thao tác không kèm ảnh: giữ danh sách ảnh đang có.
      prepare({ ...next, photos });
      notice = 'saved';
      rescheduleOpen = false;
      cancelOpen = false;
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.wr_load_error();
    } finally {
      busy = false;
    }
  }

  const optional = (value: string) => value.trim() || undefined;

  /** Mở form sửa của một giai đoạn: Tiếp nhận dùng hộp sửa thông tin tiếp nhận (mở khóa), giai đoạn khác dùng hộp sửa giai đoạn. */
  function openStageForm(stage: WarrantyEditStage, requestId = '') {
    if (stage === 'INTAKE') {
      intakeUnlocked = true;
      intakeRequestId = requestId;
      editOpen = true;
      return;
    }
    stageEditStage = stage;
    stageRequestId = requestId;
    stageEditOpen = true;
  }
  function openStagePick() {
    stagePick = editableStages[editableStages.length - 1] ?? 'INTAKE';
    stageReason = '';
    stagePickOpen = true;
  }
  /** Người duyệt: mở thẳng form sửa; nhân viên bảo hành: gửi yêu cầu. */
  async function submitStagePick() {
    if (!ticket) return;
    if (isApprover) {
      stagePickOpen = false;
      openStageForm(stagePick);
      return;
    }
    if (stageReason.trim().length < 5) return;
    await editRequestCall(`/warranty/tickets/${ticket.id}/edit-requests`, { version: ticket.version, stage: stagePick, reason: stageReason.trim() }, 'requested');
    stagePickOpen = false;
  }
  async function editRequestCall(path: string, body: Record<string, unknown>, done: string) {
    if (!ticket) return;
    busy = true;
    error = '';
    try {
      const photos = ticket.photos;
      const next = await api<Ticket>(path, { method: 'POST', idempotentCommand: true, body: JSON.stringify(body) });
      prepare({ ...next, photos });
      notice = done;
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.wr_load_error();
    } finally {
      busy = false;
    }
  }
  async function decideEdit() {
    if (!ticket || !pendingEdit || (!decideApproved && decideNote.trim().length < 5)) return;
    decideOpen = false;
    await editRequestCall(`/warranty/tickets/${ticket.id}/edit-requests/${pendingEdit.id}/decision`, { approved: decideApproved, note: optional(decideNote) }, decideApproved ? 'edit-granted' : 'edit-rejected');
  }
  const withdrawEdit = (id: string) => ticket && editRequestCall(`/warranty/tickets/${ticket.id}/edit-requests/${id}/withdraw`, {}, 'edit-withdrawn');
  function stageSaved(next: Ticket) {
    prepare({ ...next, photos: ticket?.photos });
    notice = 'edited';
  }

  /** Lập phiếu BH & SWK đổi bảo hành cho phiếu đã trả (02/11/2026) — số theo dãy phiếu bán, in đưa thủ kho. */
  async function issueExchangeOrder() {
    if (!ticket) return;
    busy = true;
    error = '';
    try {
      const photos = ticket.photos;
      const next = await api<Ticket>(`/warranty/tickets/${ticket.id}/exchange-order`, { method: 'POST', idempotentCommand: true, body: JSON.stringify({ version: ticket.version, ...staffPick(staff, exchangeStaffId) }) });
      prepare({ ...next, photos });
      notice = 'saved';
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.wr_load_error();
    } finally {
      busy = false;
    }
  }
  /** Kế toán xác nhận xuất phiếu BH & SWK đổi bảo hành → trừ kho, lập phiếu, đóng phiếu bảo hành (WAR-EXCH-02). */
  async function issueExchange() {
    if (!ticket || !issueKeeperId || !exchangeStaffId) return;
    const keeper = issueInfo?.keepers.find((row) => row.id === issueKeeperId)?.displayName ?? '';
    await act({ type: 'ISSUE_EXCHANGE', warehouseKeeperId: issueKeeperId, ...staffPick(staff, exchangeStaffId), ...(receiverName.trim().length >= 2 ? { receiverName: receiverName.trim() } : {}), ...(returnSlipCode.trim() ? { returnSlipCode: returnSlipCode.trim() } : {}), note: optional(note) });
    if (ticket?.exchangeOrder && ticket.status === 'RETURNED') issuedNotice = { order: ticket.exchangeOrder.code, slip: ticket.exchangeOrder.warehouseSlipNo, keeper: ticket.exchangeOrder.warehouseKeeperName ?? keeper };
  }

  function printExchange(type: 'BH' | 'SWK') {
    if (ticket?.exchangeOrder) window.open(`/print/sales-issue/${ticket.exchangeOrder.id}?type=${type}`, '_blank', 'noopener');
  }

  function diagnose(event: SubmitEvent) {
    event.preventDefault();
    const payload: WarrantyFaultLine[] = lines
      .filter((line) => line.symptom.trim())
      .map((line) => ({
        receivedDate: line.receivedDate,
        symptom: line.symptom.trim(),
        faultCode: optional(line.faultCode),
        rootCause: optional(line.rootCause),
        action: optional(line.action),
        partCode: optional(line.partCode),
        note: optional(line.note),
      })) as WarrantyFaultLine[];
    void act({ type: 'DIAGNOSE', lines: payload, plan, exclusion: exclusion || undefined, quoteAmount: plan === 'QUOTE' ? quoteAmount : undefined, note: optional(note) });
  }
</script>

<svelte:head><title>{ticket?.code ?? m.wr_nav_list()} · INOXPRAN ERP</title></svelte:head>

{#if ticket}
  {@const sla = ticket.sla}
  <section class="page-head">
    <div>
      <nav class="crumbs" aria-label={m.duong_dan()}><a href="/warranty">{m.wr_nav_list()}</a><span>{ticket.code}</span></nav>
      <h1 class="page-title">{ticket.code}{#if ticket.legacyCode}<small class="legacy-code">{m.wr_ma_cu({ code: ticket.legacyCode })}</small>{/if}</h1>
      <p class="pills">
        <span class={`pill ${statusTone[ticket.status]}`}>{statusText(ticket.status)}</span>
        <span class={`pill ${coverageTone[ticket.coverage]}`}>{ticketCoverageText(ticket)}{ticket.exclusion ? ` · ${exclusionText(ticket.exclusion)}` : ''}</span>
        <span class={`pill tone-${sla.tone}`}>{toneText(sla.tone)} · {slaText(sla)}</span>
        {#if serviceNumber > 1}<span class="pill orange">{m.wr_repeat_badge({ count: serviceNumber })}</span>{/if}
      </p>
    </div>
    <div class="actions">
      {#if isStaff && !['RETURNED', 'CANCELLED'].includes(ticket.status)}<button class="btn" onclick={() => { intakeUnlocked = false; intakeRequestId = ''; editOpen = true; }}><Pencil size={16} />{m.wr_act_edit()}</button>{/if}
      {#if isApprover && editableStages.length}<button class="btn" onclick={openStagePick}><FilePen size={16} />{m.wr_sua_theo_giai_doan()}</button>
      {:else if isStaff && editableStages.length && !pendingEdit && !myEditGrant}<button class="btn" onclick={openStagePick}><FilePen size={16} />{m.wr_yeu_cau_sua_phieu()}</button>{/if}
      {#if isStaff && actions.includes('RESCHEDULE')}<button class="btn" onclick={() => (rescheduleOpen = true)}><CalendarClock size={16} />{m.wr_reschedule()}</button>{/if}
      {#if isStaff && actions.includes('CANCEL')}<button class="btn danger" onclick={() => (cancelOpen = true)}><X size={16} />{m.wr_act_cancel()}</button>{/if}
      {#if ticket.exchangeOrder}
        {#if canOpen(`/print/sales-issue/${ticket.exchangeOrder.id}`)}
        <button class="btn" onclick={() => printExchange('BH')}><Printer size={16} />{m.in_phieu_bh()}</button>
        <button class="btn" onclick={() => printExchange('SWK')}><Printer size={16} />{m.in_phieu_swk()}</button>
        {/if}
      {:else if needsExchangeOrder && isStaff}
        <button class="btn primary" disabled={busy || !exchangeStaffId} title={exchangeStaffId ? '' : m.lp_chon_nguoi_phu_trach()} onclick={issueExchangeOrder}><Plus size={16} />{m.bhx_lap_phieu()}</button>
      {/if}
      <a class="btn navy" href={`/print/warranty/${ticket.id}`} target="_blank" rel="noopener"><Printer size={16} />{m.wr_print()}</a>
    </div>
  </section>

  {#if error}<div class="banner error"><CircleAlert size={17} /><span>{error}</span></div>{/if}
  {#if needsExchangeOrder && isStaff}
    <div class="banner warning"><TriangleAlert size={17} />
      <div class="exchange-body"><span>{m.bhx_can_lap({ sku: ticket.product.sku })}</span>
        <div class="field exchange-staff"><label for="exchange-staff-late">{m.bhx_nguoi_phu_trach()} <span class="req">*</span></label><StaffSelect id="exchange-staff-late" bind:value={exchangeStaffId} options={staff} missing={!exchangeStaffId} placeholder={m.lp_chon_nguoi_phu_trach()} /></div>
      </div>
    </div>
  {/if}
  {#if pendingEdit}
    <div class="banner warning edit-request">
      <Hourglass size={17} />
      <span>{m.wr_yc_dang_cho({ who: pendingEdit.requestedByName, stage: stageText(pendingEdit.stage), at: dateTime(pendingEdit.requestedAt) })} <b>{m.wr_reason()}:</b> {pendingEdit.reason}</span>
      <span class="edit-actions">
        {#if pendingEdit.requestedById === session.user?.sub}<button class="btn small" disabled={busy} onclick={() => withdrawEdit(pendingEdit.id)}>{m.wr_yc_rut()}</button>{/if}
        {#if isApprover}
          <button class="btn small danger-soft" disabled={busy} onclick={() => { decideApproved = false; decideNote = ''; decideOpen = true; }}>{m.wr_reject()}</button>
          <button class="btn small primary" disabled={busy} onclick={() => { decideApproved = true; decideNote = ''; decideOpen = true; }}>{m.wr_approve()}</button>
        {/if}
      </span>
    </div>
  {/if}
  {#if myEditGrant}
    <div class="banner success edit-request">
      <FilePen size={17} />
      <span>{m.wr_yc_duoc_sua({ stage: stageText(myEditGrant.stage), by: myEditGrant.decidedByName ?? '—', at: dateTime(myEditGrant.expiresAt ?? '') })}</span>
      <span class="edit-actions">
        <button class="btn small" disabled={busy} onclick={() => withdrawEdit(myEditGrant.id)}>{m.wr_yc_tra_quyen()}</button>
        <button class="btn small primary" onclick={() => openStageForm(myEditGrant.stage, myEditGrant.id)}>{m.wr_sua_giai_doan({ stage: stageText(myEditGrant.stage) })}</button>
      </span>
    </div>
  {/if}
  {#if issuedNotice}<div class="banner success"><CircleCheck size={17} />{m.wr_issue_done(issuedNotice)}</div>
  {:else if notice}<div class="banner success"><CircleCheck size={17} />{notice === 'created' ? m.wr_created({ code: ticket.code }) : notice === 'edited' ? m.wr_edit_saved({ code: ticket.code }) : notice === 'requested' ? m.wr_yc_da_gui() : notice === 'edit-granted' ? m.wr_yc_da_duyet({ hours: WARRANTY_EDIT_GRANT_HOURS }) : notice === 'edit-rejected' ? m.wr_yc_da_tu_choi() : notice === 'edit-withdrawn' ? m.wr_yc_da_rut() : m.wr_saved({ code: ticket.code })}</div>{/if}

  <article class={`card sla tone-${sla.tone}`}>
    <header class="card-head"><h2>{m.wr_sla_title()}</h2><b class="sla-text">{slaText(sla)}</b></header>
    <div class="track" aria-hidden="true">
      <i class="fill" style={`width:${Math.min(100, Math.max(2, (sla.tone === 'closed' ? 1 : sla.elapsedRatio) * 100))}%`}></i>
      <i class="mark" style={`left:${70}%`}></i>
    </div>
    <dl class="milestones">
      <div><dt>{m.wr_sla_received()}</dt><dd>{dateTime(ticket.receivedAt)}</dd></div>
      <div class="warn"><dt>{m.wr_sla_warning_from()}</dt><dd>{dateTime(sla.warningAt)}</dd></div>
      <div><dt>{m.wr_sla_due()}</dt><dd>{date(ticket.promisedDate)} 23:59{#if ticket.reschedules.length}<small>{m.wr_original_promise({ date: date(ticket.originalPromisedDate) })}</small>{/if}</dd></div>
      {#if ticket.returnedAt}<div><dt>{m.wr_st_returned()}</dt><dd>{dateTime(ticket.returnedAt)}</dd></div>{/if}
    </dl>
  </article>

  <section class="info">
    <article class="card">
      <header class="card-head"><h2>{m.khach_hang()}</h2></header>
      <dl class="facts">
        <div><dt>{m.wr_customer_name()}</dt><dd>{ticket.customer.code ? `${ticket.customer.code} — ` : ''}{ticket.customer.name}</dd></div>
        <div><dt>{m.dien_thoai()}</dt><dd>{ticket.customer.phone ?? '—'}</dd></div>
        <div><dt>{m.dia_chi()}</dt><dd>{ticket.customer.address ?? '—'}</dd></div>
        <div><dt>{m.wr_channel()}</dt><dd>{channelText(ticket.channel)}</dd></div>
      </dl>
    </article>
    <article class="card">
      <header class="card-head"><h2>{m.wr_info_product()}</h2></header>
      <dl class="facts">
        <div><dt>{m.wr_product()}</dt><dd><b>{ticket.product.sku}</b> — {ticket.product.name}</dd></div>
        <div><dt>{m.wr_serial()}</dt><dd>{ticket.product.serial ?? '—'}</dd></div>
        <div><dt>{m.wr_accessories()}</dt><dd>{ticket.accessories ?? '—'}</dd></div>
        <div><dt>{m.wr_condition()}</dt><dd>{ticket.condition ?? '—'}</dd></div>
        {#if ticket.loaner}<div><dt>{m.wr_loaner()}</dt><dd>{ticket.loaner}</dd></div>{/if}
      </dl>
    </article>
    <article class="card">
      <header class="card-head"><h2>{m.wr_info_warranty()}</h2></header>
      <dl class="facts">
        <div><dt>{m.wr_invoice_no()}</dt><dd>{ticket.invoice ? `${ticket.invoice.number} · ${date(ticket.invoice.date)}` : ticket.invoicelessWarranty ? m.wr_noinv_ticket({ decision: m.wr_noinv_warranty() }) : m.wr_ex_no_invoice()}{#if ticket.declaredPurchaseDate}<small>{m.wr_noinv_declared_on({ date: date(ticket.declaredPurchaseDate) })}</small>{/if}</dd></div>
        <div><dt>{m.wr_warranty_start()}</dt><dd>{ticket.warranty.startsOn ? date(ticket.warranty.startsOn) : '—'}</dd></div>
        <div><dt>{m.wr_warranty_end()}</dt><dd>{ticket.warranty.expiresOn ? date(ticket.warranty.expiresOn) : '—'}{#if ticket.warranty.extensionDays}<small>+{m.wr_days_count({ days: ticket.warranty.extensionDays })}</small>{/if}</dd></div>
        <div><dt>{m.wr_warranty_left()}</dt><dd>{warrantyLeft === null ? '—' : warrantyLeft >= 0 ? m.wr_days_count({ days: warrantyLeft }) : m.wr_expired()}</dd></div>
        <div><dt>{m.wr_prior_services()}</dt><dd>{ticket.warranty.priorServiceCount}</dd></div>
      </dl>
    </article>
    <article class="card">
      <header class="card-head"><h2>{m.wr_info_receipt()}</h2></header>
      <dl class="facts">
        <div><dt>{m.wr_received_by()}</dt><dd>{ticket.receivedByName}</dd></div>
        <div><dt>{m.wr_technician()}</dt><dd>{ticket.technicianName ?? '—'}</dd></div>
        <div><dt>{m.wr_received_date()}</dt><dd>{dateTime(ticket.receivedAt)}</dd></div>
        <div><dt>{m.wr_promised_date()}</dt><dd>{date(ticket.promisedDate)}</dd></div>
      </dl>
    </article>
  </section>

  {#if serviceNumber >= REPEAT_REPAIR_THRESHOLD && !['RETURNED', 'CANCELLED'].includes(ticket.status)}
    <div class="banner warn"><TriangleAlert size={17} />{m.wr_repeat_warning({ count: ticket.warranty.priorServiceCount, next: serviceNumber })}</div>
  {/if}

  <section class="card">
    <header class="card-head"><h2>{m.wr_lines_title()}</h2></header>
    <div class="table-wrap">
      <table class="table">
        <thead><tr><th>{m.stt()}</th><th>{m.wr_col_fault()}</th><th>{m.wr_col_line_date()}</th><th>{m.wr_col_symptom()}</th><th>{m.wr_col_cause()}</th><th>{m.wr_col_action()}</th><th>{m.wr_col_part()}</th><th>{m.wr_note()}</th></tr></thead>
        <tbody>
          {#each ticket.lines as line, index}
            <tr><td>{index + 1}</td><td><span class="code">{line.faultCode ?? '—'}</span>{#if faultName(line.faultCode)}<small class="fault-name">{faultName(line.faultCode)}</small>{/if}</td><td>{date(line.receivedDate)}</td><td>{line.symptom}</td><td>{line.rootCause ?? '—'}</td><td>{line.action ?? '—'}</td><td>{line.partCode ?? '—'}</td><td class="muted">{line.note ?? ''}</td></tr>
          {/each}
        </tbody>
      </table>
    </div>
  </section>

  <WarrantyPhotos ticketId={ticket.id} photos={ticket.photos ?? []} canUpload={isStaff && ticket.status !== 'CANCELLED'} locked={ticket.status === 'RETURNED'} onchange={load} />

  <section class="bottom">
    <article class="card">
      <header class="card-head"><h2>{m.wr_result_title()}</h2></header>
      <dl class="facts">
        <div><dt>{m.wr_plan()}</dt><dd>{ticket.plan ? planText(ticket.plan) : '—'}</dd></div>
        {#if ticket.quoteAmount}<div><dt>{m.wr_quote()}</dt><dd>{vnd(ticket.quoteAmount)}{#if ticket.quoteAccepted !== undefined}<small>{ticket.quoteAccepted ? m.wr_quote_accepted() : m.wr_quote_declined()}</small>{/if}</dd></div>{/if}
        {#if ticket.approval}
          <div><dt>{m.wr_approval()}</dt><dd>{m.wr_proposal()}: {planText(ticket.approval.proposal as WarrantyPlan)} — {ticket.approval.requestedByName}
            <small>{ticket.approval.decidedAt ? `${ticket.approval.approved ? m.wr_approved() : m.wr_not_approved()} · ${ticket.approval.decidedByName} · ${dateTime(ticket.approval.decidedAt)}` : m.wr_waiting_director()}{ticket.approval.note ? ` — ${ticket.approval.note}` : ''}</small></dd></div>
        {/if}
        <div><dt>{m.wr_resolution()}</dt><dd>{ticket.result ? resolutionText(ticket.result.resolution) : '—'}{#if ticket.result}<small>{dateTime(ticket.result.completedAt)}</small>{/if}</dd></div>
        <div><dt>{m.wr_replaced_parts()}</dt><dd>{ticket.result?.replacedParts ?? '—'}</dd></div>
        <div><dt>{m.wr_cost()}</dt><dd>{ticket.result ? `${vnd(ticket.result.cost)} · ${ticket.result.chargedTo === 'COMPANY' ? m.wr_charged_company() : m.wr_charged_customer()}` : '—'}</dd></div>
        {#if ticket.test}
          <div><dt>{m.wr_act_test()}</dt><dd>
            {#each [['functional', m.wr_test_functional()], ['safety', m.wr_test_safety()], ['performance', m.wr_test_performance()]] as [key, label]}
              <span class="check-result" class:fail={!ticket.test[key as 'functional']}>{ticket.test[key as 'functional'] ? '✓' : '✗'} {label}</span>
            {/each}
            <small>{ticket.test.testedByName} · {dateTime(ticket.test.testedAt)}</small></dd></div>
        {/if}
        {#if ticket.refund}<div><dt>{m.wr_refund_amount()}</dt><dd>{vnd(ticket.refund.amount)}</dd></div>{/if}
        {#if ticket.stock}
          <div><dt>{m.wr_stock_link()}</dt><dd>
            {#if ticket.stock.exchange}{m.wr_stock_exchange_out({ warehouse: ticket.stock.exchange.warehouseName, sku: ticket.product.sku })}<br />{/if}
            {#if ticket.stock.exchangeDelivered}{m.wr_stock_exchange_delivered()}<br />{/if}
            {#if ticket.exchangeOrder}{#if canOpen(`/sales/orders/${ticket.exchangeOrder.id}`)}<a class="link" href={`/sales/orders/${ticket.exchangeOrder.id}`}>{m.bhx_phieu_bh_swk({ code: ticket.exchangeOrder.code, slip: ticket.exchangeOrder.warehouseSlipNo })}</a>{:else}{m.bhx_phieu_bh_swk({ code: ticket.exchangeOrder.code, slip: ticket.exchangeOrder.warehouseSlipNo })}{/if}<br />{/if}
            {#if ticket.stock.defect}{m.wr_stock_defect_in({ warehouse: ticket.stock.defect.warehouseName })}
            {:else if ticket.stock.returnSlip}{#if canOpen('/inventory/returns')}<a class="link" href="/inventory/returns">{m.wr_stock_return_slip({ code: ticket.stock.returnSlip.code, warehouse: ticket.stock.returnSlip.warehouseName })}</a>{:else}{m.wr_stock_return_slip({ code: ticket.stock.returnSlip.code, warehouse: ticket.stock.returnSlip.warehouseName })}{/if}
            {:else}<span class="muted">{m.wr_stock_no_slip()}</span>{/if}
            <small>{#if canOpen('/inventory/movements')}<a class="link" href={`/inventory/movements?productId=${ticket.product.productId}`}>{m.the_kho()}</a> · {/if}{dateTime(ticket.stock.movedAt)}</small></dd></div>
        {/if}
        {#if ticket.receivable}
          <div><dt>{m.wr_receivable()}</dt><dd><b>{ticket.receivable.code}</b> · {vnd(ticket.receivable.amount)}
            <small>{ticket.receivable.partnerCode} — {ticket.receivable.partnerName} · {m.wr_due_on({ date: date(ticket.receivable.dueDate) })}{#if canOpen('/receivables')} · <a class="link" href={`/receivables?search=${ticket.receivable.code}`}>{m.wr_open_receivable()}</a>{/if}</small></dd></div>
        {/if}
        {#if ticket.returnedTo}<div><dt>{m.wr_returned_to()}</dt><dd>{ticket.returnedTo}</dd></div>{/if}
        {#if ticket.cancelReason}<div><dt>{m.wr_act_cancel()}</dt><dd>{ticket.cancelReason}</dd></div>{/if}
      </dl>
    </article>

    <article class="card next">
      <header class="card-head"><h2>{m.wr_next_step()}</h2></header>
      <div class="next-body">
        {#if ticket.status === 'RETURNED' || ticket.status === 'CANCELLED'}
          <p class="muted">{m.wr_closed_note()}</p>
        {:else if ticket.status === 'PENDING_APPROVAL'}
          {#if isApprover}
            <p>{m.wr_proposal()}: <b>{planText(ticket.approval?.proposal as WarrantyPlan)}</b>{ticket.approval?.note ? ` — ${ticket.approval.note}` : ''}</p>
            <div class="field"><label for="approve-note">{m.wr_note()}</label><textarea id="approve-note" rows="2" bind:value={note}></textarea></div>
            <div class="row"><button class="btn primary" disabled={busy} onclick={() => act({ type: 'APPROVE', approved: true, note: optional(note) })}>{m.wr_approve()}</button><button class="btn" disabled={busy} onclick={() => act({ type: 'APPROVE', approved: false, note: optional(note) })}>{m.wr_reject()}</button></div>
          {:else}
            <p class="muted">{m.wr_waiting_director()}</p>
          {/if}
        {:else if ticket.status === 'AWAITING_ISSUE'}
          {#if canIssue}
            <p class="info-note">{m.wr_issue_note({ sku: ticket.product.sku, warehouse: issueInfo?.warehouse.name ?? '…', available: issueInfo?.available ?? '…' })}</p>
            {#if issueShort && issueInfo}<p class="banner error"><CircleAlert size={16} />{m.wr_issue_no_stock({ warehouse: issueInfo.warehouse.name, available: issueInfo.available, sku: ticket.product.sku })}</p>{/if}
            <div class="field"><label for="issue-keeper">{m.wr_issue_keeper()} <span class="req">*</span></label>
              <select id="issue-keeper" bind:value={issueKeeperId} class:missing={!issueKeeperId}>
                <option value="">{issueInfo && !issueInfo.keepers.length ? m.wr_issue_no_keeper() : m.wr_issue_keeper_pick()}</option>
                {#each issueInfo?.keepers ?? [] as keeper}<option value={keeper.id}>{keeper.displayName}{keeper.title ? ` — ${keeper.title}` : ''}</option>{/each}
              </select></div>
            <div class="field"><label for="exchange-staff">{m.bhx_nguoi_phu_trach()} <span class="req">*</span></label><StaffSelect id="exchange-staff" bind:value={exchangeStaffId} options={staff} missing={!exchangeStaffId} placeholder={m.lp_chon_nguoi_phu_trach()} /><small class="hint">{m.bhx_nguoi_phu_trach_hint()}</small></div>
            <div class="field"><label for="receiver">{m.wr_returned_to()}</label><input id="receiver" bind:value={receiverName} minlength="2" maxlength="120" /></div>
            <div class="field">
              <label for="return-slip">{m.wr_return_slip()}</label>
              <SuggestInput id="return-slip" bind:value={returnSlipCode} options={returnSlipSuggestions} loading={returnSlipsLoading} uppercase maxlength={40}
                placeholder={m.wr_return_slip_placeholder()} emptyText={m.wr_return_slip_none({ sku: ticket.product.sku })} toggleLabel={m.wr_mo_ds_phieu_tra()} />
              <small class="hint">{m.wr_return_slip_hint()}</small>
            </div>
            <div class="field"><label for="issue-note">{m.wr_note()}</label><textarea id="issue-note" rows="2" bind:value={note}></textarea></div>
            <button class="btn primary" disabled={busy || !issueKeeperId || !exchangeStaffId || issueShort} onclick={issueExchange}>{m.wr_issue_btn()}</button>
          {:else}
            <p class="muted">{m.wr_issue_waiting({ sku: ticket.product.sku })}</p>
          {/if}
          {#if isApprover}
            <details class="delivered-before">
              <summary>{m.wr_exchange_delivered()}</summary>
              <p class="hint">{m.wr_issue_delivered_hint()}</p>
              <div class="field"><label for="delivered-receiver">{m.wr_returned_to()}</label><input id="delivered-receiver" bind:value={receiverName} minlength="2" maxlength="120" /></div>
              <div class="field">
                <label for="delivered-return-slip">{m.wr_return_slip()}</label>
                <SuggestInput id="delivered-return-slip" bind:value={returnSlipCode} options={returnSlipSuggestions} loading={returnSlipsLoading} uppercase maxlength={40}
                  placeholder={m.wr_return_slip_placeholder()} emptyText={m.wr_return_slip_none({ sku: ticket.product.sku })} toggleLabel={m.wr_mo_ds_phieu_tra()} />
              </div>
              <button class="btn" disabled={busy || receiverName.trim().length < 2} onclick={() => act({ type: 'RETURN', receiverName: receiverName.trim(), exchangeDelivered: true, ...(returnSlipCode.trim() ? { returnSlipCode: returnSlipCode.trim() } : {}), note: optional(note) })}>{m.wr_issue_delivered_btn()}</button>
            </details>
          {/if}
        {:else if !isStaff}
          <p class="muted">{m.wr_view_only()}</p>
        {:else if ticket.status === 'RECEIVED'}
          <form class="diagnose" onsubmit={diagnose}>
            {#each lines as line, index}
              <fieldset class="line">
                <legend>{m.stt()} {index + 1}</legend>
                {#if lines.length > 1}<button type="button" class="icon-btn danger remove-line" title={m.wr_xoa_dong_loi()} aria-label={`${m.wr_xoa_dong_loi()} ${index + 1}`} onclick={() => (lines = lines.filter((_, position) => position !== index))}><Trash2 size={15} /></button>{/if}
                <label><span>{m.wr_col_fault()}</span>
                  <select bind:value={line.faultCode}>
                    <option value="">—</option>
                    {#each productFaultCodes as code}<option value={code.code}>{code.code} — {code.name}</option>{/each}
                    {#if line.faultCode && !productFaultCodes.some((code) => code.code === line.faultCode)}<option value={line.faultCode}>{line.faultCode}</option>{/if}
                  </select>
                </label>
                <label><span>{m.wr_col_part()}</span><input bind:value={line.partCode} maxlength="80" /></label>
                <label class="full"><span>{m.wr_col_symptom()}</span><input bind:value={line.symptom} maxlength="500" required minlength="3" /></label>
                <label class="full"><span>{m.wr_col_cause()}</span><input bind:value={line.rootCause} maxlength="500" /></label>
                <label class="full"><span>{m.wr_col_action()}</span><input bind:value={line.action} maxlength="500" /></label>
              </fieldset>
            {/each}
            {#if lines.length < 5}<button type="button" class="btn small" onclick={() => (lines = [...lines, { faultCode: '', receivedDate: ticket?.receivedDate ?? todayIso(), symptom: '', rootCause: '', action: '', partCode: '', note: '' }])}><Plus size={14} />{m.wr_add_line()}</button>{/if}
            <div class="field">
              <label for="exclusion">{m.wr_exclusion()}</label>
              <select id="exclusion" value={exclusion} onchange={(event) => chooseExclusion(event.currentTarget.value)} disabled={ticket.coverage === 'NOT_COVERED' && ticket.exclusion === 'NO_INVOICE'}>
                <option value="">{ticket.exclusion === 'NO_INVOICE' ? m.wr_ex_no_invoice() : m.wr_exclusion_none()}</option>
                {#each WARRANTY_EXCLUSIONS.filter((item) => item !== 'NO_INVOICE') as item}<option value={item}>{exclusionText(item)}</option>{/each}
              </select>
            </div>
            <fieldset class="plans">
              <legend>{m.wr_plan()}</legend>
              {#each allowedPlans as item}<label><input type="radio" name="plan" value={item} bind:group={plan} />{planText(item)}</label>{/each}
            </fieldset>
            {#if plan === 'QUOTE'}<div class="field"><label for="quote">{m.wr_quote_amount()}</label><NumberInput id="quote" bind:value={quoteAmount} required /><small class="hint">{vnd(quoteAmount || 0)}</small></div>{/if}
            <div class="field"><label for="diag-note">{m.wr_note()}</label><textarea id="diag-note" rows="2" bind:value={note}></textarea></div>
            <button class="btn primary" type="submit" disabled={busy}>{m.wr_save_diagnose()}</button>
          </form>
        {:else if ticket.status === 'QUOTE_PENDING'}
          <p>{m.wr_quote()}: <b>{vnd(ticket.quoteAmount ?? 0)}</b></p>
          <div class="field"><label for="quote-note">{m.wr_note()}</label><textarea id="quote-note" rows="2" bind:value={note}></textarea></div>
          <div class="row"><button class="btn primary" disabled={busy} onclick={() => act({ type: 'QUOTE_DECISION', accepted: true, note: optional(note) })}>{m.wr_customer_accepts()}</button><button class="btn" disabled={busy} onclick={() => act({ type: 'QUOTE_DECISION', accepted: false, note: optional(note) })}>{m.wr_customer_declines()}</button></div>
        {:else if ticket.status === 'REPAIRING'}
          <div class="field"><label for="resolution">{m.wr_resolution()}</label><select id="resolution" bind:value={resolution}><option value="PART_REPLACED">{resolutionText('PART_REPLACED')}</option><option value="REPAIRED">{resolutionText('REPAIRED')}</option></select></div>
          <div class="field"><label for="parts">{m.wr_replaced_parts()}</label><input id="parts" bind:value={replacedParts} maxlength="300" /></div>
          <div class="field"><label for="cost">{m.wr_cost()}</label><NumberInput id="cost" value={cost} onvalue={(value) => (cost = value || '0')} /><small class="hint">{vnd(cost)} · {companyPays ? m.wr_charged_company() : m.wr_charged_customer()}</small></div>
          <div class="field"><label for="repair-note">{m.wr_note()} / {m.wr_parts_note()}</label><textarea id="repair-note" rows="2" bind:value={note}></textarea></div>
          <div class="row">
            <button class="btn primary" disabled={busy} onclick={() => act({ type: 'REPAIR_DONE', resolution, replacedParts: optional(replacedParts), cost, note: optional(note) })}>{m.wr_act_repair_done()}</button>
            <button class="btn" disabled={busy || note.trim().length < 2} onclick={() => act({ type: 'WAIT_PARTS', note: note.trim() })}>{m.wr_act_wait_parts()}</button>
          </div>
        {:else if ticket.status === 'WAITING_PARTS'}
          <button class="btn primary" disabled={busy} onclick={() => act({ type: 'PARTS_ARRIVED' })}>{m.wr_parts_arrived()}</button>
        {:else if ticket.status === 'TESTING'}
          <p class="hint">{m.wr_test_hint()}</p>
          <label class="check"><input type="checkbox" bind:checked={checks.functional} />{m.wr_test_functional()}</label>
          <label class="check"><input type="checkbox" bind:checked={checks.safety} />{m.wr_test_safety()}</label>
          <label class="check"><input type="checkbox" bind:checked={checks.performance} />{m.wr_test_performance()}</label>
          <div class="field"><label for="test-note">{m.wr_note()}</label><textarea id="test-note" rows="2" bind:value={note}></textarea></div>
          <button class="btn primary" disabled={busy} onclick={() => act({ type: 'TEST', ...checks, note: optional(note) })}>{m.wr_record_test()}</button>
        {:else if ticket.status === 'READY'}
          {#if resolutionNow === 'REFUNDED'}
            <p class="info-note">{m.wr_return_refund_note()}</p>
            <div class="field"><label for="refund">{m.wr_refund_amount()} <span class="req">*</span></label><NumberInput id="refund" bind:value={refundAmount} /><small class="hint">{vnd(refundAmount || 0)}</small></div>
          {/if}
          {#if resolutionNow === 'REFUNDED'}
            <div class="field">
              <label for="return-slip">{m.wr_return_slip()}</label>
              <SuggestInput id="return-slip" bind:value={returnSlipCode} options={returnSlipSuggestions} loading={returnSlipsLoading} uppercase maxlength={40}
                placeholder={m.wr_return_slip_placeholder()} emptyText={m.wr_return_slip_none({ sku: ticket.product.sku })} toggleLabel={m.wr_mo_ds_phieu_tra()} />
              <small class="hint">{m.wr_return_slip_hint()}</small>
            </div>
          {/if}
          {#if billable}<p class="info-note">{m.wr_return_bill_note({ amount: vnd(ticket.result?.cost ?? 0) })}</p>{/if}
          <div class="field"><label for="receiver">{m.wr_returned_to()}</label><input id="receiver" bind:value={receiverName} required minlength="2" /></div>
          <div class="field"><label for="return-note">{m.wr_note()}</label><textarea id="return-note" rows="2" bind:value={note}></textarea></div>
          <p class="hint">{m.wr_return_signed_hint()}</p>
          <button class="btn primary" disabled={busy || receiverName.trim().length < 2 || (resolutionNow === 'REFUNDED' && !Number(refundAmount))} onclick={() => act({ type: 'RETURN', receiverName: receiverName.trim(), note: optional(note), ...(resolutionNow === 'REFUNDED' ? { refundAmount } : {}), ...(resolutionNow === 'REFUNDED' && returnSlipCode.trim() ? { returnSlipCode: returnSlipCode.trim() } : {}) })}>{m.wr_return_btn()}</button>
        {/if}
      </div>
    </article>
  </section>

  <section class="card">
    <header class="card-head"><h2>{m.wr_history()}</h2></header>
    <ol class="history">
      {#each [...ticket.history].reverse() as entry}
        <li><b>{actionText(entry.action)}</b>{#if entry.to && entry.from !== entry.to} → {statusText(entry.to as WarrantyTicket['status'])}{/if}<small>{entry.byName} · {dateTime(entry.at)}</small>{#if entry.note}<p>{entry.note}</p>{/if}</li>
      {/each}
    </ol>
  </section>

  <WarrantyIntakeDialog bind:open={editOpen} {ticket} unlocked={intakeUnlocked} requestId={intakeRequestId} onsaved={(next) => { prepare({ ...(next as Ticket), photos: ticket?.photos }); notice = 'edited'; }} />
  <WarrantyStageEditDialog bind:open={stageEditOpen} {ticket} stage={stageEditStage} requestId={stageRequestId} {faultCodes} approver={isApprover} onsaved={(next) => stageSaved(next as Ticket)} />

  <Dialog bind:open={stagePickOpen} title={isApprover ? m.wr_sua_theo_giai_doan() : m.wr_yc_sua_tieu_de({ code: ticket.code })}>
    <p class="lead">{isApprover ? m.wr_sua_truc_tiep_giai_thich() : m.wr_yc_sua_giai_thich({ hours: WARRANTY_EDIT_GRANT_HOURS })}</p>
    <fieldset class="stage-pick">
      <legend>{m.wr_chon_giai_doan()}</legend>
      {#each editableStages as stage}<label><input type="radio" name="stage-pick" value={stage} bind:group={stagePick} />{stageText(stage)}</label>{/each}
    </fieldset>
    {#if !isApprover}
      <div class="field"><label for="stage-reason">{m.wr_reason()} <span class="req">*</span></label><textarea id="stage-reason" rows="3" maxlength="300" bind:value={stageReason}></textarea>
        {#if stageReason.trim() && stageReason.trim().length < 5}<small class="error">{m.bh_ly_do_toi_thieu()}</small>{/if}</div>
    {/if}
    {#snippet footer()}
      <button class="btn" onclick={() => (stagePickOpen = false)}>{m.huy()}</button>
      <button class="btn primary" disabled={busy || (!isApprover && stageReason.trim().length < 5)} onclick={submitStagePick}>{isApprover ? m.wr_mo_form_sua() : m.wr_gui_yeu_cau()}</button>
    {/snippet}
  </Dialog>

  <Dialog bind:open={decideOpen} title={m.wr_yc_quyet_dinh_tieu_de({ stage: stageText(pendingEdit?.stage ?? 'INTAKE') })}>
    {#if pendingEdit}<p class="lead">{decideApproved ? m.wr_yc_duyet_giai_thich({ who: pendingEdit.requestedByName, hours: WARRANTY_EDIT_GRANT_HOURS }) : pendingEdit.reason}</p>{/if}
    <div class="field"><label for="decide-note">{decideApproved ? m.wr_note() : m.wr_yc_ly_do_tu_choi()}{#if !decideApproved} <span class="req">*</span>{/if}</label><textarea id="decide-note" rows="3" maxlength="300" bind:value={decideNote}></textarea></div>
    {#snippet footer()}
      <button class="btn" onclick={() => (decideOpen = false)}>{m.huy()}</button>
      <button class={`btn ${decideApproved ? 'primary' : 'danger'}`} disabled={busy || (!decideApproved && decideNote.trim().length < 5)} onclick={decideEdit}>{decideApproved ? m.wr_approve() : m.wr_reject()}</button>
    {/snippet}
  </Dialog>

  <Dialog bind:open={rescheduleOpen} title={m.wr_reschedule_title()}>
    <div class="field"><label for="new-date">{m.wr_new_date()}</label><input id="new-date" type="date" bind:value={newDate} min={ticket.receivedDate} /></div>
    <div class="field"><label for="reschedule-reason">{m.wr_reason()} <span class="req">*</span></label><textarea id="reschedule-reason" rows="2" bind:value={reason}></textarea></div>
    {#snippet footer()}
      <button class="btn" onclick={() => (rescheduleOpen = false)}>{m.huy()}</button>
      <button class="btn primary" disabled={busy || reason.trim().length < 3 || !newDate} onclick={() => act({ type: 'RESCHEDULE', promisedDate: newDate, reason: reason.trim() })}>{m.wr_reschedule()}</button>
    {/snippet}
  </Dialog>
  <Dialog bind:open={cancelOpen} title={m.wr_cancel_title()}>
    <div class="field"><label for="cancel-reason">{m.wr_reason()} <span class="req">*</span></label><textarea id="cancel-reason" rows="2" bind:value={reason}></textarea></div>
    {#snippet footer()}
      <button class="btn" onclick={() => (cancelOpen = false)}>{m.huy()}</button>
      <button class="btn danger" disabled={busy || reason.trim().length < 3} onclick={() => act({ type: 'CANCEL', reason: reason.trim() })}>{m.wr_act_cancel()}</button>
    {/snippet}
  </Dialog>
{:else if error}
  <div class="banner error"><CircleAlert size={17} /><span>{error}</span></div>
{:else}
  <p class="muted">{m.dang_tai()}</p>
{/if}

<style>
  .legacy-code { display: block; margin-top: 2px; color: var(--muted); font-size: 13px; font-weight: 500; }
  /* WAR-EDIT-01: banner yêu cầu sửa, hộp chọn giai đoạn. */
  .edit-request { flex-wrap: wrap; }
  .edit-request > span:first-of-type { flex: 1 1 320px; min-width: 0; }
  .edit-actions { display: flex; flex-wrap: wrap; gap: 8px; }
  .lead { margin: 0 0 12px; color: var(--muted); font-size: 13px; }
  .stage-pick { display: flex; flex-wrap: wrap; gap: 8px 20px; margin: 0 0 12px; padding: 10px 14px; border: 1px solid var(--line); border-radius: var(--radius-sm); }
  .stage-pick legend { padding: 0 4px; color: var(--muted); font-size: 12.5px; font-weight: 600; }
  .stage-pick label { display: flex; align-items: center; gap: 8px; font-size: 13.5px; cursor: pointer; }
  .exchange-body { display: grid; flex: 1; gap: 10px; min-width: 0; }
  .exchange-staff { max-width: 420px; }
  .exchange-staff label { color: inherit; font-weight: 600; }
  .exchange-staff :global(select) { color: var(--text); }
  .pills { display: flex; flex-wrap: wrap; gap: 8px; margin: 8px 0 0; }
  .pill.tone-overdue { background: var(--red-soft); color: var(--red); }
  .pill.tone-warning { background: var(--amber-soft); color: var(--amber); }
  .pill.tone-normal { background: var(--green-soft); color: var(--green); }
  .pill.tone-closed { background: var(--line-soft); color: var(--muted); }
  .banner.warn { border-color: #efd9a6; background: var(--amber-soft); color: var(--amber); }
  .sla { margin-bottom: 16px; padding-bottom: 16px; border-left: 5px solid var(--green); }
  .sla.tone-warning { border-left-color: var(--amber); background: #fffbf0; }
  .sla.tone-overdue { border-left-color: var(--red); background: #fff5f4; }
  .sla.tone-closed { border-left-color: var(--line); }
  .sla-text { font-size: 15px; }
  .tone-overdue .sla-text { color: var(--red); }
  .tone-warning .sla-text { color: var(--amber); }
  .track { position: relative; height: 8px; margin: 12px 20px 10px; border-radius: 4px; background: var(--line-soft); }
  .fill { position: absolute; inset: 0 auto 0 0; border-radius: 4px; background: var(--green); }
  .tone-warning .fill { background: var(--amber); }
  .tone-overdue .fill { background: var(--red); }
  .tone-closed .fill { background: var(--muted); }
  .mark { position: absolute; top: -4px; width: 2px; height: 16px; background: var(--amber); }
  .milestones { display: flex; flex-wrap: wrap; gap: 8px 36px; margin: 0; padding: 0 20px; }
  .milestones dt { color: var(--subtle); font-size: 11.5px; }
  .milestones dd { margin: 2px 0 0; font-size: 13.5px; font-weight: 600; }
  .milestones .warn dt { color: var(--amber); }
  .milestones small, .facts small { display: block; color: var(--subtle); font-size: 12px; font-weight: 400; }
  .info { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 16px; margin-bottom: 16px; }
  .facts { display: grid; gap: 10px; margin: 0; padding: 8px 20px 18px; }
  .facts dt { color: var(--subtle); font-size: 11.5px; }
  .facts dd { margin: 2px 0 0; font-size: 13.5px; }
  .bottom { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 16px; margin: 16px 0; }
  .next { border-top: 4px solid var(--orange); }
  .next-body { display: grid; gap: 12px; padding: 8px 20px 20px; }
  .next-body p { margin: 0; }
  .row { display: flex; flex-wrap: wrap; gap: 10px; }
  .diagnose { display: grid; gap: 12px; }
  .line { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px 10px; min-width: 0; margin: 0; padding: 10px 12px; border: 1px solid var(--line); border-radius: var(--radius-sm); }
  .line label { display: grid; gap: 3px; }
  .line label span { color: var(--subtle); font-size: 11.5px; }
  .line .full { grid-column: 1 / -1; }
  .line legend { padding: 0 4px; color: var(--subtle); font-size: 12px; }
  /* Nút xóa dòng nằm trên viền khung, ngang hàng "STT n" (05/11/2026). */
  .line { position: relative; }
  .remove-line { position: absolute; top: -15px; right: 8px; width: 28px; height: 28px; border: 1px solid var(--line); background: var(--surface); }
  .line input { min-height: 36px; padding: 6px 10px; border: 1px solid var(--line); border-radius: 6px; font: inherit; font-size: 13px; }
  .plans { display: grid; gap: 8px; margin: 0; padding: 10px 12px; border: 1px solid var(--line); border-radius: var(--radius-sm); }
  .plans legend { padding: 0 4px; font-size: 13px; font-weight: 500; }
  .plans label, .check { display: flex; align-items: center; gap: 8px; font-size: 13.5px; }
  .hint { color: var(--subtle); font-size: 12px; }
  .check-result { display: inline-block; margin-right: 12px; color: var(--green); font-weight: 600; }
  .check-result.fail { color: var(--red); }
  .history { display: grid; gap: 12px; margin: 0; padding: 8px 20px 20px 40px; }
  .fault-name { display: block; color: var(--subtle); font-size: 11.5px; }
  .info-note { padding: 10px 12px; border-radius: var(--radius-sm); background: var(--blue-soft); color: var(--navy); font-size: 13px; }
  .req { color: var(--red); }
  /* Kế toán xuất phiếu BH & SWK đổi bảo hành (WAR-EXCH-02): ô chọn thủ kho cùng cỡ ô nhập; ghi hàng đổi đã giao trước gập lại. */
  #issue-keeper { width: 100%; min-height: 36px; padding: 6px 10px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface); font: inherit; font-size: 13.5px; }
  #issue-keeper.missing { border-color: var(--red); }
  .next .banner { margin: 0; }
  .delivered-before { margin-top: 6px; padding-top: 10px; border-top: 1px dashed var(--line); font-size: 13px; }
  .delivered-before summary { cursor: pointer; color: var(--muted); }
  .delivered-before[open] { display: grid; gap: 10px; }
  /* Tên mã lỗi dài không đẩy khung rộng ra (điện thoại tràn ngang trước 05/11/2026). */
  .line select, .line input { width: 100%; min-width: 0; }
  .line select { min-height: 36px; padding: 6px 10px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface); font: inherit; font-size: 13px; }
  .history li { font-size: 13.5px; }
  .history small { display: block; color: var(--subtle); font-size: 12px; }
  .history p { margin: 3px 0 0; color: var(--muted); }
  @media (max-width: 1200px) { .info { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  @media (max-width: 900px) { .info, .bottom { grid-template-columns: 1fr; } }
</style>
