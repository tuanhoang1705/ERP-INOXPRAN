<script lang="ts">
  /**
   * Xác nhận xóa bản ghi danh mục. Máy chủ từ chối (409 *_IN_USE) khi bản ghi đã phát sinh chứng từ:
   * hiện lý do và, nếu trang truyền `ondeactivate`, cho chuyển sang "Ngừng sử dụng" ngay tại đây.
   */
  import { CircleAlert, Trash2 } from 'lucide-svelte';
  import { m } from '$lib/paraglide/messages';
  import { ApiRequestError } from '$lib/api';
  import Dialog from './Dialog.svelte';

  let { open = $bindable(false), name, ondelete, ondeactivate, onpurge }: {
    open?: boolean;
    /** Tên / mã bản ghi hiển thị trong câu hỏi. */
    name: string;
    ondelete: () => Promise<void>;
    ondeactivate?: (() => Promise<void>) | undefined;
    /** Quản trị gốc: gỡ hẳn mã chỉ có tồn đầu kỳ nhập từ Excel (CAT-PURGE-01) — hiện khi máy chủ báo "purgeable". */
    onpurge?: (() => Promise<void>) | undefined;
  } = $props();

  let busy = $state(false);
  let error = $state('');
  let inUse = $state(false);
  let purgeable = $state(false);

  $effect(() => {
    if (open) {
      error = '';
      inUse = false;
      purgeable = false;
    }
  });

  async function run(action: () => Promise<void>) {
    busy = true;
    error = '';
    try {
      await action();
      open = false;
    } catch (caught) {
      inUse = caught instanceof ApiRequestError && /_IN_USE$/.test(caught.payload.code ?? '');
      purgeable = caught instanceof ApiRequestError && Boolean((caught.payload.details as { purgeable?: boolean } | undefined)?.purgeable);
      error = caught instanceof Error ? caught.message : m.crud_loi_luu();
    } finally {
      busy = false;
    }
  }
</script>

<Dialog bind:open title={m.crud_xoa_tieu_de()}>
  <p class="question">{m.crud_xoa_hoi({ name })}</p>
  {#if error}<div class="banner error"><CircleAlert size={17} /><span>{error}</span></div>{/if}
  {#snippet footer()}
    <button type="button" class="btn" onclick={() => (open = false)}>{m.huy()}</button>
    {#if inUse && purgeable && onpurge}
      <button type="button" class="btn danger" disabled={busy} onclick={() => run(onpurge)}><Trash2 size={15} />{m.cp_go_ca_ton()}</button>
    {/if}
    {#if inUse && ondeactivate}
      <button type="button" class="btn navy" disabled={busy} onclick={() => run(ondeactivate)}>{m.crud_chuyen_ngung()}</button>
    {:else}
      <button type="button" class="btn danger" disabled={busy} onclick={() => run(ondelete)}><Trash2 size={15} />{m.crud_xoa()}</button>
    {/if}
  {/snippet}
</Dialog>

<style>
  .question { margin: 0; line-height: 1.55; }
</style>
