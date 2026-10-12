<script lang="ts">
  /**
   * Tìm chức năng (NAV-02): nút nổi góc phải dưới hoặc Ctrl/Cmd+K → gõ tên chức năng (có dấu hay không) → Enter để mở.
   * Chỉ hiện chức năng người dùng được dùng (cùng quy tắc menu). Mục mở gần đây lưu trên trình duyệt.
   */
  import { m } from '$lib/paraglide/messages';
  import { goto } from '$app/navigation';
  import { tick } from 'svelte';
  import { CornerDownLeft, Search } from 'lucide-svelte';
  import { sections } from '$lib/nav';
  import { session } from '$lib/session.svelte';
  import { buildCommands, quickActions, searchCommands, visibleCommands, type CommandItem } from '$lib/command-search';

  const RECENT_KEY = 'erp.cmd.recent';
  let open = $state(false);
  let query = $state('');
  let active = $state(0);
  let input = $state<HTMLInputElement>();
  let dialog = $state<HTMLDialogElement>();
  let list = $state<HTMLUListElement>();
  let recent = $state<string[]>([]);

  const commands = $derived(visibleCommands(buildCommands(sections, quickActions()), session.user));
  const results = $derived.by<CommandItem[]>(() => {
    if (query.trim()) return searchCommands(commands, query);
    const byHref = new Map(commands.map((item) => [item.href, item]));
    const recentItems = recent.map((href) => byHref.get(href)).filter((item): item is CommandItem => Boolean(item));
    return recentItems.length ? recentItems : commands.slice(0, 8);
  });
  const heading = $derived(query.trim() ? m.cmd_tat_ca() : recent.length ? m.cmd_gan_day() : m.cmd_tat_ca());

  function readRecent(): string[] {
    try {
      const value = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as unknown;
      return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').slice(0, 6) : [];
    } catch {
      return [];
    }
  }
  async function show() {
    recent = readRecent();
    query = '';
    active = 0;
    open = true;
    dialog?.showModal();
    await tick();
    input?.focus();
  }
  function hide() {
    open = false;
    if (dialog?.open) dialog.close();
  }
  async function choose(item: CommandItem | undefined) {
    if (!item) return;
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify([item.href, ...readRecent().filter((href) => href !== item.href)].slice(0, 6)));
    } catch {
      // Trình duyệt chặn lưu trữ: bỏ qua mục gần đây.
    }
    hide();
    await goto(item.href);
  }
  function globalKey(event: KeyboardEvent) {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k' && session.user) {
      event.preventDefault();
      // Dựa vào trạng thái thật của <dialog>: sự kiện close đến sau một nhịp, bấm Esc rồi Ctrl+K ngay vẫn phải mở.
      if (dialog?.open) hide();
      else void show();
    }
  }
  async function keydown(event: KeyboardEvent) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const size = results.length;
      if (!size) return;
      active = (active + (event.key === 'ArrowDown' ? 1 : size - 1)) % size;
      await tick();
      list?.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
    } else if (event.key === 'Enter') {
      event.preventDefault();
      void choose(results[active]);
    }
  }
</script>

<svelte:window onkeydown={globalKey} />

{#if session.user}
  <button class="cmd-fab no-print" title={m.cmd_tim_chuc_nang()} aria-label={m.cmd_tim_chuc_nang()} onclick={show}><Search size={22} /></button>
{/if}

<dialog bind:this={dialog} class="cmd" aria-label={m.cmd_tim_chuc_nang()} onclose={() => (open = false)} onclick={(event) => { if (event.target === dialog) hide(); }}>
  <div class="search">
    <Search size={18} />
    <input bind:this={input} bind:value={query} placeholder={m.cmd_placeholder()} oninput={() => (active = 0)} onkeydown={keydown} autocomplete="off" aria-label={m.cmd_tim_chuc_nang()} role="combobox" aria-expanded="true" aria-controls="cmd-results" />
    <kbd>Esc</kbd>
  </div>
  <p class="heading">{heading}</p>
  <ul id="cmd-results" bind:this={list} role="listbox">
    {#each results as item, position (item.href)}
      <li role="option" aria-selected={position === active}>
        <button class:active={position === active} onclick={() => choose(item)} onmousemove={() => (active = position)}>
          <span><b>{item.label}</b><small>{item.path}</small></span>
          {#if position === active}<CornerDownLeft size={15} />{/if}
        </button>
      </li>
    {/each}
  </ul>
  {#if !results.length}<p class="empty">{m.cmd_khong_thay()}</p>{/if}
  <footer>{m.cmd_huong_dan()}</footer>
</dialog>

<style>
  .cmd-fab {
    position: fixed; right: 22px; bottom: 22px; z-index: 50;
    display: grid; width: 52px; height: 52px; place-items: center;
    border: 0; border-radius: 50%; background: var(--navy); color: #fff;
    box-shadow: 0 10px 24px rgba(18, 59, 94, 0.35); cursor: pointer;
  }
  .cmd-fab:hover { background: var(--orange); }
  .cmd-fab:focus-visible { outline: 3px solid var(--orange-soft); outline-offset: 2px; }
  .cmd { width: min(620px, calc(100vw - 24px)); max-height: min(560px, calc(100vh - 80px)); margin-top: 12vh; padding: 0; border: 0; border-radius: 14px; background: var(--surface); color: var(--text); box-shadow: 0 24px 60px rgba(18, 59, 94, 0.3); }
  .cmd[open] { display: flex; flex-direction: column; }
  .cmd::backdrop { background: rgba(18, 39, 58, 0.45); }
  .search { display: flex; align-items: center; gap: 10px; padding: 14px 16px; border-bottom: 1px solid var(--line-soft); color: var(--muted); }
  .search input { flex: 1; min-width: 0; border: 0; outline: 0; background: transparent; color: var(--text); font-size: 16px; }
  kbd { padding: 2px 6px; border: 1px solid var(--line); border-radius: 5px; color: var(--muted); font-size: 11px; }
  .heading { margin: 10px 16px 4px; color: var(--subtle); font-size: 11.5px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; }
  ul { flex: 1; margin: 0; padding: 4px 8px 8px; overflow: auto; list-style: none; }
  li button { display: flex; width: 100%; align-items: center; justify-content: space-between; gap: 10px; padding: 9px 10px; border: 0; border-radius: 8px; background: transparent; color: var(--text); text-align: left; cursor: pointer; }
  li button span { display: grid; gap: 2px; min-width: 0; }
  li button small { color: var(--muted); font-size: 12px; }
  li button.active { background: var(--blue-soft, #e8f0fa); color: var(--navy); }
  .empty { margin: 8px 16px 16px; color: var(--muted); }
  footer { padding: 9px 16px; border-top: 1px solid var(--line-soft); color: var(--subtle); font-size: 12px; }
  @media (max-width: 720px) {
    .cmd-fab { right: 14px; bottom: 16px; width: 48px; height: 48px; }
    .cmd { margin-top: 6vh; }
  }
  @media print { .cmd-fab { display: none; } }
</style>
