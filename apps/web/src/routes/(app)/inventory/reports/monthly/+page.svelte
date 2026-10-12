<script lang="ts">
  /**
   * Báo cáo tồn kho tháng theo mẫu `月库存明细单` của công ty: tồn cuối tháng trước, nhập / xuất theo từng loại,
   * xuất kho tổng hợp, tồn cuối kỳ, % tồn còn lại so với số nhập ban đầu; tháng hiện tại có thêm tồn có sẵn và đối chiếu sổ.
   * Tiêu đề cột song ngữ như file Excel; nút "Xuất Excel" tải đúng bố cục đó.
   */
  import { m } from '$lib/paraglide/messages';
  import type { InventoryMonthlyReport, Warehouse } from '@inoxpran/contracts';
  import { onMount } from 'svelte';
  import { AlertTriangle, CircleAlert, CircleCheck, Download } from 'lucide-svelte';
  import { api, download } from '$lib/api';
  import { dateTime, num, rate } from '$lib/format';
  import { categoryHeading } from '$lib/inventory';
  import { categoryInfo } from '$shared/inventory-categories';
  import { getLocale } from '$lib/paraglide/runtime';

  /** Cột cố định của 月库存明细单: nhãn chính theo ngôn ngữ giao diện, phụ đề là ngôn ngữ còn lại (như file Excel song ngữ). */
  const FIXED = {
    sku: ['Mã SP (Model)', '型号'],
    name: ['Tên sản phẩm', '产品名称'],
    initial: ['Số lượng nhập ban đầu', '初始入库'],
    percent: ['% tồn còn lại', '剩余库存百分比'],
    opening: ['Tồn cuối tháng trước', '上月库存'],
    netOut: ['Xuất kho tổng hợp', '综合出库'],
    closing: ['Tồn cuối kỳ', '库存结余'],
    available: ['Tồn có sẵn', '现货库存'],
    check: ['Đối chiếu sổ', '数据查验'],
  } as const;
  const heading = (key: keyof typeof FIXED): [string, string] => {
    const [vi, zh] = FIXED[key];
    return getLocale() === 'zh' ? [zh, vi] : [vi, zh];
  };

  const thisMonth = () => new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 7);
  let month = $state(thisMonth());
  let warehouseId = $state('');
  let search = $state('');
  let hideZero = $state(true);
  let warehouses = $state<Warehouse[]>([]);
  let report = $state<InventoryMonthlyReport | null>(null);
  let loading = $state(true);
  let exporting = $state(false);
  let error = $state('');

  const rows = $derived.by(() => {
    if (!report) return [];
    const needle = search.trim().toLowerCase();
    return report.rows.filter((row) => {
      if (needle && !row.sku.toLowerCase().includes(needle) && !row.productName.toLowerCase().includes(needle)) return false;
      if (hideZero && row.opening === 0 && row.closing === 0 && Object.values(row.amounts).every((value) => !value)) return false;
      return true;
    });
  });
  const query = $derived(new URLSearchParams({ month, ...(warehouseId ? { warehouseId } : {}) }).toString());

  async function load() {
    loading = true;
    error = '';
    try {
      report = await api<InventoryMonthlyReport>(`/inventory/reports/monthly?${query}`);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.inv_khong_tai_duoc();
      report = null;
    } finally {
      loading = false;
    }
  }
  onMount(() => {
    void load();
    void api<Warehouse[]>('/warehouses').then((list) => (warehouses = list)).catch(() => undefined);
  });

  async function exportExcel() {
    exporting = true;
    error = '';
    try {
      await download(`/inventory/reports/monthly/export?${query}`, `TonKhoThang_${month}.xlsx`);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.khong_tai_duoc_tep();
    } finally {
      exporting = false;
    }
  }
  const tone = (value: number) => (value < 40 ? 'p-red' : value < 60 ? 'p-orange' : value < 75 ? 'p-amber' : value < 90 ? 'p-yellow' : 'p-green');
  const signed = (value: number | undefined) => (value ? num(value) : '');
</script>

<svelte:head><title>{m.inv_ton_kho_thang()} · INOXPRAN ERP</title></svelte:head>

<section class="page-head">
  <div>
    <nav class="crumbs" aria-label={m.duong_dan()}><a href="/inventory">{m.kho_giao_hang()}</a><span>{m.inv_ton_kho_thang()}</span></nav>
    <h1 class="page-title">{m.inv_ton_kho_thang()} <span class="zh">月库存明细单</span></h1>
    <p class="page-sub">{m.inv_ton_kho_thang_mo_ta()}</p>
  </div>
  <div class="actions"><button class="btn primary" disabled={exporting || !report} onclick={exportExcel}><Download size={16} />{exporting ? m.dang_xuat_2() : m.xuat_excel()}</button></div>
</section>

<section class="card filters">
  <div class="field"><label for="month">{m.inv_thang()}</label><input id="month" type="month" bind:value={month} max={thisMonth()} onchange={load} /></div>
  <div class="field"><label for="warehouse">{m.kho()}</label>
    <select id="warehouse" bind:value={warehouseId} onchange={load}><option value="">{m.inv_tat_ca_kho_gop()}</option>{#each warehouses as item (item.id)}<option value={item.id}>{item.name}</option>{/each}</select>
  </div>
  <div class="field"><label for="search">{m.ma_sp_ten_hang()}</label><input id="search" bind:value={search} placeholder="INP…" /></div>
  <label class="check"><input type="checkbox" bind:checked={hideZero} />{m.inv_an_ma_khong_phat_sinh()}</label>
</section>

{#if error}<div class="banner error"><CircleAlert size={17} />{error}</div>{/if}
{#each report?.stockCountWarnings ?? [] as warning (warning.id)}
  <div class="banner error"><AlertTriangle size={17} /><span>{m.kk_canh_bao_bao_cao({ code: warning.code, warehouse: warning.warehouseName, at: dateTime(warning.closedAt), by: warning.closedByName, count: warning.mismatches, note: warning.note })} <a class="link" href={`/inventory/counts/${warning.id}`}>{m.xem()}</a></span></div>
{/each}
{#if report?.current}
  {#if report.mismatches}<div class="banner error"><CircleAlert size={17} />{m.inv_lech_so({ count: report.mismatches })}</div>
  {:else}<div class="banner success"><CircleCheck size={17} />{m.inv_khop_so()}</div>{/if}
{/if}

<section class="card">
  <header class="card-head head">
    <h2>{report ? m.inv_bao_cao_thang({ month: `${Number(month.slice(5))}/${month.slice(0, 4)}`, warehouse: report.warehouseId ? report.warehouseName : m.inv_tat_ca_kho_gop() }) : m.dang_tai()}</h2>
    {#if report}<span class="muted">{m.inv_so_ma({ shown: rows.length, total: report.rows.length })}</span>{/if}
  </header>
  <div class="table-wrap monthly">
    <table class="table">
      <thead>
        <tr>
          <th class="sticky c1">{heading('sku')[0]}<small>{heading('sku')[1]}</small></th>
          <th class="sticky c2">{heading('name')[0]}<small>{heading('name')[1]}</small></th>
          <th class="num">{heading('initial')[0]}<small>{heading('initial')[1]}</small></th>
          <th class="num">{heading('percent')[0]}<small>{heading('percent')[1]}</small></th>
          <th class="num">{heading('opening')[0]}<small>{heading('opening')[1]}</small></th>
          {#if report}
            {#each report.columns as code (code)}
              {@const [primary, secondary] = categoryHeading(code)}
              <th class={`num ${categoryInfo(code)?.direction === 'IN' ? 'in' : 'out'}`}>{primary}<small>{secondary}</small></th>
            {/each}
          {/if}
          <th class="num net">{heading('netOut')[0]}<small>{heading('netOut')[1]}</small></th>
          <th class="num">{heading('closing')[0]}<small>{heading('closing')[1]}</small></th>
          {#if report?.current}<th class="num">{heading('available')[0]}<small>{heading('available')[1]}</small></th><th>{heading('check')[0]}<small>{heading('check')[1]}</small></th>{/if}
        </tr>
      </thead>
      <tbody>
        {#if loading && !report}<tr class="empty-row"><td colspan="20">{m.dang_tai()}</td></tr>
        {:else if report && rows.length}
          {#each rows as row (row.productId)}
            <tr>
              <td class="sticky c1"><a class="code" href={`/inventory/movements?productId=${row.productId}`}>{row.sku}</a></td>
              <td class="sticky c2 name">{row.productName}</td>
              <td class="num muted">{row.initialQuantity === null ? '—' : num(row.initialQuantity)}</td>
              <td class="num">{#if row.remainingPercent !== null}<span class={`pct ${tone(row.remainingPercent)}`}>{rate(row.remainingPercent)}</span>{:else}—{/if}</td>
              <td class="num">{num(row.opening)}</td>
              {#each report.columns as code (code)}<td class="num">{signed(row.amounts[code])}</td>{/each}
              <td class="num"><i>{num(row.netOut)}</i></td>
              <td class="num"><b>{num(row.closing)}</b></td>
              {#if report.current}
                <td class="num">{num(row.available ?? 0)}</td>
                <td>{#if row.ledgerMatches}<span class="pill success">✓</span>{:else}<span class="pill danger">✗</span>{/if}</td>
              {/if}
            </tr>
          {/each}
        {:else if report}<tr class="empty-row"><td colspan="20">{m.khong_co_ma_hang_phu_hop()}</td></tr>{/if}
      </tbody>
      {#if report && rows.length}
        <tfoot>
          <tr>
            <td class="sticky c1"></td>
            <td class="sticky c2">{m.rw_tong_cong()} 合计</td>
            <td></td><td></td>
            <td class="num">{num(report.totals.opening)}</td>
            {#each report.columns as code (code)}<td class="num">{signed(report.totals.amounts[code])}</td>{/each}
            <td class="num">{num(report.totals.netOut)}</td>
            <td class="num">{num(report.totals.closing)}</td>
            {#if report.current}<td></td><td></td>{/if}
          </tr>
        </tfoot>
      {/if}
    </table>
  </div>
</section>
<p class="hint">{m.inv_cong_thuc()}</p>

<style>
  .zh { color: var(--subtle); font-size: 0.6em; font-weight: 500; }
  .filters { grid-template-columns: 180px minmax(200px, 1fr) minmax(200px, 1fr) auto; align-items: end; }
  .monthly { max-height: calc(100vh - 300px); overflow: auto; }
  .monthly th { position: sticky; top: 0; z-index: 2; vertical-align: bottom; white-space: normal; min-width: 96px; font-size: 12px; line-height: 1.25; text-transform: none; letter-spacing: 0; }
  .monthly th small { display: block; margin-top: 3px; color: var(--subtle); font-size: 10.5px; font-weight: 500; text-transform: none; letter-spacing: 0; }
  .monthly th.in { background: #e7f3e3; }
  .monthly th.out { background: #fff6dd; }
  .monthly th.net { background: #dde6f6; }
  .monthly .sticky { position: sticky; z-index: 1; background: var(--surface); }
  .monthly th.sticky { z-index: 3; }
  .monthly .c1 { left: 0; min-width: 96px; }
  .monthly .c2 { left: 96px; min-width: 220px; box-shadow: 1px 0 0 var(--line-soft); }
  .monthly .name { white-space: normal; }
  .monthly tfoot td { position: sticky; bottom: 0; background: #ffe7a6; font-weight: 700; }
  .monthly tfoot .sticky { z-index: 2; background: #ffe7a6; }
  .pct { display: inline-block; min-width: 64px; padding: 1px 6px; border-radius: 4px; color: #111; font-weight: 600; }
  .p-red { background: #ff8a80; }
  .p-orange { background: #ffb74d; }
  .p-amber { background: #ffd54f; }
  .p-yellow { background: #fff176; }
  .p-green { background: #aed581; }
  .hint { color: var(--subtle); font-size: 12.5px; }
  @media (max-width: 900px) { .filters { grid-template-columns: 1fr 1fr; } }
</style>
