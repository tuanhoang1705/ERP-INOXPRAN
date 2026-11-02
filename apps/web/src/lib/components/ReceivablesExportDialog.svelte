<script lang="ts">
  /**
   * Xuất bảng tổng hợp công nợ theo mẫu 收付明细汇总表 (AR-XLS-02, 31/10/2026): chọn khoảng tháng (mỗi tháng một sheet) và khách —
   * tất cả hoặc chọn từng khách (tìm theo mã, tên, NVKD).
   */
  import { m } from '$lib/paraglide/messages';
  import { CircleAlert, Download } from 'lucide-svelte';
  import { api, download } from '$lib/api';
  import { vnToday } from '$lib/format';
  import Dialog from '$lib/components/Dialog.svelte';

  type Customer = { partnerId: string; code: string; name: string; salesRepName?: string; balance: string };

  let { open = $bindable(false) }: { open?: boolean } = $props();

  const today = vnToday();
  const monthOf = (year: number, month: number) => {
    const at = new Date(Date.UTC(year, month - 1, 1));
    return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}`;
  };
  const thisMonth = monthOf(today.year, today.month);
  let fromMonth = $state(thisMonth);
  let toMonth = $state(thisMonth);
  let all = $state(true);
  let customers = $state<Customer[]>([]);
  let selected = $state<string[]>([]);
  let search = $state('');
  let loading = $state(false);
  let working = $state(false);
  let error = $state('');

  const fold = (text: string) => text.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toLowerCase();
  const visible = $derived(search.trim()
    ? customers.filter((row) => fold(`${row.code} ${row.name} ${row.salesRepName ?? ''}`).includes(fold(search.trim())))
    : customers);
  const span = $derived.by(() => {
    const [fy, fm] = fromMonth.split('-').map(Number);
    const [ty, tm] = toMonth.split('-').map(Number);
    return (ty! * 12 + tm!) - (fy! * 12 + fm!) + 1;
  });
  const invalid = $derived(!fromMonth || !toMonth ? m.cnx_chon_thang() : span < 1 ? m.cnx_thang_nguoc() : span > 12 ? m.cnx_toi_da_12() : toMonth > thisMonth ? m.cnx_chua_toi_thang() : '');

  type Preset = 'month' | 'quarter' | 'three';
  const PRESET_FROM: Record<Preset, string> = {
    month: thisMonth,
    quarter: monthOf(today.year, Math.floor((today.month - 1) / 3) * 3 + 1),
    three: monthOf(today.year, today.month - 2),
  };
  /** Nút vừa bấm; nút sáng khi khoảng tháng đang chọn đúng bằng khoảng của nút (sửa tay ô tháng thì tự tắt). */
  let chosen = $state<Preset | null>('month');
  const activePreset = $derived.by((): Preset | null => {
    if (toMonth !== thisMonth) return null;
    if (chosen && PRESET_FROM[chosen] === fromMonth) return chosen;
    return (['month', 'three', 'quarter'] as const).find((kind) => PRESET_FROM[kind] === fromMonth) ?? null;
  });

  function preset(kind: Preset) {
    chosen = kind;
    toMonth = thisMonth;
    fromMonth = PRESET_FROM[kind];
  }

  async function loadCustomers() {
    if (customers.length || loading) return;
    loading = true;
    try {
      const result = await api<{ rows: Customer[] }>('/receivables/customers');
      customers = result.rows;
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.khong_tai_duoc_cong_no();
    } finally {
      loading = false;
    }
  }
  $effect(() => {
    if (open && !all) void loadCustomers();
  });

  function toggle(id: string) {
    selected = selected.includes(id) ? selected.filter((item) => item !== id) : [...selected, id];
  }
  function selectVisible() {
    selected = [...new Set([...selected, ...visible.map((row) => row.partnerId)])];
  }

  async function run() {
    if (invalid || (!all && !selected.length)) return;
    working = true;
    error = '';
    try {
      const query = new URLSearchParams({ fromMonth, toMonth, ...(all ? {} : { customerIds: selected.join(',') }) });
      await download(`/receivables/customers/export?${query}`, `收付明细汇总表_${fromMonth}_${toMonth}.xlsx`);
      open = false;
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.khong_xuat_duoc_excel();
    } finally {
      working = false;
    }
  }
</script>

<Dialog bind:open title={m.cnx_tieu_de()} wide>
  <div class="export">
    {#if error}<div class="banner error"><CircleAlert size={17} /><span>{error}</span></div>{/if}
    <p class="lead">{m.cnx_giai_thich()}</p>
    <fieldset>
      <legend>{m.cnx_thoi_gian()}</legend>
      <div class="months">
        <div class="field"><label for="cnx-from">{m.cnx_tu_thang()}</label><input id="cnx-from" type="month" max={thisMonth} bind:value={fromMonth} /></div>
        <div class="field"><label for="cnx-to">{m.cnx_den_thang()}</label><input id="cnx-to" type="month" max={thisMonth} bind:value={toMonth} /></div>
        <div class="presets">
          <button type="button" class="btn small" class:active={activePreset === 'month'} aria-pressed={activePreset === 'month'} onclick={() => preset('month')}>{m.cnx_thang_nay()}</button>
          <button type="button" class="btn small" class:active={activePreset === 'quarter'} aria-pressed={activePreset === 'quarter'} onclick={() => preset('quarter')}>{m.cnx_quy_nay()}</button>
          <button type="button" class="btn small" class:active={activePreset === 'three'} aria-pressed={activePreset === 'three'} onclick={() => preset('three')}>{m.cnx_3_thang()}</button>
        </div>
      </div>
      {#if invalid}<small class="error">{invalid}</small>{:else}<small class="hint">{m.cnx_so_sheet({ count: span })}</small>{/if}
    </fieldset>
    <fieldset>
      <legend>{m.cnx_khach_hang()}</legend>
      <label class="check"><input id="cnx-all" type="checkbox" bind:checked={all} />{m.cnx_tat_ca_khach()}</label>
      {#if !all}
        <div class="pick-head">
          <input id="cnx-search" class="input" bind:value={search} placeholder={m.cnx_tim_khach()} aria-label={m.cnx_tim_khach()} />
          <button type="button" class="btn small" onclick={selectVisible} disabled={!visible.length}>{m.cnx_chon_ket_qua()}</button>
          <button type="button" class="btn small" onclick={() => (selected = [])} disabled={!selected.length}>{m.cnx_bo_chon()}</button>
          <span class="count">{m.cnx_da_chon({ count: selected.length })}</span>
        </div>
        <div class="pick-list" role="group" aria-label={m.cnx_khach_hang()}>
          {#if loading}<p class="muted">{m.dang_tai()}</p>
          {:else}
            {#each visible as row (row.partnerId)}
              <label class="pick"><input type="checkbox" checked={selected.includes(row.partnerId)} onchange={() => toggle(row.partnerId)} /><span class="code">{row.code}</span><span class="name">{row.name}</span><small>{row.salesRepName ?? ''}</small></label>
            {:else}<p class="muted">{m.cnx_khong_co_khach()}</p>{/each}
          {/if}
        </div>
      {/if}
    </fieldset>
  </div>
  {#snippet footer()}
    <button class="btn" onclick={() => (open = false)}>{m.dong()}</button>
    <button class="btn primary" disabled={working || Boolean(invalid) || (!all && !selected.length)} onclick={run}><Download size={16} />{working ? m.cnx_dang_xuat() : m.xuat_excel()}</button>
  {/snippet}
</Dialog>

<style>
  .export { display: grid; gap: 14px; }
  .lead { margin: 0; color: var(--muted); font-size: 13px; }
  fieldset { display: grid; gap: 10px; margin: 0; padding: 12px 14px; border: 1px solid var(--line); border-radius: 10px; }
  legend { padding: 0 6px; font-weight: 600; font-size: 13.5px; }
  .months { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 12px; }
  .months .field { min-width: 160px; }
  .presets { display: flex; flex-wrap: wrap; gap: 6px; }
  .presets .btn.active { border-color: var(--navy); background: var(--navy); color: #fff; }
  .check { display: flex; align-items: center; gap: 8px; font-weight: 500; }
  .pick-head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  .pick-head input { flex: 1 1 220px; min-width: 0; }
  .count { color: var(--muted); font-size: 12.5px; }
  .pick-list { display: grid; max-height: 300px; overflow: auto; border: 1px solid var(--line); border-radius: 8px; }
  .pick { display: grid; grid-template-columns: auto 64px minmax(0, 1fr) auto; align-items: center; gap: 10px; padding: 8px 12px; border-bottom: 1px solid var(--line); font-size: 13px; cursor: pointer; }
  .pick:last-child { border-bottom: 0; }
  .pick:hover { background: var(--surface-2); }
  .pick .code { font-weight: 600; }
  .pick .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pick small { color: var(--muted); }
  .muted { margin: 12px; color: var(--muted); }
  small.error { color: var(--red); }
  small.hint { color: var(--muted); }
  @media (max-width: 560px) { .pick { grid-template-columns: auto 56px minmax(0, 1fr); } .pick small { display: none; } }
</style>
