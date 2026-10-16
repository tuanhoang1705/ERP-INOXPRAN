<script lang="ts" generics="T extends CustomerOption">
  /**
   * Ô chọn người mua (phiếu BH) / khách trả hàng / nhà cung cấp (phiếu trả hàng): gõ số điện thoại / mã / tên (không dấu) để lọc,
   * hoặc bấm mũi tên mở cả danh sách như ô chọn cũ. ↑↓ chọn, Enter lấy, Esc đóng. Khi không gõ, ô hiện đối tác đang chọn.
   */
  import { m } from '$lib/paraglide/messages';
  import { tick } from 'svelte';
  import { ChevronDown } from 'lucide-svelte';
  import { customerLabel, searchCustomers, type CustomerOption } from '$lib/customer-search';

  let {
    options,
    value = '',
    onchoose,
    id = 'customer',
    disabled = false,
    loading = false,
    placeholder = m.kh_tim_nguoi_mua(),
    emptyText = m.kh_khong_tim_thay_nguoi_mua(),
    invalid = false,
  }: {
    options: readonly T[]; value?: string; onchoose: (id: string) => void; id?: string; disabled?: boolean; loading?: boolean;
    placeholder?: string; emptyText?: string; invalid?: boolean;
  } = $props();

  let query = $state('');
  let typing = $state(false);
  let open = $state(false);
  let active = $state(0);
  let input = $state<HTMLInputElement>();
  let list = $state<HTMLUListElement>();

  const selected = $derived(options.find((option) => option.id === value));
  const results = $derived(open ? searchCustomers(options, typing ? query : '', 60) : []);
  const shown = $derived(typing ? query : selected ? customerLabel(selected) : '');

  function openList() {
    if (disabled) return;
    open = true;
    active = Math.max(0, results.findIndex((option) => option.id === value));
  }
  function close() {
    open = false;
    typing = false;
    query = '';
  }
  function choose(option: T | undefined) {
    if (!option) return;
    onchoose(option.id);
    close();
    input?.blur();
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
      if (!open) return;
      event.preventDefault();
      choose(results[active]);
    } else if (event.key === 'Escape') {
      if (open) event.preventDefault();
      close();
    }
  }
</script>

<div class="picker" class:open>
  <input
    {id}
    {disabled}
    value={shown}
    placeholder={selected ? customerLabel(selected) : placeholder}
    aria-invalid={invalid}
    autocomplete="off"
    spellcheck="false"
    role="combobox"
    aria-expanded={open}
    aria-controls={`${id}-list`}
    aria-autocomplete="list"
    onfocus={(event) => { event.currentTarget.select(); openList(); }}
    oninput={(event) => { query = event.currentTarget.value; typing = true; open = true; active = 0; }}
    onkeydown={keydown}
    onblur={close}
  />
  <button type="button" class="toggle" tabindex="-1" aria-label={m.kh_mo_danh_sach()} {disabled}
    onmousedown={(event) => { event.preventDefault(); if (open) close(); else { input?.focus(); openList(); } }}><ChevronDown size={16} /></button>
  {#if open}
    <ul id={`${id}-list`} bind:this={list} role="listbox">
      {#each results as option, position (option.id)}
        <li role="option" aria-selected={option.id === value} class:active={position === active} class:current={option.id === value}
          onmousedown={(event) => { event.preventDefault(); choose(option); }} onmousemove={() => (active = position)}>
          <span class="name"><b>{option.code}</b> — {option.name}{#if option.status === 'ON_HOLD'}<em>{m.tam_khoa()}</em>{/if}</span>
          <small>{[option.phone, option.province].filter(Boolean).join(' · ') || '—'}</small>
        </li>
      {:else}
        <li class="empty" role="presentation">{loading ? m.kh_dang_tai_danh_sach() : emptyText}</li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .picker { position: relative; }
  .picker input { width: 100%; padding-right: 36px; text-overflow: ellipsis; }
  .toggle { position: absolute; top: 0; right: 0; display: grid; width: 36px; height: 100%; place-items: center; border: 0; background: transparent; color: var(--muted); cursor: pointer; }
  .open .toggle { color: var(--navy); }
  ul { position: absolute; z-index: 30; top: calc(100% + 4px); left: 0; right: 0; max-height: 320px; margin: 0; padding: 4px; overflow: auto; list-style: none; border: 1px solid var(--line); border-radius: 10px; background: var(--surface); box-shadow: 0 14px 32px rgba(18, 59, 94, 0.16); }
  li { display: grid; gap: 1px; padding: 7px 10px; border-radius: 7px; cursor: pointer; }
  li.active { background: var(--blue-soft, #e8f0fa); }
  li.current .name { color: var(--navy); }
  li .name { overflow: hidden; color: var(--text); font-size: 13.5px; text-overflow: ellipsis; white-space: nowrap; }
  li em { margin-left: 6px; color: var(--red); font-size: 12px; font-style: normal; }
  li small { color: var(--muted); font-size: 12px; }
  li.empty { color: var(--muted); cursor: default; }
</style>
