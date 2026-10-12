<script lang="ts">
  /** Lịch sử kiểm kê kho (STK-01) + bắt đầu phiếu kiểm kê mới (mỗi kho một phiếu đang mở). */
  import { m } from '$lib/paraglide/messages';
  import type { StockCountView, Warehouse } from '@inoxpran/contracts';
  import { goto } from '$app/navigation';
  import { onMount } from 'svelte';
  import { CircleAlert, ClipboardCheck } from 'lucide-svelte';
  import { api, ApiRequestError } from '$lib/api';
  import { dateTime } from '$lib/format';
  import { initialPageSize, pageQuery, rememberPageSize, type Paged } from '$lib/paging';
  import { can } from '$lib/permissions';
  import { defaultWarehouseId, session } from '$lib/session.svelte';
  import { countStatusLabel } from '$lib/stock-count';
  import Dialog from '$lib/components/Dialog.svelte';
  import Pagination from '$lib/components/Pagination.svelte';

  let rows = $state<StockCountView[]>([]);
  let total = $state(0);
  let page = $state(1);
  let pageSize = $state(initialPageSize(20));
  let warehouses = $state<Warehouse[]>([]);
  let warehouseId = $state('');
  let status = $state('');
  let loading = $state(true);
  let error = $state('');
  let startOpen = $state(false);
  let startWarehouse = $state('');
  let starting = $state(false);
  const editable = $derived(can.editWarehouses());
  const allWarehouses = $derived(Boolean(session.user?.roles.some((role) => role === 'ADMIN' || role === 'DIRECTOR')));
  /** Kho được kiểm kê: kho đang hoạt động trong phạm vi được giao (quản trị / Giám đốc: mọi kho). */
  const startable = $derived(warehouses.filter((item) => item.active !== false && (allWarehouses || session.user?.warehouseScopes.includes(item.id))));

  async function load() {
    loading = true;
    error = '';
    try {
      const result = await api<Paged<StockCountView>>(`/inventory/stock-counts?${pageQuery({ warehouseId, status }, page, pageSize)}`);
      rows = result.rows;
      total = result.total;
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.kk_khong_tai_duoc();
    } finally {
      loading = false;
    }
  }
  function changePage(next: number, size: number) {
    if (size !== pageSize) rememberPageSize(size);
    page = next;
    pageSize = size;
    void load();
  }
  const refilter = () => {
    page = 1;
    void load();
  };

  onMount(async () => {
    warehouses = await api<Warehouse[]>('/warehouses').catch(() => []);
    await load();
  });

  function openStart() {
    const preferred = defaultWarehouseId();
    startWarehouse = startable.find((item) => item.id === preferred)?.id ?? startable[0]?.id ?? '';
    error = '';
    startOpen = true;
  }
  async function start(event: SubmitEvent) {
    event.preventDefault();
    if (!startWarehouse) return;
    starting = true;
    try {
      const created = await api<StockCountView>('/inventory/stock-counts', { method: 'POST', idempotentCommand: true, body: JSON.stringify({ warehouseId: startWarehouse }) });
      await goto(`/inventory/counts/${created.id}`);
    } catch (caught) {
      // Kho đã có phiếu đang mở → vào làm tiếp phiếu đó.
      const existing = caught instanceof ApiRequestError && caught.payload.code === 'STOCK_COUNT_OPEN_EXISTS' ? (caught.payload.details as { id?: string } | undefined)?.id : undefined;
      if (existing) await goto(`/inventory/counts/${existing}`);
      else error = caught instanceof Error ? caught.message : m.crud_loi_luu();
    } finally {
      starting = false;
      startOpen = false;
    }
  }
  const tone = (value: string) => (value === 'CLOSED' ? 'success' : value === 'CANCELLED' ? 'neutral' : 'warning');
</script>

<svelte:head><title>{m.kk_title()} — INOXPRAN ERP</title></svelte:head>

<section class="page-head">
  <div>
    <nav class="crumbs" aria-label={m.duong_dan()}><a href="/inventory">{m.kho_giao_hang()}</a><span>{m.kk_title()}</span></nav>
    <h1 class="page-title">{m.kk_title()}</h1>
    <p class="page-sub">{m.kk_sub()}</p>
  </div>
  {#if editable}<div class="actions"><button class="btn primary" onclick={openStart}><ClipboardCheck size={16} />{m.kk_bat_dau()}</button></div>{/if}
</section>

<section class="card filters">
  <div class="field"><label for="kk-warehouse">{m.kho()}</label><select id="kk-warehouse" bind:value={warehouseId} onchange={refilter}><option value="">{m.tat_ca_kho()}</option>{#each warehouses as item}<option value={item.id}>{item.name}</option>{/each}</select></div>
  <div class="field"><label for="kk-status">{m.trang_thai()}</label>
    <select id="kk-status" bind:value={status} onchange={refilter}>
      <option value="">{m.tat_ca()}</option>
      <option value="OPEN">{m.kk_dang_lam()}</option>
      <option value="CLOSED">{m.kk_status_closed()}</option>
      <option value="CANCELLED">{m.kk_status_cancelled()}</option>
    </select>
  </div>
</section>

{#if error}<div class="banner error"><CircleAlert size={17} />{error}</div>{/if}

<section class="card">
  <div class="table-wrap">
    <table class="table">
      <thead><tr><th>{m.kk_so_phieu()}</th><th>{m.kho()}</th><th>{m.kk_ky()}</th><th>{m.trang_thai()}</th><th class="num">{m.kk_so_ma_lech()}</th><th>{m.kk_nguoi_bat_dau()}</th><th>{m.kk_ket_thuc()}</th><th></th></tr></thead>
      <tbody>
        {#if loading && !rows.length}<tr class="empty-row"><td colspan="8">{m.dang_tai()}</td></tr>
        {:else}
          {#each rows as row (row.id)}
            <tr>
              <td class="code"><a class="link" href={`/inventory/counts/${row.id}`}>{row.code}</a></td>
              <td>{row.warehouseName}</td>
              <td>{row.period.split('-').reverse().join('/')}</td>
              <td><span class={`pill ${tone(row.status)}`}>{countStatusLabel(row.status)}</span></td>
              <td class="num">{#if row.variance}{#if row.variance.qtyMismatches}<b class="bad">{row.variance.qtyMismatches}</b>{:else}<span class="good">0</span>{/if}{:else}—{/if}</td>
              <td>{row.startedByName}<small>{dateTime(row.startedAt)}</small></td>
              <td>{#if row.closedAt}{row.closedByName}<small>{dateTime(row.closedAt)}</small>{:else if row.cancelledAt}<small>{dateTime(row.cancelledAt)}</small>{:else}—{/if}</td>
              <td><a class="btn small" href={`/inventory/counts/${row.id}`}>{row.status === 'SKU_CHECK' || row.status === 'QTY_CHECK' ? (editable ? m.kk_lam_tiep() : m.xem()) : m.xem()}</a></td>
            </tr>
          {:else}<tr class="empty-row"><td colspan="8">{m.kk_chua_co_phieu()}</td></tr>{/each}
        {/if}
      </tbody>
    </table>
  </div>
  <Pagination {page} {pageSize} {total} {loading} onchange={changePage} />
</section>

<Dialog bind:open={startOpen} title={m.kk_bat_dau()}>
  <form id="kk-start" class="start" onsubmit={start}>
    <p>{m.kk_bat_dau_mo_ta()}</p>
    <div class="field"><label for="kk-start-warehouse">{m.kho()} <span class="req">*</span></label>
      <select id="kk-start-warehouse" bind:value={startWarehouse} required>{#each startable as item}<option value={item.id}>{item.name}</option>{/each}</select>
    </div>
  </form>
  {#snippet footer()}
    <button type="button" class="btn" onclick={() => (startOpen = false)}>{m.huy()}</button>
    <button type="submit" class="btn primary" form="kk-start" disabled={starting || !startWarehouse}><ClipboardCheck size={15} />{m.kk_bat_dau()}</button>
  {/snippet}
</Dialog>

<style>
  .filters { grid-template-columns: 1fr 1fr; }
  td small { display: block; color: var(--muted); }
  .bad { color: var(--red); }
  .good { color: var(--green); }
  .start { display: grid; gap: 12px; }
  .start p { margin: 0; color: var(--muted); }
  .req { color: var(--red); }
  @media (max-width: 720px) { .filters { grid-template-columns: 1fr; } }
</style>
