<script lang="ts">
  /** Tab "Lịch sử": ai sửa gì, lúc nào, giá trị trước → sau (GET /history/:type/:id, phân trang). */
  import type { HistoryEntry } from '@inoxpran/contracts';
  import { CircleAlert } from 'lucide-svelte';
  import { m } from '$lib/paraglide/messages';
  import { api } from '$lib/api';
  import { dateTime } from '$lib/format';
  import type { Paged } from '$lib/paging';
  import Pagination from '$lib/components/Pagination.svelte';

  let { type, id, fieldLabels = {}, actionLabels = {}, reload = 0 }: {
    type: string;
    id: string;
    /** Nhãn tiếng Việt / Trung của tên trường (thiếu thì hiện tên trường gốc). */
    fieldLabels?: Record<string, string>;
    actionLabels?: Record<string, string>;
    /** Tăng số này sau khi lưu để tải lại lịch sử. */
    reload?: number;
  } = $props();

  let rows = $state<HistoryEntry[]>([]);
  let total = $state(0);
  let page = $state(1);
  let pageSize = $state(20);
  let loading = $state(true);
  let error = $state('');

  async function load() {
    loading = true;
    error = '';
    try {
      const result = await api<Paged<HistoryEntry>>(`/history/${type}/${id}?page=${page}&pageSize=${pageSize}`);
      rows = result.rows;
      total = result.total;
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.rw_loi_tai();
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    void reload;
    void id;
    void load();
  });

  function show(value: unknown): string {
    if (value === undefined || value === null || value === '') return '—';
    if (Array.isArray(value)) return m.rw_so_dong({ count: value.length });
    if (typeof value === 'boolean') return value ? '✓' : '✗';
    if (typeof value === 'object') return JSON.stringify(value).slice(0, 120);
    return String(value).slice(0, 160);
  }
  const actionText = (action: string) => actionLabels[action] ?? action;
</script>

<section class="card">
  {#if error}<div class="banner error inset"><CircleAlert size={17} /><span>{error}</span></div>{/if}
  <div class="table-wrap">
    <table class="table">
      <thead><tr><th>{m.rw_thoi_gian()}</th><th>{m.rw_nguoi_thuc_hien()}</th><th>{m.rw_thao_tac()}</th><th>{m.rw_noi_dung_thay_doi()}</th></tr></thead>
      <tbody>
        {#if loading && !rows.length}<tr class="empty-row"><td colspan="4">{m.dang_tai()}</td></tr>
        {:else if rows.length}
          {#each rows as row (row.id)}
            <tr>
              <td class="nowrap">{dateTime(row.occurredAt)}</td>
              <td>{row.actorName ?? row.actorEmail ?? '—'}{#if row.actorName && row.actorEmail}<small>{row.actorEmail}</small>{/if}</td>
              <td><span class="pill neutral">{actionText(row.action)}</span></td>
              <td>
                {#if row.changes.length}
                  <ul class="changes">
                    {#each row.changes as change}
                      <li><b>{fieldLabels[change.field] ?? change.field}</b>: <s>{show(change.before)}</s> → <span>{show(change.after)}</span></li>
                    {/each}
                  </ul>
                {:else if row.metadata?.fileName}<span class="muted">{String(row.metadata.fileName)}</span>
                {:else}<span class="muted">—</span>{/if}
              </td>
            </tr>
          {/each}
        {:else}<tr class="empty-row"><td colspan="4">{m.rw_chua_co_lich_su()}</td></tr>{/if}
      </tbody>
    </table>
  </div>
  <Pagination {page} {pageSize} {total} {loading} onchange={(next, size) => { page = next; pageSize = size; void load(); }} />
</section>

<style>
  .inset { margin: 16px 16px 0; }
  .changes { display: grid; gap: 3px; margin: 0; padding: 0; list-style: none; font-size: 13px; }
  .changes s { color: var(--subtle); }
  .changes span { color: var(--text); }
</style>
