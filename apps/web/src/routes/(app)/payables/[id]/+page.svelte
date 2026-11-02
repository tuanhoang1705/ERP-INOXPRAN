<script lang="ts">
  /**
   * Sổ phải trả một nhà cung cấp (D2, 22/10/2026): tổng theo tiền tệ, từng đơn mua (đặt / đã nhận / trả lại / đã trả / còn phải trả),
   * các phát sinh theo ngày (nhập kho +, trả nhà máy −, đã trả −) kèm số dư lũy kế; kế toán ghi tiền đã trả ngay tại đây.
   */
  import { m } from '$lib/paraglide/messages';
  import type { PayableStatement } from '@inoxpran/contracts';
  import { page } from '$app/state';
  import { untrack } from 'svelte';
  import { CircleAlert, CircleCheck, HandCoins } from 'lucide-svelte';
  import { api } from '$lib/api';
  import { date, todayIso, vnd } from '$lib/format';
  import { hasRole, purchaseStatus } from '$lib/labels';
  import { session } from '$lib/session.svelte';
  import { money, paymentKindLabel } from '$lib/purchase';
  import Dialog from '$lib/components/Dialog.svelte';
  import NumberInput from '$lib/components/NumberInput.svelte';

  let data = $state<PayableStatement | null>(null);
  let error = $state('');
  let success = $state('');
  let loading = $state(true);
  const canPay = $derived(hasRole(session.user?.roles, ['ACCOUNTANT', 'PROCUREMENT_MANAGER']));
  const payable = $derived((data?.orders ?? []).filter((order) => order.status !== 'CANCELLED'));

  let payOpen = $state(false);
  let paying = $state(false);
  let payError = $state('');
  let pay = $state({ orderId: '', kind: 'BALANCE', amount: '', paidOn: todayIso(), reference: '', note: '' });
  const payOrder = $derived(payable.find((order) => order.id === pay.orderId));

  async function load(id: string) {
    loading = true;
    error = '';
    try {
      data = await api<PayableStatement>(`/payables/${id}`);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.apb_khong_tai_duoc();
    } finally {
      loading = false;
    }
  }
  $effect(() => {
    const id = page.params.id;
    if (id) untrack(() => void load(id));
  });

  function openPay(orderId?: string) {
    const target = payable.find((order) => order.id === orderId) ?? payable.find((order) => Number(order.balance) > 0) ?? payable[0];
    pay = { orderId: target?.id ?? '', kind: target && Number(target.received) > 0 ? 'BALANCE' : 'DEPOSIT', amount: target && Number(target.balance) > 0 ? target.balance : '', paidOn: todayIso(), reference: '', note: '' };
    payError = '';
    payOpen = true;
  }
  async function savePay(event: SubmitEvent) {
    event.preventDefault();
    if (!payOrder || !(Number(pay.amount) > 0)) {
      payError = m.apb_nhap_so_tien();
      return;
    }
    paying = true;
    try {
      await api(`/purchase-orders/${payOrder.id}/payments`, {
        method: 'POST',
        body: JSON.stringify({ kind: pay.kind, amount: pay.amount, paidOn: pay.paidOn, ...(pay.reference.trim() ? { reference: pay.reference.trim() } : {}), ...(pay.note.trim() ? { note: pay.note.trim() } : {}) }),
      });
      success = m.apb_da_ghi_tra({ amount: money(pay.amount, payOrder.currency), order: payOrder.code });
      payOpen = false;
      await load(page.params.id as string);
    } catch (caught) {
      payError = caught instanceof Error ? caught.message : m.crud_loi_luu();
    } finally {
      paying = false;
    }
  }
  const eventLabel = (kind: string, paymentKind?: string) => (kind === 'RECEIPT' ? m.apb_nhap_kho() : kind === 'RETURN' ? m.apb_tra_nha_may() : `${m.po_da_tra()} · ${paymentKindLabel(paymentKind ?? 'OTHER')}`);
</script>

<svelte:head><title>{data?.supplier.name ?? m.apb_title()} · {m.apb_title()} · INOXPRAN ERP</title></svelte:head>

<section class="page-head">
  <div>
    <nav class="crumbs" aria-label={m.duong_dan()}><a href="/payables">{m.apb_title()}</a><span>{data?.supplier.code ?? ''}</span></nav>
    <h1 class="page-title">{data?.supplier.name ?? m.apb_title()}</h1>
    {#if data}<p class="page-sub">{data.supplier.code}{data.supplier.taxCode ? ` · MST ${data.supplier.taxCode}` : ''}{data.supplier.phone ? ` · ${data.supplier.phone}` : ''}</p>{/if}
  </div>
  {#if canPay && payable.length}
    <div class="actions"><button class="btn primary" onclick={() => openPay()}><HandCoins size={16} />{m.apb_ghi_tra()}</button></div>
  {/if}
</section>

{#if error}<div class="banner error"><CircleAlert size={17} />{error}</div>{/if}
{#if success}<div class="banner success"><CircleCheck size={17} />{success}</div>{/if}
{#if loading && !data}<p class="muted">{m.dang_tai()}</p>{/if}

{#if data}
  <section class="totals">
    {#each data.totals as row (row.currency)}
      <article class="card stat">
        <span>{m.apb_con_phai_tra()} · {row.currency}</span>
        <b class:credit={Number(row.balance) < 0}>{money(row.balance, row.currency)}</b>
        <small>{m.apb_da_nhan()} {money(row.received, row.currency)} · {m.po_da_tra()} {money(row.paid, row.currency)}{Number(row.returned) ? ` · ${m.apb_tra_nha_may()} ${money(row.returned, row.currency)}` : ''}</small>
        {#if row.currency !== 'VND'}<small>≈ {vnd(row.balanceVnd)}</small>{/if}
        {#if Number(row.balance) < 0}<small class="credit">{m.apb_tra_truoc_giai_thich()}</small>{/if}
      </article>
    {/each}
  </section>

  <section class="card">
    <header class="card-head"><h2>{m.apb_theo_don()}</h2></header>
    <div class="table-wrap">
      <table class="table compact">
        <thead><tr><th>{m.don_mua()}</th><th class="num">{m.apb_gia_tri_dat()}</th><th class="num">{m.apb_da_nhan()}</th><th class="num">{m.apb_tra_nha_may()}</th><th class="num">{m.po_da_tra()}</th><th class="num">{m.apb_con_phai_tra()}</th>{#if canPay}<th></th>{/if}</tr></thead>
        <tbody>
          {#each data.orders as order (order.id)}
            {@const status = purchaseStatus[order.status]}
            <tr>
              <td>
                <a class="code" href={`/procurement/${order.id}`}>{order.code}</a>
                {#if status}<span class={`pill ${status.tone}`}>{status.label}</span>{/if}
                <small>{date(order.createdAt)}{order.supplierContractNo ? ` · ${order.supplierContractNo}` : ''}{order.exchangeRate ? ` · ${m.apb_ty_gia({ rate: order.exchangeRate })}` : ''}</small>
                {#if order.paymentTerms}<small>{order.paymentTerms}</small>{/if}
              </td>
              <td class="num muted">{money(order.ordered, order.currency)}</td>
              <td class="num">{money(order.received, order.currency)}</td>
              <td class="num muted">{Number(order.returned) ? money(order.returned, order.currency) : '—'}</td>
              <td class="num muted">{money(order.paid, order.currency)}</td>
              <td class="num"><b class:credit={Number(order.balance) < 0}>{money(order.balance, order.currency)}</b>{#if order.currency !== 'VND'}<small>≈ {vnd(order.balanceVnd)}</small>{/if}</td>
              {#if canPay}<td class="act">{#if order.status !== 'CANCELLED'}<button class="btn small" onclick={() => openPay(order.id)}>{m.apb_tra()}</button>{/if}</td>{/if}
            </tr>
          {:else}<tr class="empty-row"><td colspan={canPay ? 7 : 6}>{m.apb_chua_co()}</td></tr>{/each}
        </tbody>
      </table>
    </div>
  </section>

  <section class="card">
    <header class="card-head"><h2>{m.apb_phat_sinh()}</h2></header>
    <div class="table-wrap">
      <table class="table compact">
        <thead><tr><th>{m.apb_ngay()}</th><th>{m.chung_tu()}</th><th>{m.dien_giai()}</th><th class="num">{m.apb_tang()}</th><th class="num">{m.apb_giam()}</th><th class="num">{m.apb_so_du()}</th></tr></thead>
        <tbody>
          {#each [...data.events].reverse() as event, index (`${event.kind}-${event.code}-${event.date}-${index}`)}
            <tr>
              <td>{date(event.date)}</td>
              <td><span class="code">{event.code}</span>{#if event.kind !== 'PAYMENT'}<small><a href={`/procurement/${event.orderId}`}>{event.orderCode}</a></small>{/if}</td>
              <td>{eventLabel(event.kind, event.paymentKind)}{#if event.reference}<small>{event.reference}</small>{/if}{#if event.note}<small>{event.note}</small>{/if}{#if event.byName}<small>{event.byName}</small>{/if}</td>
              <td class="num">{Number(event.increase) ? money(event.increase, event.currency) : ''}</td>
              <td class="num muted">{Number(event.decrease) ? money(event.decrease, event.currency) : ''}</td>
              <td class="num"><b class:credit={Number(event.balance) < 0}>{money(event.balance, event.currency)}</b></td>
            </tr>
          {:else}<tr class="empty-row"><td colspan="6">{m.apb_chua_phat_sinh()}</td></tr>{/each}
        </tbody>
      </table>
    </div>
  </section>
  <p class="hint">{m.apb_giai_thich()}</p>
{/if}

<Dialog bind:open={payOpen} title={m.apb_ghi_tra()}>
  <form id="payable-pay" class="pay" onsubmit={savePay}>
    {#if payError}<div class="banner error"><CircleAlert size={17} /><span>{payError}</span></div>{/if}
    <div class="field">
      <label for="pay-order">{m.don_mua()} <span class="req">*</span></label>
      <select id="pay-order" bind:value={pay.orderId} required>
        {#each payable as order (order.id)}<option value={order.id}>{order.code} · {m.apb_con_phai_tra()} {money(order.balance, order.currency)}</option>{/each}
      </select>
    </div>
    <div class="field"><label for="pay-kind">{m.po_loai()}</label><select id="pay-kind" bind:value={pay.kind}><option value="DEPOSIT">{m.po_dat_coc()}</option><option value="BALANCE">{m.po_thanh_toan_con_lai()}</option><option value="OTHER">{m.po_khac()}</option></select></div>
    <div class="field"><label for="pay-amount">{m.crm_so_tien()} ({payOrder?.currency ?? 'VND'}) <span class="req">*</span></label><NumberInput id="pay-amount" decimals={2} bind:value={pay.amount} required /></div>
    <div class="field"><label for="pay-date">{m.apb_ngay_tra()}</label><input id="pay-date" type="date" bind:value={pay.paidOn} max={todayIso()} required /></div>
    <div class="field"><label for="pay-ref">{m.po_chung_tu_ngan_hang()}</label><input id="pay-ref" bind:value={pay.reference} maxlength="80" /></div>
    <div class="field"><label for="pay-note">{m.ghi_chu()}</label><input id="pay-note" bind:value={pay.note} maxlength="300" /></div>
  </form>
  {#snippet footer()}
    <button type="button" class="btn" onclick={() => (payOpen = false)}>{m.huy()}</button>
    <button type="submit" class="btn primary" form="payable-pay" disabled={paying}><HandCoins size={15} />{paying ? m.kh_dang_luu() : m.apb_ghi_tra()}</button>
  {/snippet}
</Dialog>

<style>
  .totals { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 280px), 1fr)); gap: 12px; margin-bottom: 16px; }
  .stat { display: grid; gap: 4px; padding: 14px 16px; }
  .stat span { color: var(--subtle); font-size: 12px; }
  .stat b { font-size: 20px; }
  .stat small { color: var(--muted); font-size: 12.5px; }
  .credit { color: var(--green) !important; }
  td small { display: block; color: var(--subtle); font-size: 11.5px; }
  .pill { margin-left: 6px; }
  td.act { width: 1%; white-space: nowrap; }
  .hint { color: var(--subtle); font-size: 12.5px; }
  .pay { display: grid; gap: 12px; }
  .req { color: var(--red); }
</style>
