<script lang="ts">
  import { m } from '$lib/paraglide/messages';
  import type { WarrantyFaultCode, WarrantyFaultLine, WarrantyTicket } from '@inoxpran/contracts';
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { untrack } from 'svelte';
  import { CalendarClock, CircleAlert, CircleCheck, Pencil, Plus, Printer, TriangleAlert, X } from 'lucide-svelte';
  import Dialog from '$lib/components/Dialog.svelte';
  import WarrantyPhotos from '$lib/components/WarrantyPhotos.svelte';
  import WarrantyIntakeDialog from '$lib/components/WarrantyIntakeDialog.svelte';
  import NumberInput from '$lib/components/NumberInput.svelte';
  import { api } from '$lib/api';
  import { date, dateTime, todayIso, vnd } from '$lib/format';
  import { hasRole } from '$lib/labels';
  import { session } from '$lib/session.svelte';
  import {
    actionText, channelText, coverageTone, ticketCoverageText, exclusionText, planText, resolutionText, slaText, statusText, statusTone, toneText,
    WARRANTY_APPROVERS, WARRANTY_STAFF, type SlaView,
  } from '$lib/warranty';
  import {
    remainingWarrantyDays, REPEAT_REPAIR_THRESHOLD, WARRANTY_ACTIONS_BY_STATUS, WARRANTY_EXCLUSIONS,
    type WarrantyCoverage, type WarrantyExclusion, type WarrantyPlan,
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
  /** Trả khách đổi mới / hoàn tiền (20/10/2026): hàng đổi đã giao trước; số phiếu trả hàng đã nhập hàng lỗi (chỉ liên kết). */
  let exchangeDelivered = $state(false);
  let returnSlipCode = $state('');
  let editOpen = $state(false);
  let faultCodes = $state<WarrantyFaultCode[]>([]);

  const isStaff = $derived(hasRole(session.user?.roles, WARRANTY_STAFF));
  const isApprover = $derived(hasRole(session.user?.roles, WARRANTY_APPROVERS));
  const actions = $derived(ticket ? WARRANTY_ACTIONS_BY_STATUS[ticket.status] : []);
  const effectiveCoverage = $derived<WarrantyCoverage>(exclusion ? 'NOT_COVERED' : (ticket?.coverage ?? 'NOT_COVERED'));
  const allowedPlans = $derived<WarrantyPlan[]>(
    effectiveCoverage === 'IN_WARRANTY' ? ['REPAIR', 'EXCHANGE', 'REFUND'] : effectiveCoverage === 'OUT_OF_WARRANTY' ? ['QUOTE'] : ['QUOTE', 'REJECT'],
  );
  const serviceNumber = $derived(ticket ? ticket.warranty.priorServiceCount + 1 : 1);
  const warrantyLeft = $derived(ticket?.warranty.expiresOn ? remainingWarrantyDays(ticket.warranty.expiresOn, todayIso()) : null);
  /** Mã lỗi của nhóm hàng của sản phẩm + mã dùng chung. */
  const productFaultCodes = $derived(faultCodes.filter((row) => row.active && (!row.categoryIds.length || row.categoryNames.includes(ticket?.product.categoryName ?? ''))));
  const faultName = (code: string | undefined) => (code ? faultCodes.find((row) => row.code === code)?.name : undefined);
  const resolutionNow = $derived(ticket?.result?.resolution);
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
    plan = next.coverage === 'IN_WARRANTY' ? 'REPAIR' : 'QUOTE';
    quoteAmount = next.quoteAmount ? String(Math.round(Number(next.quoteAmount))) : '';
    cost = next.coverage === 'IN_WARRANTY' ? '0' : quoteAmount || '0';
    replacedParts = next.result?.replacedParts ?? '';
    checks = { functional: false, safety: false, performance: false };
    receiverName = next.customer.name;
    newDate = next.promisedDate;
    reason = '';
    refundAmount = '';
    exchangeDelivered = false;
    returnSlipCode = '';
  }

  $effect(() => {
    if (!allowedPlans.includes(plan)) plan = allowedPlans[0] as WarrantyPlan;
  });

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
      <h1 class="page-title">{ticket.code}</h1>
      <p class="pills">
        <span class={`pill ${statusTone[ticket.status]}`}>{statusText(ticket.status)}</span>
        <span class={`pill ${coverageTone[ticket.coverage]}`}>{ticketCoverageText(ticket)}{ticket.exclusion ? ` · ${exclusionText(ticket.exclusion)}` : ''}</span>
        <span class={`pill tone-${sla.tone}`}>{toneText(sla.tone)} · {slaText(sla)}</span>
        {#if serviceNumber > 1}<span class="pill orange">{m.wr_repeat_badge({ count: serviceNumber })}</span>{/if}
      </p>
    </div>
    <div class="actions">
      {#if isStaff && !['RETURNED', 'CANCELLED'].includes(ticket.status)}<button class="btn" onclick={() => (editOpen = true)}><Pencil size={16} />{m.wr_act_edit()}</button>{/if}
      {#if isStaff && actions.includes('RESCHEDULE')}<button class="btn" onclick={() => (rescheduleOpen = true)}><CalendarClock size={16} />{m.wr_reschedule()}</button>{/if}
      {#if isStaff && actions.includes('CANCEL')}<button class="btn danger" onclick={() => (cancelOpen = true)}><X size={16} />{m.wr_act_cancel()}</button>{/if}
      <a class="btn navy" href={`/print/warranty/${ticket.id}`} target="_blank" rel="noopener"><Printer size={16} />{m.wr_print()}</a>
    </div>
  </section>

  {#if error}<div class="banner error"><CircleAlert size={17} /><span>{error}</span></div>{/if}
  {#if notice}<div class="banner success"><CircleCheck size={17} />{notice === 'created' ? m.wr_created({ code: ticket.code }) : notice === 'edited' ? m.wr_edit_saved({ code: ticket.code }) : m.wr_saved({ code: ticket.code })}</div>{/if}

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
            {#if ticket.stock.defect}{m.wr_stock_defect_in({ warehouse: ticket.stock.defect.warehouseName })}
            {:else if ticket.stock.returnSlip}<a class="link" href="/inventory/returns">{m.wr_stock_return_slip({ code: ticket.stock.returnSlip.code, warehouse: ticket.stock.returnSlip.warehouseName })}</a>
            {:else}<span class="muted">{m.wr_stock_no_slip()}</span>{/if}
            <small><a class="link" href={`/inventory/movements?productId=${ticket.product.productId}`}>{m.the_kho()}</a> · {dateTime(ticket.stock.movedAt)}</small></dd></div>
        {/if}
        {#if ticket.receivable}
          <div><dt>{m.wr_receivable()}</dt><dd><b>{ticket.receivable.code}</b> · {vnd(ticket.receivable.amount)}
            <small>{ticket.receivable.partnerCode} — {ticket.receivable.partnerName} · {m.wr_due_on({ date: date(ticket.receivable.dueDate) })} · <a class="link" href={`/receivables?search=${ticket.receivable.code}`}>{m.wr_open_receivable()}</a></small></dd></div>
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
        {:else if !isStaff}
          <p class="muted">{m.wr_view_only()}</p>
        {:else if ticket.status === 'RECEIVED'}
          <form class="diagnose" onsubmit={diagnose}>
            {#each lines as line, index}
              <fieldset class="line">
                <legend>{m.stt()} {index + 1}</legend>
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
              <select id="exclusion" bind:value={exclusion} disabled={ticket.coverage === 'NOT_COVERED' && ticket.exclusion === 'NO_INVOICE'}>
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
          <div class="field"><label for="cost">{m.wr_cost()}</label><NumberInput id="cost" value={cost} onvalue={(value) => (cost = value || '0')} /><small class="hint">{vnd(cost)} · {ticket.coverage === 'IN_WARRANTY' ? m.wr_charged_company() : m.wr_charged_customer()}</small></div>
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
          {#if resolutionNow === 'EXCHANGED'}<p class="info-note">{m.wr_return_exchange_note({ sku: ticket.product.sku })}</p>{/if}
          {#if resolutionNow === 'REFUNDED'}
            <p class="info-note">{m.wr_return_refund_note()}</p>
            <div class="field"><label for="refund">{m.wr_refund_amount()} <span class="req">*</span></label><NumberInput id="refund" bind:value={refundAmount} /><small class="hint">{vnd(refundAmount || 0)}</small></div>
          {/if}
          {#if resolutionNow === 'EXCHANGED'}<label class="check"><input type="checkbox" bind:checked={exchangeDelivered} />{m.wr_exchange_delivered()}</label>{/if}
          {#if resolutionNow === 'EXCHANGED' || resolutionNow === 'REFUNDED'}
            <div class="field"><label for="return-slip">{m.wr_return_slip()}</label><input id="return-slip" value={returnSlipCode} maxlength="40" placeholder="NK2026100007" autocomplete="off" oninput={(event) => (returnSlipCode = event.currentTarget.value.toUpperCase())} /><small class="hint">{m.wr_return_slip_hint()}</small></div>
          {/if}
          {#if billable}<p class="info-note">{m.wr_return_bill_note({ amount: vnd(ticket.result?.cost ?? 0) })}</p>{/if}
          <div class="field"><label for="receiver">{m.wr_returned_to()}</label><input id="receiver" bind:value={receiverName} required minlength="2" /></div>
          <div class="field"><label for="return-note">{m.wr_note()}</label><textarea id="return-note" rows="2" bind:value={note}></textarea></div>
          <p class="hint">{m.wr_return_signed_hint()}</p>
          <button class="btn primary" disabled={busy || receiverName.trim().length < 2 || (resolutionNow === 'REFUNDED' && !Number(refundAmount))} onclick={() => act({ type: 'RETURN', receiverName: receiverName.trim(), note: optional(note), ...(resolutionNow === 'REFUNDED' ? { refundAmount } : {}), ...(resolutionNow === 'EXCHANGED' && exchangeDelivered ? { exchangeDelivered: true } : {}), ...((resolutionNow === 'EXCHANGED' || resolutionNow === 'REFUNDED') && returnSlipCode.trim() ? { returnSlipCode: returnSlipCode.trim() } : {}) })}>{m.wr_return_btn()}</button>
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

  <WarrantyIntakeDialog bind:open={editOpen} {ticket} onsaved={(next) => { prepare({ ...(next as Ticket), photos: ticket?.photos }); notice = 'edited'; }} />

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
  .line { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 10px; margin: 0; padding: 10px 12px; border: 1px solid var(--line); border-radius: var(--radius-sm); }
  .line label { display: grid; gap: 3px; }
  .line label span { color: var(--subtle); font-size: 11.5px; }
  .line .full { grid-column: 1 / -1; }
  .line legend { padding: 0 4px; color: var(--subtle); font-size: 12px; }
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
  .line select { min-height: 36px; padding: 6px 10px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface); font: inherit; font-size: 13px; }
  .history li { font-size: 13.5px; }
  .history small { display: block; color: var(--subtle); font-size: 12px; }
  .history p { margin: 3px 0 0; color: var(--muted); }
  @media (max-width: 1200px) { .info { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  @media (max-width: 900px) { .info, .bottom { grid-template-columns: 1fr; } }
</style>
