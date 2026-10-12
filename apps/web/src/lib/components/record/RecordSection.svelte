<script lang="ts">
  /** Một mục thu gọn được trong cửa sổ chứng từ ("Thông tin chính ⊟"); trạng thái mở / gọn nhớ theo phiên. */
  import type { Snippet } from 'svelte';
  import { ChevronDown } from 'lucide-svelte';

  let { id, title, note = '', children, actions }: { id: string; title: string; note?: string; children: Snippet; actions?: Snippet } = $props();

  const key = $derived(`erp:section:${id}`);
  let open = $state(true);
  $effect(() => {
    try {
      open = sessionStorage.getItem(key) !== 'closed';
    } catch {
      open = true;
    }
  });
  function toggle() {
    open = !open;
    try {
      sessionStorage.setItem(key, open ? 'open' : 'closed');
    } catch {
      // bỏ qua
    }
  }
</script>

<section class="card section" class:closed={!open}>
  <header>
    <button class="toggle" aria-expanded={open} aria-controls={`section-${id}`} onclick={toggle}>
      <ChevronDown size={16} class="chev" />
      <h2>{title}</h2>
      {#if note}<small>{note}</small>{/if}
    </button>
    {#if actions && open}<div class="head-actions">{@render actions()}</div>{/if}
  </header>
  {#if open}<div class="content" id={`section-${id}`}>{@render children()}</div>{/if}
</section>

<style>
  .section { margin-bottom: 14px; }
  header { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 12px 16px; }
  .section:not(.closed) header { border-bottom: 1px solid var(--line-soft); }
  .toggle { display: flex; align-items: center; gap: 8px; min-width: 0; padding: 0; text-align: left; }
  .toggle :global(.chev) { flex: none; color: var(--muted); transition: transform 120ms ease; }
  .closed .toggle :global(.chev) { transform: rotate(-90deg); }
  h2 { margin: 0; font-size: 14.5px; font-weight: 700; }
  small { color: var(--subtle); font-size: 12px; }
  .head-actions { display: flex; gap: 8px; }
  .content { padding: 16px; }
  @media print { .content { display: block !important; } }
</style>
