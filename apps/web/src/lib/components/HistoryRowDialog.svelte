<script lang="ts" module>
  /** Dữ liệu dòng sổ công nợ cũ để sửa / xóa (CN-HIST-EDIT-01) — trả kèm trong sổ chi tiết công nợ khách. */
  export type HistoryRowInfo = {
    kind: 'DOCUMENT' | 'PAYMENT'; version?: number; date: string; documentNo?: string; invoiceNo?: string; amount: string; note?: string;
    paymentKind?: string; erpPaid?: string; erpPayments?: string[]; edited?: { at: string; byName: string; reason: string }; added?: boolean;
    numbered?: boolean; salesOrderCode?: string; locked?: 'PAY_NOW' | 'STOCK_RETURN';
  };
  export type HistoryRowResult = { action: 'CREATED' | 'UPDATED' | 'DELETED'; kind: 'DOCUMENT' | 'PAYMENT'; code: string; balance: string };
</script>

<script lang="ts">
  /**
   * Sửa / xóa một dòng nhập từ sổ công nợ cũ (CN-HIST-EDIT-01, 02/11/2026): chứng từ bán hoặc phiếu thu / phí vận chuyển /
   * trả hàng của lô lịch sử công nợ. Bắt buộc lý do; lưu xong máy chủ tự phân bổ lại tiền đã thu và khoản trả trước của khách.
   * 03/11/2026: mọi dòng sổ công nợ (không chỉ sổ cũ); chế độ "create" thêm phát sinh nợ / phiếu thu cho khách `partnerId`.
   * Công nợ của phiếu BH: chỉ sửa số tiền / ngày / ghi chú (số phiếu giữ nguyên), phiếu BH không đổi.
   */
  import { m } from '$lib/paraglide/messages';
  import { api } from '$lib/api';
  import { num, todayIso, vnd } from '$lib/format';
  import Dialog from '$lib/components/Dialog.svelte';
  import NumberInput from '$lib/components/NumberInput.svelte';

  let {
    open = $bindable(false), mode, id, code, info, partnerId = '', onsaved,
  }: { open?: boolean; mode: 'edit' | 'delete' | 'create'; id: string; code: string; info: HistoryRowInfo | null; partnerId?: string; onsaved: (result: HistoryRowResult) => void } = $props();

  let date = $state('');
  let documentNo = $state('');
  let invoiceNo = $state('');
  let amount = $state('');
  let note = $state('');
  let paymentKind = $state<'RECEIPT' | 'FREIGHT' | 'RETURN'>('RECEIPT');
  /** Thêm dòng: chứng từ bán hoặc loại phiếu giảm nợ. */
  let rowType = $state<'DOCUMENT' | 'RECEIPT' | 'FREIGHT' | 'RETURN'>('DOCUMENT');
  let reason = $state('');
  let working = $state(false);
  let error = $state('');

  const creating = $derived(mode === 'create');
  const isDocument = $derived(creating ? rowType === 'DOCUMENT' : info?.kind === 'DOCUMENT');
  const minimum = $derived(Number(info?.erpPaid ?? 0));
  const tooLow = $derived(isDocument && minimum > 0 && Number(amount || 0) < minimum);
  const blockedDelete = $derived(mode === 'delete' && isDocument && minimum > 0);
  /** Ô số chứng từ / số HĐ: dòng sổ cũ, dòng thêm tay; công nợ phiếu BH / phí bảo hành giữ số gốc. */
  const numbered = $derived(creating || !isDocument || Boolean(info?.numbered));
  const title = $derived(creating ? m.hx_tieu_de_them() : mode === 'delete' ? m.hx_tieu_de_xoa({ code }) : isDocument ? m.hx_tieu_de_sua_ct({ code }) : m.hx_tieu_de_sua_phieu({ code }));
  const path = $derived(`/receivables/history/${isDocument ? 'documents' : 'payments'}${creating ? '' : `/${id}`}`);

  // Mở hộp thoại: điền sẵn số hiện tại của dòng.
  $effect(() => {
    if (open && creating) {
      rowType = 'DOCUMENT';
      date = todayIso();
      documentNo = '';
      invoiceNo = '';
      amount = '';
      note = '';
      reason = '';
      error = '';
      return;
    }
    if (!open || !info) return;
    date = info.date;
    documentNo = info.documentNo ?? '';
    invoiceNo = info.invoiceNo ?? '';
    amount = String(Math.round(Number(info.amount) * 100) / 100);
    note = info.note ?? '';
    paymentKind = (info.paymentKind as 'RECEIPT' | 'FREIGHT' | 'RETURN' | undefined) ?? 'RECEIPT';
    reason = '';
    error = '';
  });

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if ((!creating && !info) || reason.trim().length < 5 || working) return;
    working = true;
    error = '';
    try {
      const body = mode === 'delete'
        ? { ...(info?.version ? { version: info.version } : {}), reason: reason.trim() }
        : isDocument
          ? { ...(creating ? { partnerId } : { version: info?.version }), date, amount, reason: reason.trim(), ...(documentNo.trim() ? { documentNo: documentNo.trim() } : {}), ...(invoiceNo.trim() ? { invoiceNo: invoiceNo.trim() } : {}), ...(note.trim() ? { note: note.trim() } : {}) }
          : { ...(creating ? { partnerId } : {}), date, kind: creating ? rowType : paymentKind, amount, reason: reason.trim(), ...(documentNo.trim() ? { reference: documentNo.trim() } : {}), ...(note.trim() ? { note: note.trim() } : {}) };
      const result = await api<HistoryRowResult>(path, { method: creating ? 'POST' : mode === 'delete' ? 'DELETE' : 'PATCH', idempotentCommand: true, body: JSON.stringify(body) });
      open = false;
      onsaved(result);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.crud_loi_luu();
    } finally {
      working = false;
    }
  }
</script>

<Dialog bind:open {title}>
  <form id="history-row-form" class="history-form" onsubmit={submit}>
    <p class="muted">{m.hx_giai_thich()}</p>
    {#if !creating && info?.salesOrderCode}<p class="warn">{m.hx_canh_bao_bh({ code: info.salesOrderCode })}</p>{/if}
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    {#if mode === 'delete'}
      {#if blockedDelete}
        <p class="error">{m.hx_khong_xoa_erp({ amount: num(info?.erpPaid ?? 0), codes: info?.erpPayments?.join(', ') ?? '' })}</p>
      {:else}
        <p>{m.hx_xoa_hoi({ code, amount: vnd(info?.amount ?? 0) })}</p>
      {/if}
    {:else}
      <div class="grid">
        {#if creating}
          <div class="field"><label for="hx-type">{m.hx_loai_dong()}</label>
            <select id="hx-type" bind:value={rowType}>
              <option value="DOCUMENT">{m.hx_loai_phat_sinh()}</option>
              <option value="RECEIPT">{m.hx_loai_thu()}</option>
              <option value="FREIGHT">{m.hx_loai_vc()}</option>
              <option value="RETURN">{m.hx_loai_tra()}</option>
            </select>
          </div>
        {/if}
        <div class="field"><label for="hx-date">{isDocument ? m.hx_ngay_ct() : m.hx_ngay()}</label><input id="hx-date" type="date" max={todayIso()} bind:value={date} required /></div>
        {#if !isDocument && !creating}
          <div class="field"><label for="hx-kind">{m.hx_loai()}</label>
            <select id="hx-kind" bind:value={paymentKind}>
              <option value="RECEIPT">{m.hx_loai_thu()}</option>
              <option value="FREIGHT">{m.hx_loai_vc()}</option>
              <option value="RETURN">{m.hx_loai_tra()}</option>
            </select>
          </div>
        {/if}
        {#if numbered}<div class="field"><label for="hx-no">{m.hx_so_ct()}</label><input id="hx-no" bind:value={documentNo} maxlength={isDocument ? 60 : 100} autocomplete="off" /></div>{/if}
        {#if isDocument && numbered}<div class="field"><label for="hx-invoice">{m.hx_so_hd()}</label><input id="hx-invoice" bind:value={invoiceNo} maxlength="60" autocomplete="off" /></div>{/if}
        <div class="field"><label for="hx-amount">{m.hx_so_tien()} <span class="req">*</span></label><NumberInput id="hx-amount" bind:value={amount} decimals={2} /><small class="hint">{vnd(amount || 0)}</small></div>
      </div>
      {#if isDocument && minimum > 0}<p class:error={tooLow} class:muted={!tooLow}>{m.hx_erp_da_thu({ amount: num(info?.erpPaid ?? 0), codes: info?.erpPayments?.join(', ') ?? '' })}</p>{/if}
      <div class="field"><label for="hx-note">{m.hx_dien_giai()}</label><textarea id="hx-note" rows="2" maxlength="500" bind:value={note}></textarea></div>
    {/if}
    {#if !blockedDelete}
      <div class="field"><label for="hx-reason">{creating ? m.hx_ly_do_them() : mode === 'delete' ? m.hx_ly_do_xoa() : m.hx_ly_do()} <span class="req">*</span></label><input id="hx-reason" bind:value={reason} required minlength="5" maxlength="300" autocomplete="off" /></div>
    {/if}
  </form>
  {#snippet footer()}
    <button type="button" class="btn" onclick={() => (open = false)}>{m.huy()}</button>
    {#if !blockedDelete}
      <button class={`btn ${mode === 'delete' ? 'danger' : 'primary'}`} form="history-row-form" disabled={working || reason.trim().length < 5 || (mode !== 'delete' && (!date || !(Number(amount) > 0) || tooLow))}>
        {working ? m.kh_dang_luu() : creating ? m.hx_them() : mode === 'delete' ? m.hx_xoa() : m.crud_luu()}
      </button>
    {/if}
  {/snippet}
</Dialog>

<style>
  .history-form { display: grid; gap: 14px; }
  .history-form p { margin: 0; font-size: 13px; }
  .history-form .error { color: var(--red, #b42318); }
  .history-form .warn { padding: 8px 10px; border-radius: 8px; background: var(--orange-soft, #fff4ec); color: #b4501f; }
  .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); align-items: start; gap: 12px; }
  @media (max-width: 560px) { .grid { grid-template-columns: 1fr; } }
</style>
