<script lang="ts">
  import { m } from '$lib/paraglide/messages';
  import { onMount } from 'svelte';
  import { CircleAlert, CircleCheck } from 'lucide-svelte';
  import { api } from '$lib/api';
  import { dateTime, num } from '$lib/format';
  import { approvalReason } from '$lib/labels';

  type Approval = {
    id: string; entityType: 'SalesOrder' | 'PurchaseOrder'; entityId: string; entityCode: string; counterpartyName: string;
    amount: string; entityVersion: number; entityStatus: string; status: string; reasons: string[]; requestedAt: string;
  };
  let rows = $state<Approval[]>([]);
  let loading = $state(true);
  let error = $state('');
  let success = $state('');
  let working = $state('');

  async function load() {
    loading = true;
    error = '';
    try {
      rows = await api<Approval[]>('/approval-requests?status=PENDING');
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.khong_tai_duoc_yeu_cau_duyet();
    } finally {
      loading = false;
    }
  }
  async function approve(row: Approval) {
    working = row.id;
    error = '';
    success = '';
    const base = row.entityType === 'SalesOrder' ? '/sales-orders' : '/purchase-orders';
    try {
      await api(`${base}/${row.entityId}/approve`, { method: 'POST', body: JSON.stringify({ version: row.entityVersion }), idempotentCommand: true });
      success = m.da_duyet_2({ entityCode: row.entityCode, p1: row.entityType === 'SalesOrder' ? m.va_giu_ton_kho() : '' });
      await load();
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.khong_the_duyet_chung_tu();
    } finally {
      working = '';
    }
  }
  const hoursWaiting = (value: string) => Math.floor((Date.now() - new Date(value).getTime()) / 3_600_000);
  onMount(load);
</script>

<svelte:head><title>{m.duyet_xac_nhan_don_inoxpran_erp()}</title></svelte:head>

<section class="page-head">
  <div>
    <nav class="crumbs" aria-label={m.duong_dan()}><a href="/sales/orders">{m.don_hang()}</a><span>{m.duyet_xac_nhan_don()}</span></nav>
    <h1 class="page-title">{m.duyet_xac_nhan_don()}</h1>
    <p class="page-sub">{m.don_vuot_nguong_gia_tri_vuot()}</p>
  </div>
  <div class="actions"><button class="btn" onclick={load}>{m.lam_moi()}</button></div>
</section>

{#if error}<div class="banner error"><CircleAlert size={17} />{error}</div>{/if}
{#if success}<div class="banner success"><CircleCheck size={17} />{success}</div>{/if}

<section class="card">
  <header class="card-head head"><h2>{loading ? m.dang_tai() : m.chung_tu_cho_duyet({ length: rows.length })}</h2></header>
  <div class="table-wrap">
    <table class="table">
      <thead><tr><th>{m.loai()}</th><th>{m.chung_tu()}</th><th>{m.doi_tac()}</th><th class="num">{m.gia_tri_vnd()}</th><th>{m.ly_do_can_duyet()}</th><th>{m.thoi_gian_cho()}</th><th></th></tr></thead>
      <tbody>
        {#if loading}<tr class="empty-row"><td colspan="7">{m.dang_tai()}</td></tr>
        {:else if rows.length}
          {#each rows as row}
            {@const waited = hoursWaiting(row.requestedAt)}
            <tr>
              <td><span class="tag" class:b2c={row.entityType === 'PurchaseOrder'}>{row.entityType === 'SalesOrder' ? m.don_ban() : m.don_mua()}</span></td>
              <td><a class="code" href={row.entityType === 'SalesOrder' ? `/sales/orders/${row.entityId}` : `/procurement/${row.entityId}`}>{row.entityCode}</a></td>
              <td>{row.counterpartyName}</td>
              <td class="num"><b>{num(row.amount)}</b></td>
              <td><div class="reasons">{#each row.reasons as reason}<span class="pill warning">{approvalReason[reason] ?? reason}</span>{/each}</div></td>
              <td>{dateTime(row.requestedAt)}<small class:late={waited >= 24}>{waited >= 24 ? m.qua_24_gio_gio({ waited: waited }) : m.gio({ waited: waited })}</small></td>
              <td><button class="btn primary small" disabled={working === row.id} onclick={() => approve(row)}>{working === row.id ? m.dang_duyet() : m.duyet()}</button></td>
            </tr>
          {/each}
        {:else}<tr class="empty-row"><td colspan="7">{m.khong_con_chung_tu_nao_cho()}</td></tr>{/if}
      </tbody>
    </table>
  </div>
</section>

<style>
  .head { padding-bottom: 14px; }
  .reasons { display: flex; flex-wrap: wrap; gap: 6px; }
  .late { color: var(--red) !important; font-weight: 600; }
</style>
