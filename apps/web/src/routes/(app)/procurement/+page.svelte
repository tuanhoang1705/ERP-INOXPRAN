<script lang="ts">
  import { m } from '$lib/paraglide/messages';
  import { onMount } from 'svelte';
  import { rememberList } from '$lib/record-nav';
  import { money } from '$lib/purchase';
  import { CircleAlert, Plus } from 'lucide-svelte';
  import { api } from '$lib/api';
  import { date, num } from '$lib/format';
  import { hasRole, purchaseStatus } from '$lib/labels';
  import { session } from '$lib/session.svelte';
  import { debounce, initialPageSize, pageQuery, rememberPageSize, type Paged } from '$lib/paging';
  import Pagination from '$lib/components/Pagination.svelte';
  import DateRangeFilter from '$lib/components/DateRangeFilter.svelte';

  type PurchaseOrder = { id: string; code: string; supplierName: string; supplierCode: string; supplierContractNo?: string; status: string; total: string; totalVnd: string; currency: string; expectedDate?: string; eta?: string; createdAt: string; lines: unknown[] };
  let orders = $state<PurchaseOrder[]>([]);
  let status = $state('');
  let search = $state('');
  /** Lọc theo khoảng ngày (LIST-DATE-01). */
  let from = $state('');
  let to = $state('');
  let total = $state(0);
  let page = $state(1);
  let pageSize = $state(initialPageSize());
  let loading = $state(true);
  let error = $state('');

  async function load() {
    loading = true;
    error = '';
    try {
      const filters = { status, search, from, to };
      const result = await api<Paged<PurchaseOrder>>(`/purchase-orders?${pageQuery(filters, page, pageSize)}`);
      orders = result.rows;
      total = result.total;
      rememberList('purchase-orders', { endpoint: '/purchase-orders', filters, page, pageSize, total: result.total, ids: result.rows.map((row) => row.id) });
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.khong_tai_duoc_don_mua();
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
  onMount(load);
</script>

<svelte:head><title>{m.nhap_kho_don_mua_inoxpran_erp()}</title></svelte:head>

<section class="page-head">
  <div>
    <nav class="crumbs" aria-label={m.duong_dan()}><a href="/inventory">{m.kho_giao_hang()}</a><span>{m.nhap_kho_don_mua()}</span></nav>
    <h1 class="page-title">{m.don_mua_hang_nhap_kho()}</h1>
    <p class="page-sub">{m.lap_don_dat_hang_nhap_gui()}</p>
  </div>
  <div class="actions">
    <a class="btn" href="/procurement/shipments">{m.ls_lo_hang_nhap()}</a>
    {#if hasRole(session.user?.roles, ['PROCUREMENT', 'PROCUREMENT_MANAGER'])}<a class="btn primary" href="/procurement/new"><Plus size={17} />{m.lap_don_mua()}</a>{/if}
  </div>
</section>

<section class="card filters">
  <div class="field"><label for="search">{m.tim_kiem()}</label><input id="search" bind:value={search} oninput={searchChanged} placeholder={m.crud_tim_don_mua()} /></div>
  <DateRangeFilter bind:from bind:to label={m.dr_ngay_lap()} id="po-date" onchange={refilter} />
  <div class="field"><label for="status">{m.trang_thai()}</label><select id="status" bind:value={status} onchange={refilter}><option value="">{m.tat_ca()}</option>{#each Object.entries(purchaseStatus) as [value, item]}<option {value}>{item.label}</option>{/each}</select></div>
</section>

{#if error}<div class="banner error"><CircleAlert size={17} />{error}</div>{/if}

<section class="card">
  <div class="table-wrap">
    <table class="table">
      <thead><tr><th>{m.ma_don_mua()}</th><th>{m.nha_cung_cap()}</th><th>{m.ngay_lap()}</th><th>{m.ngay_du_kien_ve()}</th><th class="num">{m.so_dong()}</th><th class="num">{m.po_gia_tri_don()}</th><th>{m.trang_thai()}</th></tr></thead>
      <tbody>
        {#if loading && !orders.length}<tr class="empty-row"><td colspan="7">{m.dang_tai()}</td></tr>
        {:else if orders.length}
          {#each orders as order (order.id)}
            {@const info = purchaseStatus[order.status] ?? { label: order.status, tone: '' }}
            <tr>
              <td><a class="code" href={`/procurement/${order.id}`}>{order.code}</a>{#if order.supplierContractNo}<small>{order.supplierContractNo}</small>{/if}</td>
              <td>{order.supplierName}<small>{order.supplierCode}</small></td>
              <td>{date(order.createdAt)}</td>
              <td>{order.eta ? `ETA ${date(`${order.eta}T00:00:00+07:00`)}` : order.expectedDate ? date(`${order.expectedDate}T00:00:00+07:00`) : '—'}</td>
              <td class="num">{order.lines.length}</td>
              <td class="num"><b>{money(order.total, order.currency)}</b>{#if order.currency !== 'VND'}<small>≈ {money(order.totalVnd)}</small>{/if}</td>
              <td><span class={`pill ${info.tone}`}>{info.label}</span></td>
            </tr>
          {/each}
        {:else}<tr class="empty-row"><td colspan="7">{m.chua_co_don_mua()}</td></tr>{/if}
      </tbody>
    </table>
  </div>
  <Pagination {page} {pageSize} {total} {loading} onchange={changePage} />
</section>

<style>
  .filters { grid-template-columns: minmax(220px, 420px) minmax(220px, 340px) minmax(200px, 280px); }
  @media (max-width: 720px) { .filters { grid-template-columns: 1fr; } }
</style>
