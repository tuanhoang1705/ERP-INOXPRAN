<script lang="ts" module>
  export interface RecordTab {
    id: string;
    label: string;
    /** Số hiển thị cạnh tên tab (VD số file đính kèm). */
    badge?: number | string | undefined;
    hidden?: boolean | undefined;
  }
</script>

<script lang="ts">
  /**
   * Cửa sổ chứng từ / hồ sơ theo mẫu hệ thống của công ty mẹ: thanh công cụ (Mới · Sao chép · Lưu · Hủy thay đổi ·
   * In · Xóa), nút bản ghi đầu / trước / sau / cuối theo danh sách đang mở (record-nav), các tab, cảnh báo khi rời
   * trang còn thay đổi chưa lưu, phím tắt Ctrl+S (lưu) và Alt+← / Alt+→ (bản ghi trước / sau).
   */
  import type { Snippet } from 'svelte';
  import { onMount } from 'svelte';
  import { beforeNavigate, goto } from '$app/navigation';
  import { page } from '$app/state';
  import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Copy, FilePlus2, History, Paperclip, Printer, Save, Trash2, Undo2 } from 'lucide-svelte';
  import { m } from '$lib/paraglide/messages';
  import { neighbor, recordPosition } from '$lib/record-nav';
  import { openWorkspaceTab } from '$lib/workspace.svelte';

  let {
    title,
    subtitle = '',
    crumbs = [],
    listKey = '',
    recordId = '',
    detailHref,
    dirty = false,
    saving = false,
    tabs = [],
    tab = $bindable(''),
    onsave,
    onreset,
    onnew,
    oncopy,
    ondelete,
    onprint,
    badges,
    extra,
    children,
  }: {
    title: string;
    subtitle?: string;
    crumbs?: Array<{ href: string; label: string }>;
    /** Khóa danh sách trong record-nav (products, dealers…) để đi bản ghi trước / sau. */
    listKey?: string;
    recordId?: string;
    detailHref?: (id: string) => string;
    dirty?: boolean;
    saving?: boolean;
    tabs?: RecordTab[];
    tab?: string;
    onsave?: (() => void | Promise<void>) | undefined;
    onreset?: (() => void) | undefined;
    onnew?: (() => void) | undefined;
    oncopy?: (() => void) | undefined;
    ondelete?: (() => void) | undefined;
    onprint?: (() => void) | undefined;
    badges?: Snippet;
    extra?: Snippet;
    children: Snippet<[string]>;
  } = $props();

  const visibleTabs = $derived(tabs.filter((item) => !item.hidden));
  const position = $derived(listKey && recordId ? recordPosition(listKey, recordId) : null);
  const hasTab = (id: string) => visibleTabs.some((item) => item.id === id);
  let navigating = $state(false);

  // Tab đang chọn giữ trong #hash để tải lại trang vẫn đúng tab.
  onMount(() => {
    const fromHash = decodeURIComponent(window.location.hash.slice(1));
    if (fromHash && hasTab(fromHash)) tab = fromHash;
    else if (!tab || !hasTab(tab)) tab = visibleTabs[0]?.id ?? '';
  });
  function selectTab(id: string) {
    tab = id;
    history.replaceState(history.state, '', `${page.url.pathname}${page.url.search}#${encodeURIComponent(id)}`);
  }

  $effect(() => {
    if (title) openWorkspaceTab(page.url.pathname, title);
  });

  beforeNavigate((navigation) => {
    if (!dirty || saving) return;
    // Đóng / tải lại tab trình duyệt: cancel() để trình duyệt hiện hộp xác nhận của chính nó.
    if (navigation.type === 'leave') {
      navigation.cancel();
      return;
    }
    if (!confirm(m.rw_chua_luu_roi_trang())) navigation.cancel();
  });

  async function go(which: 'first' | 'prev' | 'next' | 'last') {
    if (!listKey || !recordId || !detailHref || navigating) return;
    navigating = true;
    try {
      const target = await neighbor(listKey, recordId, which);
      if (target) await goto(`${detailHref(target)}${tab ? `#${encodeURIComponent(tab)}` : ''}`);
    } finally {
      navigating = false;
    }
  }

  function keydown(event: KeyboardEvent) {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      if (onsave && dirty && !saving) void onsave();
      return;
    }
    if (event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      event.preventDefault();
      void go(event.key === 'ArrowLeft' ? 'prev' : 'next');
    }
  }

  const atStart = $derived(!position || position.index <= 0);
  const atEnd = $derived(!position || position.index >= position.total - 1);
</script>

<svelte:window onkeydown={keydown} />

<section class="page-head record-head">
  <div>
    {#if crumbs.length}
      <nav class="crumbs" aria-label={m.duong_dan()}>
        {#each crumbs as crumb, index}{#if index === 0}<a href={crumb.href}>{crumb.label}</a>{:else}<span><a href={crumb.href}>{crumb.label}</a></span>{/if}{/each}
        <span>{title}</span>
      </nav>
    {/if}
    <h1 class="page-title">{title}{#if dirty}<span class="dirty" title={m.rw_co_thay_doi()}>•</span>{/if}</h1>
    {#if subtitle || badges}<p class="page-sub">{#if badges}{@render badges()}{/if}{subtitle}</p>{/if}
  </div>
</section>

<div class="toolbar card no-print" role="toolbar" aria-label={m.rw_thanh_cong_cu()}>
  <div class="group">
    {#if onnew}<button class="tool" onclick={onnew}><FilePlus2 size={16} /><span>{m.rw_moi()}</span></button>{/if}
    {#if oncopy}<button class="tool" onclick={oncopy}><Copy size={16} /><span>{m.rw_sao_chep()}</span></button>{/if}
    {#if onsave}<button class="tool primary" onclick={() => onsave?.()} disabled={!dirty || saving} title="Ctrl+S"><Save size={16} /><span>{saving ? m.kh_dang_luu() : m.crud_luu()}</span></button>{/if}
    {#if onreset}<button class="tool" onclick={onreset} disabled={!dirty || saving}><Undo2 size={16} /><span>{m.rw_huy_thay_doi()}</span></button>{/if}
    <button class="tool" onclick={() => (onprint ? onprint() : window.print())}><Printer size={16} /><span>{m.rw_in()}</span></button>
    {#if ondelete}<button class="tool danger" onclick={ondelete}><Trash2 size={16} /><span>{m.crud_xoa()}</span></button>{/if}
    {#if hasTab('attachments')}<button class="tool" onclick={() => selectTab('attachments')}><Paperclip size={16} /><span>{m.rw_dinh_kem()}</span></button>{/if}
    {#if hasTab('history')}<button class="tool" onclick={() => selectTab('history')}><History size={16} /><span>{m.rw_lich_su()}</span></button>{/if}
    {#if extra}{@render extra()}{/if}
  </div>
  {#if listKey}
    <div class="group nav" aria-label={m.rw_dieu_huong()}>
      <button class="tool icon" onclick={() => go('first')} disabled={atStart || navigating} title={m.rw_dau()} aria-label={m.rw_dau()}><ChevronsLeft size={16} /></button>
      <button class="tool icon" onclick={() => go('prev')} disabled={atStart || navigating} title={`${m.rw_truoc()} (Alt+←)`} aria-label={m.rw_truoc()}><ChevronLeft size={16} /></button>
      <span class="pos">{position ? `${position.index + 1} / ${position.total}` : '—'}</span>
      <button class="tool icon" onclick={() => go('next')} disabled={atEnd || navigating} title={`${m.rw_sau()} (Alt+→)`} aria-label={m.rw_sau()}><ChevronRight size={16} /></button>
      <button class="tool icon" onclick={() => go('last')} disabled={atEnd || navigating} title={m.rw_cuoi()} aria-label={m.rw_cuoi()}><ChevronsRight size={16} /></button>
    </div>
  {/if}
</div>

{#if visibleTabs.length > 1}
  <div class="tabs no-print" role="tablist">
    {#each visibleTabs as item (item.id)}
      <button role="tab" id={`tab-${item.id}`} aria-selected={tab === item.id} class:active={tab === item.id} onclick={() => selectTab(item.id)}>
        {item.label}{#if item.badge !== undefined && item.badge !== 0 && item.badge !== ''}<b>{item.badge}</b>{/if}
      </button>
    {/each}
  </div>
{/if}

<div class="record-body" role="tabpanel" aria-labelledby={tab ? `tab-${tab}` : undefined}>
  {@render children(tab)}
</div>

<style>
  .record-head { margin-bottom: 12px; }
  .dirty { margin-left: 8px; color: var(--orange); }
  .page-sub { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  .toolbar { position: sticky; top: calc(var(--topbar) + 6px); z-index: 20; display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 14px; padding: 6px 8px; }
  .group { display: flex; flex-wrap: wrap; align-items: center; gap: 2px; }
  .tool { display: inline-flex; align-items: center; gap: 6px; min-height: 34px; padding: 0 10px; border-radius: 7px; color: var(--text); font-size: 13px; font-weight: 600; }
  .tool:hover:not(:disabled) { background: var(--surface-2); color: var(--navy); }
  .tool:disabled { opacity: 0.45; cursor: not-allowed; }
  .tool.primary:not(:disabled) { background: var(--orange); color: #fff; }
  .tool.primary:hover:not(:disabled) { background: var(--orange-hover); color: #fff; }
  .tool.danger:hover:not(:disabled) { background: var(--red-soft); color: var(--red); }
  .tool.icon { width: 34px; justify-content: center; padding: 0; }
  .pos { min-width: 70px; color: var(--muted); font-size: 12.5px; text-align: center; font-variant-numeric: tabular-nums; }
  .tabs { display: flex; gap: 4px; margin-bottom: 14px; overflow-x: auto; border-bottom: 1px solid var(--line); scrollbar-width: thin; }
  .tabs button { flex: none; display: inline-flex; align-items: center; gap: 6px; padding: 9px 14px; border-bottom: 2px solid transparent; color: var(--muted); font-size: 13.5px; font-weight: 600; white-space: nowrap; }
  .tabs button:hover { color: var(--navy); }
  .tabs button.active { border-color: var(--orange); color: var(--navy); }
  .tabs b { padding: 0 7px; border-radius: 999px; background: var(--surface-2); color: var(--text); font-size: 11.5px; }
  @media (max-width: 720px) {
    .tool span { display: none; }
    .tool { padding: 0 9px; }
  }
</style>
