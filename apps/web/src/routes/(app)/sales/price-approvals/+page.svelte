<script lang="ts">
  /**
   * Duyệt quyền sửa đơn giá phiếu BH (Admin, Kế toán, Giám đốc): kế toán xin kèm lý do khi đang lập phiếu; duyệt xong ô đơn giá
   * trên máy kế toán tự mở khóa — quyền chỉ dùng cho đúng phiếu đó. Từ chối phải ghi lý do.
   */
  import { m } from '$lib/paraglide/messages';
  import type { PriceOverrideRequestView } from '@inoxpran/contracts';
  import { onMount } from 'svelte';
  import { CircleAlert, CircleCheck } from 'lucide-svelte';
  import Dialog from '$lib/components/Dialog.svelte';
  import { api } from '$lib/api';
  import { dateTime } from '$lib/format';

  let tab = $state<'PENDING' | 'DONE'>('PENDING');
  let rows = $state<PriceOverrideRequestView[]>([]);
  let loading = $state(true);
  let error = $state('');
  let success = $state('');
  let working = $state('');
  let rejectTarget = $state<PriceOverrideRequestView | null>(null);
  let rejectOpen = $state(false);
  let note = $state('');

  const shown = $derived(tab === 'PENDING' ? rows.filter((row) => row.status === 'PENDING') : rows.filter((row) => row.status !== 'PENDING'));
  const pendingCount = $derived(rows.filter((row) => row.status === 'PENDING').length);
  const statusLabel: Record<string, { label: string; tone: string }> = {
    PENDING: { label: m.gia_tt_cho_duyet(), tone: 'warning' },
    APPROVED: { label: m.gia_tt_da_duyet(), tone: 'success' },
    REJECTED: { label: m.gia_tt_tu_choi(), tone: 'danger' },
    CANCELLED: { label: m.gia_tt_da_huy(), tone: 'neutral' },
  };

  async function load(quiet = false) {
    if (!quiet) loading = true;
    try {
      rows = await api<PriceOverrideRequestView[]>('/price-override-requests');
      error = '';
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.khong_the_hoan_tat_thao_tac();
    } finally {
      loading = false;
    }
  }
  async function decide(row: PriceOverrideRequestView, decision: 'APPROVE' | 'REJECT', reason = '') {
    working = row.id;
    error = '';
    success = '';
    try {
      await api(`/price-override-requests/${row.id}/decision`, { method: 'POST', idempotentCommand: true, body: JSON.stringify({ decision, ...(reason ? { note: reason } : {}) }) });
      success = decision === 'APPROVE' ? m.gia_da_duyet_cho({ name: row.requestedByName }) : m.gia_da_tu_choi_cho({ name: row.requestedByName });
      await load(true);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.khong_the_hoan_tat_thao_tac();
    } finally {
      working = '';
    }
  }
  function openReject(row: PriceOverrideRequestView) {
    rejectTarget = row;
    note = '';
    rejectOpen = true;
  }
  async function confirmReject() {
    if (!rejectTarget || !note.trim()) return;
    rejectOpen = false;
    await decide(rejectTarget, 'REJECT', note.trim());
  }
  onMount(() => {
    void load();
    // Kế toán đang chờ ở form: làm mới danh sách mỗi 15 giây để không bỏ sót yêu cầu mới.
    const timer = setInterval(() => void load(true), 15000);
    return () => clearInterval(timer);
  });
</script>

<svelte:head><title>{m.gia_duyet_tieu_de()} | INOXPRAN ERP</title></svelte:head>

<section class="page-head">
  <div>
    <nav class="crumbs" aria-label={m.duong_dan()}><a href="/sales/orders">{m.don_hang()}</a><span>{m.gia_duyet_tieu_de()}</span></nav>
    <h1 class="page-title">{m.gia_duyet_tieu_de()}</h1>
    <p class="page-sub">{m.gia_duyet_mo_ta()}</p>
  </div>
  <div class="actions"><button class="btn" onclick={() => load()}>{m.lam_moi()}</button></div>
</section>

{#if error}<div class="banner error"><CircleAlert size={17} />{error}</div>{/if}
{#if success}<div class="banner success"><CircleCheck size={17} />{success}</div>{/if}

<div class="tabs" role="tablist">
  <button role="tab" aria-selected={tab === 'PENDING'} class:on={tab === 'PENDING'} onclick={() => (tab = 'PENDING')}>{m.gia_tab_cho_duyet({ count: pendingCount })}</button>
  <button role="tab" aria-selected={tab === 'DONE'} class:on={tab === 'DONE'} onclick={() => (tab = 'DONE')}>{m.gia_tab_da_xu_ly()}</button>
</div>

<section class="card">
  <div class="table-wrap">
    <table class="table">
      <thead><tr><th>{m.gia_cot_so()}</th><th>{m.gia_cot_nguoi_xin()}</th><th>{m.gia_cot_khach_phieu()}</th><th>{m.gia_ly_do()}</th><th>{m.gia_cot_trang_thai()}</th><th></th></tr></thead>
      <tbody>
        {#if loading}<tr class="empty-row"><td colspan="6">{m.dang_tai()}</td></tr>
        {:else if shown.length}
          {#each shown as row (row.id)}
            {@const status = statusLabel[row.status] ?? { label: row.status, tone: '' }}
            <tr>
              <td><span class="code">{row.code}</span><small>{dateTime(row.requestedAt)}</small></td>
              <td>{row.requestedByName}</td>
              <td>{row.customerName ?? '—'}{#if row.salesOrderCode}<small>{#if row.salesOrderId}<a class="link" href={`/sales/orders/${row.salesOrderId}`}>{row.salesOrderCode}</a>{:else}{row.salesOrderCode}{/if}</small>{/if}</td>
              <td class="reason">{row.reason}</td>
              <td><span class={`pill ${status.tone}`}>{status.label}</span>{#if row.decidedByName && row.status !== 'PENDING'}<small>{row.decidedByName}{row.decidedAt ? ` · ${dateTime(row.decidedAt)}` : ''}</small>{/if}{#if row.decisionNote}<small class="note">{row.decisionNote}</small>{/if}</td>
              <td class="acts">
                {#if row.status === 'PENDING'}
                  <button class="btn primary small" disabled={working === row.id} onclick={() => decide(row, 'APPROVE')}>{m.gia_cap_quyen()}</button>
                  <button class="btn danger small" disabled={working === row.id} onclick={() => openReject(row)}>{m.gia_tu_choi()}</button>
                {/if}
              </td>
            </tr>
          {/each}
        {:else}<tr class="empty-row"><td colspan="6">{tab === 'PENDING' ? m.gia_khong_co_yeu_cau() : m.gia_chua_co_lich_su()}</td></tr>{/if}
      </tbody>
    </table>
  </div>
</section>

<Dialog bind:open={rejectOpen} title={m.gia_tu_choi_tieu_de({ name: rejectTarget?.requestedByName ?? '' })}>
  <p class="lead">{rejectTarget?.reason}</p>
  <div class="field">
    <label for="reject-note">{m.gia_ly_do_tu_choi()} <span class="req">*</span></label>
    <textarea id="reject-note" rows="3" maxlength="300" bind:value={note}></textarea>
  </div>
  {#snippet footer()}
    <button class="btn" onclick={() => (rejectOpen = false)}>{m.dong()}</button>
    <button class="btn danger" disabled={!note.trim()} onclick={confirmReject}>{m.gia_tu_choi()}</button>
  {/snippet}
</Dialog>

<style>
  .tabs { display: flex; gap: 6px; margin: 0 0 12px; }
  .tabs button { padding: 7px 14px; border: 1px solid var(--line); border-radius: 999px; background: var(--surface); color: var(--muted); font-weight: 600; cursor: pointer; }
  .tabs button.on { border-color: var(--navy); background: var(--navy); color: #fff; }
  td small { display: block; color: var(--muted); font-size: 12px; }
  td small.note { color: var(--text); font-style: italic; }
  td.reason { max-width: 340px; white-space: normal; }
  td.acts { display: flex; gap: 6px; justify-content: flex-end; white-space: nowrap; }
</style>
