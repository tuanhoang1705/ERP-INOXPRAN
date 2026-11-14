<script lang="ts">
  /**
   * Xuất hàng mẫu (SAMPLE-ISSUE-01, 12/11/2026): phiếu SWK-M do thủ kho lập — không qua phiếu BH / 5 bước. Danh sách kèm tình trạng
   * mượn và yêu cầu "khách mua luôn" đang chờ kế toán.
   */
  import type { SalesOrder, SampleSaleRequest, Warehouse } from '@inoxpran/contracts';
  import { onMount } from 'svelte';
  import { CircleAlert, PackagePlus, Search } from 'lucide-svelte';
  import { m } from '$lib/paraglide/messages';
  import { api } from '$lib/api';
  import { date, num } from '$lib/format';
  import { initialPageSize, pageQuery, rememberPageSize, type Paged } from '$lib/paging';
  import { can } from '$lib/permissions';
  import { loanAge, loanStatusInfo } from '$lib/slip-type';
  import Pagination from '$lib/components/Pagination.svelte';

  type Row = SalesOrder & { saleRequests?: SampleSaleRequest[]; shippedAt?: string; createdByName?: string };
  let rows = $state<Row[]>([]);
  let total = $state(0);
  let page = $state(1);
  let pageSize = $state(initialPageSize());
  let search = $state('');
  let loan = $state('');
  let loading = $state(true);
  let error = $state('');
  const editable = $derived(can.editWarehouses());
  let warehouses = $state<Warehouse[]>([]);
  const warehouseName = (id: string) => warehouses.find((row) => row.id === id)?.name ?? '';

  async function load() {
    loading = true;
    error = '';
    try {
      const result = await api<Paged<Row>>(`/sample-issues?${pageQuery({ search: search.trim(), loan }, page, pageSize)}`);
      rows = result.rows;
      total = result.total;
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.khong_tai_duoc_du_lieu_danh();
    } finally {
      loading = false;
    }
  }
  onMount(() => {
    void load();
    void api<Warehouse[]>('/warehouses').then((rows) => (warehouses = rows)).catch(() => undefined);
  });
  function changePage(next: number, size: number) {
    if (size !== pageSize) rememberPageSize(size);
    page = next;
    pageSize = size;
    void load();
  }
  const pendingSale = (row: Row) => (row.saleRequests ?? []).filter((item) => item.status === 'PENDING' || item.status === 'ORDERED').length;
</script>

<svelte:head><title>{m.xm_tieu_de()} · INOXPRAN ERP</title></svelte:head>

<section class="page-head">
  <div>
    <nav class="crumbs" aria-label={m.duong_dan()}><a href="/inventory">{m.kho_giao_hang()}</a><span>{m.xm_tieu_de()}</span></nav>
    <h1 class="page-title">{m.xm_tieu_de()}</h1>
    <p class="page-sub">{m.xm_mo_ta()}</p>
  </div>
  {#if editable}<div class="actions"><a class="btn primary" href="/inventory/sample-issues/new"><PackagePlus size={16} />{m.xm_lap_phieu()}</a></div>{/if}
</section>

<section class="card filters">
  <form class="field grow" onsubmit={(event) => { event.preventDefault(); page = 1; void load(); }}>
    <label for="si-search">{m.tim_kiem()}</label>
    <div class="search"><Search size={16} /><input id="si-search" bind:value={search} placeholder={m.xm_tim_goi_y()} /></div>
  </form>
  <div class="field">
    <label for="si-loan">{m.xm_tinh_trang()}</label>
    <select id="si-loan" bind:value={loan} onchange={() => { page = 1; void load(); }}>
      <option value="">{m.tat_ca()}</option>
      <option value="OUT">{m.lp_hang_mau_chua_tra()}</option>
    </select>
  </div>
</section>

{#if error}<div class="banner error"><CircleAlert size={17} />{error}</div>{/if}

<section class="card">
  <div class="table-wrap">
    <table class="table">
      <thead><tr><th>{m.chung_tu()}</th><th>{m.lp_nguoi_muon_ngan()}</th><th>{m.kho_xuat()}</th><th>{m.xm_hang_mau()}</th><th>{m.lp_hen_tra()}</th><th>{m.xm_tinh_trang()}</th></tr></thead>
      <tbody>
        {#if loading && !rows.length}<tr class="empty-row"><td colspan="6">{m.dang_tai()}</td></tr>
        {:else}
          {#each rows as row (row.id)}
            {@const status = loanStatusInfo(row.loanStatus)}
            {@const age = loanAge(row)}
            <tr class:voided={row.status === 'CANCELLED'}>
              <td><a class="code link" href={`/inventory/sample-issues/${row.id}`}>{row.code}</a><small>{date(row.shippedAt ?? row.createdAt)} · {row.createdByName ?? ''}</small></td>
              <td>{row.salesRepName ?? '—'}{#if row.destination}<small>→ {row.destination}</small>{/if}</td>
              <td>{warehouseName(row.warehouseId)}<small>{row.warehouseKeeperName ?? ''}</small></td>
              <td><div class="lines">{#each row.lines as line}<span><b class="code">{line.sku}</b> × {num(line.quantity)}</span>{/each}</div></td>
              <td>{row.expectedReturnDate ? date(`${row.expectedReturnDate}T12:00:00+07:00`) : '—'}{#if row.loanStatus === 'OUT' || row.loanStatus === 'PARTIAL'}<small class:overdue={age.overdue > 0}>{age.overdue > 0 ? m.lp_qua_hen({ days: age.overdue }) : m.lp_da_muon_ngay({ days: age.days })}</small>{/if}</td>
              <td>
                {#if row.status === 'CANCELLED'}<span class="pill danger">{m.inv_trang_thai_da_huy()}</span>
                {:else if status}<span class={`pill ${status.tone}`}>{status.label}</span>{/if}
                {#if pendingSale(row)}<span class="pill orange">{m.xm_cho_ban({ count: pendingSale(row) })}</span>{/if}
              </td>
            </tr>
          {:else}<tr class="empty-row"><td colspan="6">{m.xm_chua_co_phieu()}</td></tr>{/each}
        {/if}
      </tbody>
    </table>
  </div>
  <Pagination {page} {pageSize} {total} {loading} onchange={changePage} />
</section>

<style>
  .filters { display: grid; grid-template-columns: minmax(240px, 1fr) minmax(200px, 280px); gap: 16px; }
  .search { display: flex; align-items: center; gap: 8px; padding: 0 12px; border: 1px solid var(--border); border-radius: 10px; background: var(--surface); }
  .search input { flex: 1; min-width: 0; border: 0; padding: 10px 0; background: none; outline: none; }
  td { vertical-align: top; }
  td small { display: block; color: var(--subtle); font-size: 12px; }
  small.overdue { color: var(--red); }
  .lines { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 2px 12px; }
  .lines span { white-space: nowrap; }
  td .pill + .pill { margin-left: 4px; }
  tr.voided td { color: var(--subtle); }
  .link { color: var(--navy-2); font-weight: 700; }
  @media (max-width: 760px) { .filters { grid-template-columns: 1fr; } }
</style>
