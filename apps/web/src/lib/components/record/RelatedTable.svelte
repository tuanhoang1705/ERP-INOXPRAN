<script lang="ts" module>
  export interface RelatedColumn<T> {
    label: string;
    value: (row: T) => string;
    href?: ((row: T) => string) | undefined;
    num?: boolean | undefined;
    tone?: ((row: T) => string) | undefined;
  }
</script>

<script lang="ts" generics="T extends { id: string }">
  /** Bảng chứng từ liên quan của một hồ sơ (phiếu bán, công nợ, bảo hành, đơn mua…), tải theo trang từ API có sẵn. */
  import { CircleAlert } from 'lucide-svelte';
  import { m } from '$lib/paraglide/messages';
  import { api } from '$lib/api';
  import type { Paged } from '$lib/paging';
  import Pagination from '$lib/components/Pagination.svelte';

  let { endpoint, columns, empty }: { endpoint: string; columns: Array<RelatedColumn<T>>; empty: string } = $props();

  let rows = $state<T[]>([]);
  let total = $state(0);
  let page = $state(1);
  let pageSize = $state(20);
  let loading = $state(true);
  let error = $state('');

  async function load() {
    loading = true;
    error = '';
    try {
      const joiner = endpoint.includes('?') ? '&' : '?';
      const result = await api<Paged<T>>(`${endpoint}${joiner}page=${page}&pageSize=${pageSize}`);
      rows = result.rows;
      total = result.total;
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.rw_loi_tai();
      rows = [];
    } finally {
      loading = false;
    }
  }
  $effect(() => {
    void endpoint;
    page = 1;
    void load();
  });
</script>

<section class="card">
  {#if error}<div class="banner error inset"><CircleAlert size={17} /><span>{error}</span></div>{/if}
  <div class="table-wrap">
    <table class="table">
      <thead><tr>{#each columns as column}<th class:num={column.num}>{column.label}</th>{/each}</tr></thead>
      <tbody>
        {#if loading && !rows.length}<tr class="empty-row"><td colspan={columns.length}>{m.dang_tai()}</td></tr>
        {:else if rows.length}
          {#each rows as row (row.id)}
            <tr>
              {#each columns as column}
                {@const value = column.value(row)}
                <td class:num={column.num}>
                  {#if column.href}<a class="link" href={column.href(row)}>{value}</a>
                  {:else if column.tone}<span class={`pill ${column.tone(row)}`}>{value}</span>
                  {:else}{value}{/if}
                </td>
              {/each}
            </tr>
          {/each}
        {:else}<tr class="empty-row"><td colspan={columns.length}>{empty}</td></tr>{/if}
      </tbody>
    </table>
  </div>
  {#if total > pageSize || page > 1}<Pagination {page} {pageSize} {total} {loading} onchange={(next, size) => { page = next; pageSize = size; void load(); }} />{/if}
</section>

<style>
  .inset { margin: 16px 16px 0; }
</style>
