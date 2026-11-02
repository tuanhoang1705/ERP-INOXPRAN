<script lang="ts">
  /**
   * Đổi nơi trừ phiếu giảm nợ trả hàng đã ghi (AR-RET-01, 27/10/2026): kế toán chuyển sang trừ vào một nhóm công nợ riêng khi cần,
   * hoặc trả về tổng công nợ. Xem trước phân bổ hiện tại / sau khi đổi và nợ thường / nợ nhóm của khách; phần đã thành khoản
   * khách trả trước không đổi.
   */
  import { m } from '$lib/paraglide/messages';
  import type { StockReturn, StockReturnCreditTargetPreview } from '@inoxpran/contracts';
  import { untrack } from 'svelte';
  import { ArrowLeftRight, CircleAlert } from 'lucide-svelte';
  import { api } from '$lib/api';
  import { date, vnd } from '$lib/format';
  import Dialog from '$lib/components/Dialog.svelte';

  type Saved = StockReturn & { partnerHoldReleased?: boolean };
  let { open = $bindable(false), target, onsaved }: { open?: boolean; target: StockReturn | null; onsaved: (row: Saved) => void } = $props();

  let segments = $state<Array<{ code: string; name: string; active: boolean }>>([]);
  let segment = $state('');
  let note = $state('');
  let preview = $state<StockReturnCreditTargetPreview | null>(null);
  let loading = $state(false);
  let saving = $state(false);
  let error = $state('');
  const current = $derived(target?.creditNote?.segment ?? '');
  const segmentName = (code: string | null | undefined) => (code ? segments.find((item) => item.code === code)?.name ?? code : m.rac_tong_cong_no());

  $effect(() => {
    if (!open || !target) return;
    untrack(() => {
      segment = current ? '' : (segments[0]?.code ?? '');
      note = '';
      error = '';
      preview = null;
      if (!segments.length) {
        void api<{ segments: Array<{ code: string; name: string; active: boolean }> }>('/receivables/segments')
          .then((result) => {
            segments = result.segments.filter((item) => item.active);
            if (!current && !segment) segment = segments[0]?.code ?? '';
          })
          .catch(() => (segments = []));
      }
    });
  });

  // Xem trước mỗi khi đổi lựa chọn (không ghi gì).
  $effect(() => {
    const id = open ? target?.id : undefined;
    const chosen = segment;
    if (!id || chosen === current) {
      untrack(() => (preview = null));
      return;
    }
    loading = true;
    error = '';
    api<StockReturnCreditTargetPreview>(`/inventory/returns/${id}/credit-target-preview${chosen ? `?segment=${encodeURIComponent(chosen)}` : ''}`)
      .then((result) => (preview = result))
      .catch((caught) => (error = caught instanceof Error ? caught.message : m.crud_loi_luu()))
      .finally(() => (loading = false));
  });

  async function save(event: SubmitEvent) {
    event.preventDefault();
    if (!target || segment === current) return;
    if (note.trim().length < 3) {
      error = m.inv_ghi_chu_toi_thieu();
      return;
    }
    saving = true;
    error = '';
    try {
      const saved = await api<Saved>(`/inventory/returns/${target.id}/credit-target`, { method: 'POST', idempotentCommand: true, body: JSON.stringify({ segment: segment || null, note: note.trim() }) });
      open = false;
      onsaved(saved);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.crud_loi_luu();
    } finally {
      saving = false;
    }
  }
</script>

<Dialog bind:open title={m.rct_tieu_de({ code: target?.creditNote?.code ?? '' })}>
  <form id="credit-target-form" class="rct" onsubmit={save}>
    {#if error}<div class="banner error"><CircleAlert size={17} /><span>{error}</span></div>{/if}
    <p class="facts">
      <span>{m.rct_dang_tru({ target: segmentName(current) })}</span>
      {#if target?.creditNote}<span>{m.rac_da_giam_no({ amount: vnd(target.creditNote.amount) })}</span>{/if}
    </p>
    <div class="field">
      <label for="rct-target">{m.rct_doi_sang()}</label>
      <select id="rct-target" bind:value={segment}>
        {#if current}<option value="">{m.rac_tong_cong_no()}</option>{/if}
        {#each segments.filter((item) => item.code !== current) as item (item.code)}<option value={item.code}>{m.rac_tru_nhom({ name: item.name })}</option>{/each}
      </select>
    </div>
    {#if loading}<p class="muted">{m.rac_dang_tinh()}</p>
    {:else if preview}
      <div class="compare">
        <div>
          <b>{m.rct_hien_tai()}</b>
          <ul>{#each preview.before as row (`${row.receivableId}-${row.segment ?? ''}`)}<li><span class="code">{row.documentNo}</span>{#if row.segment}<span class="pill neutral">{segmentName(row.segment)}</span>{/if}<b class="amount">{vnd(row.amount)}</b></li>{/each}</ul>
        </div>
        <div>
          <b>{m.rct_sau_khi_doi()}</b>
          <ul>{#each preview.after as row (`${row.receivableId}-${row.segment ?? ''}`)}<li><span class="code">{row.documentNo}</span>{#if row.segment}<span class="pill neutral">{segmentName(row.segment)}</span>{/if}{#if row.dueDate}<small class="due">{m.rac_han_tra({ date: date(row.dueDate) })}</small>{/if}<b class="amount">{vnd(row.amount)}</b></li>{/each}</ul>
        </div>
      </div>
      <p class="summary">{m.rct_no_khach({ normalBefore: vnd(preview.customerBefore.normal), normalAfter: vnd(preview.customerAfter.normal), segmentBefore: vnd(preview.customerBefore.segment), segmentAfter: vnd(preview.customerAfter.segment) })}</p>
      {#if Number(preview.credit) > 0}<p class="summary credit">{m.rct_tra_truoc_giu({ amount: vnd(preview.credit) })}</p>{/if}
    {/if}
    <div class="field">
      <label for="rct-note">{m.rac_ghi_chu()} <span class="req">*</span></label>
      <input id="rct-note" bind:value={note} maxlength="300" />
    </div>
  </form>
  {#snippet footer()}
    <button type="button" class="btn" onclick={() => (open = false)}>{m.huy()}</button>
    <button type="submit" class="btn primary" form="credit-target-form" disabled={saving || !preview || segment === current}><ArrowLeftRight size={15} />{saving ? m.kh_dang_luu() : m.rct_nut()}</button>
  {/snippet}
</Dialog>

<style>
  .rct { display: grid; gap: 14px; }
  .facts { display: flex; flex-wrap: wrap; gap: 6px 18px; margin: 0; color: var(--muted); font-size: 13.5px; }
  .compare { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; padding: 10px 12px; border: 1px dashed var(--line); border-radius: 8px; font-size: 13.5px; }
  .compare ul { display: grid; gap: 4px; margin: 6px 0 0; padding: 0; list-style: none; }
  .compare li { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
  .compare .amount { margin-left: auto; font-variant-numeric: tabular-nums; }
  .due { color: var(--subtle); font-size: 12px; }
  .summary { margin: 0; color: var(--muted); font-size: 13px; }
  .summary.credit { color: var(--amber); }
  .req { color: var(--red); }
</style>
