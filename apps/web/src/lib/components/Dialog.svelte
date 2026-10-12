<script lang="ts">
  import { m } from '$lib/paraglide/messages';
  /** Hộp thoại modal dùng thẻ <dialog> gốc (Esc để đóng, khóa nền). */
  import type { Snippet } from 'svelte';
  import { X } from 'lucide-svelte';

  let { open = $bindable(false), title, wide = false, children, footer }: { open?: boolean; title: string; wide?: boolean; children: Snippet; footer?: Snippet } = $props();
  let element = $state<HTMLDialogElement>();

  $effect(() => {
    if (!element) return;
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
  });
</script>

<dialog bind:this={element} class:wide onclose={() => (open = false)} aria-label={title}>
  <header><h2>{title}</h2><button class="close" onclick={() => (open = false)} aria-label={m.dong()}><X size={18} /></button></header>
  <div class="body">{@render children()}</div>
  {#if footer}<footer>{@render footer()}</footer>{/if}
</dialog>

<style>
  dialog { width: min(560px, calc(100vw - 32px)); padding: 0; border: 0; border-radius: 12px; background: var(--surface); color: var(--text); box-shadow: 0 24px 60px rgba(18, 59, 94, 0.25); }
  dialog.wide { width: min(760px, calc(100vw - 32px)); }
  dialog::backdrop { background: rgba(18, 39, 58, 0.45); }
  header { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 18px 22px; border-bottom: 1px solid var(--line-soft); }
  h2 { margin: 0; font-size: 16px; font-weight: 700; }
  .close { display: grid; width: 30px; height: 30px; place-items: center; border-radius: 50%; color: var(--muted); }
  .close:hover { background: var(--surface-2); }
  .body { display: grid; gap: 14px; padding: 20px 22px; }
  footer { display: flex; justify-content: flex-end; gap: 10px; padding: 14px 22px 18px; border-top: 1px solid var(--line-soft); }
</style>
