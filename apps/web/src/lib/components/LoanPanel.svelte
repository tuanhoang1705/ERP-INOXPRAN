<script lang="ts">
  /**
   * Hàng của phiếu xuất hàng mẫu / kiểm định (SAL-TYPE-01): đã xuất / đã về / còn ở ngoài theo mã, các lần nhập lại,
   * nút "Nhập lại hàng mẫu" (thủ kho) và "Chốt phần chưa trả" (kế toán, quản lý kho).
   */
  import { m } from '$lib/paraglide/messages';
  import { goto } from '$app/navigation';
  import { CircleAlert, PackageCheck, PackageX } from 'lucide-svelte';
  import Dialog from './Dialog.svelte';
  import NumberInput from './NumberInput.svelte';
  import { api } from '$lib/api';
  import { dateTime, num } from '$lib/format';

  export type LoanLine = { productId: string; sku: string; productName: string; unit: string; shipped: string; returned: string; remaining: string };
  export type LoanReturnRow = { code: string; createdAt: string; createdByName: string; note?: string; soldConversion?: boolean; lines: Array<{ sku: string; unit: string; quantity: string }> };
  type LoanOrder = {
    id: string; code: string; version: number; purpose?: string | undefined; loanStatus?: string | undefined;
    loanCloseOutcome?: string | undefined; loanCloseReason?: string | undefined; loanClosedAt?: string | undefined; loanClosedByName?: string | undefined;
    loanLines?: LoanLine[] | undefined; loanReturns?: LoanReturnRow[] | undefined;
  };

  let { order, canReturn = false, canClose = false, onchanged }: { order: LoanOrder; canReturn?: boolean; canClose?: boolean; onchanged: (message: string) => void } = $props();

  const open = $derived(order.loanStatus === 'OUT' || order.loanStatus === 'PARTIAL');
  const lines = $derived(order.loanLines ?? []);
  let returnOpen = $state(false);
  let closeOpen = $state(false);
  let quantities = $state<Record<string, string>>({});
  let returnNote = $state('');
  let outcome = $state<'CONSUMED' | 'SOLD'>('CONSUMED');
  let closeReason = $state('');
  let working = $state(false);
  let error = $state('');

  const returnLines = $derived(lines.filter((line) => Number(quantities[line.productId] || 0) > 0).map((line) => ({ productId: line.productId, quantity: String(Number(quantities[line.productId])) })));
  const overLimit = $derived(lines.some((line) => Number(quantities[line.productId] || 0) > Number(line.remaining)));

  function startReturn() {
    quantities = Object.fromEntries(lines.map((line) => [line.productId, Number(line.remaining) > 0 ? String(Number(line.remaining)) : '']));
    returnNote = '';
    error = '';
    returnOpen = true;
  }
  function startClose() {
    outcome = 'CONSUMED';
    closeReason = '';
    error = '';
    closeOpen = true;
  }

  async function submitReturn() {
    if (!returnLines.length || overLimit) return;
    working = true;
    error = '';
    try {
      const result = await api<{ returnCode: string }>(`/sales-orders/${order.id}/loan-returns`, {
        method: 'POST', idempotentCommand: true,
        body: JSON.stringify({ version: order.version, lines: returnLines, ...(returnNote.trim() ? { note: returnNote.trim() } : {}) }),
      });
      returnOpen = false;
      onchanged(m.lp_nhap_lai_ok({ code: result.returnCode }));
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.khong_the_hoan_tat_thao_tac();
    } finally {
      working = false;
    }
  }

  async function submitClose() {
    if (closeReason.trim().length < 5) return;
    working = true;
    error = '';
    try {
      const result = await api<{ returnCode?: string }>(`/sales-orders/${order.id}/loan-close`, {
        method: 'POST', idempotentCommand: true,
        body: JSON.stringify({ version: order.version, outcome, reason: closeReason.trim() }),
      });
      closeOpen = false;
      if (outcome === 'SOLD') {
        await goto(`/sales/orders/new?fromLoan=${order.id}`);
        return;
      }
      onchanged(result.returnCode ? m.lp_chot_ok_mua_luon({ code: result.returnCode }) : m.lp_chot_ok_tieu_hao());
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.khong_the_hoan_tat_thao_tac();
    } finally {
      working = false;
    }
  }
</script>

<article class="card loan">
  <header class="card-head">
    <h2>{m.lp_hang_o_ngoai()}</h2>
    <div class="loan-actions">
      {#if open && canReturn}<button class="btn primary small" onclick={startReturn}><PackageCheck size={15} />{m.lp_nhap_lai_hang_mau()}</button>{/if}
      {#if open && canClose}<button class="btn small danger-soft" onclick={startClose}><PackageX size={15} />{m.lp_chot_phan_chua_tra()}</button>{/if}
    </div>
  </header>
  {#if order.loanStatus === 'CLOSED'}
    <p class="closed">{m.lp_da_chot_luc({ by: order.loanClosedByName ?? '—', at: order.loanClosedAt ? dateTime(order.loanClosedAt) : '—', outcome: order.loanCloseOutcome === 'SOLD' ? m.lp_ket_qua_mua_luon() : m.lp_ket_qua_tieu_hao(), reason: order.loanCloseReason ?? '—' })}</p>
  {/if}
  <div class="table-wrap">
    <table class="table">
      <thead><tr><th>{m.ma_hang()}</th><th>{m.ten_hang()}</th><th>{m.don_vi()}</th><th class="num">{m.lp_da_xuat()}</th><th class="num">{m.lp_da_ve()}</th><th class="num">{m.lp_con_ngoai()}</th></tr></thead>
      <tbody>
        {#each lines as line}
          <tr>
            <td class="code">{line.sku}</td>
            <td>{line.productName}</td>
            <td>{line.unit}</td>
            <td class="num">{num(line.shipped)}</td>
            <td class="num">{num(line.returned)}</td>
            <td class="num"><b class:out={Number(line.remaining) > 0 && order.loanStatus !== 'CLOSED'}>{num(line.remaining)}</b></td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
  {#if order.loanReturns?.length}
    <div class="history">
      <h3>{m.lp_lich_su_nhap_lai()}</h3>
      <ul>
        {#each order.loanReturns as item}
          <li>
            <b>{item.code}</b> · {dateTime(item.createdAt)} · {item.createdByName}{#if item.soldConversion} · <span class="pill orange">{m.lp_chuyen_ban()}</span>{/if}
            <small>{item.lines.map((line) => `${line.sku} × ${num(line.quantity)}${line.unit ? ` ${line.unit}` : ''}`).join(', ')}{item.note ? ` — ${item.note}` : ''}</small>
          </li>
        {/each}
      </ul>
    </div>
  {/if}
</article>

<Dialog bind:open={returnOpen} title={m.lp_nhap_lai_tieu_de({ code: order.code })} wide>
  <p class="lead">{m.lp_nhap_lai_giai_thich()}</p>
  {#if error}<div class="banner error"><CircleAlert size={16} /><span>{error}</span></div>{/if}
  <div class="table-wrap">
    <table class="table">
      <thead><tr><th>{m.ma_hang()}</th><th>{m.ten_hang()}</th><th class="num">{m.lp_con_ngoai()}</th><th class="num">{m.lp_so_luong_ve()}</th></tr></thead>
      <tbody>
        {#each lines as line}
          <tr>
            <td class="code">{line.sku}</td>
            <td>{line.productName}</td>
            <td class="num">{num(line.remaining)} {line.unit}</td>
            <td class="num"><NumberInput class={Number(quantities[line.productId] || 0) > Number(line.remaining) ? 'input qty invalid' : 'input qty'} decimals={4} bind:value={quantities[line.productId]} disabled={Number(line.remaining) <= 0} aria-label={`${m.lp_so_luong_ve()} ${line.sku}`} /></td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
  <div class="field">
    <label for="loan-return-note">{m.ghi_chu_noi_bo()}</label>
    <input id="loan-return-note" bind:value={returnNote} maxlength="300" placeholder={m.khong_bat_buoc()} />
  </div>
  {#snippet footer()}
    <button class="btn" onclick={() => (returnOpen = false)}>{m.dong()}</button>
    <button class="btn primary" disabled={!returnLines.length || overLimit || working} onclick={submitReturn}><PackageCheck size={15} />{m.lp_nhap_lai_hang_mau()}</button>
  {/snippet}
</Dialog>

<Dialog bind:open={closeOpen} title={m.lp_chot_tieu_de({ code: order.code })}>
  <p class="lead">{m.lp_chot_giai_thich()}</p>
  {#if error}<div class="banner error"><CircleAlert size={16} /><span>{error}</span></div>{/if}
  <div class="outcomes" role="radiogroup">
    <label><input type="radio" name="loan-outcome" value="CONSUMED" bind:group={outcome} /> {m.lp_tieu_hao()}</label>
    <label><input type="radio" name="loan-outcome" value="SOLD" bind:group={outcome} /> {m.lp_mua_luon()}</label>
  </div>
  <div class="field">
    <label for="loan-close-reason">{m.bh_ly_do()} <span class="req">*</span></label>
    <textarea id="loan-close-reason" rows="3" maxlength="500" bind:value={closeReason} placeholder={m.bh_ly_do_placeholder()}></textarea>
    {#if closeReason.trim() && closeReason.trim().length < 5}<small class="error">{m.bh_ly_do_toi_thieu()}</small>{/if}
  </div>
  {#snippet footer()}
    <button class="btn" onclick={() => (closeOpen = false)}>{m.dong()}</button>
    <button class="btn danger" disabled={closeReason.trim().length < 5 || working} onclick={submitClose}>{m.lp_chot_phan_chua_tra()}</button>
  {/snippet}
</Dialog>

<style>
  .loan-actions { display: flex; flex-wrap: wrap; gap: 8px; }
  .closed { margin: 0; padding: 4px 20px 10px; color: var(--muted); font-size: 13px; }
  .loan b.out { color: var(--orange); }
  .history { padding: 6px 20px 18px; }
  .history h3 { margin: 6px 0 8px; font-size: 13px; font-weight: 600; }
  .history ul { display: grid; gap: 6px; margin: 0; padding: 0; list-style: none; font-size: 13px; }
  .history small { display: block; color: var(--muted); }
  .outcomes { display: grid; gap: 8px; margin: 4px 0 14px; }
  .outcomes label { display: flex; align-items: flex-start; gap: 8px; font-size: 13.5px; line-height: 1.4; }
  .btn.danger-soft { border-color: #f3c9c9; background: var(--red-soft); color: var(--red); }
  :global(.loan .table-wrap) { padding: 0 6px; }
</style>
