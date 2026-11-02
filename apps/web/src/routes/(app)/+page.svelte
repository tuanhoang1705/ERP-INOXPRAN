<script lang="ts">
  import { slipTypeShort } from '$lib/slip-type';
  import { m } from '$lib/paraglide/messages';
  import { intlLocale } from '$lib/i18n';
  import type { DashboardSummary } from '@inoxpran/contracts';
  import { alertText, periodText } from '$lib/server-text';
  import { goto } from '$app/navigation';
  import { onMount } from 'svelte';
  import { ChevronLeft, ChevronRight, CircleAlert, Plus, Search } from 'lucide-svelte';
  import ColumnChart from '$lib/components/ColumnChart.svelte';
  import { api, download } from '$lib/api';
  import { billions, date, num, percent, time, vnd, vnToday, isoFromParts, lastDayOfMonth } from '$lib/format';
  import { hasRole, orderStage } from '$lib/labels';
  import { can, session } from '$lib/session.svelte';

  const PAGE_SIZE = 5;
  let summary = $state<DashboardSummary | null>(null);
  let loading = $state(true);
  let error = $state('');
  let notice = $state('');
  let pageNumber = $state(1);
  let search = $state('');
  let working = $state('');

  const roles = $derived(session.user?.roles ?? []);
  const canApprove = $derived(hasRole(roles, ['SALES_MANAGER', 'DIRECTOR']));
  // Lập phiếu BH / gửi đề nghị theo bước được Admin phân công (SAL-STEP-01).
  const canIssue = $derived(can('sales.step.create') && can('sales.step.issue'));
  const canRequest = $derived(can('sales.step.create'));
  const canExport = $derived(hasRole(roles, ['DIRECTOR', 'SALES_MANAGER', 'ACCOUNTANT', 'AUDITOR']));
  const totalPages = $derived(summary ? Math.max(1, Math.ceil(summary.recentOrdersTotal / PAGE_SIZE)) : 1);
  const monthLabel = $derived(summary ? summary.period.label.slice(0, 2) : '');

  async function load(target = pageNumber) {
    loading = true;
    error = '';
    try {
      summary = await api<DashboardSummary>(`/dashboard/summary?page=${target}&pageSize=${PAGE_SIZE}`);
      pageNumber = target;
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.khong_tai_duoc_bang_dieu_khien();
    } finally {
      loading = false;
    }
  }
  onMount(() => load(1));

  const pages = $derived.by(() => {
    const result: Array<number | '…'> = [];
    for (let index = 1; index <= totalPages; index += 1) {
      if (index === 1 || index === totalPages || Math.abs(index - pageNumber) <= 1) result.push(index);
      else if (result[result.length - 1] !== '…') result.push('…');
    }
    return result;
  });

  async function approve(order: DashboardSummary['recentOrders'][number]) {
    working = order.id;
    notice = '';
    error = '';
    try {
      await api(`/sales-orders/${order.id}/approve`, { method: 'POST', body: JSON.stringify({ version: order.version }), idempotentCommand: true });
      notice = m.da_duyet_va_giu_ton_kho({ code: order.code });
      await load(pageNumber);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.khong_duyet_duoc_don();
    } finally {
      working = '';
    }
  }

  async function exportMonth() {
    const { year, month } = vnToday();
    try {
      await download(`/reports/sales-by-dealer/export?from=${isoFromParts(year, month, 1)}&to=${isoFromParts(year, month, lastDayOfMonth(year, month))}`, 'BaoCao_DoanhSo.xlsx');
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.khong_xuat_duoc_excel();
    }
  }

  function submitSearch(event: SubmitEvent) {
    event.preventDefault();
    goto(`/sales/orders${search ? `?search=${encodeURIComponent(search)}` : ''}`);
  }
</script>

<svelte:head><title>{m.bang_dieu_khien_inoxpran_erp()}</title></svelte:head>

<section class="page-head">
  <div>
    <h1 class="page-title">{m.bang_dieu_khien()}</h1>
    <p class="page-sub">{m.tong_quan_hoat_dong_ban_hang()}{#if summary}{m.cap_nhat_luc({  })} {time(summary.generatedAt)} {m.ngay()} {date(summary.generatedAt)}{/if}</p>
  </div>
  <div class="actions">
    {#if canExport}<button class="btn" onclick={exportMonth}>{m.xuat_excel()}</button>{/if}
    {#if canIssue}<a class="btn primary" href="/sales/orders/new"><Plus size={17} />{m.lap_phieu_bh()}</a>{:else if canRequest}<a class="btn primary" href="/sales/orders/new"><Plus size={17} />{m.de_nghi_xuat_ban()}</a>{/if}
  </div>
</section>

{#if error}<div class="banner error"><CircleAlert size={17} />{error}</div>{/if}
{#if notice}<div class="banner success">{notice}</div>{/if}

<!-- DB-REV-02 (31/10/2026): doanh thu trước thuế là số chính, sau thuế là dòng phụ; thêm card tiền đã thu trong tháng. -->
<section class="kpis five">
  <article class="card kpi top green">
    <p class="label">{m.doanh_thu_thang()} {monthLabel} · <span class="basis">{m.dt_truoc_thue()}</span></p>
    <p class="value">{summary ? vnd(summary.revenueThisMonth) : '—'}</p>
    <p class="gross">{m.dt_sau_thue()}: <b>{summary ? vnd(summary.revenueThisMonthGross) : '—'}</b></p>
    <p class="note">
      {#if summary?.revenueChangePercent !== null && summary?.revenueChangePercent !== undefined}
        <span class="dot" class:red={summary.revenueChangePercent < 0}></span>{summary.revenueChangePercent >= 0 ? '+' : ''}{percent(summary.revenueChangePercent)} {m.so_voi()} {periodText(summary.revenueComparisonLabel)}
      {:else if summary}<span class="dot"></span>{m.dau_thang_thang_truoc_dat()} {vnd(summary.revenuePreviousMonth)}{/if}
    </p>
  </article>
  <article class="card kpi top blue">
    <p class="label">{m.da_thu_thang()} {monthLabel}</p>
    <p class="value">{summary ? vnd(summary.collectedThisMonth) : '—'}</p>
    <p class="note"><span class="dot blue"></span>{m.so_phieu_thu({ count: summary?.collectedCount ?? 0 })}{#if summary && Number(summary.collectedPayNow) > 0}{' · '}{m.gom_thanh_toan_ngay({ amount: vnd(summary.collectedPayNow) })}{/if}</p>
  </article>
  <article class="card kpi top amber">
    <p class="label">{m.don_hang_cho_duyet()}</p>
    <p class="value">{summary ? m.don({ p0: num(summary.pendingApprovalOrders) }) : '—'}</p>
    <p class="note"><span class="dot amber"></span>{summary?.pendingOver24h ?? 0} {m.don_qua_24_gio()}</p>
  </article>
  <article class="card kpi top amber">
    <p class="label">{m.gia_tri_ton_kho_npp()}</p>
    <p class="value">{summary ? vnd(summary.inventoryValue) : '—'}</p>
    <p class="note"><span class="dot amber"></span>{summary?.lowStockSkuCount ?? 0} {m.sku_duoi_dinh_muc()}{#if summary?.inventoryValueFallbackSkus} · {m.ton_chua_co_gia_npp({ count: summary.inventoryValueFallbackSkus })}{/if}</p>
  </article>
  <article class="card kpi top red">
    <p class="label">{m.cong_no_qua_han()}</p>
    <p class="value">{summary ? vnd(summary.overdueReceivables) : '—'}</p>
    <p class="note"><span class="dot red"></span>{summary?.dealersOverdue30 ?? 0} {m.dai_ly_qua_30_ngay()}</p>
  </article>
</section>

<section class="middle">
  <article class="card">
    <header class="card-head">
      <div><h2>{m.doanh_so_6_thang_gan_nhat()}</h2><p>{m.don_vi_ty_dong_sau_chiet()}</p></div>
      <span class="chip">{m.t_6_thang()}</span>
    </header>
    <div class="card-body">
      {#if summary}
        <ColumnChart
          caption={m.doanh_so_6_thang_gan_nhat()}
          data={summary.monthlyRevenue.map((item) => ({ label: item.label, value: Number(item.revenue), highlight: item.current, tooltip: vnd(item.revenue) }))}
          format={(value) => billions(value)}
          axisFormat={(value) => (value / 1e9).toLocaleString(intlLocale(), { maximumFractionDigits: 1 })}
        />
        <div class="legend"><span><i></i>{m.thang_da_ket_thuc()}</span><span><i class="orange"></i>{m.thang_dang_thuc_hien()}</span></div>
      {:else}<div class="skeleton" style="height:236px"></div>{/if}
    </div>
  </article>

  <article class="card alerts">
    <header class="card-head"><h2>{m.canh_bao_can_xu_ly()}</h2></header>
    <div class="card-body">
      {#if loading && !summary}
        {#each [1, 2, 3] as _}<div class="skeleton" style="height:58px;margin-bottom:10px"></div>{/each}
      {:else if summary?.alerts.length}
        {#each summary.alerts as alert}
          {@const text = alertText(alert)}
          <a class={`alert ${alert.level.toLowerCase()}`} href={alert.href ?? '#'}>
            <div><b>{text.title}</b><small>{text.detail}</small></div>
            <span class={`pill ${alert.level === 'CRITICAL' ? 'danger' : alert.level === 'WARNING' ? 'warning' : ''}`}>
              {alert.level === 'CRITICAL' ? m.nguy_hiem() : alert.level === 'WARNING' ? m.canh_bao() : m.thong_tin()}
            </span>
          </a>
        {/each}
      {:else}<p class="empty">{m.khong_co_canh_bao_mo_dong()}</p>{/if}
    </div>
  </article>
</section>

<section class="card orders">
  <header class="card-head">
    <h2>{m.don_hang_moi_nhat()}</h2>
    <form class="tools" onsubmit={submitSearch}>
      <label class="search"><Search size={15} /><input bind:value={search} placeholder={m.tim_ma_don_dai_ly()} aria-label={m.tim_ma_don_dai_ly_2()} /></label>
      <a class="btn small" href="/sales/orders">{m.bo_loc()}</a>
    </form>
  </header>
  <div class="table-wrap">
    <table class="table">
      <thead><tr><th>{m.so_phieu_bh()}</th><th>{m.dai_ly_khach_hang()}</th><th>{m.kenh()}</th><th>{m.ngay_chung_tu()}</th><th class="num">{m.so_dong()}</th><th class="num">{m.gia_tri_vnd()}</th><th>{m.buoc_xu_ly()}</th><th>{m.thao_tac()}</th></tr></thead>
      <tbody>
        {#if !summary}
          <tr class="empty-row"><td colspan="8">{m.dang_tai_don_hang()}</td></tr>
        {:else if summary.recentOrders.length}
          {#each summary.recentOrders as order}
            {@const status = orderStage(order)}
            <tr>
              <td><a class="code" href={`/sales/orders/${order.id}`}>{order.code}</a></td>
              <td>{order.customerName}{order.province ? ` — ${order.province}` : ''}</td>
              <td><span class="tag" class:b2c={(order.slipType ?? order.channel) === 'B2C'} class:loan={order.slipType === 'SAMPLE' || order.slipType === 'INSPECTION' || order.slipType === 'GIFT'}>{slipTypeShort(order.slipType ?? order.channel)}</span></td>
              <td>{date(order.orderDate)}</td>
              <td class="num">{order.lineCount}</td>
              <td class="num"><b>{num(order.total)}</b></td>
              <td><span class={`pill ${status.tone}`}>{status.label}</span></td>
              <td><div class="ops">
                <a class="link" href={`/sales/orders/${order.id}`}>{m.xem()}</a>
                {#if order.status === 'PENDING_APPROVAL' && canApprove}
                  <button class="link green" disabled={working === order.id} onclick={() => approve(order)}>{working === order.id ? m.dang_duyet() : m.duyet()}</button>
                {/if}
              </div></td>
            </tr>
          {/each}
        {:else}<tr class="empty-row"><td colspan="8">{m.chua_co_don_hang()}</td></tr>{/if}
      </tbody>
    </table>
  </div>
  {#if summary}
    <footer class="pager">
      <span>{m.hien_thi()} {summary.recentOrders.length} / {num(summary.recentOrdersTotal)} {m.don_hang_gan_nhat()}</span>
      <nav aria-label={m.phan_trang()}>
        <button disabled={pageNumber === 1 || loading} onclick={() => load(pageNumber - 1)} aria-label={m.trang_truoc()}><ChevronLeft size={15} /></button>
        {#each pages as item}
          {#if item === '…'}<span>…</span>{:else}<button class:current={item === pageNumber} disabled={loading} onclick={() => load(item)}>{item}</button>{/if}
        {/each}
        <button disabled={pageNumber === totalPages || loading} onclick={() => load(pageNumber + 1)} aria-label={m.trang_sau()}><ChevronRight size={15} /></button>
      </nav>
    </footer>
  {/if}
</section>

<style>
  .tag.loan { background: var(--orange-soft); color: #b4501f; }
  .kpi.top { border-top: 4px solid var(--green); }
  .kpi.amber { border-top-color: var(--amber); }
  .kpi.red { border-top-color: var(--red); }
  .kpi.blue { border-top-color: var(--navy-2); }
  .dot.blue { background: var(--navy-2); }
  /* Card doanh thu rộng hơn: số trước thuế + dòng sau thuế không bị cắt. */
  .kpis.five { grid-template-columns: repeat(5, minmax(0, 1fr)); }
  .kpis.five .value { font-size: clamp(17px, 1.3vw, 23px); }
  .kpi .basis { color: var(--green); font-weight: 600; }
  .kpi .gross { margin: -2px 0 6px; color: var(--muted); font-size: 12.5px; }
  .kpi .gross b { color: var(--text); font-weight: 600; }
  @media (max-width: 1360px) { .kpis.five { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
  @media (max-width: 1100px) { .kpis.five { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  @media (max-width: 640px) { .kpis.five { grid-template-columns: 1fr; } }
  .middle { display: grid; grid-template-columns: minmax(0, 1.42fr) minmax(320px, 1fr); gap: 18px; margin-bottom: 18px; }
  .chip { padding: 6px 14px; border-radius: 7px; background: var(--surface-2); color: var(--muted); font-size: 12.5px; }
  .legend { display: flex; gap: 22px; margin: 6px 0 0 34px; color: var(--muted); font-size: 12.5px; }
  .legend i { display: inline-block; width: 11px; height: 11px; margin-right: 7px; border-radius: 3px; background: var(--navy); vertical-align: -1px; }
  .legend i.orange { background: var(--orange); }
  .alerts .card-body { display: grid; gap: 10px; }
  .alert { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 11px 14px; border-left: 4px solid var(--navy-2); border-radius: 0 8px 8px 0; background: var(--surface-2); }
  .alert:hover { background: #edf1f6; }
  .alert.critical { border-left-color: var(--red); }
  .alert.warning { border-left-color: var(--amber); }
  .alert div { display: grid; gap: 3px; min-width: 0; }
  .alert b { font-size: 13.5px; font-weight: 600; }
  .alert small { overflow: hidden; color: var(--muted); font-size: 12.5px; text-overflow: ellipsis; }
  .empty { margin: 30px 0; color: var(--muted); text-align: center; }
  .orders .card-head { padding-bottom: 14px; }
  .tools { display: flex; gap: 10px; }
  .search { display: flex; align-items: center; gap: 7px; width: 200px; padding: 0 10px; border: 1px solid var(--line); border-radius: 8px; color: var(--subtle); }
  .search input { width: 100%; height: 32px; border: 0; outline: 0; background: transparent; font-size: 13px; }
  .ops { display: flex; gap: 14px; white-space: nowrap; }
  .link.green { color: var(--green); }
  .pager { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 20px; border-top: 1px solid var(--line-soft); color: var(--muted); font-size: 13px; }
  .pager nav { display: flex; align-items: center; gap: 4px; }
  .pager button { display: grid; min-width: 28px; height: 28px; place-items: center; padding: 0 6px; border-radius: 6px; color: var(--muted); }
  .pager button:hover:not(:disabled) { background: var(--surface-2); }
  .pager button.current { background: var(--navy); color: #fff; font-weight: 700; }
  .pager button:disabled { opacity: 0.4; cursor: default; }
  @media (max-width: 1100px) { .middle { grid-template-columns: 1fr; } }
  @media (max-width: 720px) { .orders .card-head, .pager { flex-direction: column; align-items: stretch; } .search { width: 100%; } }
</style>
