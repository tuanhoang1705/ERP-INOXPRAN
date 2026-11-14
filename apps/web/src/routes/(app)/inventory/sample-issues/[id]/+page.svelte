<script lang="ts">
  /**
   * Chi tiết phiếu xuất hàng mẫu SWK-M (SAMPLE-ISSUE-01, 12/11/2026): thông tin người mượn, hàng đã xuất / đã về / còn ở ngoài, các lần
   * nhập lại, yêu cầu "khách mua luôn" (SAMPLE-SALE-01). Thủ kho: In · Nhập lại · Chốt phần chưa trả · Khách mua luôn · Sửa · Hủy.
   */
  import type { SalesOrder, SampleSaleRequest, Warehouse } from '@inoxpran/contracts';
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { Ban, CircleAlert, CircleCheck, Pencil, Printer, ShoppingCart, Undo2 } from 'lucide-svelte';
  import { m } from '$lib/paraglide/messages';
  import { api } from '$lib/api';
  import { date, dateTime, num } from '$lib/format';
  import { hasRole } from '$lib/labels';
  import { can } from '$lib/permissions';
  import { session } from '$lib/session.svelte';
  import { loanAge, loanStatusInfo } from '$lib/slip-type';
  import Dialog from '$lib/components/Dialog.svelte';
  import LoanPanel, { type LoanLine, type LoanReturnRow } from '$lib/components/LoanPanel.svelte';
  import SampleSaleDialog from '$lib/components/SampleSaleDialog.svelte';

  type Slip = SalesOrder & { loanLines?: LoanLine[]; loanReturns?: LoanReturnRow[]; saleRequests?: SampleSaleRequest[]; createdByName?: string; shippedAt?: string };

  let slip = $state<Slip | null>(null);
  let warehouses = $state<Warehouse[]>([]);
  let error = $state('');
  let success = $state('');
  let saleOpen = $state(false);
  let voidOpen = $state(false);
  let voidReason = $state('');
  let voidError = $state('');
  let cancelTarget = $state<SampleSaleRequest | null>(null);
  let cancelOpen = $state(false);
  let cancelReason = $state('');
  let cancelError = $state('');
  let working = $state(false);

  const roles = $derived(session.user?.roles);
  const editable = $derived(can.editWarehouses());
  const active = $derived(Boolean(slip) && slip?.status !== 'CANCELLED');
  const open = $derived(slip?.loanStatus === 'OUT' || slip?.loanStatus === 'PARTIAL');
  const status = $derived(slip?.status === 'CANCELLED' ? null : loanStatusInfo(slip?.loanStatus));
  const age = $derived(slip ? loanAge(slip) : { days: 0, overdue: 0 });
  const requests = $derived(slip?.saleRequests ?? []);
  const holding = $derived(requests.some((item) => item.status === 'PENDING' || item.status === 'ORDERED'));
  const canSell = $derived(editable && open && (slip?.loanLines ?? []).some((line) => Number(line.remaining) > 0));
  const requestStatus = (value: string) => ({ PENDING: { label: m.xm_yc_cho_ke_toan(), tone: 'warning' }, ORDERED: { label: m.xm_yc_da_lap_bh(), tone: 'orange' }, DONE: { label: m.xm_yc_da_xong(), tone: 'success' }, CANCELLED: { label: m.xm_yc_da_rut(), tone: 'neutral' } } as Record<string, { label: string; tone: string }>)[value] ?? { label: value, tone: 'neutral' };

  async function load() {
    try {
      slip = await api<Slip>(`/sample-issues/${page.params.id}`);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.khong_tai_duoc_du_lieu_danh();
    }
  }
  onMount(() => {
    if (page.url.searchParams.get('created')) success = m.xm_da_lap();
    if (page.url.searchParams.get('saved')) success = m.xm_da_sua();
    void load();
    void api<Warehouse[]>('/warehouses').then((rows) => (warehouses = rows)).catch(() => undefined);
  });

  async function saveVoid(event: SubmitEvent) {
    event.preventDefault();
    if (!slip) return;
    if (voidReason.trim().length < 5) {
      voidError = m.xm_ly_do_5();
      return;
    }
    working = true;
    try {
      await api(`/sample-issues/${slip.id}/void`, { method: 'POST', idempotentCommand: true, body: JSON.stringify({ version: slip.version, reason: voidReason.trim() }) });
      voidOpen = false;
      success = m.xm_da_huy({ code: slip.code });
      error = '';
      slip = { ...slip, status: 'CANCELLED' };
    } catch (caught) {
      voidError = caught instanceof Error ? caught.message : m.khong_the_hoan_tat_thao_tac();
    } finally {
      working = false;
    }
  }
  async function saveCancel(event: SubmitEvent) {
    event.preventDefault();
    if (!slip || !cancelTarget) return;
    if (cancelReason.trim().length < 3) {
      cancelError = m.inv_ly_do_toi_thieu();
      return;
    }
    working = true;
    try {
      await api(`/sample-issues/${slip.id}/sale-requests/${cancelTarget.id}/cancel`, { method: 'POST', idempotentCommand: true, body: JSON.stringify({ version: slip.version, reason: cancelReason.trim() }) });
      cancelOpen = false;
      success = m.xm_da_rut_yc();
      await load();
    } catch (caught) {
      cancelError = caught instanceof Error ? caught.message : m.khong_the_hoan_tat_thao_tac();
    } finally {
      working = false;
    }
  }
</script>

<svelte:head><title>{slip?.code ?? m.xm_tieu_de()} · INOXPRAN ERP</title></svelte:head>

<section class="page-head">
  <div>
    <nav class="crumbs" aria-label={m.duong_dan()}><a href="/inventory">{m.kho_giao_hang()}</a><span><a href="/inventory/sample-issues">{m.xm_tieu_de()}</a></span><span>{slip?.code ?? ''}</span></nav>
    <h1 class="page-title">{m.xm_phieu({ code: slip?.code ?? '' })}</h1>
    <p class="page-sub">
      {#if slip?.status === 'CANCELLED'}<span class="pill danger">{m.inv_trang_thai_da_huy()}</span>{:else if status}<span class={`pill ${status.tone}`}>{status.label}</span>{/if}
      {#if holding}<span class="pill orange">{m.xm_dang_cho_ban()}</span>{/if}
      <span>{m.lp_khong_tinh_tien_ngan()} · {m.xm_khong_qua_bh()}</span>
    </p>
  </div>
  {#if slip}
    <div class="actions">
      <a class="btn" href={`/print/sales-issue/${slip.id}`} target="_blank" rel="noopener"><Printer size={16} />{m.in_phieu()}</a>
      {#if canSell}<button class="btn" onclick={() => (saleOpen = true)}><ShoppingCart size={16} />{m.xm_khach_mua_luon()}</button>{/if}
      {#if editable && active && slip.loanStatus !== 'CLOSED'}<a class="btn" href={`/inventory/sample-issues/${slip.id}/edit`}><Pencil size={16} />{m.crud_sua()}</a>{/if}
      {#if editable && active && slip.loanStatus !== 'CLOSED'}<button class="btn danger-soft" onclick={() => { voidReason = ''; voidError = ''; voidOpen = true; }}><Ban size={16} />{m.inv_huy_phieu()}</button>{/if}
    </div>
  {/if}
</section>

{#if error}<div class="banner error"><CircleAlert size={17} />{error}</div>{/if}
{#if success}<div class="banner success"><CircleCheck size={17} />{success}</div>{/if}

{#if slip}
  <article class="card info">
    <dl>
      <div><dt>{m.lp_nguoi_muon()}</dt><dd>{slip.salesRepName ?? '—'}</dd></div>
      <div><dt>{m.lp_gui_toi()}</dt><dd>{slip.destination ?? '—'}</dd></div>
      <div class="wide"><dt>{m.dia_chi()}</dt><dd>{slip.recipientAddress ?? '—'}</dd></div>
      <div><dt>{m.kho_xuat()}</dt><dd>{warehouses.find((row) => row.id === slip?.warehouseId)?.name ?? '—'}</dd></div>
      <div><dt>{m.xm_nguoi_xuat()}</dt><dd>{slip.warehouseKeeperName ?? slip.createdByName ?? '—'} · {dateTime(slip.shippedAt ?? slip.createdAt)}</dd></div>
      <div><dt>{m.lp_hen_tra()}</dt><dd>{slip.expectedReturnDate ? date(`${slip.expectedReturnDate}T12:00:00+07:00`) : '—'}{#if open} · <span class:overdue={age.overdue > 0}>{age.overdue > 0 ? m.lp_qua_hen({ days: age.overdue }) : m.lp_da_muon_ngay({ days: age.days })}</span>{/if}</dd></div>
      <div class="wide"><dt>{m.ghi_chu()}</dt><dd>{slip.note ?? '—'}</dd></div>
    </dl>
  </article>

  {#if slip.status !== 'CANCELLED'}
    <LoanPanel order={slip} canReturn={hasRole(roles, ['WAREHOUSE', 'WAREHOUSE_MANAGER'])} canClose={hasRole(roles, ['WAREHOUSE', 'WAREHOUSE_MANAGER'])} onchanged={(message) => { success = message; error = ''; void load(); }} />
  {:else}
    <article class="card">
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>{m.ma_hang()}</th><th>{m.ten_hang()}</th><th>{m.don_vi()}</th><th class="num">{m.so_luong()}</th></tr></thead>
          <tbody>{#each slip.lines as line}<tr><td class="code">{line.sku}</td><td>{line.productName}</td><td>{line.unit}</td><td class="num">{num(line.quantity)}</td></tr>{/each}</tbody>
        </table>
      </div>
    </article>
  {/if}

  {#if requests.length}
    <article class="card requests">
      <header class="card-head"><h2>{m.xm_yeu_cau_ban()}</h2></header>
      <ul>
        {#each [...requests].reverse() as item (item.id)}
          {@const state = requestStatus(item.status)}
          <li>
            <div class="row">
              <span class={`pill ${state.tone}`}>{state.label}</span>
              <b>{item.customerName}</b><span class="code">{item.customerCode}</span>
              <span class="muted">{m.xm_yc_gui({ by: item.requestedByName, to: item.accountantName, at: dateTime(item.requestedAt) })}</span>
            </div>
            <small>{item.lines.map((line) => `${line.sku} × ${num(line.quantity)}${line.unit ? ` ${line.unit.toLowerCase()}` : ''}`).join(', ')}{item.note ? ` — ${item.note}` : ''}</small>
            {#if item.salesOrderCode}<small>{m.xm_yc_phieu_bh()}: <a class="code link" href={`/sales/orders/${item.salesOrderId}`}>{item.salesOrderCode}</a>{#if item.returnCode} · {m.xm_yc_nhap_bu({ code: item.returnCode })}{/if}</small>{/if}
            {#if item.status === 'CANCELLED' && item.cancelReason}<small>{m.xm_yc_ly_do_rut({ by: item.cancelledByName ?? '', reason: item.cancelReason })}</small>{/if}
            {#if item.status === 'PENDING' && editable}
              <button class="btn small" onclick={() => { cancelTarget = item; cancelReason = ''; cancelError = ''; cancelOpen = true; }}><Undo2 size={14} />{m.xm_rut_yeu_cau()}</button>
            {/if}
          </li>
        {/each}
      </ul>
    </article>
  {/if}

  <SampleSaleDialog bind:open={saleOpen} {slip} onsaved={() => { success = m.xm_da_gui_yc(); error = ''; void load(); }} />
{/if}

<Dialog bind:open={voidOpen} title={m.inv_huy_phieu_tra({ code: slip?.code ?? '' })}>
  <form id="si-void-form" class="mini" onsubmit={saveVoid}>
    {#if voidError}<div class="banner error"><CircleAlert size={17} /><span>{voidError}</span></div>{/if}
    <p class="hint">{m.xm_huy_ghi_chu()}</p>
    <div class="field"><label for="si-void-reason">{m.inv_ly_do_huy()} <span class="req">*</span></label><input id="si-void-reason" bind:value={voidReason} maxlength="300" /></div>
  </form>
  {#snippet footer()}
    <button type="button" class="btn" onclick={() => (voidOpen = false)}>{m.huy()}</button>
    <button type="submit" class="btn danger" form="si-void-form" disabled={working}><Ban size={15} />{working ? m.kh_dang_luu() : m.inv_huy_phieu()}</button>
  {/snippet}
</Dialog>

<Dialog bind:open={cancelOpen} title={m.xm_rut_yeu_cau()}>
  <form id="si-cancel-form" class="mini" onsubmit={saveCancel}>
    {#if cancelError}<div class="banner error"><CircleAlert size={17} /><span>{cancelError}</span></div>{/if}
    <p class="hint">{m.xm_rut_ghi_chu({ customer: cancelTarget?.customerName ?? '' })}</p>
    <div class="field"><label for="si-cancel-reason">{m.xm_ly_do_rut()} <span class="req">*</span></label><input id="si-cancel-reason" bind:value={cancelReason} maxlength="300" /></div>
  </form>
  {#snippet footer()}
    <button type="button" class="btn" onclick={() => (cancelOpen = false)}>{m.dong()}</button>
    <button type="submit" class="btn primary" form="si-cancel-form" disabled={working}><Undo2 size={15} />{working ? m.kh_dang_luu() : m.xm_rut_yeu_cau()}</button>
  {/snippet}
</Dialog>

<style>
  .page-sub { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  .info { margin-bottom: 18px; padding: 18px 20px; }
  dl { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px 20px; margin: 0; }
  dl .wide { grid-column: 1 / -1; }
  dt { color: var(--subtle); font-size: 12px; }
  dd { margin: 2px 0 0; overflow-wrap: anywhere; }
  .overdue { color: var(--red); }
  .requests { margin-top: 18px; }
  .requests ul { display: grid; gap: 14px; margin: 0; padding: 4px 20px 20px; list-style: none; }
  .requests li { display: grid; gap: 4px; justify-items: start; padding-top: 12px; border-top: 1px solid var(--border); }
  .requests li:first-child { border-top: 0; padding-top: 0; }
  .row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  .muted { color: var(--muted); font-size: 12.5px; }
  .requests small { color: var(--muted); font-size: 12.5px; }
  .link { color: var(--navy-2); font-weight: 700; }
  .mini { display: grid; gap: 12px; }
  .mini p { margin: 0; }
  .hint { color: var(--subtle); font-size: 12.5px; }
  .req { color: var(--red); }
  @media (max-width: 760px) { dl { grid-template-columns: 1fr; } }
</style>
