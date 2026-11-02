<script lang="ts">
  import { m } from '$lib/paraglide/messages';
  import type { SalesOrder } from '@inoxpran/contracts';
  import { untrack } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { CircleAlert, CircleCheck, Plus } from 'lucide-svelte';
  import { api } from '$lib/api';
  import { date, num } from '$lib/format';
  import { orderStage, salesStatus, stageFilters } from '$lib/labels';
  import { can, session } from '$lib/session.svelte';
  import { initialPageSize, rememberPageSize, type Paged } from '$lib/paging';
  import Pagination from '$lib/components/Pagination.svelte';
  import DateRangeFilter from '$lib/components/DateRangeFilter.svelte';
  import { loanAge, partyName, SLIP_TYPE_OPTIONS, slipTypeLabel, slipTypeOf, slipTypeShort, type SalesSlipType } from '$lib/slip-type';

  type Row = SalesOrder & { warehouseKeeperName?: string; province?: string; lineCount?: number; netTotal?: string; shippedAt?: string };
  let rows = $state<Row[]>([]);
  let loading = $state(true);
  let error = $state('');
  let search = $state('');
  let stage = $state('');
  let status = $state('');
  /** Loại phiếu (SAL-TYPE-01) — URL cũ `?channel=B2B` vẫn dùng được. */
  let type = $state('');
  /** `OUT` = hàng mẫu / kiểm định còn ở ngoài. */
  let loan = $state('');
  let from = $state('');
  let to = $state('');
  let customerId = $state('');
  let total = $state(0);
  let totalValue = $state('0');
  let pageNo = $state(1);
  let pageSize = $state(initialPageSize());
  /** Số phiếu nháp vừa xóa (chuyển từ trang chi tiết sang) — hiện thông báo. */
  let deletedCode = $state('');
  /** Số phiếu vừa hủy: phiếu đã hủy không còn hiện với người dùng (DOC-HIDE-01) nên trang chi tiết chuyển về đây. */
  let cancelledCode = $state('');
  /** Lọc "Đã hủy" chỉ dành cho quản trị gốc (DOC-HIDE-01). */
  const stages = $derived(stageFilters.filter((item) => item.value !== 'cancelled' || session.user?.root));

  const title = $derived(
    loan === 'OUT' ? m.lp_hang_mau_chua_tra()
      : type === 'B2C' ? m.phieu_xuat_kho_ban_le_b2c()
      : type === 'B2B' ? m.phieu_xuat_kho_dai_ly_b2b()
      : type === 'SAMPLE' || type === 'INSPECTION' || type === 'GIFT' ? slipTypeLabel(type)
      : m.phieu_xuat_kho_ban_hang(),
  );

  $effect(() => {
    const params = page.url.searchParams;
    search = params.get('search') ?? '';
    stage = params.get('stage') ?? '';
    status = params.get('status') ?? '';
    type = params.get('type') ?? params.get('channel') ?? '';
    loan = params.get('loan') ?? '';
    from = params.get('from') ?? '';
    to = params.get('to') ?? '';
    customerId = params.get('customerId') ?? '';
    deletedCode = params.get('deleted') ?? '';
    cancelledCode = params.get('cancelled') ?? '';
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
    if (type) query.set('type', type);
    if (loan) query.set('loan', loan);
    if (from) query.set('from', from);
    if (to) query.set('to', to);
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
    if (type) query.set('type', type);
    if (loan) query.set('loan', loan);
    if (from) query.set('from', from);
    if (to) query.set('to', to);
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
  {#if can('sales.step.create') && can('sales.step.issue')}
    <div class="actions"><a class="btn primary" href="/sales/orders/new"><Plus size={17} />{m.lap_phieu_bh()}</a></div>
  {:else if can('sales.step.create')}
    <div class="actions"><a class="btn primary" href="/sales/orders/new"><Plus size={17} />{m.de_nghi_xuat_ban()}</a></div>
  {/if}
</section>

<form class="card filters" onsubmit={apply}>
  <div class="field"><label for="search">{m.tim_kiem()}</label><input id="search" bind:value={search} placeholder={m.so_bh_swk_ma_hoac_ten()} /></div>
  <div class="field"><label for="stage">{m.buoc_xu_ly()}</label>
    <select id="stage" bind:value={stage} onchange={() => (status = '')}>
      <option value="">{status && salesStatus[status] ? salesStatus[status].label : m.tat_ca_buoc()}</option>
      {#each stages as item}<option value={item.value}>{item.label}</option>{/each}
    </select>
  </div>
  <div class="field"><label for="type">{m.lp_loai_phieu()}</label>
    <select id="type" bind:value={type} onchange={() => { if (type !== 'SAMPLE' && type !== 'INSPECTION' && type !== '') loan = ''; }}>
      <option value="">{m.lp_tat_ca_loai()}</option>
      {#each SLIP_TYPE_OPTIONS as item}<option value={item}>{slipTypeLabel(item as SalesSlipType)}</option>{/each}
    </select>
  </div>
  <DateRangeFilter bind:from bind:to label={m.dr_ngay_chung_tu()} id="order-date" onchange={() => apply()} />
  <label class="loan-check"><input type="checkbox" checked={loan === 'OUT'} onchange={(event) => { loan = event.currentTarget.checked ? 'OUT' : ''; apply(); }} /> {m.lp_hang_mau_chua_tra()}</label>
  <div class="actions"><button class="btn navy" type="submit">{m.loc_du_lieu()}</button><a class="btn" href="/sales/orders">{m.dat_lai()}</a></div>
</form>

{#if error}<div class="banner error"><CircleAlert size={17} />{error}</div>{/if}
{#if deletedCode}<div class="banner success"><CircleCheck size={17} />{m.bh_da_xoa_phieu({ code: deletedCode })}</div>{/if}
{#if cancelledCode}<div class="banner success"><CircleCheck size={17} />{m.doc_da_huy_khong_hien({ code: cancelledCode })}</div>{/if}
{#if customerId}<div class="banner">{m.dang_loc_theo_mot_khach_hang()} <a class="link" href="/sales/orders">{m.bo_loc_2()}</a></div>{/if}

<section class="card">
  <header class="card-head list-head"><h2>{loading && !rows.length ? m.dang_tai() : m.phieu({ p0: num(total) })}</h2><span class="muted">{m.tong_gia_tri()} <b>{num(totalValue)} {m.d()}</b></span></header>
  <div class="table-wrap">
    <table class="table">
      <thead><tr><th>{m.so_phieu_bh()}</th><th>{m.ngay_chung_tu()}</th><th>{m.so_phieu_swk()}</th><th>{m.khach_hang()}</th><th>{m.lp_loai_phieu()}</th><th>{m.nv_ban_hang()}</th><th class="num">{m.so_dong()}</th><th class="num">{m.tong_thanh_toan_2()}</th><th>{m.buoc_xu_ly()}</th></tr></thead>
      <tbody>
        {#if loading && !rows.length}<tr class="empty-row"><td colspan="9">{m.dang_tai_phieu()}</td></tr>
        {:else if rows.length}
          {#each rows as row (row.id)}
            {@const info = orderStage(row)}
            <tr>
              <td><a class="code" href={`/sales/orders/${row.id}`}>{row.code}</a></td>
              <td>{date(row.orderDate ?? row.createdAt)}</td>
              <td class="code slip">{row.warehouseSlipNo ?? '—'}{#if row.warehouseKeeperName}<small>{m.thu_kho_2()} {row.warehouseKeeperName}</small>{/if}</td>
              {#if row.purpose === 'SAMPLE' || row.purpose === 'INSPECTION' || row.purpose === 'GIFT'}
                {@const age = loanAge(row)}
                <td>{partyName(row)}{#if row.loanStatus === 'OUT' || row.loanStatus === 'PARTIAL'}<small class:overdue={age.overdue > 0}>{age.overdue > 0 ? m.lp_qua_hen({ days: age.overdue }) : m.lp_da_muon_ngay({ days: age.days })}</small>{/if}</td>
              {:else}
                <td>{row.customerName}<small>{row.customerCode}{row.province ? ` · ${row.province}` : ''}</small></td>
              {/if}
              <td><span class="tag" class:b2c={row.channel === 'B2C' && !row.purpose?.match(/SAMPLE|INSPECTION|GIFT/)} class:loan={row.purpose === 'SAMPLE' || row.purpose === 'INSPECTION' || row.purpose === 'GIFT'}>{slipTypeShort(slipTypeOf(row))}</span></td>
              <td class="muted">{row.salesRepName ?? '—'}</td>
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
  .filters { grid-template-columns: 1.3fr 1.1fr 1fr 1.2fr auto auto; align-items: end; }
  .loan-check { display: flex; align-items: center; gap: 6px; padding-bottom: 10px; font-size: 13px; white-space: nowrap; }
  .tag.loan { background: var(--orange-soft); color: #b4501f; }
  .overdue { color: var(--red) !important; font-weight: 600; }
  .list-head { padding-bottom: 14px; }
  .slip { color: var(--muted); font-weight: 500; }
  @media (max-width: 900px) { .filters { grid-template-columns: 1fr 1fr; } }
</style>
