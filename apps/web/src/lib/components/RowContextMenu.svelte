<script lang="ts" module>
  import type { Copy } from 'lucide-svelte';

  export interface ContextMenuItem {
    label: string;
    icon?: typeof Copy;
    danger?: boolean;
    disabled?: boolean;
    action: () => void;
  }
</script>

<script lang="ts">
  /**
   * Menu chuột phải trên dòng bảng (SAL-CTX-01): hiện tại vị trí chuột, kẹp trong khung nhìn. ↑ / ↓ / Home / End chọn mục,
   * Enter làm, Esc / Tab / bấm ra ngoài / lăn chuột / đổi kích thước thì đóng; đóng bằng phím thì trả focus về chỗ đã mở.
   * Không đóng theo sự kiện `scroll`: trình duyệt tự cuộn ô đang chọn vào khung nhìn ngay lúc bấm chuột phải.
   */
  import { tick } from 'svelte';

  let { open = $bindable(false), x = 0, y = 0, label, items }: { open?: boolean; x?: number; y?: number; label: string; items: ContextMenuItem[] } = $props();

  let menu = $state<HTMLUListElement>();
  let left = $state(0);
  let top = $state(0);
  let opener: Element | null = null;

  const buttons = () => [...(menu?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];

  function close(restoreFocus: boolean) {
    open = false;
    if (restoreFocus && opener instanceof HTMLElement) opener.focus();
  }

  $effect(() => {
    if (!open) return;
    opener = document.activeElement;
    left = x;
    top = y;
    void tick().then(() => {
      if (!menu) return;
      const rect = menu.getBoundingClientRect();
      left = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8));
      top = Math.max(8, Math.min(y, window.innerHeight - rect.height - 8));
      buttons()[0]?.focus();
    });
    const outside = (event: Event) => {
      if (!menu?.contains(event.target as Node)) close(false);
    };
    const dismiss = () => close(false);
    // Bắt ở pha capture: lăn chuột trong khung bảng cũng đóng menu.
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('wheel', dismiss, { capture: true, passive: true });
    window.addEventListener('resize', dismiss);
    window.addEventListener('blur', dismiss);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('wheel', dismiss, { capture: true });
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('blur', dismiss);
    };
  });

  function onkeydown(event: KeyboardEvent) {
    const list = buttons();
    const index = list.indexOf(document.activeElement as HTMLButtonElement);
    const focus = (next: number) => list[(next + list.length) % list.length]?.focus();
    if (event.key === 'Escape') close(true);
    else if (event.key === 'Tab') close(true);
    else if (event.key === 'ArrowDown') focus(index + 1);
    else if (event.key === 'ArrowUp') focus(index - 1);
    else if (event.key === 'Home') focus(0);
    else if (event.key === 'End') focus(list.length - 1);
    else return;
    event.preventDefault();
  }

  function run(item: ContextMenuItem) {
    close(false);
    item.action();
  }
</script>

{#if open}
  <ul bind:this={menu} class="context-menu" role="menu" aria-label={label} style:left={`${left}px`} style:top={`${top}px`} {onkeydown} oncontextmenu={(event) => event.preventDefault()}>
    {#each items as item (item.label)}
      <li role="none">
        <button type="button" role="menuitem" class:danger={item.danger} disabled={item.disabled} onclick={() => run(item)}>
          {#if item.icon}<item.icon size={15} aria-hidden="true" />{/if}<span>{item.label}</span>
        </button>
      </li>
    {/each}
  </ul>
{/if}

<style>
  .context-menu { position: fixed; z-index: 60; min-width: 230px; margin: 0; padding: 5px; border: 1px solid var(--line); border-radius: 10px; background: var(--surface); box-shadow: 0 12px 30px rgba(18, 59, 94, 0.15); list-style: none; }
  button { display: flex; align-items: center; gap: 9px; width: 100%; padding: 8px 10px; border: 0; border-radius: 7px; background: transparent; color: var(--text); font: inherit; font-size: 13.5px; text-align: left; cursor: pointer; }
  button :global(svg) { flex: none; color: var(--muted); }
  button:hover:not(:disabled), button:focus-visible { outline: none; background: var(--blue-soft); color: var(--navy); }
  button.danger { color: var(--red); }
  button.danger :global(svg) { color: var(--red); }
  button.danger:hover:not(:disabled), button.danger:focus-visible { background: var(--red-soft); color: var(--red); }
  button:disabled { color: var(--subtle); cursor: default; }
</style>
