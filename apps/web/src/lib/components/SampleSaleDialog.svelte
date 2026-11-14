<script lang="ts">
  /**
   * Khách mua luôn hàng mẫu (SAMPLE-SALE-01, 12/11/2026): thủ kho chọn kế toán, khách hàng và số lượng từng mã (không quá số còn ở
   * ngoài) → kế toán nhận thông báo và lập phiếu BH theo luồng thường. Phiếu BH xuất kho xong thì hàng tự bù lại kho đã xuất mẫu.
   */
  import type { SalesIssuer } from '@inoxpran/contracts';
  import { untrack } from 'svelte';
  import { CircleAlert, Send } from 'lucide-svelte';
  import { m } from '$lib/paraglide/messages';
  import { api } from '$lib/api';
  import { num } from '$lib/format';
  import type { CustomerOption } from '$lib/customer-search';
  import CustomerPicker from './CustomerPicker.svelte';
  import Dialog from './Dialog.svelte';
  import NumberInput from './NumberInput.svelte';

  type LoanLine = { productId: string; sku: string; productName: string; unit: string; remaining: string };
  type Slip = { id: string; code: string; version: number; recipientCustomerId?: string | undefined; loanLines?: LoanLine[] | undefined };

  let { open = $bindable(false), slip, onsaved }: { open?: boolean; slip: Slip; onsaved: () => void } = $props();

  let issuers = $state<SalesIssuer[]>([]);
  let customers = $state<CustomerOption[]>([]);
  let loaded = $state(false);
  let accountantId = $state('');
  let customerId = $state('');
  let quantities = $state<Record<string, string>>({});
  let note = $state('');
  let error = $state('');
  let saving = $state(false);

  const lines = $derived((slip.loanLines ?? []).filter((line) => Number(line.remaining) > 0));
  const chosen = $derived(lines.filter((line) => Number(quantities[line.productId] || 0) > 0).map((line) => ({ productId: line.productId, quantity: String(Number(quantities[line.productId])) })));
  const overLimit = $derived(lines.some((line) => Number(quantities[line.productId] || 0) > Number(line.remaining)));

  $effect(() => {
    if (!open) return;
    untrack(() => {
      error = '';
      note = '';
      quantities = Object.fromEntries(lines.map((line) => [line.productId, String(Number(line.remaining))]));
      customerId = slip.recipientCustomerId ?? '';
      loaded = false;
      void Promise.all([
        api<SalesIssuer[]>('/sample-issues/issuers').then((rows) => { issuers = rows; if (rows.length === 1) accountantId = rows[0]!.id; }),
        api<{ rows: Array<CustomerOption & { status?: string }> }>('/dealers?stage=CUSTOMER').then((result) => (customers = result.rows.filter((row) => row.status !== 'INACTIVE'))),
      ])
        .catch((caught) => (error = caught instanceof Error ? caught.message : m.khong_tai_duoc_du_lieu_danh()))
        .finally(() => (loaded = true));
    });
  });

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!accountantId || !customerId || !chosen.length) {
      error = m.xm_ban_thieu();
      return;
    }
    if (overLimit) return;
    saving = true;
    error = '';
    try {
      await api(`/sample-issues/${slip.id}/sale-requests`, {
        method: 'POST', idempotentCommand: true,
        body: JSON.stringify({ version: slip.version, accountantId, customerId, lines: chosen, ...(note.trim() ? { note: note.trim() } : {}) }),
      });
      open = false;
      onsaved();
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.khong_the_hoan_tat_thao_tac();
    } finally {
      saving = false;
    }
  }
</script>

<Dialog bind:open title={m.xm_ban_tieu_de({ code: slip.code })} wide>
  <form id="sample-sale-form" class="form" onsubmit={submit} oninput={() => (error = '')} novalidate>
    <p class="note">{m.xm_ban_giai_thich()}</p>
    {#if error}<div class="banner error"><CircleAlert size={17} /><span>{error}</span></div>{/if}
    <div class="grid">
      <div class="field">
        <label for="ss-accountant">{m.xm_ke_toan_nhan()} <span class="req">*</span></label>
        <select id="ss-accountant" bind:value={accountantId} class:missing={!accountantId}>
          <option value="">{loaded ? m.xm_chon_ke_toan() : m.dang_tai()}</option>
          {#each issuers as row (row.id)}<option value={row.id}>{row.displayName}{row.title ? ` — ${row.title}` : ''}</option>{/each}
        </select>
      </div>
      <div class="field">
        <label for="ss-customer">{m.xm_khach_mua()} <span class="req">*</span></label>
        <CustomerPicker id="ss-customer" options={customers} value={customerId} onchoose={(id) => (customerId = id)} loading={!loaded} />
      </div>
    </div>
    <div class="table-wrap">
      <table class="table compact">
        <thead><tr><th>{m.ten_san_pham()}</th><th class="num">{m.lp_con_ngoai()}</th><th class="qty">{m.xm_so_ban()}</th></tr></thead>
        <tbody>
          {#each lines as line (line.productId)}
            <tr>
              <td><span class="code">{line.sku}</span><small>{line.productName}</small></td>
              <td class="num">{num(line.remaining)} {line.unit}</td>
              <td class="qty"><NumberInput class="input" decimals={4} aria-label={`${m.xm_so_ban()} ${line.sku}`} bind:value={quantities[line.productId]} /></td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
    {#if overLimit}<p class="err">{m.xm_ban_vuot()}</p>{/if}
    <div class="field"><label for="ss-note">{m.ghi_chu()}</label><input id="ss-note" bind:value={note} maxlength="300" placeholder={m.xm_ban_ghi_chu_goi_y()} /></div>
  </form>
  {#snippet footer()}
    <button type="button" class="btn" onclick={() => (open = false)}>{m.huy()}</button>
    <button type="submit" class="btn primary" form="sample-sale-form" disabled={saving || overLimit || !loaded}><Send size={15} />{saving ? m.kh_dang_luu() : m.xm_gui_yeu_cau()}</button>
  {/snippet}
</Dialog>

<style>
  .form { display: grid; gap: 14px; }
  .note { margin: 0; color: var(--muted); font-size: 12.5px; }
  .err { margin: 0; color: var(--red); font-size: 13px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px 16px; }
  .req { color: var(--red); }
  .compact td, .compact th { padding: 6px 10px; }
  td small { display: block; color: var(--subtle); font-size: 11.5px; }
  .qty { width: 160px; }
  select.missing { border-color: var(--orange, #e2733a); }
  @media (max-width: 640px) {
    .grid { grid-template-columns: 1fr; }
    .qty { width: 110px; }
  }
</style>
