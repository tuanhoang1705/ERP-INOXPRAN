<script lang="ts">
  import { tick } from 'svelte';
  import { m } from '$lib/paraglide/messages';
  import { expandStockReturnCode, type StockReturnPrefix } from '$shared/stock-return-code';
  import { vnDate } from '$shared/warranty';

  let { prefix, documentDay = vnDate(new Date()) }: { prefix: StockReturnPrefix; documentDay?: string } = $props();
  const id = $props.id();
  let mode = $state<'AUTO' | 'MANUAL'>('AUTO');
  let value = $state('');
  let input = $state<HTMLInputElement>();
  let attempted = $state(false);
  const expanded = $derived(expandStockReturnCode(value, prefix, documentDay));
  const invalid = $derived(!expanded && (attempted || Boolean(value.trim())));

  // undefined = tự sinh, null = số nhập tay cần sửa. Chỉ gửi mã đầy đủ đã hiện cho thủ kho.
  export function readCode(): string | null | undefined {
    if (mode === 'AUTO') return undefined;
    attempted = true;
    if (!expanded) input?.focus();
    return expanded;
  }

  async function chooseManual() {
    mode = 'MANUAL';
    await tick();
    input?.focus();
  }
</script>

<div class="field">
  <div class="heading">
    <label for={id}>{m.so_phieu()}{#if mode === 'MANUAL'} <span class="req">*</span>{/if}</label>
    <div class="modes" role="radiogroup" aria-label={m.bh_che_do_so_phieu()}>
      <label><input type="radio" name={id} checked={mode === 'AUTO'} onchange={() => { mode = 'AUTO'; attempted = false; }} /><span>{m.bh_che_do_tu_sinh()}</span></label>
      <label><input type="radio" name={id} checked={mode === 'MANUAL'} onchange={chooseManual} /><span>{m.bh_che_do_tu_nhap()}</span></label>
    </div>
  </div>
  {#if mode === 'MANUAL'}
    <input {id} bind:this={input} bind:value maxlength="13" autocomplete="off" spellcheck="false" placeholder="0040"
      aria-required="true" aria-invalid={invalid} aria-describedby={id + '-hint'} />
    <span id={id + '-hint'} class:error={invalid} class:hint={!invalid} aria-live="polite">
      {expanded ? m.bh_so_se_la({ code: expanded }) : m.inv_goi_y_nhap_so_tra({ prefix })}
    </span>
  {:else}
    <input {id} readonly value={m.inv_so_tra_tu_sinh({ prefix: prefix + documentDay.slice(0, 7).replace('-', '') })} />
  {/if}
</div>

<style>
  .heading { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 12px; }
  .heading > label { font-size: 13px; font-weight: 500; }
  .req { color: var(--red); }
  .modes { display: inline-flex; padding: 2px; border: 1px solid var(--line); border-radius: 7px; background: var(--surface-2); }
  .modes label { position: relative; cursor: pointer; }
  .modes input { position: absolute; width: 1px; height: 1px; min-height: 0; padding: 0; border: 0; clip-path: inset(50%); }
  .modes span { display: block; padding: 3px 9px; border-radius: 5px; color: var(--muted); font-size: 12px; }
  .modes input:checked + span { background: var(--navy); color: #fff; }
  .modes input:focus-visible + span { outline: 2px solid var(--navy-2); outline-offset: 2px; }
</style>
