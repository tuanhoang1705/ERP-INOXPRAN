<script lang="ts">
  /** Danh sách lô hàng nhập (container / B/L) theo trạng thái đi đường. */
  import { m } from '$lib/paraglide/messages';
  import { onMount } from 'svelte';
  import { CircleAlert } from 'lucide-svelte';
  import { api } from '$lib/api';
  import { date, num, vnd } from '$lib/format';
  import { debounce, initialPageSize, pageQuery, rememberPageSize, type Paged } from '$lib/paging';
  import { rememberList } from '$lib/record-nav';
  import Pagination from '$lib/components/Pagination.svelte';

  type Row = { id: string; code: string; status: string; containerNo?: string; containerType?: string; billOfLading?: string; etd?: string; eta?: string; lineCount: number; purchaseOrderCodes: string[]; costTotal: string; receivedAt?: string };
  let rows = $state<Row[]>([]);
  let status = $state('');
  let search = $state('');
  let total = $state(0);
  let page = $state(1);
  let pageSize = $state(initialPageSize());
  let loading = $state(true);
  let error = $state('');
  const statusLabel = (value: string) => ({ PLANNED: m.ls_ke_hoach(), IN_TRANSIT: m.ls_dang_van_chuyen(), ARRIVED: m.ls_da_cap_cang(), RECEIVED: m.ls_da_nhap_kho(), CANCELLED: m.ls_da_huy() })[value] ?? value;
  const statusTone = (value: string) => ({ IN_TRANSIT: 'warning', ARRIVED: '', RECEIVED: 'success', CANCELLED: 'neutral' })[value] ?? 'neutral';

  async function load() {
    loading = true;
    error = '';
    try {
      const filters = { status, search };
      const result = await api<Paged<Row>>(`/import-shipments?${pageQuery(filters, page, pageSize)}`);
      rows = result.rows;
      total = result.total;
      rememberList('import-shipments', { endpoint: '/import-shipments', filters, page, pageSize, total: result.total, ids: result.rows.map((row) => row.id) });
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.rw_loi_tai();
    } finally {
      loading = false;
    }
  }
  const refilter = () => {
    page = 1;
    void load();
  };
  const searchChanged = debounce(refilter);
  onMount(load);
</script>

<svelte:head><title>{m.ls_lo_hang_nhap()} · INOXPRAN ERP</title></svelte:head>

<section class="page-head">
  <div>
    <nav class="crumbs" aria-label={m.duong_dan()}><a href="/inventory">{m.kho_giao_hang()}</a><span><a href="/procurement">{m.nhap_kho_don_mua()}</a></span><span>{m.ls_lo_hang_nhap()}</span></nav>
    <h1 class="page-title">{m.ls_lo_hang_nhap()}</h1>
    <p class="page-sub">{m.ls_mo_ta_trang()}</p>
  </div>
</section>

<section class="card filters">
  <div class="field"><label for="search">{m.tim_kiem()}</label><input id="search" bind:value={search} oninput={searchChanged} placeholder={m.ls_tim_kiem()} /></div>
  <div class="field"><label for="status">{m.trang_thai()}</label>
    <select id="status" bind:value={status} onchange={refilter}><option value="">{m.tat_ca()}</option>{#each ['PLANNED', 'IN_TRANSIT', 'ARRIVED', 'RECEIVED', 'CANCELLED'] as value}<option {value}>{statusLabel(value)}</option>{/each}</select>
  </div>
</section>

{#if error}<div class="banner error"><CircleAlert size={17} />{error}</div>{/if}

<section class="card">
  <div class="table-wrap">
    <table class="table">
      <thead><tr><th>{m.po_so_lo()}</th><th>{m.ls_don_mua()}</th><th>Container</th><th>B/L</th><th>ETD</th><th>ETA</th><th class="num">{m.so_dong()}</th><th class="num">{m.ls_chi_phi_nhap()}</th><th>{m.trang_thai()}</th></tr></thead>
      <tbody>
        {#if loading && !rows.length}<tr class="empty-row"><td colspan="9">{m.dang_tai()}</td></tr>
        {:else if rows.length}
          {#each rows as row (row.id)}
            <tr>
              <td><a class="code link" href={`/procurement/shipments/${row.id}`}>{row.code}</a></td>
              <td>{row.purchaseOrderCodes.join(', ')}</td>
              <td>{row.containerNo ?? '—'}<small>{row.containerType ?? ''}</small></td>
              <td>{row.billOfLading ?? '—'}</td>
              <td>{row.etd ? date(row.etd) : '—'}</td>
              <td>{row.eta ? date(row.eta) : '—'}</td>
              <td class="num">{num(row.lineCount)}</td>
              <td class="num">{Number(row.costTotal) ? vnd(row.costTotal) : '—'}</td>
              <td><span class={`pill ${statusTone(row.status)}`}>{statusLabel(row.status)}</span></td>
            </tr>
          {/each}
        {:else}<tr class="empty-row"><td colspan="9">{m.ls_chua_co_lo_nao()}</td></tr>{/if}
      </tbody>
    </table>
  </div>
  <Pagination {page} {pageSize} {total} {loading} onchange={(next, size) => { if (size !== pageSize) rememberPageSize(size); page = next; pageSize = size; void load(); }} />
</section>

<style>
  .filters { grid-template-columns: minmax(220px, 420px) minmax(200px, 280px); }
  @media (max-width: 720px) { .filters { grid-template-columns: 1fr; } }
</style>
