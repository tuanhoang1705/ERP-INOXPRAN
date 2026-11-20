<script lang="ts">
  import { NEW_PROVINCES } from '$shared/provinces';
  import { CUSTOMER_RETURN_CATEGORIES } from '$shared/inventory-categories';
  import { RETURN_THRESHOLDS, type ReturnDebtState, type ReturnMonthTone, type ReturnRating, type ReturnsScope } from '$shared/returns-report';
  import { canSeePath } from '$shared/visibility';
  import { m } from '$lib/paraglide/messages';
  import type { ReturnsReport, ReturnsReportSlip } from '@inoxpran/contracts';
  import { onMount } from 'svelte';
  import { CircleAlert, TriangleAlert } from 'lucide-svelte';
  import Dialog from '$lib/components/Dialog.svelte';
  import { api, download } from '$lib/api';
  import { date, dateTime, num, percent, vnd, vnToday } from '$lib/format';
  import { categoryLabel } from '$lib/inventory';
  import { session } from '$lib/session.svelte';

  // Tab "Theo tháng bán" bỏ ngày 20/11/2026 (RPT-RET-COHORT-OFF-01): đa số hàng trả không ghi phiếu BH gốc nên không theo dõi được.
  type Tab = 'overview' | 'customers' | 'products' | 'reps' | 'definitions';
  const TABS: Array<{ key: Tab; label: () => string }> = [
    { key: 'overview', label: m.rr_tab_overview },
    { key: 'customers', label: m.rr_tab_customers },
    { key: 'products', label: m.rr_tab_products },
    { key: 'reps', label: m.rr_tab_reps },
    { key: 'definitions', label: m.rr_tab_definitions },
  ];
  const COLORS: Record<'credited' | 'notCredited' | 'pending', string> = { credited: 'var(--navy)', notCredited: '#AAB6C3', pending: 'var(--orange)' };

  const today = vnToday();
  const monthOptions = Array.from({ length: 12 }, (_, back) => {
    const index = today.month - back;
    const year = today.year + Math.floor((index - 1) / 12);
    const month = ((index - 1 + 120) % 12) + 1;
    return { key: `${year}-${String(month).padStart(2, '0')}`, label: m.thang_2({ p0: String(month).padStart(2, '0'), year }) };
  });

  let monthKey = $state(monthOptions[0]!.key);
  let scope = $state<ReturnsScope>('90');
  let region = $state('');
  let salesRepId = $state('');
  let tier = $state('');
  let category = $state('');
  let tab = $state<Tab>('overview');
  let reps = $state<Array<{ id: string; code: string; name: string }>>([]);
  let report = $state<ReturnsReport | null>(null);
  let loading = $state(true);
  let exporting = $state(false);
  let error = $state('');
  let search = $state('');
  let onlyReturns = $state(true);

  let slipsOpen = $state(false);
  let slipsTitle = $state('');
  let slips = $state<ReturnsReportSlip[]>([]);
  let slipsLoading = $state(false);
  let slipsError = $state('');

  const filterParams = $derived({ ...(region ? { region } : {}), ...(salesRepId ? { salesRepId } : {}), ...(tier ? { tier } : {}), ...(category ? { category } : {}) });
  const query = $derived(new URLSearchParams({ month: monthKey, scope, ...filterParams }).toString());
  const canOpenReturns = $derived(canSeePath(session.user, '/inventory/returns'));
  const s = $derived(report?.summary);
  const monthName = $derived(report ? monthText(report.month.key) : '');

  function monthText(key: string): string {
    const [year, month] = key.split('-');
    return m.thang_2({ p0: month ?? '', year: Number(year) });
  }
  function shortMonth(key: string): string {
    const [year, month] = key.split('-');
    return `T${Number(month)}/${String(year).slice(-2)}`;
  }
  const money = (value: string | number | null | undefined) => num(value ?? 0);
  const toneClass = (tone: ReturnMonthTone | null) => (tone === 'OK' ? 'success' : tone === 'WATCH' ? 'warning' : tone === 'OVER' ? 'danger' : 'neutral');
  const toneText = (tone: ReturnMonthTone | null) => (tone === 'OK' ? m.rr_tone_ok() : tone === 'WATCH' ? m.rr_tone_watch() : tone === 'OVER' ? m.rr_tone_over() : '—');
  const ratingClass = (rating: ReturnRating) => ({ HIGH_RISK: 'danger', WARNING: 'orange', WATCH: 'warning', NORMAL: 'success' })[rating];
  const ratingText = (rating: ReturnRating) => ({ HIGH_RISK: m.rr_rating_HIGH_RISK(), WARNING: m.rr_rating_WARNING(), WATCH: m.rr_rating_WATCH(), NORMAL: m.rr_rating_NORMAL() })[rating];
  const stateText = (state: ReturnDebtState) => ({ CREDITED: m.rr_state_credited(), NOT_CREDITED: m.rr_state_not_credited(), PENDING: m.rr_state_pending(), NO_MONEY: m.rr_state_no_money() })[state];

  // Biểu đồ: trục % theo bội số 4, tối thiểu 12%.
  const chartMax = $derived(Math.max(12, Math.ceil(Math.max(RETURN_THRESHOLDS.company.ok, ...(report?.months.map((row) => row.rate ?? 0) ?? [0])) / 4) * 4));
  const ticks = $derived(Array.from({ length: chartMax / 4 + 1 }, (_, index) => index * 4));
  const chartAria = $derived(report ? m.rr_chart_aria({ list: report.months.map((row) => `${monthText(row.key)} ${percent(row.rate)}`).join(', ') }) : '');
  const totals6 = $derived.by(() => {
    if (!report) return null;
    const sum = (pick: (row: ReturnsReport['months'][number]) => string) => report!.months.reduce((total, row) => total + Number(pick(row)), 0);
    const sales = sum((row) => row.sales);
    const returns = sum((row) => row.returns.total);
    const collected = sum((row) => row.collected);
    const returnCredits = sum((row) => row.returnCredits);
    return {
      sales, returns, rate: sales > 0 ? (returns / sales) * 100 : null,
      credited: sum((row) => row.returns.credited), notCredited: sum((row) => row.returns.notCredited), pending: sum((row) => row.returns.pending),
      net: sum((row) => row.netSales), collected, debtByReturns: collected + returnCredits > 0 ? (returnCredits / (collected + returnCredits)) * 100 : null,
    };
  });
  const customerRows = $derived.by(() => {
    const term = search.trim().toLowerCase();
    return (report?.customers ?? []).filter((row) => (!onlyReturns || row.slips > 0) && (!term || row.code.toLowerCase().includes(term) || row.name.toLowerCase().includes(term)));
  });
  const ratingCounts = $derived.by(() => {
    const counts: Record<ReturnRating, number> = { HIGH_RISK: 0, WARNING: 0, WATCH: 0, NORMAL: 0 };
    for (const row of report?.customers ?? []) if (row.slips > 0) counts[row.rating] += 1;
    return counts;
  });
  const withReturns = $derived((report?.customers ?? []).filter((row) => row.slips > 0).length);
  const reasonMax = $derived(Math.max(1, ...(report?.reasons.map((row) => Number(row.value)) ?? [0])));
  const slipsTotal = $derived(slips.reduce((sum, row) => sum + Number(row.value ?? 0), 0));

  async function load() {
    loading = true;
    error = '';
    try {
      report = await api<ReturnsReport>(`/reports/returns?${query}`);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.khong_tai_duoc_bao_cao();
    } finally {
      loading = false;
    }
  }
  onMount(async () => {
    reps = await api<Array<{ id: string; code: string; name: string }>>('/employees').catch(() => []);
    await load();
  });
  function reset() {
    monthKey = monthOptions[0]!.key;
    scope = '90';
    region = '';
    salesRepId = '';
    tier = '';
    category = '';
    load();
  }
  async function exportExcel() {
    exporting = true;
    try {
      await download(`/reports/returns/export?${query}`, `BaoCao_HangTra_${monthKey}.xlsx`);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.khong_xuat_duoc_excel();
    } finally {
      exporting = false;
    }
  }

  async function openSlips(title: string, params: Record<string, string>) {
    slipsTitle = title;
    slipsOpen = true;
    slipsLoading = true;
    slipsError = '';
    slips = [];
    try {
      slips = await api<ReturnsReportSlip[]>(`/reports/returns/slips?${new URLSearchParams({ ...filterParams, ...params }).toString()}`);
    } catch (caught) {
      slipsError = caught instanceof Error ? caught.message : m.khong_tai_duoc_bao_cao();
    } finally {
      slipsLoading = false;
    }
  }
  const monthRange = (key: string) => {
    const [year, month] = key.split('-').map(Number) as [number, number];
    const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return { from: `${key}-01`, to: `${key}-${String(last).padStart(2, '0')}` };
  };
  const windowRange = () => (report ? { from: report.window.from, to: report.window.to } : monthRange(monthKey));
  const openMonth = (key: string, state?: ReturnDebtState) => openSlips(`${m.rr_slips_month({ month: monthText(key) })}${state ? ` · ${stateText(state)}` : ''}`, { ...monthRange(key), ...(state ? { state } : {}) });
</script>

<svelte:head><title>{m.rr_page_title()}</title></svelte:head>

<section class="page-head">
  <div>
    <nav class="crumbs" aria-label={m.duong_dan()}><a href="/reports/sales">{m.bao_cao()}</a><span>{m.rr_title()}</span></nav>
    <h1 class="page-title">{m.rr_title()}</h1>
    <p class="page-sub">{m.rr_sub({ month: report ? `${monthName}${report.month.partial ? ` (${m.rr_partial()})` : ''}` : '—' })}{#if report} · {dateTime(report.generatedAt)}{/if}</p>
  </div>
  <div class="actions no-print">
    <button class="btn primary" disabled={exporting || !report} onclick={exportExcel}>{exporting ? m.dang_xuat_2() : m.xuat_excel()}</button>
  </div>
</section>

<section class="card filters no-print">
  <div class="field"><label for="rr-month">{m.rr_filter_month()}</label><select id="rr-month" bind:value={monthKey}>{#each monthOptions as item}<option value={item.key}>{item.label}</option>{/each}</select></div>
  <div class="field"><label for="rr-scope">{m.rr_filter_scope()}</label><select id="rr-scope" bind:value={scope}><option value="month">{m.rr_scope_month()}</option><option value="90">{m.rr_scope_90()}</option><option value="180">{m.rr_scope_180()}</option></select></div>
  <div class="field"><label for="rr-region">{m.khu_vuc()}</label><select id="rr-region" bind:value={region}><option value="">{m.toan_quoc()}</option>{#each NEW_PROVINCES as item}<option value={item.code}>{item.name}</option>{/each}</select></div>
  <div class="field"><label for="rr-rep">{m.nv_phu_trach()}</label><select id="rr-rep" bind:value={salesRepId}><option value="">{m.pv_tat_ca_nv()}</option>{#each reps as item}<option value={item.id}>{item.name} ({item.code})</option>{/each}</select></div>
  <div class="field"><label for="rr-tier">{m.cap_dai_ly()}</label><select id="rr-tier" bind:value={tier}><option value="">{m.tat_ca_cac_cap()}</option><option value="TIER_1">{m.cap_1_nha_phan_phoi()}</option><option value="TIER_2">{m.cap_2_dai_ly()}</option><option value="RETAIL">{m.khach_le()}</option></select></div>
  <div class="field"><label for="rr-category">{m.rr_filter_category()}</label><select id="rr-category" bind:value={category}><option value="">{m.rr_all_categories()}</option>{#each CUSTOMER_RETURN_CATEGORIES as code}<option value={code}>{categoryLabel(code)}</option>{/each}</select></div>
  <div class="actions"><button class="btn navy" onclick={load} disabled={loading}>{m.loc_du_lieu()}</button><button class="btn" onclick={reset}>{m.dat_lai()}</button></div>
</section>

{#if error}<div class="banner error"><CircleAlert size={17} />{error}</div>{/if}

<div class="tabs" role="tablist" aria-label={m.rr_title()}>
  {#each TABS as item}
    <button role="tab" aria-selected={tab === item.key} class:on={tab === item.key} onclick={() => (tab = item.key)}>{item.label()}</button>
  {/each}
</div>

{#if !report}
  <section class="card"><p class="empty">{loading ? m.dang_tong_hop() : m.khong_co_du_lieu()}</p></section>
{:else if tab === 'overview' && s}
  <section class="kpis six">
    <article class="card kpi">
      <p class="label">{m.rr_kpi_sales()}</p>
      <p class="value">{vnd(s.sales)}</p>
      <p class="note">{m.rr_kpi_sales_note({ count: num(s.salesOrders) })}</p>
    </article>
    <button class="card kpi click" onclick={() => openMonth(report!.month.key)}>
      <p class="label">{m.rr_kpi_returns()}</p>
      <p class="value">{vnd(s.returns.total)}</p>
      <p class="note">{m.rr_kpi_returns_note({ rate: percent(s.rate), count: num(s.returns.slips) })}</p>
      <p class="note"><span class={`pill ${toneClass(s.tone)}`}>{toneText(s.tone)}</span> {m.rr_previous_month({ rate: percent(s.previousRate) })}</p>
    </button>
    <button class="card kpi click" onclick={() => openMonth(report!.month.key, 'CREDITED')}>
      <p class="label"><i class="sw" style={`background:${COLORS.credited}`}></i>{m.rr_kpi_credited()}</p>
      <p class="value">{vnd(s.returns.credited)}</p>
      <p class="note">{m.rr_kpi_credited_note({ count: num(s.returns.creditedSlips), share: percent(Number(s.returns.total) > 0 ? (Number(s.returns.credited) / Number(s.returns.total)) * 100 : null, 0) })}</p>
    </button>
    <button class="card kpi click" onclick={() => openMonth(report!.month.key, 'NOT_CREDITED')}>
      <p class="label"><i class="sw" style={`background:${COLORS.notCredited}`}></i>{m.rr_kpi_not_credited()}</p>
      <p class="value">{vnd(s.returns.notCredited)}</p>
      <p class="note">{m.rr_kpi_not_credited_note({ count: num(s.returns.notCreditedSlips) })}</p>
    </button>
    <button class="card kpi click" onclick={() => openMonth(report!.month.key, 'PENDING')}>
      <p class="label"><i class="sw" style={`background:${COLORS.pending}`}></i>{m.rr_kpi_pending()}</p>
      <p class="value">{vnd(s.returns.pending)}</p>
      <p class="note">{m.rr_kpi_pending_note({ count: num(s.returns.pendingSlips) })}</p>
      {#if s.pendingOverdueSlips}<p class="note danger"><TriangleAlert size={13} /> {m.rr_pending_overdue({ count: s.pendingOverdueSlips, days: RETURN_THRESHOLDS.pendingDays })}</p>{/if}
    </button>
    <article class="card kpi">
      <p class="label">{m.rr_kpi_net()}</p>
      <p class="value">{vnd(s.netSales)}</p>
      <p class="note">{m.rr_kpi_net_note({ amount: vnd(s.expectedNetSales) })}</p>
    </article>
  </section>
  {#if s.returns.unvaluedSlips || Number(s.returns.giftQuantity) > 0}
    <p class="hint">{#if s.returns.unvaluedSlips}{m.rr_unvalued({ count: s.returns.unvaluedSlips })}{/if}{#if s.returns.unvaluedSlips && Number(s.returns.giftQuantity) > 0}{' · '}{/if}{#if Number(s.returns.giftQuantity) > 0}{m.rr_gift_qty({ quantity: num(s.returns.giftQuantity) })}{/if}</p>
  {/if}

  <section class="card">
    <header class="card-head chart-head">
      <div><h2>{m.rr_chart_title()}</h2><p>{m.rr_chart_sub()}</p></div>
      <div class="legend">
        <span><i style={`background:${COLORS.credited}`}></i>{m.rr_state_credited()}</span>
        <span><i style={`background:${COLORS.notCredited}`}></i>{m.rr_state_not_credited()}</span>
        <span><i style={`background:${COLORS.pending}`}></i>{m.rr_state_pending()}</span>
        <span><i class="dash"></i>{m.rr_target({ rate: percent(RETURN_THRESHOLDS.company.ok, 0) })}</span>
      </div>
    </header>
    <div class="card-body">
      <div class="rate-chart" role="img" aria-label={chartAria}>
        <div class="plot">
          {#each ticks as tick}<div class="grid" style={`bottom:${(tick / chartMax) * 100}%`}><span>{percent(tick, 0)}</span></div>{/each}
          <div class="target" style={`bottom:${(RETURN_THRESHOLDS.company.ok / chartMax) * 100}%`}></div>
          <div class="cols">
            {#each report.months as row}
              {@const total = Number(row.returns.total)}
              <button class="col" class:current={row.key === report.month.key} title={`${monthText(row.key)}: ${vnd(row.returns.total)} = ${percent(row.rate)} · ${m.rr_state_credited()} ${vnd(row.returns.credited)} · ${m.rr_state_not_credited()} ${vnd(row.returns.notCredited)} · ${m.rr_state_pending()} ${vnd(row.returns.pending)}`} onclick={() => openMonth(row.key)}>
                <span class="val" class:over={row.tone === 'OVER'}>{percent(row.rate)}</span>
                <span class="stack" style={`height:${((row.rate ?? 0) / chartMax) * 100}%`}>
                  {#if total > 0}
                    {#if Number(row.returns.pending) > 0}<i style={`flex:${row.returns.pending} 1 0;background:${COLORS.pending}`}></i>{/if}
                    {#if Number(row.returns.notCredited) > 0}<i style={`flex:${row.returns.notCredited} 1 0;background:${COLORS.notCredited}`}></i>{/if}
                    {#if Number(row.returns.credited) > 0}<i style={`flex:${row.returns.credited} 1 0;background:${COLORS.credited}`}></i>{/if}
                  {/if}
                </span>
              </button>
            {/each}
          </div>
        </div>
        <div class="xlabels">{#each report.months as row}<span class:current={row.key === report.month.key}>{shortMonth(row.key)}</span>{/each}</div>
      </div>
    </div>
  </section>

  <section class="card">
    <header class="card-head"><h2>{m.rr_month_table()}</h2><span class="muted">{m.rr_unit_vnd()}</span></header>
    <div class="table-wrap">
      <table class="table">
        <thead><tr><th>{m.rr_col_month()}</th><th class="num">{m.rr_col_sales()}</th><th class="num">{m.rr_col_returns()}</th><th class="num">{m.rr_col_rate()}</th><th class="num">{m.rr_col_credited()}</th><th class="num">{m.rr_col_not_credited()}</th><th class="num">{m.rr_col_pending()}</th><th class="num">{m.rr_col_net()}</th><th class="num">{m.rr_col_collected()}</th><th class="num">{m.rr_col_debt_by_returns()}</th></tr></thead>
        <tbody>
          {#each report.months as row}
            <tr class:current={row.key === report.month.key}>
              <td class="nowrap">{monthText(row.key)}{#if row.partial}{' '}<span class="muted">({m.rr_running()})</span>{/if}</td>
              <td class="num">{money(row.sales)}</td>
              <td class="num"><button class="link" onclick={() => openMonth(row.key)}>{money(row.returns.total)}</button></td>
              <td class="num nowrap">{percent(row.rate)} <span class={`pill ${toneClass(row.tone)}`}>{toneText(row.tone)}</span></td>
              <td class="num"><button class="link" onclick={() => openMonth(row.key, 'CREDITED')}>{money(row.returns.credited)}</button></td>
              <td class="num"><button class="link" onclick={() => openMonth(row.key, 'NOT_CREDITED')}>{money(row.returns.notCredited)}</button></td>
              <td class="num" class:warn={Number(row.returns.pending) > 0}><button class="link" onclick={() => openMonth(row.key, 'PENDING')}>{money(row.returns.pending)}</button></td>
              <td class="num"><b>{money(row.netSales)}</b></td>
              <td class="num">{money(row.collected)}</td>
              <td class="num">{percent(row.debtByReturns)}</td>
            </tr>
          {/each}
        </tbody>
        {#if totals6}
          <tfoot><tr><td>{m.rr_total_6m()}</td><td class="num">{money(totals6.sales)}</td><td class="num">{money(totals6.returns)}</td><td class="num">{percent(totals6.rate)}</td><td class="num">{money(totals6.credited)}</td><td class="num">{money(totals6.notCredited)}</td><td class="num">{money(totals6.pending)}</td><td class="num">{money(totals6.net)}</td><td class="num">{money(totals6.collected)}</td><td class="num">{percent(totals6.debtByReturns)}</td></tr></tfoot>
        {/if}
      </table>
    </div>
    <footer class="foot">{m.rr_month_table_note()}</footer>
  </section>

  <section class="two">
    <article class="card">
      <header class="card-head"><div><h2>{m.rr_wh_title()}</h2><p>{m.rr_wh_sub({ month: monthName, amount: vnd(s.returns.total) })}</p></div></header>
      <div class="card-body split-list">
        {#each report.warehouses as row}
          <button class="split-row" onclick={() => openSlips(`${row.name} · ${monthName}`, { ...monthRange(report!.month.key), warehouseId: row.id })}>
            <span class="split-title"><b>{row.name}</b> <span class="muted">· {row.defective ? m.rr_wh_defective() : m.rr_wh_main()}</span><b class="right">{vnd(row.total)}</b></span>
            <span class="split-bar">
              {#if Number(row.credited) > 0}<i style={`flex:${row.credited} 1 0;background:${COLORS.credited}`}></i>{/if}
              {#if Number(row.notCredited) > 0}<i style={`flex:${row.notCredited} 1 0;background:${COLORS.notCredited}`}></i>{/if}
              {#if Number(row.pending) > 0}<i style={`flex:${row.pending} 1 0;background:${COLORS.pending}`}></i>{/if}
            </span>
            <span class="split-legend"><span>{m.rr_state_credited()} <b>{money(row.credited)}</b></span><span>{m.rr_state_not_credited()} <b>{money(row.notCredited)}</b></span><span>{m.rr_state_pending()} <b>{money(row.pending)}</b></span></span>
          </button>
        {:else}<p class="empty small">{m.rr_empty_month()}</p>{/each}
        {#if Number(s.returns.pending) > 0}
          <div class="callout"><TriangleAlert size={16} /><span>{m.rr_wh_pending_note({ amount: vnd(s.returns.pending) })}</span></div>
        {/if}
      </div>
    </article>
    <article class="card">
      <header class="card-head"><div><h2>{m.rr_reason_title()}</h2><p>{m.rr_reason_sub({ month: monthName })}</p></div></header>
      <div class="card-body bars">
        {#each report.reasons as row}
          <button class="bar-row" onclick={() => openSlips(`${categoryLabel(row.category)} · ${monthName}`, { ...monthRange(report!.month.key), category: row.category })}>
            <span class="bar-text"><span>{categoryLabel(row.category)}</span><span>{#if row.category === 'GIFT_RETURN_IN'}<span class="muted">{m.rr_reason_qty({ quantity: num(row.quantity) })}</span>{:else}<b>{vnd(row.value)}</b> <span class="muted">· {percent(row.share, 0)}</span>{/if}</span></span>
            <span class="track"><i style={`width:${row.category === 'GIFT_RETURN_IN' ? 0 : (Number(row.value) / reasonMax) * 100}%`}></i></span>
          </button>
        {/each}
      </div>
    </article>
  </section>

  <section class="two">
    <article class="card">
      <header class="card-head"><div><h2>{m.rr_ledger_title()}</h2><p>{m.rr_ledger_sub({ month: monthName })}</p></div></header>
      <div class="card-body">
        <dl class="ledger">
          <div><dt>{m.rr_ledger_opening()}</dt><dd>{money(report.ledger.opening)}</dd></div>
          <div><dt>{m.rr_ledger_debits()}</dt><dd>{money(report.ledger.debits)}</dd></div>
          <div><dt>{m.rr_ledger_collected()}</dt><dd>{money(report.ledger.collected)}</dd></div>
          <div><dt><i class="sw" style={`background:${COLORS.credited}`}></i>{m.rr_ledger_returns()}</dt><dd>{money(report.ledger.returnCredits)}</dd></div>
          <div><dt>{m.rr_ledger_freight()}</dt><dd>{money(report.ledger.freight)}</dd></div>
          {#if Number(report.ledger.other) !== 0}<div><dt>{m.rr_ledger_other()}</dt><dd>{money(report.ledger.other)}</dd></div>{/if}
          <div class="total"><dt>{report.month.partial ? m.rr_ledger_closing_today() : m.rr_ledger_closing()}</dt><dd>{money(report.ledger.closing)}</dd></div>
          <div class="pending"><dt><i class="sw" style={`background:${COLORS.pending}`}></i><button class="link" onclick={() => openSlips(m.rr_slips_pending(), { from: '2020-01-01', to: monthRange(report!.month.key).to, state: 'PENDING' })}>{m.rr_ledger_pending({ count: report.ledger.pendingSlips })}</button>{#if report.ledger.pendingOverdueSlips}{' '}<span class="danger-text">· {m.rr_pending_overdue({ count: report.ledger.pendingOverdueSlips, days: RETURN_THRESHOLDS.pendingDays })}</span>{/if}</dt><dd>{money(report.ledger.pendingValue)}</dd></div>
          <div class="sub"><dt>{m.rr_ledger_expected()}</dt><dd>{money(report.ledger.expectedClosing)}</dd></div>
        </dl>
        <div class="info"><b>{m.rr_ledger_ratio({ rate: percent(report.ledger.debtByReturns) })}</b> {m.rr_ledger_ratio_note()}</div>
      </div>
    </article>
    <article class="card">
      <header class="card-head"><div><h2>{m.rr_products_title()}</h2><p>{m.rr_products_sub({ window: report.window.label })}</p></div><button class="btn small" onclick={() => (tab = 'products')}>{m.rr_view_all()}</button></header>
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>{m.rr_col_product()}</th><th class="num">{m.rr_col_sold()}</th><th class="num">{m.rr_col_returned()}</th><th class="num">{m.rr_col_rate_qty()}</th><th>{m.rr_col_main_reason()}</th></tr></thead>
          <tbody>
            {#each report.products.slice(0, 6) as row}
              <tr><td><b>{row.sku}</b> <span class="muted">{row.name}</span></td><td class="num">{num(row.soldQuantity)}</td><td class="num">{num(row.returnedQuantity)}</td><td class="num" class:danger-text={(row.rate ?? 0) > RETURN_THRESHOLDS.customer.warning}>{percent(row.rate)}</td><td class="muted">{categoryLabel(row.mainCategory)}</td></tr>
            {:else}<tr class="empty-row"><td colspan="5">{m.rr_no_rows()}</td></tr>{/each}
          </tbody>
        </table>
      </div>
    </article>
  </section>

{:else if tab === 'customers'}
  <section class="card">
    <header class="card-head wrap">
      <div class="rating-chips">
        <span>{m.rr_customers_summary({ count: withReturns })}</span>
        {#each ['HIGH_RISK', 'WARNING', 'WATCH', 'NORMAL'] as const as rating}<span class={`pill ${ratingClass(rating)}`}>{ratingCounts[rating]} {ratingText(rating).toLowerCase()}</span>{/each}
      </div>
      <div class="row-tools">
        <input type="search" placeholder={m.rr_search()} bind:value={search} aria-label={m.rr_search()} />
        <label class="check"><input type="checkbox" bind:checked={onlyReturns} />{m.rr_only_returns()}</label>
      </div>
    </header>
    <p class="hint pad">{m.rr_window({ range: report.window.label })} · {m.rr_unit_vnd()} · {m.rr_click_hint()}</p>
    <div class="table-wrap">
      <table class="table">
        <thead><tr><th>{m.rr_col_customer()}</th><th>{m.rr_col_rep()}</th><th class="num">{m.rr_col_sales()}</th><th class="num">{m.rr_col_returns()}</th><th class="num">%</th><th class="num">{m.rr_col_slow()}</th><th class="num">{m.rr_col_defect()}</th><th class="num">{m.rr_col_credited()}</th><th class="num">{m.rr_col_not_credited_short()}</th><th class="num">{m.rr_col_collected()}</th><th class="num">{m.rr_col_debt_by_returns()}</th><th class="num">{m.rr_col_outstanding()}</th><th class="num">{m.rr_col_overdue_days()}</th><th>{m.rr_col_rating()}</th></tr></thead>
        <tbody>
          {#each customerRows as row (row.customerId)}
            <tr class="clickable" onclick={() => openSlips(m.rr_slips_customer({ customer: `${row.code} · ${row.name}`, range: report!.window.label }), { ...windowRange(), customerId: row.customerId })}>
              <td class="who"><a class="code" href={`/catalog/dealers/${row.customerId}`} onclick={(event) => event.stopPropagation()}>{row.code}</a> {row.name}<br /><span class="muted small">{row.tier} · {row.regionName}</span></td>
              <td class="nowrap muted">{row.salesRepName ?? '—'}</td>
              <td class="num">{money(row.sales)}</td>
              <td class="num"><b>{money(row.returns)}</b>{#if row.unvaluedSlips}<br /><span class="muted small">{m.rr_unvalued({ count: row.unvaluedSlips })}</span>{/if}</td>
              <td class="num" class:danger-text={(row.rate ?? (row.slips ? Infinity : 0)) > RETURN_THRESHOLDS.customer.warning}><b>{row.rate === null && row.slips ? '—' : percent(row.rate)}</b></td>
              <td class="num">{money(row.slow)}</td>
              <td class="num">{money(row.defect)}</td>
              <td class="num">{money(row.credited)}</td>
              <td class="num" class:warn={Number(row.pending) > 0}>{money(row.notCredited)}</td>
              <td class="num">{money(row.collected)}</td>
              <td class="num" class:danger-text={(row.debtByReturns ?? 0) > RETURN_THRESHOLDS.highRisk.debtByReturns}>{percent(row.debtByReturns)}</td>
              <td class="num">{money(row.outstanding)}</td>
              <td class="num" class:danger-text={row.maxDaysOverdue > RETURN_THRESHOLDS.highRisk.overdueDays}>{row.maxDaysOverdue || '—'}</td>
              <td><span class={`pill ${ratingClass(row.rating)}`}>{ratingText(row.rating)}</span></td>
            </tr>
          {:else}<tr class="empty-row"><td colspan="14">{m.rr_no_rows()}</td></tr>{/each}
        </tbody>
      </table>
    </div>
    <footer class="foot">{m.rr_rating_rules({ watch: RETURN_THRESHOLDS.customer.watch, warning: RETURN_THRESHOLDS.customer.warning, days: RETURN_THRESHOLDS.highRisk.overdueDays, debt: RETURN_THRESHOLDS.highRisk.debtByReturns })}</footer>
  </section>

{:else if tab === 'products'}
  <section class="card">
    <header class="card-head"><div><h2>{m.rr_products_title()}</h2><p>{m.rr_products_sub({ window: report.window.label })}</p></div></header>
    <div class="table-wrap">
      <table class="table">
        <thead><tr><th>{m.stt()}</th><th>{m.rr_col_sku()}</th><th>{m.rr_col_product()}</th><th class="num">{m.rr_col_sold()}</th><th class="num">{m.rr_col_returned()}</th><th class="num">{m.rr_col_rate_qty()}</th>{#each CUSTOMER_RETURN_CATEGORIES.filter((code) => code !== 'GIFT_RETURN_IN') as code}<th class="num">{categoryLabel(code)}</th>{/each}<th>{m.rr_col_main_reason()}</th></tr></thead>
        <tbody>
          {#each report.products as row, index (row.productId)}
            <tr>
              <td class="muted">{index + 1}</td>
              <td><b>{row.sku}</b></td>
              <td>{row.name}</td>
              <td class="num">{num(row.soldQuantity)} <span class="muted small">{row.unit}</span></td>
              <td class="num"><b>{num(row.returnedQuantity)}</b></td>
              <td class="num" class:danger-text={(row.rate ?? 0) > RETURN_THRESHOLDS.customer.warning}>{percent(row.rate)}</td>
              {#each CUSTOMER_RETURN_CATEGORIES.filter((code) => code !== 'GIFT_RETURN_IN') as code}<td class="num">{row.byCategory[code] ? num(row.byCategory[code]) : '—'}</td>{/each}
              <td class="muted">{categoryLabel(row.mainCategory)}</td>
            </tr>
          {:else}<tr class="empty-row"><td colspan="10">{m.rr_no_rows()}</td></tr>{/each}
        </tbody>
      </table>
    </div>
    <footer class="foot">{m.rr_products_note()}</footer>
  </section>

{:else if tab === 'reps'}
  <section class="card">
    <header class="card-head"><div><h2>{m.rr_reps_title()}</h2><p>{m.rr_window({ range: report.window.label })} · {m.rr_unit_vnd()}</p></div></header>
    <div class="table-wrap">
      <table class="table">
        <thead><tr><th>{m.rr_col_rep()}</th><th class="num">{m.rr_col_customers()}</th><th class="num">{m.rr_col_sales()}</th><th class="num">{m.rr_col_returns()}</th><th class="num">%</th><th class="num">{m.rr_col_credited()}</th><th class="num">{m.rr_col_pending()}</th><th class="num">{m.rr_col_slips()}</th></tr></thead>
        <tbody>
          {#each report.reps as row}
            <tr class="clickable" onclick={() => openSlips(m.rr_slips_rep({ rep: row.id ? row.name : m.rr_no_rep(), range: report!.window.label }), { ...windowRange(), repId: row.id ?? 'none' })}>
              <td class:missing={!row.id}>{row.id ? row.name : m.rr_no_rep()}</td>
              <td class="num">{row.customers}</td>
              <td class="num">{money(row.sales)}</td>
              <td class="num"><b>{money(row.returns)}</b></td>
              <td class="num" class:danger-text={(row.rate ?? 0) > RETURN_THRESHOLDS.customer.warning}>{percent(row.rate)}</td>
              <td class="num">{money(row.credited)}</td>
              <td class="num" class:warn={Number(row.pending) > 0}>{money(row.pending)}</td>
              <td class="num">{row.slips}</td>
            </tr>
          {:else}<tr class="empty-row"><td colspan="8">{m.rr_no_rows()}</td></tr>{/each}
        </tbody>
      </table>
    </div>
    <footer class="foot">{m.rr_reps_note()}</footer>
  </section>

{:else if tab === 'definitions'}
  <section class="card">
    <header class="card-head"><div><h2>{m.rr_def_title()}</h2><p>{m.rr_def_sub()}</p></div></header>
    <div class="table-wrap">
      <table class="table defs">
        <thead><tr><th>{m.rr_def_col_metric()}</th><th>{m.rr_def_col_formula()}</th><th>{m.rr_def_col_note()}</th></tr></thead>
        <tbody>
          <tr><td>{m.rr_kpi_sales()}</td><td>{m.rr_def_a_formula()}</td><td>{m.rr_def_a_note()}</td></tr>
          <tr><td>{m.rr_kpi_returns()}</td><td>B1 + B2 + B3</td><td>{m.rr_def_b_note()}</td></tr>
          <tr><td><i class="sw" style={`background:${COLORS.credited}`}></i>{m.rr_kpi_credited()}</td><td>{m.rr_def_b1_formula()}</td><td>{m.rr_def_b1_note()}</td></tr>
          <tr><td><i class="sw" style={`background:${COLORS.notCredited}`}></i>{m.rr_kpi_not_credited()}</td><td>{m.rr_def_b2_formula()}</td><td>{m.rr_def_b2_note()}</td></tr>
          <tr><td><i class="sw" style={`background:${COLORS.pending}`}></i>{m.rr_kpi_pending()}</td><td>{m.rr_def_b3_formula()}</td><td>{m.rr_def_b3_note({ days: RETURN_THRESHOLDS.pendingDays })}</td></tr>
          <tr><td>{m.rr_def_rate_name()}</td><td>B ÷ A</td><td>{m.rr_def_rate_note({ ok: RETURN_THRESHOLDS.company.ok, watch: RETURN_THRESHOLDS.company.watch })}</td></tr>
          <tr><td>{m.rr_kpi_net()}</td><td>{m.rr_def_net_formula()}</td><td>{m.rr_def_net_note()}</td></tr>
          <tr><td>{m.rr_col_debt_by_returns()}</td><td>{m.rr_def_debt_formula()}</td><td>{m.rr_def_debt_note()}</td></tr>
          <tr><td>{m.rr_def_unvalued_name()}</td><td>{m.rr_def_unvalued_formula()}</td><td>{m.rr_def_unvalued_note()}</td></tr>
        </tbody>
      </table>
    </div>
    <footer class="foot">{m.rr_rating_rules({ watch: RETURN_THRESHOLDS.customer.watch, warning: RETURN_THRESHOLDS.customer.warning, days: RETURN_THRESHOLDS.highRisk.overdueDays, debt: RETURN_THRESHOLDS.highRisk.debtByReturns })}</footer>
  </section>
{/if}

<Dialog bind:open={slipsOpen} title={slipsTitle} wide>
  {#if slipsError}<div class="banner error"><CircleAlert size={17} />{slipsError}</div>{/if}
  {#if slipsLoading}<p class="muted">{m.dang_tai()}</p>
  {:else}
    <p class="muted">{m.rr_slips_total({ count: slips.length, amount: vnd(slipsTotal) })}</p>
    <div class="table-wrap">
      <table class="table compact">
        <thead><tr><th>{m.rr_slip_col_code()}</th><th>{m.rr_slip_col_received()}</th><th>{m.rr_col_customer()}</th><th>{m.rr_slip_col_source()}</th><th class="num">{m.rr_slip_col_days()}</th><th>{m.rr_slip_col_category()}</th><th>{m.rr_slip_col_warehouse()}</th><th class="num">{m.rr_slip_col_value()}</th><th>{m.rr_slip_col_state()}</th></tr></thead>
        <tbody>
          {#each slips as row (row.id)}
            <tr>
              <td class="nowrap"><b>{row.code}</b></td>
              <td class="nowrap">{date(row.receivedAt)}</td>
              <td>{row.customerCode} · {row.customerName}</td>
              <td class="nowrap">{#if row.salesOrderCode}{#if row.salesOrderId && canSeePath(session.user, `/sales/orders/${row.salesOrderId}`)}<a class="code" href={`/sales/orders/${row.salesOrderId}`}>{row.salesOrderCode}</a>{:else}{row.salesOrderCode}{/if}{#if row.deliveredAt}<br /><span class="muted small">{date(row.deliveredAt)}</span>{/if}{:else if row.preErpSalesCode}{m.rr_slip_pre_erp({ code: row.preErpSalesCode })}{:else}—{/if}</td>
              <td class="num">{row.days ?? '—'}</td>
              <td>{categoryLabel(row.category)}</td>
              <td>{row.warehouseName}</td>
              <td class="num">{row.value === null ? m.rr_slip_unvalued() : num(row.value)}</td>
              <td class="nowrap">
                {#if row.state === 'CREDITED'}<span class="state"><i style={`background:${COLORS.credited}`}></i>{m.rr_slip_credited_on({ date: row.creditPostedOn ? row.creditPostedOn.split('-').reverse().join('/') : '' })}</span>
                {:else if row.state === 'PENDING'}<span class="state pending"><i style={`background:${COLORS.pending}`}></i>{m.rr_slip_pending_days({ days: row.pendingDays ?? 0 })}</span>
                {:else if row.state === 'NOT_CREDITED'}<span class="state"><i style={`background:${COLORS.notCredited}`}></i>{m.rr_state_not_credited()}</span>
                {:else}<span class="state muted">{m.rr_state_no_money()}</span>{/if}
              </td>
            </tr>
          {:else}<tr class="empty-row"><td colspan="9">{m.rr_slips_empty()}</td></tr>{/each}
        </tbody>
      </table>
    </div>
    {#if slips.some((row) => row.state === 'PENDING')}
      <p class="muted">{m.rr_slips_process()}{#if canOpenReturns}{' '}<a href="/inventory/returns">{m.rr_open_returns()}</a>{/if}</p>
    {/if}
  {/if}
</Dialog>

<style>
  .filters { grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); }
  .tabs { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 16px; }
  .tabs button { min-height: 38px; padding: 7px 14px; border: 1px solid var(--line); border-radius: 999px; background: var(--surface); color: var(--muted); font-weight: 600; cursor: pointer; }
  .tabs button.on { border-color: var(--navy); background: var(--navy); color: #fff; }
  .kpis.six { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .kpi.click { display: block; width: 100%; text-align: left; font: inherit; cursor: pointer; }
  .kpi.click:hover { border-color: var(--navy); }
  .kpi .note + .note { margin-top: 6px; }
  .kpi .note.danger { display: flex; align-items: center; gap: 4px; color: var(--red); font-weight: 600; }
  .sw { display: inline-block; width: 10px; height: 10px; margin-right: 7px; border-radius: 2px; vertical-align: 0; }
  .hint { margin: -6px 0 16px; color: var(--muted); font-size: 12.5px; }
  .hint.pad { margin: 0; padding: 0 20px 10px; }
  .empty { margin: 40px 0; color: var(--muted); text-align: center; }
  .empty.small { margin: 10px 0; }
  .muted { color: var(--muted); }
  .small { font-size: 11.5px; }
  .nowrap { white-space: nowrap; }
  .danger-text { color: var(--red); font-weight: 600; }
  td.warn { color: var(--orange); font-weight: 600; }
  td.missing { color: var(--red); }
  tr.current td { background: var(--surface-2); }
  tr.clickable { cursor: pointer; }
  tr.clickable:hover td { background: var(--surface-2); }
  .link { padding: 0; border: 0; background: none; color: var(--navy); font: inherit; text-decoration: underline; text-decoration-color: var(--line); text-underline-offset: 3px; cursor: pointer; }
  .foot { padding: 12px 20px; border-top: 1px solid var(--line-soft); color: var(--subtle); font-size: 12.5px; }
  .chart-head { flex-wrap: wrap; gap: 12px; }
  .legend { display: flex; flex-wrap: wrap; gap: 14px; align-items: center; color: var(--text); font-size: 12px; }
  .legend i { display: inline-block; width: 12px; height: 12px; margin-right: 6px; border-radius: 2px; vertical-align: -1px; }
  .legend i.dash { width: 18px; height: 0; border-top: 2px dashed var(--red); border-radius: 0; vertical-align: 3px; }
  .rate-chart { padding: 6px 0 0 40px; }
  .plot { position: relative; height: 230px; border-bottom: 1px solid var(--line); }
  .grid { position: absolute; right: 0; left: 0; border-top: 1px solid var(--line-soft); }
  .grid span { position: absolute; top: -8px; left: -40px; width: 34px; color: var(--muted); font-size: 11px; text-align: right; }
  .target { position: absolute; right: 0; left: 0; border-top: 2px dashed var(--red); }
  .cols { position: absolute; inset: 0; display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); }
  .col { display: flex; flex-direction: column; align-items: center; justify-content: flex-end; gap: 4px; height: 100%; padding: 0; border: 0; background: none; cursor: pointer; }
  .col:hover .stack { outline: 2px solid var(--line); outline-offset: 2px; }
  .col.current .stack { outline: 2px solid var(--navy); outline-offset: 3px; }
  .val { color: var(--text); font-size: 12px; font-weight: 600; }
  .val.over { color: var(--red); font-weight: 700; }
  .stack { display: flex; flex-direction: column; gap: 2px; width: min(48px, 60%); min-height: 0; overflow: hidden; border-radius: 4px 4px 0 0; }
  .stack i { display: block; min-height: 2px; }
  .xlabels { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); margin-top: 6px; color: var(--muted); font-size: 12px; text-align: center; }
  .xlabels .current { color: var(--navy); font-weight: 700; }
  .two { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; margin-bottom: 18px; }
  .two > .card { margin-bottom: 0; }
  .split-list { display: grid; gap: 16px; }
  .split-row, .bar-row { display: grid; gap: 7px; width: 100%; padding: 0; border: 0; background: none; color: var(--text); font: inherit; text-align: left; cursor: pointer; }
  .split-title { display: flex; flex-wrap: wrap; gap: 6px; font-size: 14px; }
  .split-title .right { margin-left: auto; }
  .split-bar { display: flex; gap: 2px; height: 16px; overflow: hidden; border-radius: 4px; background: var(--surface-2); }
  .split-bar i { display: block; }
  .split-legend { display: flex; flex-wrap: wrap; gap: 14px; color: var(--muted); font-size: 12px; }
  .split-legend b { color: var(--text); }
  .callout { display: flex; gap: 10px; align-items: flex-start; padding: 12px 14px; border-radius: 8px; background: var(--orange-soft); color: var(--text); font-size: 13px; }
  .bars { display: grid; gap: 14px; }
  .bar-text { display: flex; justify-content: space-between; gap: 10px; font-size: 14px; }
  .track { height: 14px; border-radius: 4px; background: var(--surface-2); }
  .track i { display: block; height: 100%; border-radius: 0 4px 4px 0; background: var(--navy); }
  .ledger { display: grid; margin: 0; font-size: 14px; font-variant-numeric: tabular-nums; }
  .ledger div { display: flex; justify-content: space-between; gap: 12px; padding: 9px 0; border-bottom: 1px solid var(--line-soft); }
  .ledger dt, .ledger dd { margin: 0; }
  .ledger .total { border-bottom: 2px solid var(--navy); font-weight: 700; }
  .ledger .pending { border-bottom: 0; }
  .ledger .sub { padding-top: 0; border-bottom: 0; color: var(--muted); font-size: 13px; }
  .info { margin-top: 12px; padding: 12px 14px; border-radius: 8px; background: var(--surface-2); font-size: 13px; }
  .card-head.wrap { flex-wrap: wrap; gap: 12px; }
  .rating-chips { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; font-size: 14px; }
  .row-tools { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; }
  .row-tools input[type='search'] { min-width: 220px; }
  .check { display: inline-flex; gap: 6px; align-items: center; font-size: 13px; }
  td.who { min-width: 220px; }
  .defs td { vertical-align: top; line-height: 1.5; }
  .defs td:first-child { font-weight: 600; white-space: nowrap; }
  .state { display: inline-flex; align-items: center; gap: 6px; }
  .state i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; }
  .state.pending { color: var(--orange); font-weight: 600; }
  @media (min-width: 1760px) { .kpis.six { grid-template-columns: repeat(6, minmax(0, 1fr)); } }
  @media (max-width: 900px) { .two { grid-template-columns: 1fr; } .kpis.six { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  @media (max-width: 640px) { .kpis.six { grid-template-columns: 1fr; } .rate-chart { padding-left: 34px; } td.who { min-width: 180px; } }
</style>
