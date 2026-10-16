<script lang="ts">
  /**
   * Tìm chức năng (NAV-02): thanh tìm kiếm luôn hiện ở góc phải dưới (thay nút tròn, 15/10/2026) — bấm vào hoặc Ctrl/Cmd+K,
   * gõ tên chức năng (có dấu hay không) → danh sách mở lên phía trên → Enter để mở. Chỉ hiện chức năng người dùng được dùng
   * (cùng quy tắc menu). Mục mở gần đây lưu trên trình duyệt.
   */
  import { m } from '$lib/paraglide/messages';
  import { goto } from '$app/navigation';
  import { tick } from 'svelte';
  import { CornerDownLeft, Search, X } from 'lucide-svelte';
  import { sections } from '$lib/nav';
  import { session } from '$lib/session.svelte';
  import { buildCommands, quickActions, searchCommands, visibleCommands, type CommandItem } from '$lib/command-search';

  const RECENT_KEY = 'erp.cmd.recent';
  let expanded = $state(false);
  let query = $state('');
  let active = $state(0);
  let input = $state<HTMLInputElement>();
  let root = $state<HTMLDivElement>();
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
  function openPanel() {
    if (expanded) return;
    recent = readRecent();
    active = 0;
    expanded = true;
  }
  function close(clear = false) {
    expanded = false;
    if (clear) query = '';
  }
  async function choose(item: CommandItem | undefined) {
    if (!item) return;
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify([item.href, ...readRecent().filter((href) => href !== item.href)].slice(0, 6)));
    } catch {
      // Trình duyệt chặn lưu trữ: bỏ qua mục gần đây.
    }
    close(true);
    input?.blur();
    await goto(item.href);
  }
  async function globalKey(event: KeyboardEvent) {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k' && session.user) {
      event.preventDefault();
      if (expanded && document.activeElement === input) {
        close();
        input?.blur();
        return;
      }
      openPanel();
      await tick();
      input?.focus();
      input?.select();
    }
  }
  async function keydown(event: KeyboardEvent) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      openPanel();
      const size = results.length;
      if (!size) return;
      active = (active + (event.key === 'ArrowDown' ? 1 : size - 1)) % size;
      await tick();
      list?.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
    } else if (event.key === 'Enter') {
      event.preventDefault();
      void choose(results[active]);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      if (query) query = '';
      else {
        close();
        input?.blur();
      }
    }
  }
  /** Rời khỏi thanh (bấm ra ngoài / Tab đi) thì thu danh sách lại. */
  function focusOut(event: FocusEvent) {
    const next = event.relatedTarget as Node | null;
    if (!next || !root?.contains(next)) close();
  }
</script>

<svelte:window onkeydown={globalKey} />

{#if session.user}
  <div class="cmd-bar no-print" class:open={expanded} bind:this={root} onfocusout={focusOut}>
    {#if expanded}
      <div class="panel" role="presentation">
        <p class="heading">{heading}</p>
        <ul id="cmd-results" bind:this={list} role="listbox" aria-label={m.cmd_tim_chuc_nang()}>
          {#each results as item, position (item.href)}
            <li role="option" aria-selected={position === active}>
              <button type="button" tabindex="-1" class:active={position === active} onmousedown={(event) => event.preventDefault()} onclick={() => choose(item)} onmousemove={() => (active = position)}>
                <span><b>{item.label}</b><small>{item.path}</small></span>
                {#if position === active}<CornerDownLeft size={15} />{/if}
              </button>
            </li>
          {/each}
        </ul>
        {#if !results.length}<p class="empty">{m.cmd_khong_thay()}</p>{/if}
        <footer>{m.cmd_huong_dan()}</footer>
      </div>
    {/if}
    <div class="bar">
      <Search size={18} />
      <input
        bind:this={input}
        bind:value={query}
        placeholder={m.cmd_thanh_tim()}
        onfocus={openPanel}
        onclick={openPanel}
        oninput={() => { openPanel(); active = 0; }}
        onkeydown={keydown}
        autocomplete="off"
        spellcheck="false"
        aria-label={m.cmd_tim_chuc_nang()}
        role="combobox"
        aria-expanded={expanded}
        aria-controls="cmd-results"
        aria-autocomplete="list"
      />
      {#if query}
        <button type="button" class="clear" aria-label={m.cmd_xoa()} title={m.cmd_xoa()} onmousedown={(event) => event.preventDefault()} onclick={() => { query = ''; active = 0; input?.focus(); }}><X size={14} /></button>
      {:else}
        <kbd>Ctrl K</kbd>
      {/if}
    </div>
  </div>
{/if}

<style>
  .cmd-bar { position: fixed; right: 22px; bottom: 22px; z-index: 50; width: min(320px, calc(100vw - 28px)); transition: width 0.15s ease; }
  .cmd-bar.open { width: min(460px, calc(100vw - 28px)); }
  .bar {
    display: flex; align-items: center; gap: 10px; height: 48px; padding: 0 12px 0 16px;
    border: 1px solid transparent; border-radius: 999px; background: var(--navy); color: #cfe0ef;
    box-shadow: 0 10px 24px rgba(18, 59, 94, 0.35);
  }
  .cmd-bar.open .bar, .bar:focus-within { border-color: var(--navy); background: var(--surface); color: var(--muted); }
  .bar input { flex: 1; min-width: 0; height: 100%; padding: 0; border: 0; outline: 0; background: transparent; color: #fff; font-size: 14.5px; }
  .bar input::placeholder { color: #cfe0ef; }
  .cmd-bar.open .bar input, .bar:focus-within input { color: var(--text); }
  .cmd-bar.open .bar input::placeholder, .bar:focus-within input::placeholder { color: var(--subtle); }
  kbd { padding: 2px 6px; border: 1px solid rgba(255, 255, 255, 0.35); border-radius: 5px; font-size: 11px; white-space: nowrap; }
  .cmd-bar.open kbd, .bar:focus-within kbd { border-color: var(--line); color: var(--muted); }
  .clear { display: grid; width: 26px; height: 26px; place-items: center; border: 0; border-radius: 50%; background: var(--surface-2); color: var(--muted); cursor: pointer; }
  .panel {
    position: absolute; right: 0; bottom: calc(100% + 8px); display: flex; flex-direction: column; width: 100%;
    max-height: min(460px, calc(100vh - 140px)); overflow: hidden; border-radius: 14px; background: var(--surface); color: var(--text);
    box-shadow: 0 24px 60px rgba(18, 59, 94, 0.3);
  }
  .heading { margin: 12px 16px 4px; color: var(--subtle); font-size: 11.5px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; }
  ul { flex: 1; margin: 0; padding: 4px 8px 8px; overflow: auto; list-style: none; }
  li button { display: flex; width: 100%; align-items: center; justify-content: space-between; gap: 10px; padding: 9px 10px; border: 0; border-radius: 8px; background: transparent; color: var(--text); text-align: left; cursor: pointer; }
  li button span { display: grid; gap: 2px; min-width: 0; }
  li button small { color: var(--muted); font-size: 12px; }
  li button.active { background: var(--blue-soft, #e8f0fa); color: var(--navy); }
  .empty { margin: 8px 16px 16px; color: var(--muted); }
  footer { padding: 9px 16px; border-top: 1px solid var(--line-soft); color: var(--subtle); font-size: 12px; }
  @media (max-width: 720px) {
    .cmd-bar { right: 14px; bottom: 14px; width: min(230px, calc(100vw - 28px)); }
    .cmd-bar.open { width: calc(100vw - 28px); }
    kbd { display: none; }
  }
  @media print { .cmd-bar { display: none; } }
</style>
