<script lang="ts">
  /** Thanh phân trang dùng chung cho các danh sách tải theo trang từ máy chủ. */
  import { ChevronLeft, ChevronRight } from 'lucide-svelte';
  import { m } from '$lib/paraglide/messages';
  import { num } from '$lib/format';
  import { PAGE_SIZE_OPTIONS } from '$lib/paging';

  let { page, pageSize, total, loading = false, onchange }: {
    page: number;
    pageSize: number;
    total: number;
    loading?: boolean;
    onchange: (page: number, pageSize: number) => void;
  } = $props();

  const totalPages = $derived(Math.max(1, Math.ceil(total / pageSize)));
  const from = $derived(total === 0 ? 0 : (page - 1) * pageSize + 1);
  const to = $derived(Math.min(total, page * pageSize));
  const pages = $derived.by(() => {
    const result: Array<number | '…'> = [];
    for (let index = 1; index <= totalPages; index += 1) {
      if (index === 1 || index === totalPages || Math.abs(index - page) <= 1) result.push(index);
      else if (result.at(-1) !== '…') result.push('…');
    }
    return result;
  });
</script>

<footer class="pager">
  <span>{m.pg_range({ from: num(from), to: num(to), total: num(total) })}</span>
  <div class="right">
    <label class="size">
      {m.pg_per_page()}
      <select value={pageSize} disabled={loading} onchange={(event) => onchange(1, Number(event.currentTarget.value))}>
        {#each PAGE_SIZE_OPTIONS as size}<option value={size}>{size}</option>{/each}
      </select>
    </label>
    <nav aria-label={m.phan_trang()}>
      <button disabled={page <= 1 || loading} onclick={() => onchange(page - 1, pageSize)} aria-label={m.trang_truoc()}><ChevronLeft size={15} /></button>
      {#each pages as item}
        {#if item === '…'}<span>…</span>{:else}<button class:current={item === page} disabled={loading} onclick={() => onchange(item, pageSize)}>{item}</button>{/if}
      {/each}
      <button disabled={page >= totalPages || loading} onclick={() => onchange(page + 1, pageSize)} aria-label={m.trang_sau()}><ChevronRight size={15} /></button>
    </nav>
  </div>
</footer>

<style>
  .pager { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 20px; border-top: 1px solid var(--line-soft); color: var(--muted); font-size: 13px; }
  .right { display: flex; align-items: center; gap: 16px; }
  .size { display: flex; align-items: center; gap: 8px; }
  .size select { min-height: 30px; padding: 2px 8px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface); color: var(--text); font: inherit; }
  nav { display: flex; align-items: center; gap: 4px; }
  nav button { display: grid; min-width: 28px; height: 28px; place-items: center; padding: 0 6px; border-radius: 6px; color: var(--muted); }
  nav button:hover:not(:disabled) { background: var(--surface-2); }
  nav button.current { background: var(--navy); color: #fff; font-weight: 700; }
  nav button:disabled { opacity: 0.4; cursor: default; }
  @media (max-width: 720px) { .pager, .right { flex-direction: column; align-items: stretch; } }
</style>
