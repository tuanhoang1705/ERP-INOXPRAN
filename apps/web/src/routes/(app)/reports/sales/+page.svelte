<script lang="ts">
  import { m } from '$lib/paraglide/messages';
  import type { SalesReport } from '@inoxpran/contracts';
  import { onMount } from 'svelte';
  import { CircleAlert } from 'lucide-svelte';
  import { api, download } from '$lib/api';
  import { date, dateTime, isoFromParts, lastDayOfMonth, millions, num, percent, vnd, vnToday } from '$lib/format';
  import { session } from '$lib/session.svelte';
  import { periodText } from '$lib/server-text';

  type Option = { value: string; label: string; from: string; to: string };
  const today = vnToday();
  const periods: Option[] = (() => {
    const list: Option[] = [];
    for (let back = 0; back < 6; back += 1) {
      const monthIndex = today.month - back;
      const year = today.year + Math.floor((monthIndex - 1) / 12);
      const month = ((monthIndex - 1 + 120) % 12) + 1;
      list.push({ value: `m${back}`, label: m.thang_2({ p0: String(month).padStart(2, '0'), year: year }), from: isoFromParts(year, month, 1), to: isoFromParts(year, month, lastDayOfMonth(year, month)) });
    }
    const quarter = Math.floor((today.month - 1) / 3);
    const qStart = quarter * 3 + 1;
    list.push({ value: 'q0', label: m.quy({ p0: quarter + 1, year: today.year }), from: isoFromParts(today.year, qStart, 1), to: isoFromParts(today.year, qStart + 2, lastDayOfMonth(today.year, qStart + 2)) });
    const prevQuarterStartMonth = qStart - 3 > 0 ? qStart - 3 : qStart + 9;
    const prevQuarterYear = qStart - 3 > 0 ? today.year : today.year - 1;
    list.push({ value: 'q1', label: m.quy_2({ p0: ((quarter + 3) % 4) + 1, prevQuarterYear: prevQuarterYear }), from: isoFromParts(prevQuarterYear, prevQuarterStartMonth, 1), to: isoFromParts(prevQuarterYear, prevQuarterStartMonth + 2, lastDayOfMonth(prevQuarterYear, prevQuarterStartMonth + 2)) });
    const sixStartIndex = today.month - 5;
    const sixYear = today.year + Math.floor((sixStartIndex - 1) / 12);
    const sixMonth = ((sixStartIndex - 1 + 120) % 12) + 1;
    list.push({ value: 'h6', label: m.t_6_thang_gan_nhat(), from: isoFromParts(sixYear, sixMonth, 1), to: isoFromParts(today.year, today.month, today.day) });
    list.push({ value: 'ytd', label: m.nam_den_nay({ year: today.year }), from: isoFromParts(today.year, 1, 1), to: isoFromParts(today.year, today.month, today.day) });
    return list;
  })();
  // Đầu tháng (ngày 1–7) mặc định xem tháng trước đã khép lại.
  const defaultPeriod = today.day <= 7 ? 'm1' : 'm0';

  let periodKey = $state(defaultPeriod);
  let region = $state('');
  let tier = $state('');
  let categoryId = $state('');
  let regions = $state<Array<{ code: string; name: string }>>([]);
  let categories = $state<Array<{ id: string; name: string }>>([]);
  let report = $state<SalesReport | null>(null);
  let loading = $state(true);
  let exporting = $state(false);
  let error = $state('');

  const period = $derived(periods.find((item) => item.value === periodKey) ?? (periods[0] as Option));
  const query = $derived(new URLSearchParams({
    from: period.from, to: period.to,
    ...(region ? { region } : {}), ...(tier ? { tier } : {}), ...(categoryId ? { categoryId } : {}),
  }).toString());
  const topMax = $derived(Math.max(...(report?.topDealers.map((row) => Number(row.revenue)) ?? [0]), 1));
  const regionColors = ['#123B5E', '#1B5480', '#E2703A', '#7FA6C4', '#C7D0DA', '#8A99A8'];

  async function load() {
    loading = true;
    error = '';
    try {
      report = await api<SalesReport>(`/reports/sales-by-dealer?${query}`);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.khong_tai_duoc_bao_cao();
    } finally {
      loading = false;
    }
  }
  onMount(async () => {
    [regions, categories] = await Promise.all([
      api<Array<{ code: string; name: string }>>('/regions').catch(() => []),
      api<Array<{ id: string; name: string }>>('/product-categories').catch(() => []),
    ]);
    await load();
  });

  function reset() {
    periodKey = defaultPeriod;
    region = '';
    tier = '';
    categoryId = '';
    load();
  }
  async function exportExcel() {
    exporting = true;
    try {
      await download(`/reports/sales-by-dealer/export?${query}`, 'BaoCao_DoanhSo.xlsx');
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.khong_xuat_duoc_excel();
    } finally {
      exporting = false;
    }
  }
</script>

<svelte:head><title>{m.bao_cao_doanh_so_inoxpran_erp()}</title></svelte:head>

<section class="page-head">
  <div>
    <nav class="crumbs" aria-label={m.duong_dan()}><a href="/reports/sales">{m.bao_cao()}</a><span>{m.bao_cao_doanh_so()}</span></nav>
    <h1 class="page-title">{m.bao_cao_doanh_so_theo_dai()}</h1>
    <p class="page-sub">{m.ky_bao_cao()} {date(`${period.from}T00:00:00+07:00`)} – {date(`${period.to}T00:00:00+07:00`)} {m.nguoi_lap()} {session.user?.displayName ?? '—'} {m.ngay_ket_xuat()} {report ? dateTime(report.generatedAt) : '—'}</p>
  </div>
  <div class="actions no-print">
    <button class="btn" onclick={() => window.print()}>{m.in_bao_cao()}</button>
    <button class="btn" onclick={() => window.print()} title={m.chon_luu_duoi_dang_pdf_trong()}>{m.xuat_pdf()}</button>
    <button class="btn primary" disabled={exporting || !report} onclick={exportExcel}>{exporting ? m.dang_xuat_2() : m.xuat_excel()}</button>
  </div>
</section>

<section class="card filters no-print">
  <div class="field"><label for="period">{m.ky_bao_cao_2()}</label><select id="period" bind:value={periodKey}>{#each periods as item}<option value={item.value}>{item.label}</option>{/each}</select></div>
  <div class="field"><label for="region">{m.khu_vuc()}</label><select id="region" bind:value={region}><option value="">{m.toan_quoc()}</option>{#each regions as item}<option value={item.code}>{item.name}</option>{/each}<option value="B2C">{m.kenh_ban_le_b2c()}</option></select></div>
  <div class="field"><label for="tier">{m.cap_dai_ly()}</label><select id="tier" bind:value={tier}><option value="">{m.tat_ca_cac_cap()}</option><option value="TIER_1">{m.cap_1_nha_phan_phoi()}</option><option value="TIER_2">{m.cap_2_dai_ly()}</option><option value="RETAIL">{m.khach_le()}</option></select></div>
  <div class="field"><label for="category">{m.nhom_san_pham()}</label><select id="category" bind:value={categoryId}><option value="">{m.tat_ca_nhom()}</option>{#each categories as item}<option value={item.id}>{item.name}</option>{/each}</select></div>
  <div class="actions"><button class="btn navy" onclick={load} disabled={loading}>{m.loc_du_lieu()}</button><button class="btn" onclick={reset}>{m.dat_lai()}</button></div>
</section>

{#if error}<div class="banner error"><CircleAlert size={17} />{error}</div>{/if}

<p class="print-only">{m.ky_bao_cao()} {report ? periodText(report.period.label) : period.label}</p>
<section class="kpis">
  <article class="card kpi">
    <p class="label">{m.tong_doanh_so()}</p>
    <p class="value">{report ? vnd(report.summary.revenue) : '—'}</p>
    <p class="note">{#if report?.summary.changePercent !== null && report?.summary.changePercent !== undefined}{report.summary.changePercent >= 0 ? '+' : ''}{percent(report.summary.changePercent)} {m.so_voi_ky_truoc()}{:else}{m.sau_chiet_khau_chua_vat_2()}{/if}</p>
  </article>
  <article class="card kpi">
    <p class="label">{m.so_don_hang()}</p>
    <p class="value">{report ? m.don({ p0: num(report.summary.orders) }) : '—'}</p>
    <p class="note">{m.binh_quan()} {report ? millions(report.summary.averageOrderValue).replace(' tr', m.trieu()) : '—'}{m.don_2()}</p>
  </article>
  <article class="card kpi">
    <p class="label">{m.so_dai_ly_phat_sinh()}</p>
    <p class="value">{report ? m.dai_ly_2({ activeDealers: report.summary.activeDealers, totalDealers: report.summary.totalDealers }) : '—'}</p>
    <p class="note">{m.ty_le_hoat_dong()} {report && report.summary.totalDealers ? percent((report.summary.activeDealers / report.summary.totalDealers) * 100) : '—'}</p>
  </article>
  <article class="card kpi">
    <p class="label">{m.ty_le_chiet_khau_binh_quan()}</p>
    <p class="value">{report ? percent(report.summary.averageDiscountRate) : '—'}</p>
    <p class="note">{m.tran_chiet_khau_2()} {report?.summary.discountCapRate ?? '—'}%</p>
  </article>
</section>

<section class="charts">
  <article class="card">
    <header class="card-head"><div><h2>{m.top_6_dai_ly_theo_doanh()}</h2><p>{m.don_vi_trieu_dong()}</p></div></header>
    <div class="card-body">
      {#if report?.topDealers.length}
        <ol class="rank" aria-label={m.top_6_dai_ly_theo_doanh()}>
          {#each report.topDealers as row, index}
            <li title={`${row.name}: ${vnd(row.revenue)}`}>
              <span class="who">{row.name}{row.province ? ` — ${row.province}` : ''}</span>
              <span class="track"><span class="fill" class:top={index === 0} style={`width:${(Number(row.revenue) / topMax) * 100}%`}></span></span>
              <b>{num(Number(row.revenue) / 1_000_000)}</b>
            </li>
          {/each}
        </ol>
      {:else}<p class="empty">{loading ? m.dang_tong_hop() : m.khong_co_dai_ly_phat_sinh()}</p>{/if}
    </div>
  </article>
  <article class="card">
    <header class="card-head"><div><h2>{m.co_cau_doanh_so_theo_khu()}</h2><p>{m.ty_trong_tren_tong_doanh_so()}</p></div></header>
    <div class="card-body">
      {#if report?.regions.length}
        <div class="stack" role="img" aria-label={m.thanh_ty_trong_doanh_so_theo()}>
          {#each report.regions as row, index}
            {#if row.share > 0}
              <span style={`flex:${row.share};background:${regionColors[index] ?? '#C7D0DA'};color:${index < 3 ? '#fff' : 'var(--text)'}`} title={`${row.name}: ${percent(row.share)}`}>{row.share >= 7 ? percent(row.share) : ''}</span>
            {/if}
          {/each}
        </div>
        <table class="legend">
          <tbody>
            {#each report.regions as row, index}
              <tr><td><i style={`background:${regionColors[index] ?? '#C7D0DA'}`}></i>{row.name}</td><td class="num muted">{percent(row.share)}</td><td class="num"><b>{num(Number(row.revenue) / 1_000_000)} tr</b></td></tr>
            {/each}
          </tbody>
        </table>
      {:else}<p class="empty">{loading ? m.dang_tong_hop() : m.khong_co_du_lieu()}</p>{/if}
    </div>
  </article>
</section>

<section class="card">
  <header class="card-head detail-head"><h2>{m.chi_tiet_doanh_so_theo_dai()}</h2><span class="muted">{m.don_vi_tien_vnd()}</span></header>
  <div class="table-wrap">
    <table class="table">
      <thead><tr><th>{m.stt()}</th><th>{m.ma_dl()}</th><th>{m.ten_dai_ly_khach_hang()}</th><th>{m.khu_vuc()}</th><th>{m.cap()}</th><th class="num">{m.so_don()}</th><th class="num">{m.doanh_so()}</th><th class="num">{m.chiet_khau()}</th><th class="num">{m.cong_no_cuoi_ky()}</th><th class="num">{m.ty_trong()}</th></tr></thead>
      <tbody>
        {#if !report}<tr class="empty-row"><td colspan="10">{loading ? m.dang_tong_hop_bao_cao() : m.chua_co_du_lieu()}</td></tr>
        {:else if !report.rows.length}<tr class="empty-row"><td colspan="10">{m.khong_co_doanh_so_phu_hop()}</td></tr>
        {:else}
          {#each report.rows as row, index}
            <tr>
              <td class="muted">{index + 1}</td>
              <td><a class="code" href={`/sales/orders?customerId=${row.customerId}`}>{row.code}</a></td>
              <td>{row.name}</td>
              <td class="muted nowrap">{row.regionName}</td>
              <td class="muted nowrap">{row.tier}</td>
              <td class="num">{row.orders}</td>
              <td class="num"><b>{num(row.revenue)}</b></td>
              <td class="num muted">{num(row.discount)}</td>
              <td class="num">{num(row.closingDebt)}</td>
              <td class="num">{percent(row.share)}</td>
            </tr>
          {/each}
        {/if}
      </tbody>
      {#if report?.rows.length}
        <tfoot><tr><td></td><td></td><td colspan="3">{m.tong_cong()}{report.rows.length} {m.khach_hang_phat_sinh()}</td><td class="num">{num(report.totals.orders)}</td><td class="num">{num(report.totals.revenue)}</td><td class="num">{num(report.totals.discount)}</td><td class="num">{num(report.totals.closingDebt)}</td><td class="num">100%</td></tr></tfoot>
      {/if}
    </table>
  </div>
  {#if report}<footer class="foot"><span>{m.hien_thi()} {report.rows.length} {m.khach_hang_sap_xep_theo_doanh()}</span><span>{m.doanh_so_tien_hang_sau_chiet()} {session.user?.displayName}</span></footer>{/if}
</section>

<style>
  .filters { grid-template-columns: repeat(4, minmax(0, 1fr)) auto; }
  .charts { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; margin-bottom: 18px; }
  .rank { display: grid; gap: 16px; margin: 6px 0 4px; padding: 0; list-style: none; }
  .rank li { display: grid; grid-template-columns: minmax(230px, 1.1fr) minmax(120px, 1fr) 52px; align-items: center; gap: 12px; }
  .who { overflow: hidden; color: var(--text); font-size: 13px; text-align: right; text-overflow: ellipsis; white-space: nowrap; }
  .track { height: 22px; border-radius: 4px; background: var(--surface-2); }
  .fill { display: block; height: 100%; border-radius: 4px; background: var(--navy); }
  .fill.top { background: var(--orange); }
  .rank b { font-size: 13px; }
  .stack { display: flex; gap: 2px; height: 30px; margin: 8px 0 20px; overflow: hidden; border-radius: 4px; }
  .stack span { display: grid; min-width: 4px; place-items: center; font-size: 12px; font-weight: 700; }
  .legend { width: 100%; border-collapse: collapse; font-size: 13.5px; }
  .legend td { padding: 8px 0; }
  .legend i { display: inline-block; width: 12px; height: 12px; margin-right: 10px; border-radius: 3px; vertical-align: -1px; }
  .detail-head { padding-bottom: 14px; }
  .nowrap { white-space: nowrap; }
  .foot { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 10px; padding: 12px 20px; border-top: 1px solid var(--line-soft); color: var(--subtle); font-size: 12.5px; }
  .empty { margin: 40px 0; color: var(--muted); text-align: center; }
  .print-only { display: none; }
  @media (max-width: 1100px) { .filters { grid-template-columns: repeat(2, minmax(0, 1fr)); } .charts { grid-template-columns: 1fr; } }
  @media (max-width: 640px) { .filters { grid-template-columns: 1fr; } .rank li { grid-template-columns: 1fr 52px; } .who { grid-column: 1 / -1; text-align: left; } }
  @media print { .print-only { display: block; } .kpis { grid-template-columns: repeat(4, 1fr); } .charts { grid-template-columns: 1fr 1fr; } }
</style>
