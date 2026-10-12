<script lang="ts">
  /**
   * Lịch chăm sóc khách chưa xong (跟进示警): quá hẹn / hôm nay / 7 ngày tới. Nhân viên kinh doanh thấy lịch của mình,
   * quản lý / Giám đốc thấy tất cả. Đánh dấu xong ngay tại đây.
   */
  import type { PartnerActivity } from '@inoxpran/contracts';
  import { Check, CircleAlert } from 'lucide-svelte';
  import { m } from '$lib/paraglide/messages';
  import { api } from '$lib/api';
  import { date } from '$lib/format';
  import type { Paged } from '$lib/paging';
  import Pagination from '$lib/components/Pagination.svelte';

  let { open = $bindable(false), oncounts }: { open?: boolean; oncounts?: ((counts: { overdue: number; today: number }) => void) | undefined } = $props();

  type Result = Paged<PartnerActivity> & { today: string; counts: { overdue: number; today: number } };
  let due = $state<'overdue' | 'today' | 'week'>('overdue');
  let rows = $state<PartnerActivity[]>([]);
  let total = $state(0);
  let page = $state(1);
  let pageSize = $state(20);
  let today = $state('');
  let loading = $state(false);
  let error = $state('');

  async function load() {
    loading = true;
    error = '';
    try {
      const result = await api<Result>(`/crm/follow-ups?due=${due}&page=${page}&pageSize=${pageSize}`);
      rows = result.rows;
      total = result.total;
      today = result.today;
      oncounts?.(result.counts);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.rw_loi_tai();
    } finally {
      loading = false;
    }
  }
  $effect(() => {
    void due;
    page = 1;
    void load();
  });

  async function done(row: PartnerActivity) {
    try {
      await api(`/partners/${row.partnerId}/activities/${row.id}`, { method: 'PATCH', body: JSON.stringify({ done: true }) });
      await load();
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.crud_loi_luu();
    }
  }
</script>

{#if open}
  <section class="card panel">
    <header>
      <h2>{m.crm_lich_cham_soc()}</h2>
      <div class="seg" role="tablist">
        <button role="tab" aria-selected={due === 'overdue'} class:active={due === 'overdue'} onclick={() => (due = 'overdue')}>{m.crm_qua_hen_tab()}</button>
        <button role="tab" aria-selected={due === 'today'} class:active={due === 'today'} onclick={() => (due = 'today')}>{m.crm_hom_nay()}</button>
        <button role="tab" aria-selected={due === 'week'} class:active={due === 'week'} onclick={() => (due = 'week')}>{m.crm_7_ngay()}</button>
      </div>
    </header>
    {#if error}<div class="banner error inset"><CircleAlert size={17} /><span>{error}</span></div>{/if}
    <div class="table-wrap">
      <table class="table">
        <thead><tr><th>{m.crm_ngay_hen()}</th><th>{m.khach_hang()}</th><th>{m.crm_viec_can_lam()}</th><th>{m.crm_lan_lien_he_truoc()}</th><th>{m.crm_nguoi_phu_trach()}</th><th></th></tr></thead>
        <tbody>
          {#each rows as row (row.id)}
            <tr>
              <td><span class={`pill ${row.followUpOn && row.followUpOn < today ? 'danger' : row.followUpOn === today ? 'warning' : ''}`}>{date(row.followUpOn)}</span></td>
              <td><a class="link" href={`/catalog/dealers/${row.partnerId}#activities`}>{row.partnerCode}</a><small>{row.partnerName}</small></td>
              <td>{row.followUpNote ?? '—'}</td>
              <td class="muted">{date(row.occurredAt)} · {row.content.slice(0, 80)}</td>
              <td class="muted">{row.ownerName}</td>
              <td class="row-actions"><button class="icon-btn" title={m.crm_danh_dau_xong()} aria-label={m.crm_danh_dau_xong()} onclick={() => done(row)}><Check size={15} /></button></td>
            </tr>
          {:else}<tr class="empty-row"><td colspan="6">{loading ? m.dang_tai() : m.crm_khong_co_lich()}</td></tr>{/each}
        </tbody>
      </table>
    </div>
    {#if total > pageSize}<Pagination {page} {pageSize} {total} {loading} onchange={(next, size) => { page = next; pageSize = size; void load(); }} />{/if}
  </section>
{/if}

<style>
  .panel { margin-bottom: 18px; }
  header { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px; padding: 14px 16px; border-bottom: 1px solid var(--line-soft); }
  h2 { margin: 0; font-size: 15px; }
  .seg { display: inline-flex; padding: 3px; border-radius: 8px; background: var(--surface-2); }
  .seg button { padding: 5px 12px; border-radius: 6px; color: var(--muted); font-size: 13px; font-weight: 600; }
  .seg button.active { background: var(--surface); color: var(--navy); box-shadow: var(--shadow); }
  .inset { margin: 12px 16px 0; }
</style>
