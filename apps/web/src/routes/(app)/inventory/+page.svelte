<script lang="ts">
  import { m } from '$lib/paraglide/messages';
  import type { InventoryBalance, StockCountView, Warehouse } from '@inoxpran/contracts';
  import { page as appPage } from '$app/state';
  import { onMount } from 'svelte';
  import { CircleAlert, CircleCheck, ClipboardCheck, SlidersHorizontal } from 'lucide-svelte';
  import { api } from '$lib/api';
  import { date, dateTime, num, todayIso } from '$lib/format';
  import { debounce, initialPageSize, pageQuery, rememberPageSize, type Paged } from '$lib/paging';
  import { can } from '$lib/permissions';
  import Pagination from '$lib/components/Pagination.svelte';
  import AdjustmentDialog from '$lib/components/AdjustmentDialog.svelte';

  type Row = InventoryBalance & { locationCode?: string | null };
  let rows = $state<Row[]>([]);
  let total = $state(0);
  let lowCount = $state(0);
  let page = $state(1);
  let pageSize = $state(initialPageSize());
  let warehouses = $state<Warehouse[]>([]);
  let warehouseId = $state('');
  let search = $state('');
  /** Tồn cuối ngày (LIST-DATE-01); trống = hiện tại. */
  let asOf = $state('');
  let lowOnly = $state(false);
  let loading = $state(true);
  let error = $state('');
  let success = $state('');
  let adjustOpen = $state(false);
  let adjustProductId = $state('');
  const editable = $derived(can.editWarehouses());
  /** Phiếu kiểm kê đang mở (STK-01) trong phạm vi kho của người dùng → nhắc làm tiếp. */
  let openCounts = $state<StockCountView[]>([]);

  async function load() {
    loading = true;
    error = '';
    try {
      const result = await api<Paged<Row> & { lowCount: number }>(`/inventory/balances?${pageQuery({ warehouseId, search, low: lowOnly && !asOf ? '1' : '', asOf }, page, pageSize)}`);
      rows = result.rows;
      total = result.total;
      lowCount = result.lowCount;
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.khong_tai_duoc_ton_kho();
    } finally {
      loading = false;
    }
  }
  const refilter = () => {
    page = 1;
    void load();
  };
  const searchChanged = debounce(refilter);
  function changePage(next: number, size: number) {
    if (size !== pageSize) rememberPageSize(size);
    page = next;
    pageSize = size;
    void load();
  }

  onMount(async () => {
    lowOnly = appPage.url.searchParams.get('low') === '1';
    warehouseId = appPage.url.searchParams.get('warehouseId') ?? '';
    warehouses = await api<Warehouse[]>('/warehouses').catch(() => []);
    if (editable) openCounts = (await api<Paged<StockCountView>>('/inventory/stock-counts?status=OPEN&page=1&pageSize=10').catch(() => null))?.rows ?? [];
    // Ô tìm chức năng "Điều chỉnh tồn" mở thẳng hộp thoại.
    if (editable && appPage.url.searchParams.get('adjust') === '1') adjust();
    await load();
  });

  function adjust(productId = '') {
    adjustProductId = productId;
    adjustOpen = true;
  }
  async function adjusted() {
    success = m.crud_da_dieu_chinh();
    await load();
  }
</script>

<svelte:head><title>{m.ton_kho_inoxpran_erp()}</title></svelte:head>

<section class="page-head">
  <div>
    <nav class="crumbs" aria-label={m.duong_dan()}><a href="/inventory">{m.kho_giao_hang()}</a><span>{m.ton_kho()}</span></nav>
    <h1 class="page-title">{lowOnly ? m.ton_kho_duoi_dinh_muc() : m.ton_kho_kha_dung()}</h1>
    <p class="page-sub">{m.ton_thuc_te_phan_da_giu()}</p>
  </div>
  <div class="actions">
    {#if editable}<a class="btn" href="/inventory/counts"><ClipboardCheck size={16} />{m.kk_nut()}</a>{/if}
    <a class="btn" href="/inventory/movements">{m.the_kho()}</a>
    {#if editable}<button class="btn" onclick={() => adjust()}><SlidersHorizontal size={16} />{m.crud_dieu_chinh_ton()}</button>{/if}
    <a class="btn primary" href="/procurement/new">{m.lap_don_nhap_hang()}</a>
  </div>
</section>

<section class="card filters">
  <div class="field"><label for="search">{m.ma_sp_ten_hang()}</label><input id="search" bind:value={search} oninput={searchChanged} placeholder={m.quet_hoac_nhap_ma_vi_du()} /></div>
  <div class="field"><label for="as-of">{m.dr_ton_tai_ngay()}</label><input id="as-of" type="date" max={todayIso()} bind:value={asOf} onchange={refilter} placeholder={m.dr_ton_hien_tai()} /></div>
  <div class="field"><label for="warehouse">{m.kho()}</label><select id="warehouse" bind:value={warehouseId} onchange={refilter}><option value="">{m.tat_ca_kho()}</option>{#each warehouses as item}<option value={item.id}>{item.name}</option>{/each}</select></div>
  <label class="check" class:muted={Boolean(asOf)}><input type="checkbox" bind:checked={lowOnly} onchange={refilter} disabled={Boolean(asOf)} />{m.chi_hien_duoi_dinh_muc()}{lowCount})</label>
</section>

{#if error}<div class="banner error"><CircleAlert size={17} />{error}</div>{/if}
{#if asOf}<div class="banner warning"><CircleAlert size={17} /><span>{m.dr_dang_xem_ngay({ date: date(`${asOf}T00:00:00+07:00`) })}</span></div>{/if}
{#each openCounts as item (item.id)}<div class="banner warning"><ClipboardCheck size={17} /><span>{m.kk_dang_mo({ warehouse: item.warehouseName, code: item.code })} <a class="link" href={`/inventory/counts/${item.id}`}>{m.kk_lam_tiep()}</a></span></div>{/each}
{#if success}<div class="banner success"><CircleCheck size={17} />{success}</div>{/if}

<section class="card">
  <header class="card-head head"><h2>{loading && !rows.length ? m.dang_tai() : m.ma_hang_2({ length: total })}</h2><span class="muted"><span class="dot amber"></span>{m.dong_to_vang_ton_kha_dung()}</span></header>
  <div class="table-wrap">
    <table class="table">
      <thead><tr><th>{m.ma_sp()}</th><th>{m.ten_san_pham()}</th><th>{m.dvt()}</th><th>{m.crud_vi_tri()}</th><th class="num">{m.ton_thuc_te()}</th><th class="num">{m.da_giu_cho()}</th><th class="num">{m.kha_dung()}</th><th class="num">{m.dinh_muc_toi_thieu()}</th><th>{m.cap_nhat()}</th>{#if editable}<th class="actions-col"><span class="sr-only">{m.crud_thao_tac()}</span></th>{/if}</tr></thead>
      <tbody>
        {#if loading && !rows.length}<tr class="empty-row"><td colspan="10">{m.dang_doc_so_ton()}</td></tr>
        {:else if rows.length}
          {#each rows as row (`${row.warehouseId}-${row.productId}`)}
            {@const low = row.belowMinimum && Number(row.minimumStock) > 0}
            <tr class:low>
              <td><a class="code" href={`/inventory/movements?productId=${row.productId}`}>{row.sku}</a></td>
              <td>{row.productName}</td>
              <td>{row.unit}</td>
              <td class="muted">{row.locationCode ?? '—'}</td>
              <td class="num">{num(row.onHand)}</td>
              <td class="num muted">{num(row.reserved)}</td>
              <td class="num"><b class:warn={low} class:zero={Number(row.available) <= 0}>{num(row.available)}</b></td>
              <td class="num muted">{num(row.minimumStock)}</td>
              <td class="muted nowrap">{dateTime(row.updatedAt)}</td>
              {#if editable}<td class="row-actions"><button class="icon-btn" title={m.crud_dieu_chinh_ton()} aria-label={`${m.crud_dieu_chinh_ton()} ${row.sku}`} onclick={() => adjust(row.productId)}><SlidersHorizontal size={15} /></button></td>{/if}
            </tr>
          {/each}
        {:else}<tr class="empty-row"><td colspan="10">{m.khong_co_ma_hang_phu_hop()}</td></tr>{/if}
      </tbody>
    </table>
  </div>
  <Pagination {page} {pageSize} {total} {loading} onchange={changePage} />
</section>

<AdjustmentDialog bind:open={adjustOpen} {warehouses} {warehouseId} productId={adjustProductId} onsaved={adjusted} />

<style>
  .filters { grid-template-columns: 1.5fr 1fr 1fr auto; }
  .check { display: flex; align-items: center; gap: 8px; min-height: 42px; color: var(--muted); font-size: 13.5px; }
  .check input { width: 17px; height: 17px; accent-color: var(--navy); }
  .head { padding-bottom: 14px; }
  tr.low { background: #fffaf0; }
  tr.low td:first-child { box-shadow: inset 3px 0 var(--amber); }
  .warn { color: var(--orange); }
  .zero { color: var(--red); }
  .actions-col { width: 48px; }
  @media (max-width: 900px) { .filters { grid-template-columns: 1fr 1fr; } }
</style>
