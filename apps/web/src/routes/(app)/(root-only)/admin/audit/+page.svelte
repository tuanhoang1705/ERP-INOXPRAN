<script lang="ts">
  import { m } from '$lib/paraglide/messages';
  import { onMount } from 'svelte';
  import { CircleAlert } from 'lucide-svelte';
  import { api } from '$lib/api';
  import { dateTime } from '$lib/format';
  import { debounce, initialPageSize, pageQuery, rememberPageSize, type Paged } from '$lib/paging';
  import Pagination from '$lib/components/Pagination.svelte';

  type AuditRow = {
    id: string; occurredAt: string; actorEmail: string; action: string; entityType: string; entityId: string;
    correlationId?: string; before?: unknown; after?: unknown; metadata?: Record<string, unknown>;
  };
  let rows = $state<AuditRow[]>([]);
  let total = $state(0);
  let page = $state(1);
  let pageSize = $state(initialPageSize());
  let search = $state('');
  let entityType = $state('');
  let from = $state('');
  let to = $state('');
  let loading = $state(true);
  let error = $state('');
  let expanded = $state<string | null>(null);

  const ENTITY_TYPES = ['User', 'Product', 'ProductCategory', 'Partner', 'Warehouse', 'Location', 'SalesOrder', 'PurchaseOrder', 'InventoryAdjustment', 'InventoryTransfer', 'StockCount', 'StockReturn', 'ImportBatch', 'Payment', 'WarrantyTicket', 'WarrantyFaultCode', 'Region', 'Employee'];

  async function load() {
    loading = true;
    error = '';
    try {
      const result = await api<Paged<AuditRow>>(`/audit-events?${pageQuery({ search, entityType, from, to }, page, pageSize)}`);
      rows = result.rows;
      total = result.total;
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.acc_error();
    } finally {
      loading = false;
    }
  }
  const refilter = () => {
    page = 1;
    void load();
  };
  const searchChanged = debounce(refilter);
  function changePage(next: number, size: number) {
    if (size !== pageSize) rememberPageSize(size);
    page = next;
    pageSize = size;
    void load();
  }
  onMount(load);
  const pretty = (value: unknown) => JSON.stringify(value, null, 2);
</script>

<svelte:head><title>{m.aud_title()} · INOXPRAN ERP</title></svelte:head>

<section class="page-head">
  <div>
    <nav class="crumbs" aria-label={m.duong_dan()}><a href="/admin/system">{m.adm_section()}</a><span>{m.aud_title()}</span></nav>
    <h1 class="page-title">{m.aud_title()}</h1>
    <p class="page-sub">{m.aud_sub()}</p>
  </div>
</section>

<section class="card filters">
  <div class="field"><label for="a-search">{m.tim_kiem()}</label><input id="a-search" bind:value={search} oninput={searchChanged} placeholder={m.aud_search_ph()} /></div>
  <div class="field"><label for="a-type">{m.aud_entity()}</label><select id="a-type" bind:value={entityType} onchange={refilter}><option value="">{m.tat_ca()}</option>{#each ENTITY_TYPES as item}<option value={item}>{item}</option>{/each}</select></div>
  <div class="field"><label for="a-from">{m.wr_report_from()}</label><input id="a-from" type="date" bind:value={from} onchange={refilter} /></div>
  <div class="field"><label for="a-to">{m.wr_report_to()}</label><input id="a-to" type="date" bind:value={to} onchange={refilter} /></div>
</section>

{#if error}<div class="banner error"><CircleAlert size={17} />{error}</div>{/if}

<section class="card">
  <div class="table-wrap">
    <table class="table">
      <thead><tr><th>{m.adm_time()}</th><th>{m.nguoi_dung()}</th><th>{m.aud_action()}</th><th>{m.aud_entity()}</th><th>{m.aud_entity_id()}</th></tr></thead>
      <tbody>
        {#if loading && !rows.length}<tr class="empty-row"><td colspan="5">{m.dang_tai()}</td></tr>
        {:else}
          {#each rows as row (row.id)}
            <tr class="clickable" onclick={() => (expanded = expanded === row.id ? null : row.id)}>
              <td class="nowrap">{dateTime(row.occurredAt)}</td>
              <td>{row.actorEmail}</td>
              <td><span class="code">{row.action}</span></td>
              <td>{row.entityType}</td>
              <td class="muted mono">{row.entityId}</td>
            </tr>
            {#if expanded === row.id}
              <tr class="detail"><td colspan="5">
                <div class="diff">
                  {#if row.before}<div><b>{m.aud_before()}</b><pre>{pretty(row.before)}</pre></div>{/if}
                  {#if row.after}<div><b>{m.aud_after()}</b><pre>{pretty(row.after)}</pre></div>{/if}
                  {#if row.metadata}<div><b>{m.aud_metadata()}</b><pre>{pretty(row.metadata)}</pre></div>{/if}
                  {#if !row.before && !row.after && !row.metadata}<p class="muted">{m.aud_no_detail()}</p>{/if}
                </div>
              </td></tr>
            {/if}
          {:else}<tr class="empty-row"><td colspan="5">{m.aud_empty()}</td></tr>{/each}
        {/if}
      </tbody>
    </table>
  </div>
  <Pagination {page} {pageSize} {total} {loading} onchange={changePage} />
</section>

<style>
  .filters { grid-template-columns: 2fr 1fr 1fr 1fr; }
  .clickable { cursor: pointer; }
  .mono { font-family: ui-monospace, monospace; font-size: 12px; }
  .detail td { background: var(--surface-2); }
  .diff { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 12px; }
  pre { max-height: 320px; overflow: auto; margin: 6px 0 0; padding: 10px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface); font-size: 11.5px; white-space: pre-wrap; word-break: break-word; }
  @media (max-width: 900px) { .filters { grid-template-columns: 1fr 1fr; } }
</style>
