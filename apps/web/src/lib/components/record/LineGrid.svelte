<script lang="ts" module>
  export interface GridColumn<T> {
    key: string;
    label: string;
    /** Giá trị hiển thị (ô chỉ đọc, xuất Excel). */
    value: (row: T) => string;
    /** Ô sửa được: giá trị đang sửa và cách ghi lại vào dòng. */
    /** `decimals` có giá trị → ô số có phân cách hàng nghìn (NumberInput), `set` nhận giá trị chuẩn "1250.5". */
    edit?: { get: (row: T) => string; set: (row: T, value: string) => void; inputmode?: 'numeric' | 'decimal' | 'text'; decimals?: number; options?: (row: T) => Array<{ value: string; label: string }> } | undefined;
    align?: 'left' | 'right' | 'center' | undefined;
    width?: string | undefined;
    /** Không cho ẩn cột (mã, số lượng…). */
    required?: boolean | undefined;
    /** Ẩn mặc định cho tới khi người dùng chọn hiện. */
    hiddenByDefault?: boolean | undefined;
    /** Giá trị dòng tổng của cột. */
    total?: ((rows: T[]) => string) | undefined;
  }
</script>

<script lang="ts" generics="T">
  /**
   * Bảng dòng hàng của chứng từ (theo lưới dòng hàng của hệ thống công ty mẹ): sửa trực tiếp trong ô, ↑ / ↓ / Enter
   * chuyển dòng cùng cột, thêm dòng bằng ô nhập mã (gõ hoặc máy quét mã vạch — Enter để thêm, trùng mã thì cộng số lượng),
   * chọn / sắp xếp cột (nhớ theo người dùng trên trình duyệt), xuất CSV mở bằng Excel.
   */
  import { ArrowDown, ArrowUp, Columns3, Download, Info, ScanBarcode, Trash2 } from 'lucide-svelte';
  import { m } from '$lib/paraglide/messages';
  import { session } from '$lib/session.svelte';
  import NumberInput from '$lib/components/NumberInput.svelte';

  let {
    rows = $bindable([]),
    columns,
    gridKey,
    readonly = false,
    exportName = 'dong-hang',
    suggestions = [],
    onadd,
    onremove,
    ondetail,
  }: {
    rows: T[];
    columns: Array<GridColumn<T>>;
    /** Khóa lưu lựa chọn cột (VD purchase-order-lines). */
    gridKey: string;
    readonly?: boolean;
    exportName?: string;
    /** Gợi ý ô nhập mã (mã — tên). */
    suggestions?: Array<{ value: string; label: string }>;
    /** Thêm dòng theo mã / mã vạch; trả lỗi (chuỗi) nếu không tìm thấy. */
    onadd?: ((code: string) => string | null | Promise<string | null>) | undefined;
    onremove?: ((index: number) => void) | undefined;
    ondetail?: ((row: T) => void) | undefined;
  } = $props();

  const storageKey = $derived(`erp:grid:${gridKey}:${session.user?.sub ?? ''}`);
  let order = $state<string[]>([]);
  let hidden = $state<string[]>([]);
  let chooserOpen = $state(false);
  let code = $state('');
  let addError = $state('');
  let adding = $state(false);
  let table = $state<HTMLTableElement>();
  let codeInput = $state<HTMLInputElement>();

  $effect(() => {
    const defaults = { order: columns.map((column) => column.key), hidden: columns.filter((column) => column.hiddenByDefault).map((column) => column.key) };
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) ?? 'null') as { order?: string[]; hidden?: string[] } | null;
      const known = new Set(defaults.order);
      const savedOrder = (saved?.order ?? []).filter((key) => known.has(key));
      order = [...savedOrder, ...defaults.order.filter((key) => !savedOrder.includes(key))];
      hidden = (saved?.hidden ?? defaults.hidden).filter((key) => known.has(key) && !columns.find((column) => column.key === key)?.required);
    } catch {
      order = defaults.order;
      hidden = defaults.hidden;
    }
  });
  function remember() {
    try {
      localStorage.setItem(storageKey, JSON.stringify({ order, hidden }));
    } catch {
      // Trình duyệt chặn lưu trữ: lựa chọn cột chỉ giữ trong trang này.
    }
  }
  const visible = $derived(order.map((key) => columns.find((column) => column.key === key)).filter((column): column is GridColumn<T> => Boolean(column) && !hidden.includes(column!.key)));
  const hasTotals = $derived(visible.some((column) => column.total));

  function toggle(key: string) {
    hidden = hidden.includes(key) ? hidden.filter((item) => item !== key) : [...hidden, key];
    remember();
  }
  function move(key: string, delta: number) {
    const index = order.indexOf(key);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= order.length) return;
    const next = [...order];
    [next[index], next[target]] = [next[target] as string, next[index] as string];
    order = next;
    remember();
  }

  async function submitCode(event: SubmitEvent) {
    event.preventDefault();
    const value = code.trim();
    if (!value || !onadd) return;
    adding = true;
    addError = '';
    try {
      const problem = await onadd(value);
      if (problem) addError = problem;
      else code = '';
    } finally {
      adding = false;
      codeInput?.focus();
    }
  }

  /** ↑ / ↓ / Enter: sang ô cùng cột ở dòng trên / dưới. */
  function keydown(event: KeyboardEvent, rowIndex: number, columnKey: string) {
    const step = event.key === 'ArrowDown' || event.key === 'Enter' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
    if (!step || (event.target as HTMLElement).tagName === 'SELECT') return;
    event.preventDefault();
    const next = table?.querySelector<HTMLInputElement>(`[data-cell="${rowIndex + step}:${columnKey}"]`);
    if (next) {
      next.focus();
      next.select();
    } else if (step > 0 && onadd) {
      codeInput?.focus();
    }
  }

  function exportCsv() {
    const escape = (value: string) => (/[",\n;]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
    const lines = [visible.map((column) => escape(column.label)).join(','), ...rows.map((row) => visible.map((column) => escape(column.value(row))).join(','))];
    if (hasTotals) lines.push(visible.map((column, index) => escape(column.total ? column.total(rows) : index === 0 ? m.rw_tong_cong() : '')).join(','));
    const blob = new Blob([`﻿${lines.join('\r\n')}`], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${exportName}.csv`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
</script>

<div class="grid-tools no-print">
  {#if onadd && !readonly}
    <form class="scan" onsubmit={submitCode}>
      <ScanBarcode size={17} />
      <input bind:this={codeInput} bind:value={code} list={`${gridKey}-codes`} placeholder={m.lg_nhap_ma()} aria-label={m.lg_nhap_ma()} autocomplete="off" disabled={adding} />
      <datalist id={`${gridKey}-codes`}>{#each suggestions as item}<option value={item.value}>{item.label}</option>{/each}</datalist>
      <button class="btn small soft" disabled={adding || !code.trim()}>{m.lg_them()}</button>
    </form>
  {/if}
  <div class="right">
    <div class="chooser">
      <button class="btn small" aria-expanded={chooserOpen} onclick={() => (chooserOpen = !chooserOpen)}><Columns3 size={15} />{m.lg_cot()}</button>
      {#if chooserOpen}
        <ul class="menu" role="menu">
          {#each order as key, index}
            {@const column = columns.find((item) => item.key === key)}
            {#if column}
              <li>
                <label><input type="checkbox" checked={!hidden.includes(key)} disabled={column.required} onchange={() => toggle(key)} />{column.label}</label>
                <button class="icon-btn" aria-label={m.lg_len()} disabled={index === 0} onclick={() => move(key, -1)}><ArrowUp size={13} /></button>
                <button class="icon-btn" aria-label={m.lg_xuong()} disabled={index === order.length - 1} onclick={() => move(key, 1)}><ArrowDown size={13} /></button>
              </li>
            {/if}
          {/each}
        </ul>
      {/if}
    </div>
    <button class="btn small" onclick={exportCsv} disabled={!rows.length}><Download size={15} />{m.lg_xuat_excel()}</button>
  </div>
</div>
{#if addError}<p class="add-error">{addError}</p>{/if}

<div class="table-wrap">
  <table class="table lines" bind:this={table}>
    <thead>
      <tr>
        <th class="idx">#</th>
        {#each visible as column (column.key)}<th class:num={column.align === 'right'} style:width={column.width}>{column.label}</th>{/each}
        {#if !readonly || ondetail}<th class="tools-col"></th>{/if}
      </tr>
    </thead>
    <tbody>
      {#each rows as row, rowIndex}
        <tr>
          <td class="idx muted">{rowIndex + 1}</td>
          {#each visible as column (column.key)}
            <td class:num={column.align === 'right'}>
              {#if column.edit && !readonly}
                {#if column.edit.options}
                  <select class="cell" value={column.edit.get(row)} onchange={(event) => column.edit?.set(row, event.currentTarget.value)} aria-label={`${column.label} ${rowIndex + 1}`}>
                    {#each column.edit.options(row) as option}<option value={option.value}>{option.label}</option>{/each}
                  </select>
                {:else if column.edit.decimals !== undefined}
                  <NumberInput class={column.align === 'right' ? 'cell right' : 'cell'} data-cell={`${rowIndex}:${column.key}`} value={column.edit.get(row)} decimals={column.edit.decimals}
                    onvalue={(value) => column.edit?.set(row, value)} onkeydown={(event) => keydown(event, rowIndex, column.key)} aria-label={`${column.label} ${rowIndex + 1}`} />
                {:else}
                  <input class="cell" class:right={column.align === 'right'} data-cell={`${rowIndex}:${column.key}`} value={column.edit.get(row)} inputmode={column.edit.inputmode ?? 'text'}
                    oninput={(event) => column.edit?.set(row, event.currentTarget.value)} onkeydown={(event) => keydown(event, rowIndex, column.key)} aria-label={`${column.label} ${rowIndex + 1}`} />
                {/if}
              {:else}{column.value(row)}{/if}
            </td>
          {/each}
          {#if !readonly || ondetail}
            <td class="row-actions">
              {#if ondetail}<button class="icon-btn" title={m.lg_chi_tiet()} aria-label={m.lg_chi_tiet()} onclick={() => ondetail?.(row)}><Info size={15} /></button>{/if}
              {#if !readonly && onremove}<button class="icon-btn danger" title={m.crud_xoa()} aria-label={`${m.crud_xoa()} ${rowIndex + 1}`} onclick={() => onremove?.(rowIndex)}><Trash2 size={15} /></button>{/if}
            </td>
          {/if}
        </tr>
      {:else}
        <tr class="empty-row"><td colspan={visible.length + 2}>{m.lg_chua_co_dong()}</td></tr>
      {/each}
    </tbody>
    {#if hasTotals && rows.length}
      <tfoot>
        <tr>
          <td></td>
          {#each visible as column, index (column.key)}<td class:num={column.align === 'right'}>{column.total ? column.total(rows) : index === 0 ? m.rw_tong_cong() : ''}</td>{/each}
          {#if !readonly || ondetail}<td></td>{/if}
        </tr>
      </tfoot>
    {/if}
  </table>
</div>

<style>
  .grid-tools { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px; padding: 12px 16px; }
  .scan { display: flex; flex: 1 1 320px; align-items: center; gap: 8px; max-width: 520px; padding: 0 4px 0 10px; border: 1px solid var(--line); border-radius: var(--radius-sm); background: var(--surface); color: var(--muted); }
  .scan:focus-within { border-color: var(--navy-2); box-shadow: 0 0 0 3px rgba(27, 84, 128, 0.12); }
  .scan input { flex: 1; min-width: 0; min-height: 38px; border: 0; outline: none; background: transparent; }
  .right { display: flex; gap: 8px; }
  .chooser { position: relative; }
  .menu { position: absolute; right: 0; z-index: 30; min-width: 240px; max-height: 360px; margin: 6px 0 0; padding: 6px; overflow-y: auto; border: 1px solid var(--line); border-radius: 10px; background: var(--surface); box-shadow: 0 12px 30px rgba(18, 59, 94, 0.15); list-style: none; }
  .menu li { display: flex; align-items: center; gap: 2px; }
  .menu label { display: flex; flex: 1; align-items: center; gap: 8px; padding: 6px 8px; font-size: 13px; cursor: pointer; }
  .add-error { margin: 0 16px 8px; color: var(--red); font-size: 12.5px; }
  .lines td { padding: 6px 10px; }
  .idx { width: 42px; }
  .tools-col { width: 72px; }
  /* :global vì ô số là NumberInput (component con) — vẫn chỉ áp trong ô của bảng này. */
  td :global(.cell) { width: 100%; min-width: 70px; min-height: 34px; padding: 5px 8px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface); }
  td :global(.cell.right) { text-align: right; }
  td :global(.cell:focus) { outline: none; border-color: var(--navy-2); box-shadow: 0 0 0 2px rgba(27, 84, 128, 0.12); }
  tfoot td { font-weight: 700; }
</style>
