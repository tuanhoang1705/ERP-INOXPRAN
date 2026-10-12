<script lang="ts">
  /** Hộp xác nhận "Bạn có muốn thực hiện hành động này không?" — nút Đồng ý được focus sẵn (Enter = đồng ý, Esc = hủy). */
  import { m } from '$lib/paraglide/messages';
  import { tick } from 'svelte';
  import Dialog from './Dialog.svelte';

  let {
    open = $bindable(false),
    title,
    message,
    confirmLabel,
    tone = 'primary',
    onconfirm,
  }: { open?: boolean; title: string; message: string; confirmLabel?: string; tone?: 'primary' | 'navy' | 'danger'; onconfirm: () => void | Promise<void> } = $props();
  let button = $state<HTMLButtonElement>();
  let busy = $state(false);

  $effect(() => {
    if (open) void tick().then(() => button?.focus());
  });
  async function confirm() {
    busy = true;
    try {
      open = false;
      await onconfirm();
    } finally {
      busy = false;
    }
  }
</script>

<Dialog bind:open {title}>
  <p class="message">{message}</p>
  {#snippet footer()}
    <button type="button" class="btn" onclick={() => (open = false)}>{m.huy()}</button>
    <button type="button" class={`btn ${tone}`} bind:this={button} disabled={busy} onclick={confirm}>{confirmLabel ?? m.kk_dong_y()}</button>
  {/snippet}
</Dialog>

<style>
  .message { margin: 0; line-height: 1.55; white-space: pre-line; }
</style>
