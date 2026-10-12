<script lang="ts">
  import { m } from '$lib/paraglide/messages';
  import type { WarrantyReport } from '@inoxpran/contracts';
  import { onMount } from 'svelte';
  import { CircleAlert } from 'lucide-svelte';
  import { api } from '$lib/api';
  import ColumnChart from '$lib/components/ColumnChart.svelte';
  import { decimal1, millions, num, percent, vnd } from '$lib/format';
  import { resolutionText } from '$lib/warranty';
  import type { WarrantyResolution } from '$shared/warranty';

  let report = $state<WarrantyReport | null>(null);
  let from = $state('');
  let to = $state('');
  let loading = $state(true);
  let error = $state('');

  const monthLabel = (month: string) => `${month.slice(5, 7)}/${month.slice(0, 4)}`;
  const maxFault = $derived(Math.max(1, ...(report?.byFaultCode.map((row) => row.count) ?? [1])));

  async function load(event?: SubmitEvent) {
    event?.preventDefault();
    loading = true;
    error = '';
    try {
      const query = new URLSearchParams();
      if (from) query.set('from', from);
      if (to) query.set('to', to);
      report = await api<WarrantyReport>(`/warranty/reports${query.size ? `?${query}` : ''}`);
      from = report.from;
      to = report.to;
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.wr_load_error();
    } finally {
      loading = false;
    }
  }
  onMount(load);
</script>

<svelte:head><title>{m.wr_report_title()} · INOXPRAN ERP</title></svelte:head>

<section class="page-head">
  <div>
    <nav class="crumbs" aria-label={m.duong_dan()}><a href="/warranty">{m.wr_nav()}</a><span>{m.wr_nav_reports()}</span></nav>
    <h1 class="page-title">{m.wr_report_title()}</h1>
    <p class="page-sub">{m.wr_report_sub()}</p>
  </div>
</section>

<form class="card filters" onsubmit={load}>
  <div class="field"><label for="from">{m.wr_report_from()}</label><input id="from" type="month" bind:value={from} max={to || undefined} /></div>
  <div class="field"><label for="to">{m.wr_report_to()}</label><input id="to" type="month" bind:value={to} min={from || undefined} /></div>
  <div class="actions"><button class="btn navy" type="submit" disabled={loading}>{m.loc_du_lieu()}</button></div>
</form>

{#if error}<div class="banner error"><CircleAlert size={17} />{error}</div>{/if}

{#if report}
  {@const totals = report.totals}
  <section class="tiles">
    <article class="card tile"><span>{m.wr_kpi_received()}</span><b>{num(totals.received)}</b><small>{m.wr_kpi_open({ open: totals.open, overdue: totals.overdueOpen })}</small></article>
    <article class="card tile"><span>{m.wr_kpi_returned()}</span><b>{num(totals.returned)}</b><small>{m.wr_kpi_exchange_refund({ exchanged: totals.exchanged, refunded: totals.refunded })}</small></article>
    <article class="card tile"><span>{m.wr_kpi_on_time()}</span><b class:good={(totals.onTimeRate ?? 0) >= 90} class:bad={totals.onTimeRate !== null && totals.onTimeRate < 80}>{totals.onTimeRate === null ? '—' : percent(totals.onTimeRate, 1)}</b><small>{m.wr_kpi_on_time_hint()}</small></article>
    <article class="card tile"><span>{m.wr_kpi_turnaround()}</span><b>{totals.averageTurnaroundDays === null ? '—' : m.wr_days_count({ days: decimal1(totals.averageTurnaroundDays) })}</b><small>{m.wr_kpi_turnaround_hint()}</small></article>
    <article class="card tile"><span>{m.wr_kpi_rejection()}</span><b>{totals.rejectionRate === null ? '—' : percent(totals.rejectionRate, 1)}</b><small>{m.wr_kpi_rejection_hint()}</small></article>
    <article class="card tile"><span>{m.wr_kpi_company_cost()}</span><b>{vnd(totals.companyCost)}</b><small>{m.wr_kpi_company_cost_hint()}</small></article>
    <article class="card tile"><span>{m.wr_kpi_service_revenue()}</span><b>{vnd(totals.serviceRevenue)}</b><small>{m.wr_kpi_service_revenue_hint()}</small></article>
  </section>

  <section class="charts">
    <article class="card">
      <header class="card-head"><h2>{m.wr_chart_received()}</h2></header>
      <ColumnChart caption={m.wr_chart_received()} data={report.byMonth.map((row) => ({ label: monthLabel(row.month), value: row.received, tooltip: `${monthLabel(row.month)}: ${row.received}` }))} />
    </article>
    <article class="card">
      <header class="card-head"><h2>{m.wr_chart_cost()}</h2></header>
      <ColumnChart caption={m.wr_chart_cost()} format={(value) => millions(value)} axisFormat={(value) => decimal1(value / 1_000_000)}
        data={report.byMonth.map((row) => ({ label: monthLabel(row.month), value: Number(row.companyCost), tooltip: `${monthLabel(row.month)}: ${vnd(row.companyCost)}` }))} />
    </article>
  </section>

  <section class="card">
    <header class="card-head"><h2>{m.wr_by_month()}</h2></header>
    <div class="table-wrap">
      <table class="table">
        <thead><tr><th>{m.wr_month()}</th><th class="num">{m.wr_kpi_received()}</th><th class="num">{m.wr_kpi_returned()}</th><th class="num">{m.wr_kpi_on_time()}</th><th class="num">{m.wr_kpi_company_cost()}</th><th class="num">{m.wr_kpi_service_revenue()}</th></tr></thead>
        <tbody>
          {#each report.byMonth as row}
            <tr><td>{monthLabel(row.month)}</td><td class="num">{row.received}</td><td class="num">{row.returned}</td><td class="num">{row.returned ? percent((row.onTime / row.returned) * 100, 0) : '—'}</td><td class="num">{num(row.companyCost)}</td><td class="num">{num(row.serviceRevenue)}</td></tr>
          {/each}
        </tbody>
      </table>
    </div>
  </section>

  <section class="split">
    <article class="card">
      <header class="card-head"><h2>{m.wr_by_fault()}</h2></header>
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>{m.wr_col_fault()}</th><th>{m.wr_fault_name()}</th><th class="num">{m.wr_count()}</th></tr></thead>
          <tbody>
            {#each report.byFaultCode as row}
              <tr><td class="code">{row.code}</td><td>{row.name}<span class="bar" aria-hidden="true"><i style={`width:${(row.count / maxFault) * 100}%`}></i></span></td><td class="num">{row.count}</td></tr>
            {:else}<tr class="empty-row"><td colspan="3">{m.wr_report_empty()}</td></tr>{/each}
          </tbody>
        </table>
      </div>
    </article>
    <article class="card">
      <header class="card-head"><h2>{m.wr_by_product()}</h2></header>
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>{m.ma_sp()}</th><th>{m.ten_san_pham()}</th><th class="num">{m.wr_count()}</th><th class="num">{m.wr_kpi_company_cost()}</th></tr></thead>
          <tbody>
            {#each report.byProduct as row}
              <tr><td class="code">{row.sku}</td><td>{row.name}</td><td class="num">{row.count}</td><td class="num">{num(row.companyCost)}</td></tr>
            {:else}<tr class="empty-row"><td colspan="4">{m.wr_report_empty()}</td></tr>{/each}
          </tbody>
        </table>
      </div>
    </article>
  </section>

  <section class="split">
    <article class="card">
      <header class="card-head"><h2>{m.wr_by_resolution()}</h2></header>
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>{m.wr_resolution()}</th><th class="num">{m.wr_count()}</th><th class="num">%</th></tr></thead>
          <tbody>
            {#each report.byResolution as row}
              <tr><td>{resolutionText(row.resolution as WarrantyResolution)}</td><td class="num">{row.count}</td><td class="num">{percent((row.count / Math.max(1, totals.returned)) * 100, 0)}</td></tr>
            {:else}<tr class="empty-row"><td colspan="3">{m.wr_report_empty()}</td></tr>{/each}
          </tbody>
        </table>
      </div>
    </article>
    <article class="card">
      <header class="card-head"><h2>{m.wr_repeat_title()}</h2></header>
      <p class="note">{m.wr_repeat_note()}</p>
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>{m.ma_sp()}</th><th>{m.wr_invoice_no()}</th><th>{m.khach_hang()}</th><th class="num">{m.wr_services()}</th><th>{m.wr_last_ticket()}</th></tr></thead>
          <tbody>
            {#each report.repeatProducts as row}
              <tr><td class="code">{row.sku}</td><td>{row.invoiceNumber}</td><td>{row.customerName}</td><td class="num"><b class="bad">{row.services}</b></td><td><a class="code" href={`/warranty/${row.lastTicketId}`}>{row.lastCode}</a></td></tr>
            {:else}<tr class="empty-row"><td colspan="5">{m.wr_repeat_empty()}</td></tr>{/each}
          </tbody>
        </table>
      </div>
    </article>
  </section>
{:else if loading}
  <p class="muted">{m.dang_tai()}</p>
{/if}

<style>
  .filters { grid-template-columns: minmax(160px, 220px) minmax(160px, 220px) auto; }
  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(145px, 1fr)); gap: 14px; margin-bottom: 16px; }
  .tile { display: grid; gap: 4px; padding: 16px 18px; }
  .tile span { color: var(--muted); font-size: 12.5px; }
  .tile b { font-size: 20px; font-weight: 700; white-space: nowrap; }
  .tile small { color: var(--subtle); font-size: 11.5px; }
  .good { color: var(--green); }
  .bad { color: var(--red); }
  .charts { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; margin-bottom: 16px; }
  .charts article { padding-bottom: 12px; }
  .split { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; margin: 16px 0; }
  .bar { display: block; height: 4px; margin-top: 5px; border-radius: 2px; background: var(--line-soft); }
  .bar i { display: block; height: 100%; border-radius: 2px; background: var(--navy-2); }
  .note { margin: 0; padding: 0 20px 10px; color: var(--subtle); font-size: 12.5px; }
  @media (max-width: 1000px) { .charts, .split { grid-template-columns: 1fr; } }
  @media (max-width: 640px) { .filters { grid-template-columns: 1fr 1fr; } }
</style>
