<script lang="ts">
  /**
   * Đề nghị sửa / hủy / xóa phiếu BH (SAL-CHG-01): người duyệt (quyền sales.change_approve, mặc định Admin) thấy mọi đề nghị,
   * duyệt / từ chối ngay tại đây; người gửi (kế toán, kho) thấy đề nghị của mình và rút được khi còn chờ.
   */
  import { m } from '$lib/paraglide/messages';
  import { onMount } from 'svelte';
  import { CircleAlert, CircleCheck } from 'lucide-svelte';
  import ChangeRequestDialog from '$lib/components/ChangeRequestDialog.svelte';
  import { api } from '$lib/api';
  import { dateTime } from '$lib/format';
  import { can, session } from '$lib/session.svelte';
  import { changeKindLabel, changeStatus, type ChangeRequest } from '$lib/change-requests';

  let tab = $state<'PENDING' | 'DONE'>('PENDING');
  let rows = $state<ChangeRequest[]>([]);
  let loading = $state(true);
  let error = $state('');
  let success = $state('');
  let working = $state('');
  let dialogOpen = $state(false);
  let dialogAction = $state<'view' | 'approve' | 'reject'>('view');
  let target = $state<ChangeRequest | null>(null);

  const approver = $derived(can('sales.change_approve'));
  const shown = $derived(tab === 'PENDING' ? rows.filter((row) => row.status === 'PENDING') : rows.filter((row) => row.status !== 'PENDING'));
  const pendingCount = $derived(rows.filter((row) => row.status === 'PENDING').length);

  async function load(quiet = false) {
    if (!quiet) loading = true;
    try {
      rows = await api<ChangeRequest[]>('/sales-change-requests');
      error = '';
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.khong_the_hoan_tat_thao_tac();
    } finally {
      loading = false;
    }
  }
  function open(row: ChangeRequest, action: 'view' | 'approve' | 'reject') {
    target = row;
    dialogAction = action;
    dialogOpen = true;
  }
  async function decided(result: ChangeRequest) {
    error = '';
    success = '';
    if (result.status === 'FAILED') error = m.yc_khong_thuc_hien({ code: result.code, error: result.error ?? '' });
    else success = result.status === 'APPLIED' ? m.yc_da_duyet({ code: result.code }) : m.yc_da_tu_choi({ code: result.code });
    await load(true);
  }
  async function withdraw(row: ChangeRequest) {
    working = row.id;
    error = '';
    success = '';
    try {
      await api(`/sales-change-requests/${row.id}/withdraw`, { method: 'POST', idempotentCommand: true });
      success = m.yc_da_rut({ code: row.code });
      await load(true);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.khong_the_hoan_tat_thao_tac();
    } finally {
      working = '';
    }
  }
  onMount(() => {
    void load();
    const timer = setInterval(() => void load(true), 20000);
    return () => clearInterval(timer);
  });
</script>

<svelte:head><title>{m.yc_menu()} | INOXPRAN ERP</title></svelte:head>

<section class="page-head">
  <div>
    <nav class="crumbs" aria-label={m.duong_dan()}><a href="/sales/orders">{m.don_hang()}</a><span>{m.yc_menu()}</span></nav>
    <h1 class="page-title">{m.yc_menu()}</h1>
    <p class="page-sub">{m.yc_mo_ta()}</p>
  </div>
  <div class="actions"><button class="btn" onclick={() => load()}>{m.lam_moi()}</button></div>
</section>

{#if error}<div class="banner error"><CircleAlert size={17} />{error}</div>{/if}
{#if success}<div class="banner success"><CircleCheck size={17} />{success}</div>{/if}

<div class="tabs" role="tablist">
  <button role="tab" aria-selected={tab === 'PENDING'} class:on={tab === 'PENDING'} onclick={() => (tab = 'PENDING')}>{m.yc_tab_cho({ count: pendingCount })}</button>
  <button role="tab" aria-selected={tab === 'DONE'} class:on={tab === 'DONE'} onclick={() => (tab = 'DONE')}>{m.yc_tab_xong()}</button>
</div>

<section class="card">
  <div class="table-wrap">
    <table class="table">
      <thead><tr><th>{m.yc_cot_so()}</th><th>{m.yc_cot_phieu()}</th><th>{m.yc_cot_loai()}</th><th>{m.bh_ly_do()}</th><th>{m.yc_cot_nguoi()}</th><th>{m.yc_cot_trang_thai()}</th><th></th></tr></thead>
      <tbody>
        {#if loading}<tr class="empty-row"><td colspan="7">{m.dang_tai()}</td></tr>
        {:else if shown.length}
          {#each shown as row (row.id)}
            {@const status = changeStatus(row.status)}
            <tr>
              <td><span class="code">{row.code}</span></td>
              <td><a class="link" href={`/sales/orders/${row.orderId}`}>{row.orderCode}</a><small>{row.customerName ?? ''}</small></td>
              <td>{changeKindLabel(row.kind)}</td>
              <td class="reason">{row.reason}</td>
              <td>{row.requestedByName}<small>{dateTime(row.requestedAt)}</small></td>
              <td>
                <span class={`pill ${status.tone}`}>{status.label}</span>
                {#if row.decidedByName && row.status !== 'PENDING'}<small>{row.decidedByName}{row.decidedAt ? ` · ${dateTime(row.decidedAt)}` : ''}</small>{/if}
                {#if row.decisionNote}<small class="note">{row.decisionNote}</small>{/if}
                {#if row.error}<small class="bad">{row.error}</small>{/if}
              </td>
              <td class="acts">
                {#if row.kind === 'EDIT'}<button class="btn small" onclick={() => open(row, 'view')}>{m.yc_xem_thay_doi()}</button>{/if}
                {#if row.status === 'PENDING' && approver}
                  <button class="btn small danger-soft" disabled={working === row.id} onclick={() => open(row, 'reject')}>{m.yc_tu_choi()}</button>
                  <button class="btn small primary" disabled={working === row.id} onclick={() => open(row, 'approve')}>{m.yc_duyet()}</button>
                {/if}
                {#if row.status === 'PENDING' && row.requestedById === session.user?.sub}<button class="btn small" disabled={working === row.id} onclick={() => withdraw(row)}>{m.yc_rut()}</button>{/if}
              </td>
            </tr>
          {/each}
        {:else}<tr class="empty-row"><td colspan="7">{tab === 'PENDING' ? m.yc_khong_co() : m.yc_chua_co_lich_su()}</td></tr>{/if}
      </tbody>
    </table>
  </div>
</section>

<ChangeRequestDialog bind:open={dialogOpen} request={target} action={dialogAction} ondone={decided} />

<style>
  .tabs { display: flex; gap: 6px; margin: 0 0 12px; }
  .tabs button { padding: 7px 14px; border: 1px solid var(--line); border-radius: 999px; background: var(--surface); color: var(--muted); font-weight: 600; cursor: pointer; }
  .tabs button.on { border-color: var(--navy); background: var(--navy); color: #fff; }
  td small { display: block; color: var(--muted); font-size: 12px; }
  td small.note { color: var(--text); font-style: italic; }
  td small.bad { color: var(--red); }
  td.reason { max-width: 320px; white-space: normal; }
  td.acts { display: flex; flex-wrap: wrap; gap: 6px; justify-content: flex-end; }
</style>
