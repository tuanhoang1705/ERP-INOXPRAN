<script lang="ts">
  import { m } from '$lib/paraglide/messages';
  import type { WarrantyTicket } from '@inoxpran/contracts';
  import { untrack } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { CircleAlert, Plus, Search } from 'lucide-svelte';
  import { api } from '$lib/api';
  import { date } from '$lib/format';
  import { hasRole } from '$lib/labels';
  import { session } from '$lib/session.svelte';
  import { coverageText, coverageTone, slaText, statusText, statusTone, toneText, WARRANTY_STAFF, type SlaView } from '$lib/warranty';
  import { WARRANTY_STATUSES, type SlaTone } from '$shared/warranty';
  import { initialPageSize, rememberPageSize } from '$lib/paging';
  import Pagination from '$lib/components/Pagination.svelte';
  import DateRangeFilter from '$lib/components/DateRangeFilter.svelte';

  type Row = WarrantyTicket & { sla: SlaView };
  type Result = { settings: { warrantyMonths: number; turnaroundDays: number; warningRatio: number }; counts: Record<SlaTone, number>; rows: Row[]; total: number };

  let result = $state<Result | null>(null);
  let loading = $state(true);
  let error = $state('');
  let search = $state(page.url.searchParams.get('search') ?? '');
  const tone = $derived(page.url.searchParams.get('tone') ?? '');
  const status = $derived(page.url.searchParams.get('status') ?? '');
  /** Lọc theo ngày nhận phiếu (LIST-DATE-01), giữ trên URL như các bộ lọc khác. */
  let from = $state(page.url.searchParams.get('from') ?? '');
  let to = $state(page.url.searchParams.get('to') ?? '');
  const canReceive = $derived(hasRole(session.user?.roles, WARRANTY_STAFF));
  const tones: SlaTone[] = ['overdue', 'warning', 'normal', 'closed'];
  let pageNo = $state(1);
  let pageSize = $state(initialPageSize());

  async function load() {
    loading = true;
    error = '';
    const query = new URLSearchParams();
    for (const [key, value] of [['tone', tone], ['status', status], ['search', page.url.searchParams.get('search') ?? ''], ['from', page.url.searchParams.get('from') ?? ''], ['to', page.url.searchParams.get('to') ?? '']]) if (value) query.set(key, value);
    query.set('page', String(pageNo));
    query.set('pageSize', String(pageSize));
    try {
      result = await api<Result>(`/warranty/tickets?${query}`);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.wr_load_error();
    } finally {
      loading = false;
    }
  }

  // Bộ lọc nằm trên URL: đổi URL → về trang 1. load() chạy ngoài theo dõi để đổi trang không kích hoạt lại effect.
  $effect(() => {
    void page.url.search;
    untrack(() => {
      pageNo = 1;
      void load();
    });
  });
  function changePage(next: number, size: number) {
    if (size !== pageSize) rememberPageSize(size);
    pageNo = next;
    pageSize = size;
    void load();
  }

  function filter(changes: Record<string, string>) {
    const query = new URLSearchParams(page.url.searchParams);
    for (const [key, value] of Object.entries(changes)) {
      if (value) query.set(key, value);
      else query.delete(key);
    }
    void goto(`/warranty${query.size ? `?${query}` : ''}`, { keepFocus: true });
  }
</script>

<svelte:head><title>{m.wr_title()} · INOXPRAN ERP</title></svelte:head>

<section class="page-head">
  <div>
    <nav class="crumbs" aria-label={m.duong_dan()}><a href="/warranty">{m.wr_nav()}</a><span>{m.wr_nav_list()}</span></nav>
    <h1 class="page-title">{m.wr_title()}</h1>
    {#if result}<p class="page-sub">{m.wr_sub({ months: result.settings.warrantyMonths, days: result.settings.turnaroundDays, percent: Math.round(result.settings.warningRatio * 100) })}</p>{/if}
  </div>
  {#if canReceive}<div class="actions"><a class="btn primary" href="/warranty/new"><Plus size={17} />{m.wr_nav_new()}</a></div>{/if}
</section>

<section class="tones" aria-label={m.wr_col_time()}>
  {#each tones as item}
    <button class={`tone ${item}`} class:active={tone === item} onclick={() => filter({ tone: tone === item ? '' : item })}>
      <span>{toneText(item)}</span><b>{result?.counts[item] ?? '—'}</b>
    </button>
  {/each}
</section>

<form class="card filters" onsubmit={(event) => { event.preventDefault(); filter({ search: search.trim() }); }}>
  <div class="field"><label for="search">{m.tim_kiem()}</label><input id="search" bind:value={search} placeholder={m.wr_search_ph()} /></div>
  <DateRangeFilter bind:from bind:to label={m.dr_ngay_nhan()} id="ticket-date" onchange={() => filter({ from, to })} />
  <div class="field">
    <label for="status">{m.trang_thai()}</label>
    <select id="status" value={status} onchange={(event) => filter({ status: event.currentTarget.value })}>
      <option value="">{m.wr_all_status()}</option>
      {#each WARRANTY_STATUSES as item}<option value={item}>{statusText(item)}</option>{/each}
    </select>
  </div>
  <div class="actions"><button class="btn navy" type="submit"><Search size={16} />{m.loc_du_lieu()}</button><a class="btn" href="/warranty">{m.dat_lai()}</a></div>
</form>

{#if error}<div class="banner error"><CircleAlert size={17} />{error}</div>{/if}

<section class="card">
  <header class="card-head"><h2>{loading ? m.dang_tai() : m.wr_count_tickets({ count: result?.total ?? 0 })}</h2></header>
  <div class="table-wrap">
    <table class="table">
      <thead>
        <tr>
          <th>{m.so_phieu()}</th><th>{m.khach_hang()}</th><th>{m.wr_info_product()}</th><th>{m.wr_col_coverage()}</th>
          <th>{m.wr_col_received()}</th><th>{m.wr_col_promised()}</th><th>{m.wr_col_time()}</th><th>{m.trang_thai()}</th><th>{m.wr_col_tech()}</th>
        </tr>
      </thead>
      <tbody>
        {#if loading && !result}<tr class="empty-row"><td colspan="9">{m.dang_tai()}</td></tr>
        {:else if result?.rows.length}
          {#each result.rows as row (row.id)}
            <tr class={`tone-${row.sla.tone}`}>
              <td><a class="code" href={`/warranty/${row.id}`}>{row.code}</a></td>
              <td class="customer">{row.customer.name}<small>{row.customer.phone ?? row.customer.code ?? ''}</small></td>
              <td class="product"><span class="code">{row.product.sku}</span><small title={row.product.name}>{row.product.name}</small></td>
              <td><span class={`pill ${coverageTone[row.coverage]}`}>{coverageText(row.coverage)}</span></td>
              <td class="muted">{date(row.receivedAt)}</td>
              <td>{date(row.promisedDate)}{#if row.reschedules.length}<small>{m.wr_rescheduled()}</small>{/if}</td>
              <td class="time">
                {#if row.sla.tone !== 'closed'}<span class="bar" aria-hidden="true"><i style={`width:${Math.min(100, Math.max(4, row.sla.elapsedRatio * 100))}%`}></i></span>{/if}
                <b>{slaText(row.sla)}</b>
              </td>
              <td><span class={`pill ${statusTone[row.status]}`}>{statusText(row.status)}</span></td>
              <td class="muted">{row.technicianName ?? '—'}</td>
            </tr>
          {/each}
        {:else}<tr class="empty-row"><td colspan="9">{m.wr_empty()}</td></tr>{/if}
      </tbody>
    </table>
  </div>
  {#if result}<Pagination page={pageNo} {pageSize} total={result.total} {loading} onchange={changePage} />{/if}
</section>
<p class="legend"><span class="swatch warning"></span><span class="swatch overdue"></span>{m.wr_legend()}</p>

<style>
  .tones { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-bottom: 16px; }
  .tone { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 14px 16px; border: 1px solid var(--line); border-left-width: 5px; border-radius: var(--radius-sm); background: var(--surface); color: var(--text); text-align: left; }
  .tone span { font-size: 13px; font-weight: 600; }
  .tone b { font-size: 22px; }
  .tone.overdue { border-left-color: var(--red); }
  .tone.overdue b { color: var(--red); }
  .tone.warning { border-left-color: var(--amber); }
  .tone.warning b { color: var(--amber); }
  .tone.normal { border-left-color: var(--line); }
  .tone.closed { border-left-color: var(--line-soft); color: var(--muted); }
  .tone.active { box-shadow: 0 0 0 2px var(--navy-2) inset; }
  .filters { grid-template-columns: 2fr 1.4fr 1fr auto; margin-bottom: 16px; }
  td small { display: block; color: var(--subtle); font-size: 12px; }
  .customer { min-width: 170px; }
  .product small { max-width: 210px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  td:last-child { white-space: nowrap; }
  tr.tone-warning td { background: #fff8e1; }
  tr.tone-warning td:first-child { box-shadow: inset 4px 0 0 var(--amber); }
  tr.tone-overdue td { background: #fdecea; }
  tr.tone-overdue td:first-child { box-shadow: inset 4px 0 0 var(--red); }
  tr.tone-closed td { color: var(--muted); }
  .time { min-width: 130px; }
  .time b { font-size: 12.5px; }
  .bar { display: block; width: 110px; height: 6px; margin-bottom: 5px; border-radius: 3px; background: var(--line-soft); overflow: hidden; }
  .bar i { display: block; height: 100%; background: var(--green); }
  .tone-warning .bar i { background: var(--amber); }
  .tone-overdue .bar i { background: var(--red); }
  .tone-overdue .time b { color: var(--red); }
  .tone-warning .time b { color: var(--amber); }
  .legend { display: flex; align-items: center; gap: 6px; color: var(--subtle); font-size: 12.5px; }
  .swatch { display: inline-block; width: 14px; height: 14px; border-radius: 3px; }
  .swatch.warning { background: #fff8e1; box-shadow: inset 3px 0 0 var(--amber); }
  .swatch.overdue { background: #fdecea; box-shadow: inset 3px 0 0 var(--red); margin-right: 4px; }
  @media (max-width: 900px) { .tones { grid-template-columns: repeat(2, minmax(0, 1fr)); } .filters { grid-template-columns: 1fr; } }
</style>
