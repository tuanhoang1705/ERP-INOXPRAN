<script lang="ts">
  /**
   * Nhật ký xuất nhập kho theo tháng (mẫu `出库汇总` của công ty): mỗi dòng thẻ kho kèm khách / NCC, phiếu BH gốc,
   * số phiếu xuất (SWK) / nhập (NK, TH…), loại phát sinh, thủ kho, NVKD. Lọc theo kho, loại, mã hàng / số phiếu; xuất Excel.
   */
  import { m } from '$lib/paraglide/messages';
  import type { InventoryJournalRow, Warehouse } from '@inoxpran/contracts';
  import { onMount } from 'svelte';
  import { CircleAlert, Download } from 'lucide-svelte';
  import { api, download } from '$lib/api';
  import { date, dateTime, num } from '$lib/format';
  import { categoryLabel } from '$lib/inventory';
  import { debounce, initialPageSize, pageQuery, rememberPageSize, type Paged } from '$lib/paging';
  import { INVENTORY_CATEGORIES } from '$shared/inventory-categories';
  import Pagination from '$lib/components/Pagination.svelte';

  const thisMonth = () => new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 7);
  let month = $state(thisMonth());
  let warehouseId = $state('');
  let category = $state('');
  let search = $state('');
  let warehouses = $state<Warehouse[]>([]);
  let rows = $state<InventoryJournalRow[]>([]);
  let total = $state(0);
  let page = $state(1);
  let pageSize = $state(initialPageSize());
  let loading = $state(true);
  let exporting = $state(false);
  let error = $state('');
  const filters = $derived({ month, warehouseId, category, search: search.trim() });

  async function load() {
    loading = true;
    error = '';
    try {
      const result = await api<Paged<InventoryJournalRow>>(`/inventory/reports/journal?${pageQuery(filters, page, pageSize)}`);
      rows = result.rows;
      total = result.total;
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.inv_khong_tai_duoc();
      rows = [];
      total = 0;
    } finally {
      loading = false;
    }
  }
  onMount(() => {
    void load();
    void api<Warehouse[]>('/warehouses').then((list) => (warehouses = list)).catch(() => undefined);
  });
  function refilter() {
    page = 1;
    void load();
  }
  const searchChanged = debounce(refilter, 350);
  function changePage(next: number, size: number) {
    if (size !== pageSize) rememberPageSize(size);
    page = next;
    pageSize = size;
    void load();
  }
  async function exportExcel() {
    exporting = true;
    error = '';
    try {
      const query = new URLSearchParams(Object.entries(filters).filter(([, value]) => value) as Array<[string, string]>).toString();
      await download(`/inventory/reports/journal/export?${query}`, `NhatKyXuatNhap_${month}.xlsx`);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.khong_tai_duoc_tep();
    } finally {
      exporting = false;
    }
  }
</script>

<svelte:head><title>{m.inv_nhat_ky()} · INOXPRAN ERP</title></svelte:head>

<section class="page-head">
  <div>
    <nav class="crumbs" aria-label={m.duong_dan()}><a href="/inventory">{m.kho_giao_hang()}</a><span>{m.inv_nhat_ky()}</span></nav>
    <h1 class="page-title">{m.inv_nhat_ky()} <span class="zh">出入库汇总</span></h1>
    <p class="page-sub">{m.inv_nhat_ky_mo_ta()}</p>
  </div>
  <div class="actions"><button class="btn primary" disabled={exporting} onclick={exportExcel}><Download size={16} />{exporting ? m.dang_xuat_2() : m.xuat_excel()}</button></div>
</section>

<section class="card filters">
  <div class="field"><label for="month">{m.inv_thang()}</label><input id="month" type="month" bind:value={month} max={thisMonth()} onchange={refilter} /></div>
  <div class="field"><label for="warehouse">{m.kho()}</label>
    <select id="warehouse" bind:value={warehouseId} onchange={refilter}><option value="">{m.tat_ca_kho()}</option>{#each warehouses as item (item.id)}<option value={item.id}>{item.name}</option>{/each}</select>
  </div>
  <div class="field"><label for="category">{m.inv_loai_phat_sinh()}</label>
    <select id="category" bind:value={category} onchange={refilter}><option value="">{m.tat_ca()}</option>{#each INVENTORY_CATEGORIES as item (item.code)}<option value={item.code}>{categoryLabel(item.code)}</option>{/each}</select>
  </div>
  <div class="field"><label for="search">{m.inv_tim_ma_phieu()}</label><input id="search" bind:value={search} oninput={searchChanged} placeholder="INP… / BH… / SWK…" /></div>
</section>

{#if error}<div class="banner error"><CircleAlert size={17} />{error}</div>{/if}

<section class="card">
  <div class="table-wrap">
    <table class="table">
      <thead><tr><th>{m.thoi_diem()}</th><th>{m.inv_doi_tac()}</th><th>{m.inv_phieu_bh()}</th><th>{m.chung_tu()}</th><th>{m.ma_sp()}</th><th>{m.inv_loai_phat_sinh()}</th><th class="num">{m.nhap_2()}</th><th class="num">{m.xuat()}</th><th>{m.ghi_chu()}</th><th>{m.inv_thu_kho()}</th><th>{m.inv_nvkd()}</th></tr></thead>
      <tbody>
        {#if loading && !rows.length}<tr class="empty-row"><td colspan="11">{m.dang_tai()}</td></tr>
        {:else if rows.length}
          {#each rows as row (row.id)}
            <tr>
              <td class="muted nowrap">{dateTime(row.occurredAt)}<small>{row.warehouseCode}</small></td>
              <td>{#if row.partnerCode}<span class="code">{row.partnerCode}</span>{/if}<small>{row.partnerName ?? ''}</small></td>
              <td>{#if row.salesOrderCode}<span class="code">{row.salesOrderCode}</span><small>{row.salesOrderDate ? date(row.salesOrderDate) : ''}</small>{:else}—{/if}</td>
              <td class="code">{row.documentNo}</td>
              <td><span class="code">{row.sku}</span><small>{row.productName}</small></td>
              <td><span class={`pill ${row.direction === 'IN' ? 'success' : 'orange'}`}>{categoryLabel(row.category)}</span></td>
              <td class="num">{row.direction === 'IN' ? num(Math.abs(row.quantity)) : ''}</td>
              <td class="num">{row.direction === 'OUT' ? num(Math.abs(row.quantity)) : ''}</td>
              <td class="muted note">{row.note ?? ''}</td>
              <td class="muted">{row.keeperName ?? ''}</td>
              <td class="muted">{row.salesRepName ?? ''}</td>
            </tr>
          {/each}
        {:else}<tr class="empty-row"><td colspan="11">{m.inv_khong_co_phat_sinh()}</td></tr>{/if}
      </tbody>
    </table>
  </div>
  <Pagination {page} {pageSize} {total} {loading} onchange={changePage} />
</section>

<style>
  .zh { color: var(--subtle); font-size: 0.6em; font-weight: 500; }
  .filters { grid-template-columns: 180px minmax(180px, 1fr) minmax(200px, 1fr) minmax(200px, 1fr); }
  td small { display: block; color: var(--subtle); font-size: 12px; }
  .note { max-width: 260px; }
  @media (max-width: 900px) { .filters { grid-template-columns: 1fr 1fr; } }
</style>
