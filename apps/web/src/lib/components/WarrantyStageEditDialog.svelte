<script lang="ts">
  /**
   * Sửa dữ liệu một giai đoạn đã qua của phiếu bảo hành (WAR-EDIT-01, 06/11/2026): Chẩn đoán / Sửa chữa / Kiểm tra / Trả khách —
   * cả phiếu đã trả khách. Người duyệt (Quản lý kho / Admin) sửa thẳng; nhân viên bảo hành sửa theo yêu cầu đã được duyệt
   * (`requestId`, một lần). Giai đoạn Tiếp nhận dùng hộp "Sửa thông tin tiếp nhận". Hướng xử lý không đổi ở đây.
   */
  import type { WarrantyFaultCode, WarrantyFaultLine, WarrantyReturnSlipOption, WarrantyTicket } from '@inoxpran/contracts';
  import { untrack } from 'svelte';
  import { CircleAlert, Info, Plus, Trash2 } from 'lucide-svelte';
  import { m } from '$lib/paraglide/messages';
  import { api } from '$lib/api';
  import { date, todayIso, vnd } from '$lib/format';
  import { exclusionText, planText, resolutionText, stageText } from '$lib/warranty';
  import { WARRANTY_EXCLUSIONS, type WarrantyExclusion } from '$shared/warranty';
  import Dialog from './Dialog.svelte';
  import NumberInput from './NumberInput.svelte';
  import SuggestInput, { type Suggestion } from './SuggestInput.svelte';

  type Stage = 'DIAGNOSE' | 'REPAIR' | 'TEST' | 'RETURN';
  type EditableLine = { faultCode: string; receivedDate: string; symptom: string; rootCause: string; action: string; partCode: string; note: string };

  let { open = $bindable(false), ticket, stage, requestId = '', faultCodes = [], onsaved }: {
    open?: boolean;
    ticket: WarrantyTicket;
    stage: Stage;
    requestId?: string;
    faultCodes?: WarrantyFaultCode[];
    onsaved?: (next: WarrantyTicket) => void;
  } = $props();

  let reason = $state('');
  let error = $state('');
  let saving = $state(false);
  let lines = $state<EditableLine[]>([]);
  let exclusion = $state<WarrantyExclusion | ''>('');
  let quoteAmount = $state('');
  let resolution = $state<'REPAIRED' | 'PART_REPLACED'>('REPAIRED');
  let replacedParts = $state('');
  let cost = $state('0');
  let chargedTo = $state<'COMPANY' | 'CUSTOMER'>('COMPANY');
  let note = $state('');
  let checks = $state({ functional: true, safety: true, performance: true });
  let returnedDate = $state('');
  let receiverName = $state('');
  let refundAmount = $state('');
  let returnSlipCode = $state('');
  let returnSlips = $state<WarrantyReturnSlipOption[]>([]);
  let returnSlipsLoading = $state(false);

  const noInvoiceExclusion = $derived(ticket.exclusion === 'NO_INVOICE');
  const productFaultCodes = $derived(faultCodes.filter((row) => row.active && (!row.categoryIds.length || row.categoryNames.includes(ticket.product.categoryName ?? ''))));
  const resolutionNow = $derived(ticket.result?.resolution);
  const linksReturnSlip = $derived(resolutionNow === 'EXCHANGED' || resolutionNow === 'REFUNDED');
  const suggestions = $derived<Suggestion[]>(returnSlips.map((slip) => ({ value: slip.code, label: slip.partnerName, detail: `${date(slip.date)} · SL ${slip.quantity} · ${slip.warehouseName}`, muted: !slip.samePartner })));

  $effect(() => {
    if (!open) return;
    untrack(() => {
      reason = '';
      error = '';
      note = '';
      lines = ticket.lines.map((line) => ({ faultCode: line.faultCode ?? '', receivedDate: line.receivedDate, symptom: line.symptom, rootCause: line.rootCause ?? '', action: line.action ?? '', partCode: line.partCode ?? '', note: line.note ?? '' }));
      exclusion = ticket.exclusion && ticket.exclusion !== 'NO_INVOICE' ? ticket.exclusion : '';
      quoteAmount = ticket.quoteAmount ? String(Math.round(Number(ticket.quoteAmount))) : '';
      resolution = ticket.result?.resolution === 'PART_REPLACED' ? 'PART_REPLACED' : 'REPAIRED';
      replacedParts = ticket.result?.replacedParts ?? '';
      cost = ticket.result ? String(Math.round(Number(ticket.result.cost))) : '0';
      chargedTo = ticket.result?.chargedTo ?? 'COMPANY';
      if (stage === 'REPAIR') note = ticket.result?.note ?? '';
      if (stage === 'TEST') {
        note = ticket.test?.note ?? '';
        checks = { functional: Boolean(ticket.test?.functional), safety: Boolean(ticket.test?.safety), performance: Boolean(ticket.test?.performance) };
      }
      returnedDate = ticket.returnedAt ? new Date(new Date(ticket.returnedAt).getTime() + 7 * 3_600_000).toISOString().slice(0, 10) : todayIso();
      receiverName = ticket.returnedTo ?? ticket.customer.name;
      refundAmount = ticket.refund ? String(Math.round(Number(ticket.refund.amount))) : '';
      returnSlipCode = ticket.stock?.returnSlip?.code ?? '';
      if (stage === 'RETURN' && linksReturnSlip && !returnSlips.length) {
        returnSlipsLoading = true;
        void api<WarrantyReturnSlipOption[]>(`/warranty/tickets/${ticket.id}/return-slips`).then((rows) => (returnSlips = rows)).catch(() => undefined).finally(() => (returnSlipsLoading = false));
      }
    });
  });

  const optional = (value: string) => value.trim() || undefined;

  function payload(): Record<string, unknown> {
    if (stage === 'DIAGNOSE') {
      const filled: WarrantyFaultLine[] = lines.filter((line) => line.symptom.trim()).map((line) => ({
        receivedDate: line.receivedDate,
        symptom: line.symptom.trim(),
        faultCode: optional(line.faultCode),
        rootCause: optional(line.rootCause),
        action: optional(line.action),
        partCode: optional(line.partCode),
        note: optional(line.note),
      })) as WarrantyFaultLine[];
      return { lines: filled, exclusion: exclusion || undefined, ...(ticket.plan === 'QUOTE' ? { quoteAmount } : {}) };
    }
    if (stage === 'REPAIR') return { resolution, replacedParts: optional(replacedParts), cost: cost || '0', chargedTo, note: optional(note) };
    if (stage === 'TEST') return { ...checks, note: optional(note) };
    return {
      returnedDate,
      receiverName: receiverName.trim(),
      ...(resolutionNow === 'REFUNDED' ? { refundAmount } : {}),
      ...(linksReturnSlip ? { returnSlipCode: returnSlipCode.trim() } : {}),
    };
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    error = '';
    if (reason.trim().length < 3) {
      error = m.inv_ghi_chu_toi_thieu();
      return;
    }
    saving = true;
    try {
      const next = await api<WarrantyTicket>(`/warranty/tickets/${ticket.id}/stages`, {
        method: 'PATCH',
        idempotentCommand: true,
        body: JSON.stringify({ stage, version: ticket.version, reason: reason.trim(), ...(requestId ? { requestId } : {}), ...payload() }),
      });
      open = false;
      onsaved?.(next);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.wr_load_error();
    } finally {
      saving = false;
    }
  }
</script>

<Dialog bind:open title={m.wr_sua_giai_doan_tieu_de({ stage: stageText(stage), code: ticket.code })} wide>
  <form id="warranty-stage-edit" class="grid" onsubmit={submit}>
    {#if error}<div class="banner error span"><CircleAlert size={17} /><span>{error}</span></div>{/if}
    {#if stage === 'DIAGNOSE'}
      <p class="hint span"><Info size={15} />{m.wr_sua_chan_doan_goi_y({ plan: ticket.plan ? planText(ticket.plan) : '—' })}</p>
      {#each lines as line, index}
        <fieldset class="line span">
          <legend>{m.stt()} {index + 1}</legend>
          {#if lines.length > 1}<button type="button" class="icon-btn danger remove-line" title={m.wr_xoa_dong_loi()} aria-label={`${m.wr_xoa_dong_loi()} ${index + 1}`} onclick={() => (lines = lines.filter((_, position) => position !== index))}><Trash2 size={15} /></button>{/if}
          <label><span>{m.wr_col_fault()}</span>
            <select bind:value={line.faultCode}>
              <option value="">—</option>
              {#each productFaultCodes as code}<option value={code.code}>{code.code} — {code.name}</option>{/each}
              {#if line.faultCode && !productFaultCodes.some((code) => code.code === line.faultCode)}<option value={line.faultCode}>{line.faultCode}</option>{/if}
            </select>
          </label>
          <label><span>{m.wr_col_line_date()}</span><input type="date" bind:value={line.receivedDate} max={todayIso()} required /></label>
          <label><span>{m.wr_col_part()}</span><input bind:value={line.partCode} maxlength="80" /></label>
          <label class="full"><span>{m.wr_col_symptom()}</span><input bind:value={line.symptom} maxlength="500" required minlength="3" /></label>
          <label class="full"><span>{m.wr_col_cause()}</span><input bind:value={line.rootCause} maxlength="500" /></label>
          <label class="full"><span>{m.wr_col_action()}</span><input bind:value={line.action} maxlength="500" /></label>
        </fieldset>
      {/each}
      {#if lines.length < 5}<div class="span"><button type="button" class="btn small" onclick={() => (lines = [...lines, { faultCode: '', receivedDate: ticket.receivedDate, symptom: '', rootCause: '', action: '', partCode: '', note: '' }])}><Plus size={14} />{m.wr_add_line()}</button></div>{/if}
      <div class="field">
        <label for="se-exclusion">{m.wr_exclusion()}</label>
        <select id="se-exclusion" bind:value={exclusion} disabled={noInvoiceExclusion}>
          <option value="">{noInvoiceExclusion ? m.wr_ex_no_invoice() : m.wr_exclusion_none()}</option>
          {#each WARRANTY_EXCLUSIONS.filter((item) => item !== 'NO_INVOICE') as item}<option value={item}>{exclusionText(item)}</option>{/each}
        </select>
      </div>
      {#if ticket.plan === 'QUOTE'}<div class="field"><label for="se-quote">{m.wr_quote_amount()}</label><NumberInput id="se-quote" bind:value={quoteAmount} required /><small class="field-hint">{vnd(quoteAmount || 0)}</small></div>{/if}
    {:else if stage === 'REPAIR'}
      {#if ticket.status === 'RETURNED'}<p class="hint span"><Info size={15} />{m.wr_sua_sua_chua_da_tra()}</p>{/if}
      <div class="field"><label for="se-resolution">{m.wr_resolution()}</label><select id="se-resolution" bind:value={resolution}><option value="PART_REPLACED">{resolutionText('PART_REPLACED')}</option><option value="REPAIRED">{resolutionText('REPAIRED')}</option></select></div>
      <div class="field wide"><label for="se-parts">{m.wr_replaced_parts()}</label><input id="se-parts" bind:value={replacedParts} maxlength="300" /></div>
      <div class="field"><label for="se-cost">{m.wr_cost()}</label><NumberInput id="se-cost" value={cost} onvalue={(value) => (cost = value || '0')} /><small class="field-hint">{vnd(cost)}</small></div>
      <fieldset class="choice wide">
        <legend>{m.wr_ben_chiu_phi()}</legend>
        <label><input type="radio" name="se-charged" value="COMPANY" bind:group={chargedTo} />{m.wr_charged_company()}</label>
        <label><input type="radio" name="se-charged" value="CUSTOMER" bind:group={chargedTo} />{m.wr_charged_customer()}</label>
      </fieldset>
      <div class="field span"><label for="se-note">{m.wr_note()}</label><textarea id="se-note" rows="2" bind:value={note} maxlength="500"></textarea></div>
    {:else if stage === 'TEST'}
      <label class="check"><input type="checkbox" bind:checked={checks.functional} />{m.wr_test_functional()}</label>
      <label class="check"><input type="checkbox" bind:checked={checks.safety} />{m.wr_test_safety()}</label>
      <label class="check"><input type="checkbox" bind:checked={checks.performance} />{m.wr_test_performance()}</label>
      <div class="field span"><label for="se-test-note">{m.wr_note()}</label><textarea id="se-test-note" rows="2" bind:value={note} maxlength="500"></textarea></div>
    {:else}
      <p class="hint span"><Info size={15} />{m.wr_sua_tra_khach_goi_y()}</p>
      <div class="field"><label for="se-returned">{m.wr_ngay_tra_khach()} <span class="req">*</span></label><input id="se-returned" type="date" bind:value={returnedDate} min={ticket.receivedDate} max={todayIso()} required /></div>
      <div class="field wide"><label for="se-receiver">{m.wr_returned_to()} <span class="req">*</span></label><input id="se-receiver" bind:value={receiverName} required minlength="2" maxlength="120" /></div>
      {#if resolutionNow === 'REFUNDED'}<div class="field"><label for="se-refund">{m.wr_refund_amount()} <span class="req">*</span></label><NumberInput id="se-refund" bind:value={refundAmount} /><small class="field-hint">{vnd(refundAmount || 0)}</small></div>{/if}
      {#if linksReturnSlip}
        <div class="field wide">
          <label for="se-return-slip">{m.wr_return_slip()}</label>
          <SuggestInput id="se-return-slip" bind:value={returnSlipCode} options={suggestions} loading={returnSlipsLoading} uppercase maxlength={40}
            placeholder={m.wr_return_slip_placeholder()} emptyText={m.wr_return_slip_none({ sku: ticket.product.sku })} toggleLabel={m.wr_mo_ds_phieu_tra()} />
        </div>
      {/if}
    {/if}
    <div class="field span"><label for="se-reason">{m.wr_edit_reason()} <span class="req">*</span></label><input id="se-reason" bind:value={reason} maxlength="300" required minlength="3" /></div>
  </form>
  {#snippet footer()}
    <button type="button" class="btn" onclick={() => (open = false)}>{m.huy()}</button>
    <button type="submit" class="btn primary" form="warranty-stage-edit" disabled={saving}>{saving ? m.kh_dang_luu() : m.inv_luu_thay_doi()}</button>
  {/snippet}
</Dialog>

<style>
  .grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px 16px; align-items: start; }
  .span { grid-column: 1 / -1; }
  .wide { grid-column: span 2; }
  .req { color: var(--red); }
  .hint { display: flex; align-items: flex-start; gap: 8px; margin: 0; padding: 10px 12px; border-radius: var(--radius-sm); background: var(--surface-2); color: var(--muted); font-size: 13px; }
  .line { position: relative; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px 12px; margin: 0; padding: 12px; border: 1px solid var(--line); border-radius: var(--radius-sm); min-width: 0; }
  .line legend { padding: 0 4px; color: var(--muted); font-size: 12.5px; font-weight: 600; }
  .line label { display: grid; gap: 4px; min-width: 0; font-size: 12.5px; color: var(--muted); }
  .line label.full { grid-column: 1 / -1; }
  .line select, .line input { width: 100%; min-width: 0; }
  .remove-line { position: absolute; top: -12px; right: 8px; background: var(--surface); }
  .choice { display: flex; flex-wrap: wrap; gap: 8px 22px; margin: 0; padding: 10px 14px; border: 1px solid var(--line); border-radius: var(--radius-sm); }
  .choice legend { padding: 0 4px; color: var(--muted); font-size: 12.5px; font-weight: 600; }
  .choice label, .check { display: flex; align-items: center; gap: 8px; font-size: 13.5px; cursor: pointer; }
  .field-hint { color: var(--muted); font-size: 12px; }
  @media (max-width: 760px) { .grid, .line { grid-template-columns: 1fr; } .wide { grid-column: auto; } }
</style>
