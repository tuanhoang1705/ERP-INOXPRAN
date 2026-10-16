<script lang="ts">
  /**
   * Ô lọc thời gian dùng chung cho các danh sách (LIST-DATE-01): chọn nhanh (hôm nay, 7 ngày, tháng này…) hoặc "Tùy chọn…"
   * → khung nhỏ nhập từ / đến ngày rồi Áp dụng (không làm lệch hàng bộ lọc). `onchange` chạy mỗi khi khoảng đổi.
   */
  import { m } from '$lib/paraglide/messages';
  import { tick } from 'svelte';
  import { DATE_PRESETS, presetOf, presetRange, validRange, type DatePreset } from '$lib/date-range';

  let {
    from = $bindable(''),
    to = $bindable(''),
    label = m.dr_thoi_gian(),
    id = 'date-range',
    allowAll = true,
    onchange,
  }: { from?: string; to?: string; label?: string; id?: string; allowAll?: boolean; onchange?: () => void } = $props();

  let editing = $state(false);
  let draftFrom = $state('');
  let draftTo = $state('');
  let fromInput = $state<HTMLInputElement>();
  let root = $state<HTMLDivElement>();
  const preset = $derived<DatePreset>(presetOf({ from, to }));
  const draftValid = $derived(Boolean(draftFrom || draftTo) && validRange({ from: draftFrom, to: draftTo }));
  const show = (value: string) => (value ? value.split('-').reverse().join('/') : '…');
  const customText = $derived(preset === 'CUSTOM' ? `${show(from)} – ${show(to)}` : m.dr_tuy_chon());

  const presetLabel: Record<DatePreset, () => string> = {
    ALL: m.dr_tat_ca, TODAY: m.dr_hom_nay, '7D': m.dr_7_ngay, THIS_MONTH: m.dr_thang_nay, LAST_MONTH: m.dr_thang_truoc,
    THIS_QUARTER: m.dr_quy_nay, THIS_YEAR: m.dr_nam_nay, CUSTOM: m.dr_tuy_chon,
  };

  async function choose(select: HTMLSelectElement) {
    const next = select.value as DatePreset;
    if (next === 'CUSTOM') {
      // Giữ lựa chọn cũ trên ô chọn cho tới khi bấm Áp dụng.
      select.value = preset;
      draftFrom = from;
      draftTo = to;
      editing = true;
      await tick();
      fromInput?.focus();
      return;
    }
    editing = false;
    const range = presetRange(next);
    from = range.from;
    to = range.to;
    onchange?.();
  }
  function apply() {
    if (!draftValid) return;
    from = draftFrom;
    to = draftTo;
    editing = false;
    onchange?.();
  }
  function keydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.stopPropagation();
      editing = false;
    } else if (event.key === 'Enter') {
      event.preventDefault();
      apply();
    }
  }
  function focusOut(event: FocusEvent) {
    const next = event.relatedTarget as Node | null;
    if (editing && next && !root?.contains(next)) editing = false;
  }
</script>

<div class="field date-range" bind:this={root} onfocusout={focusOut}>
  <label for={id}>{label}</label>
  <select {id} value={preset} onchange={(event) => choose(event.currentTarget)} title={preset === 'CUSTOM' ? customText : ''}>
    {#each DATE_PRESETS.filter((item) => allowAll || item !== 'ALL') as item}<option value={item}>{item === 'CUSTOM' ? customText : presetLabel[item]()}</option>{/each}
  </select>
  {#if editing}
    <div class="popover" role="dialog" aria-label={label} tabindex="-1" onkeydown={keydown}>
      <label>{m.dr_tu_ngay()}<input bind:this={fromInput} type="date" bind:value={draftFrom} max={draftTo || undefined} /></label>
      <label>{m.dr_den_ngay()}<input type="date" bind:value={draftTo} min={draftFrom || undefined} /></label>
      {#if draftFrom && draftTo && draftFrom > draftTo}<small class="error">{m.dr_tu_ngay()} &gt; {m.dr_den_ngay()}</small>{/if}
      <div class="pop-actions">
        <button type="button" class="btn small" onclick={() => (editing = false)}>{m.huy()}</button>
        <button type="button" class="btn small primary" disabled={!draftValid} onclick={apply}>{m.dr_ap_dung()}</button>
      </div>
    </div>
  {/if}
</div>

<style>
  .date-range { position: relative; min-width: 0; }
  .popover {
    position: absolute; top: calc(100% + 6px); left: 0; z-index: 30; display: grid; gap: 10px; width: 250px; padding: 14px;
    border: 1px solid var(--line); border-radius: 10px; background: var(--surface); box-shadow: 0 16px 40px rgba(18, 59, 94, 0.22);
  }
  .popover label { display: grid; gap: 4px; color: var(--muted); font-size: 12px; font-weight: 600; }
  .popover input { width: 100%; }
  .pop-actions { display: flex; justify-content: flex-end; gap: 8px; }
  .error { color: var(--red); font-size: 12px; }
</style>
