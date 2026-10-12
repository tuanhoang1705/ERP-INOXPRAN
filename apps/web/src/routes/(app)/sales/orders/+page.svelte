<script lang="ts">
  import { m } from '$lib/paraglide/messages';
  import type { SalesOrder } from '@inoxpran/contracts';
  import { untrack } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { CircleAlert, CircleCheck, Plus } from 'lucide-svelte';
  import { api } from '$lib/api';
  import { date, num } from '$lib/format';
  import { hasRole, orderStage, salesStatus, stageFilters } from '$lib/labels';
  import { session } from '$lib/session.svelte';
  import { initialPageSize, rememberPageSize, type Paged } from '$lib/paging';
  import Pagination from '$lib/components/Pagination.svelte';

  type Row = SalesOrder & { warehouseKeeperName?: string; province?: string; lineCount?: number; netTotal?: string };
  let rows = $state<Row[]>([]);
  let loading = $state(true);
  let error = $state('');
  let search = $state('');
  let stage = $state('');
  let status = $state('');
  let channel = $state('');
  let customerId = $state('');
  let total = $state(0);
  let totalValue = $state('0');
  let pageNo = $state(1);
  let pageSize = $state(initialPageSize());
  /** Số phiếu nháp vừa xóa (chuyển từ trang chi tiết sang) — hiện thông báo. */
  let deletedCode = $state('');

  const roles = $derived(session.user?.roles ?? []);
  const title = $derived(channel === 'B2C' ? m.phieu_xuat_kho_ban_le_b2c() : channel === 'B2B' ? m.phieu_xuat_kho_dai_ly_b2b() : m.phieu_xuat_kho_ban_hang());

  $effect(() => {
    const params = page.url.searchParams;
    search = params.get('search') ?? '';
    stage = params.get('stage') ?? '';
    status = params.get('status') ?? '';
    channel = params.get('channel') ?? '';
    customerId = params.get('customerId') ?? '';
    deletedCode = params.get('deleted') ?? '';
    // load() chạy ngoài theo dõi: đổi trang / gõ tìm kiếm không kích hoạt lại effect (chỉ URL mới kích hoạt).
    untrack(() => {
      pageNo = 1;
      void load();
    });
  });

  async function load() {
    loading = true;
    error = '';
    const query = new URLSearchParams();
    if (search) query.set('search', search);
    const preset = stageFilters.find((item) => item.value === stage);
    if (preset) for (const [key, value] of Object.entries(preset.query)) query.set(key, value);
    else if (status) query.set('status', status);
    if (channel) query.set('channel', channel);
    if (customerId) query.set('customerId', customerId);
    query.set('page', String(pageNo));
    query.set('pageSize', String(pageSize));
    try {
      const result = await api<Paged<Row> & { totalValue: string }>(`/sales-orders?${query}`);
      rows = result.rows;
      total = result.total;
      totalValue = result.totalValue;
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.khong_tai_duoc_danh_sach_phieu();
    } finally {
      loading = false;
    }
  }

  function changePage(next: number, size: number) {
    if (size !== pageSize) rememberPageSize(size);
    pageNo = next;
    pageSize = size;
    void load();
  }

  function apply(event?: SubmitEvent) {
    event?.preventDefault();
    const query = new URLSearchParams();
    if (search) query.set('search', search);
    if (stage) query.set('stage', stage);
    else if (status) query.set('status', status);
    if (channel) query.set('channel', channel);
    goto(`/sales/orders${query.size ? `?${query}` : ''}`, { keepFocus: true });
  }
</script>

<svelte:head><title>{title} | INOXPRAN ERP</title></svelte:head>

<section class="page-head">
  <div>
    <nav class="crumbs" aria-label={m.duong_dan()}><a href="/sales/orders">{m.don_hang()}</a><span>{title}</span></nav>
    <h1 class="page-title">{title}</h1>
    <p class="page-sub">{m.ke_toan_lap_phieu_bh_kinh_2()}</p>
  </div>
  {#if hasRole(roles, ['ACCOUNTANT'])}
    <div class="actions"><a class="btn primary" href="/sales/orders/new"><Plus size={17} />{m.lap_phieu_bh()}</a></div>
  {:else if hasRole(roles, ['SALES', 'SALES_MANAGER'])}
    <div class="actions"><a class="btn primary" href="/sales/orders/new"><Plus size={17} />{m.de_nghi_xuat_ban()}</a></div>
  {/if}
</section>

<form class="card filters" onsubmit={apply}>
  <div class="field"><label for="search">{m.tim_kiem()}</label><input id="search" bind:value={search} placeholder={m.so_bh_swk_ma_hoac_ten()} /></div>
  <div class="field"><label for="stage">{m.buoc_xu_ly()}</label>
    <select id="stage" bind:value={stage} onchange={() => (status = '')}>
      <option value="">{status && salesStatus[status] ? salesStatus[status].label : m.tat_ca_buoc()}</option>
      {#each stageFilters as item}<option value={item.value}>{item.label}</option>{/each}
    </select>
  </div>
  <div class="field"><label for="channel">{m.kenh_ban()}</label>
    <select id="channel" bind:value={channel}><option value="">{m.tat_ca_kenh()}</option><option value="B2B">{m.b2b_dai_ly_npp()}</option><option value="B2C">{m.b2c_khach_le()}</option></select>
  </div>
  <div class="actions"><button class="btn navy" type="submit">{m.loc_du_lieu()}</button><a class="btn" href="/sales/orders">{m.dat_lai()}</a></div>
</form>

{#if error}<div class="banner error"><CircleAlert size={17} />{error}</div>{/if}
{#if deletedCode}<div class="banner success"><CircleCheck size={17} />{m.bh_da_xoa_phieu({ code: deletedCode })}</div>{/if}
{#if customerId}<div class="banner">{m.dang_loc_theo_mot_khach_hang()} <a class="link" href="/sales/orders">{m.bo_loc_2()}</a></div>{/if}

<section class="card">
  <header class="card-head list-head"><h2>{loading && !rows.length ? m.dang_tai() : m.phieu({ p0: num(total) })}</h2><span class="muted">{m.tong_gia_tri()} <b>{num(totalValue)} {m.d()}</b></span></header>
  <div class="table-wrap">
    <table class="table">
      <thead><tr><th>{m.so_phieu_bh()}</th><th>{m.so_phieu_swk()}</th><th>{m.khach_hang()}</th><th>{m.kenh()}</th><th>{m.nv_ban_hang()}</th><th>{m.ngay_chung_tu()}</th><th class="num">{m.so_dong()}</th><th class="num">{m.tong_thanh_toan_2()}</th><th>{m.buoc_xu_ly()}</th></tr></thead>
      <tbody>
        {#if loading && !rows.length}<tr class="empty-row"><td colspan="9">{m.dang_tai_phieu()}</td></tr>
        {:else if rows.length}
          {#each rows as row (row.id)}
            {@const info = orderStage(row)}
            <tr>
              <td><a class="code" href={`/sales/orders/${row.id}`}>{row.code}</a></td>
              <td class="code slip">{row.warehouseSlipNo ?? '—'}{#if row.warehouseKeeperName}<small>{m.thu_kho_2()} {row.warehouseKeeperName}</small>{/if}</td>
              <td>{row.customerName}<small>{row.customerCode}{row.province ? ` · ${row.province}` : ''}</small></td>
              <td><span class="tag" class:b2c={row.channel === 'B2C'}>{row.channel ?? 'B2B'}</span></td>
              <td class="muted">{row.salesRepName ?? '—'}</td>
              <td>{date(row.orderDate ?? row.createdAt)}</td>
              <td class="num">{row.lineCount ?? row.lines.length}</td>
              <td class="num"><b>{num(row.grandTotal)}</b></td>
              <td><span class={`pill ${info.tone}`}>{info.label}</span></td>
            </tr>
          {/each}
        {:else}<tr class="empty-row"><td colspan="9">{m.khong_co_phieu_phu_hop_bo()}</td></tr>{/if}
      </tbody>
    </table>
  </div>
  <Pagination page={pageNo} {pageSize} {total} {loading} onchange={changePage} />
</section>

<style>
  .filters { grid-template-columns: 1.4fr 1.2fr 1fr auto; }
  .list-head { padding-bottom: 14px; }
  .slip { color: var(--muted); font-weight: 500; }
  @media (max-width: 900px) { .filters { grid-template-columns: 1fr 1fr; } }
</style>
