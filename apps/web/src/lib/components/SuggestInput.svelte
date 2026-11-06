<script lang="ts" module>
  export type Suggestion = { value: string; label?: string; detail?: string; note?: string; muted?: boolean };
</script>

<script lang="ts">
  /**
   * Ô vừa gõ vừa chọn (05/11/2026): gõ tự do (VD số phiếu chưa có trong gợi ý), hoặc bấm mũi tên / gõ vài ký tự để chọn từ danh sách
   * gợi ý. ↑↓ chọn, Enter lấy, Esc đóng. Khác CustomerPicker: giá trị là chữ đã gõ, không bắt buộc nằm trong danh sách.
   */
  import { tick } from 'svelte';
  import { ChevronDown } from 'lucide-svelte';
  import { foldText } from '$shared/text';

  let {
    value = $bindable(''),
    options,
    id,
    placeholder = '',
    emptyText = '',
    toggleLabel = '',
    loading = false,
    uppercase = false,
    maxlength,
  }: {
    value?: string; options: readonly Suggestion[]; id: string; placeholder?: string; emptyText?: string; toggleLabel?: string; loading?: boolean;
    uppercase?: boolean; maxlength?: number;
  } = $props();

  let open = $state(false);
  let typed = $state(false);
  let active = $state(0);
  let input = $state<HTMLInputElement>();
  let list = $state<HTMLUListElement>();

  /** Chưa gõ (mới mở, hoặc ô đang là một gợi ý) thì hiện cả danh sách; gõ thì lọc theo số / nhãn / dòng phụ (không dấu). */
  const results = $derived.by(() => {
    if (!open) return [];
    const text = typed ? foldText(value) : '';
    if (!text) return options;
    return options.filter((option) => foldText(`${option.value} ${option.label ?? ''} ${option.detail ?? ''}`).includes(text));
  });

  function openList() {
    open = true;
    typed = false;
    active = Math.max(0, options.findIndex((option) => option.value === value));
  }
  function close() {
    open = false;
    typed = false;
  }
  function choose(option: Suggestion | undefined) {
    if (!option) return;
    value = option.value;
    close();
  }
  async function keydown(event: KeyboardEvent) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) openList();
      const size = results.length;
      if (!size) return;
      active = (active + (event.key === 'ArrowDown' ? 1 : size - 1)) % size;
      await tick();
      list?.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
    } else if (event.key === 'Enter') {
      if (!open || !results.length) return;
      event.preventDefault();
      choose(results[active]);
    } else if (event.key === 'Escape') {
      if (open) event.preventDefault();
      close();
    }
  }
</script>

<div class="suggest" class:open>
  <input
    {id}
    bind:this={input}
    {value}
    {placeholder}
    {maxlength}
    autocomplete="off"
    spellcheck="false"
    role="combobox"
    aria-expanded={open}
    aria-controls={`${id}-list`}
    aria-autocomplete="list"
    onfocus={openList}
    oninput={(event) => { value = uppercase ? event.currentTarget.value.toUpperCase() : event.currentTarget.value; typed = true; open = true; active = 0; }}
    onkeydown={keydown}
    onblur={close}
  />
  <button type="button" class="toggle" tabindex="-1" aria-label={toggleLabel}
    onmousedown={(event) => { event.preventDefault(); if (open) close(); else { input?.focus(); openList(); } }}><ChevronDown size={16} /></button>
  {#if open}
    <ul id={`${id}-list`} bind:this={list} role="listbox">
      {#each results as option, position (option.value)}
        <li role="option" aria-selected={option.value === value} class:active={position === active} class:current={option.value === value} class:muted={option.muted}
          onmousedown={(event) => { event.preventDefault(); choose(option); }} onmousemove={() => (active = position)}>
          <span class="name"><b>{option.value}</b>{option.label ? ` — ${option.label}` : ''}{#if option.note}<em>{option.note}</em>{/if}</span>
          {#if option.detail}<small>{option.detail}</small>{/if}
        </li>
      {:else}
        {#if loading || emptyText}<li class="empty" role="presentation">{loading ? '…' : emptyText}</li>{/if}
      {/each}
    </ul>
  {/if}
</div>

<style>
  .suggest { position: relative; }
  .suggest input { width: 100%; padding-right: 36px; text-overflow: ellipsis; }
  .toggle { position: absolute; top: 0; right: 0; display: grid; width: 36px; height: 100%; place-items: center; border: 0; background: transparent; color: var(--muted); cursor: pointer; }
  .open .toggle { color: var(--navy); }
  ul { position: absolute; z-index: 30; top: calc(100% + 4px); left: 0; right: 0; max-height: 300px; margin: 0; padding: 4px; overflow: auto; list-style: none; border: 1px solid var(--line); border-radius: 10px; background: var(--surface); box-shadow: 0 14px 32px rgba(18, 59, 94, 0.16); }
  li { display: grid; gap: 1px; padding: 7px 10px; border-radius: 7px; cursor: pointer; }
  li.active { background: var(--blue-soft, #e8f0fa); }
  li.current .name { color: var(--navy); }
  li .name { overflow: hidden; color: var(--text); font-size: 13.5px; text-overflow: ellipsis; white-space: nowrap; }
  li.muted .name { color: var(--muted); }
  li em { margin-left: 6px; color: var(--amber); font-size: 12px; font-style: normal; }
  li small { color: var(--muted); font-size: 12px; }
  li.empty { color: var(--muted); cursor: default; }
</style>
