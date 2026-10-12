<script lang="ts">
  /** Thanh tab các chứng từ / hồ sơ đang mở, đặt trên cùng vùng nội dung. */
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { X } from 'lucide-svelte';
  import { m } from '$lib/paraglide/messages';
  import { closeAllWorkspaceTabs, closeWorkspaceTab, workspace } from '$lib/workspace.svelte';

  const current = $derived(page.url.pathname);

  async function close(href: string) {
    const isCurrent = href === current;
    const next = closeWorkspaceTab(href);
    if (isCurrent) await goto(next?.href ?? href.replace(/\/[^/]+$/, ''));
  }
</script>

{#if workspace.tabs.length}
  <nav class="workspace no-print" aria-label={m.rw_dang_mo()}>
    <ul>
      {#each workspace.tabs as tab (tab.href)}
        <li class:active={tab.href === current}>
          <a href={tab.href} aria-current={tab.href === current ? 'page' : undefined} title={tab.title}>{tab.title}</a>
          <button class="close" aria-label={`${m.dong()} ${tab.title}`} title={m.dong()} onclick={() => close(tab.href)}><X size={13} /></button>
        </li>
      {/each}
    </ul>
    {#if workspace.tabs.length > 1}<button class="clear" onclick={closeAllWorkspaceTabs}>{m.rw_dong_tat_ca()}</button>{/if}
  </nav>
{/if}

<style>
  .workspace { display: flex; align-items: flex-end; gap: 8px; margin: -6px 0 16px; border-bottom: 1px solid var(--line); }
  ul { display: flex; gap: 4px; min-width: 0; margin: 0; padding: 0; overflow-x: auto; list-style: none; scrollbar-width: thin; }
  li { display: flex; flex: none; align-items: center; max-width: 220px; border: 1px solid var(--line); border-bottom: 0; border-radius: 8px 8px 0 0; background: var(--surface-2); }
  li.active { position: relative; top: 1px; background: var(--surface); }
  li.active a { color: var(--navy); font-weight: 600; }
  a { overflow: hidden; padding: 7px 4px 7px 12px; color: var(--muted); font-size: 12.5px; text-overflow: ellipsis; white-space: nowrap; }
  a:hover { color: var(--navy); }
  .close { display: grid; width: 22px; height: 22px; margin-right: 4px; place-items: center; border-radius: 50%; color: var(--subtle); }
  .close:hover { background: var(--line-soft); color: var(--red); }
  .clear { flex: none; margin-bottom: 6px; padding: 2px 6px; color: var(--subtle); font-size: 12px; }
  .clear:hover { color: var(--navy); text-decoration: underline; }
</style>
