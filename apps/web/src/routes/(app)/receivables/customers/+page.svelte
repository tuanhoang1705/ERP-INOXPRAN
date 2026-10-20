<script lang="ts">
  /**
   * Công nợ theo khách hàng (CN-KH-01, 16/10/2026): tổng phát sinh / đã thu / phí vận chuyển khách trả / trả hàng / còn nợ của
   * từng khách — NPP trả gối đầu nên kế toán thu theo khách, không theo từng phiếu. Bấm khách để xem sổ chi tiết.
   */
  import { m } from '$lib/paraglide/messages';
  import { onMount } from 'svelte';
  import { CircleAlert, CircleCheck, HandCoins, ShieldOff } from 'lucide-svelte';
  import { api } from '$lib/api';
  import { num, vnd } from '$lib/format';
  import { hasRole, overdueLevel } from '$lib/labels';
  import { session } from '$lib/session.svelte';
  import { debounce, initialPageSize, pageQuery, rememberPageSize, type Paged } from '$lib/paging';
  import Pagination from '$lib/components/Pagination.svelte';
  import CustomerPaymentDrawer, { type PostedPayment } from '$lib/components/CustomerPaymentDrawer.svelte';

  type Row = {
    partnerId: string; code: string; name: string; province?: string; salesRepName?: string; status: string; holdReason?: string; autoHoldExempt: boolean;
    debit: string; receipt: string; freight: string; returns: string; openDebt: string; prepayment: string; balance: string;
    openDocuments: number; maxDaysOverdue: number; overdueLevel: string | null;
    segmentOutstanding: string; normalBalance: string; segments: Array<{ code: string; outstanding: string }>;
  };
  type Totals = { debit: string; receipt: string; freight: string; returns: string; balance: string; prepayment: string; segmentOutstanding: string; normalBalance: string };

  let rows = $state<Row[]>([]);
  let segmentNames = $state<Array<{ code: string; name: string }>>([]);
  const segmentName = (code: string) => segmentNames.find((item) => item.code === code)?.name ?? code;
  let totals = $state<Totals | null>(null);
  let search = $state('');
  let show = $state<'open' | 'all'>('open');
  let loading = $state(true);
  let error = $state('');
  let success = $state('');
  let total = $state(0);
  let pageNo = $state(1);
  let pageSize = $state(initialPageSize());
  let drawerOpen = $state(false);
  let drawerKind = $state<'RECEIPT' | 'FREIGHT'>('RECEIPT');
  const canCollect = $derived(hasRole(session.user?.roles, ['ACCOUNTANT']));

  async function load() {
    loading = true;
    error = '';
    try {
      const result = await api<Paged<Row> & { totals: Totals; segmentNames: Array<{ code: string; name: string }> }>(`/receivables/customers?${pageQuery({ search, onlyOpen: show === 'open' ? 'true' : '' }, pageNo, pageSize)}`);
      rows = result.rows;
      segmentNames = result.segmentNames ?? [];
      total = result.total;
      totals = result.totals;
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.khong_tai_duoc_cong_no();
    } finally {
      loading = false;
    }
  }
  const refilter = () => {
    pageNo = 1;
    void load();
  };
  const searchChanged = debounce(refilter);
  function changePage(next: number, size: number) {
    if (size !== pageSize) rememberPageSize(size);
    pageNo = next;
    pageSize = size;
    void load();
  }
  function posted(payment: PostedPayment, kind: 'RECEIPT' | 'FREIGHT') {
    success = kind === 'FREIGHT' ? m.cn_da_ghi_phi_vc({ code: payment.code }) : m.cn_da_lap_phieu_thu({ code: payment.code });
    if (Number(payment.prepayment) > 0) success += ` ${m.cn_thu_du_tra_truoc({ amount: vnd(payment.prepayment) })}`;
    void load();
  }
  onMount(load);
</script>

<svelte:head><title>{m.cn_theo_khach_title()} · INOXPRAN ERP</title></svelte:head>

<section class="page-head">
  <div>
    <nav class="crumbs" aria-label={m.duong_dan()}><a href="/receivables">{m.cong_no()}</a><span>{m.cn_theo_khach_title()}</span></nav>
    <h1 class="page-title">{m.cn_theo_khach_title()}</h1>
    <p class="page-sub">{m.cn_theo_khach_sub()}</p>
  </div>
  <div class="actions">
    <a class="btn" href="/receivables">{m.so_chi_tiet_cong_no()}</a>
    {#if canCollect}
      <button class="btn" onclick={() => { drawerKind = 'FREIGHT'; drawerOpen = true; }}>{m.cn_ghi_phi_vc()}</button>
      <button class="btn primary" onclick={() => { drawerKind = 'RECEIPT'; drawerOpen = true; }}><HandCoins size={16} />{m.cn_thu_theo_khach()}</button>
    {/if}
  </div>
</section>

<section class="card filters">
  <div class="field"><label for="search">{m.tim_kiem()}</label><input id="search" bind:value={search} oninput={searchChanged} placeholder={m.cn_tim_khach()} /></div>
  <div class="field"><label for="show">{m.hien_thi()}</label><select id="show" bind:value={show} onchange={refilter}><option value="open">{m.cn_khach_con_no()}</option><option value="all">{m.cn_tat_ca_khach()}</option></select></div>
  <div class="total"><span>{m.cn_tong_con_no()}</span><b>{vnd(totals?.balance ?? '0')}</b></div>
</section>

{#if error}<div class="banner error"><CircleAlert size={17} />{error}</div>{/if}
{#if success}<div class="banner success"><CircleCheck size={17} />{success}</div>{/if}

<section class="card">
  <div class="table-wrap">
    <table class="table">
      <thead><tr>
        <th>{m.khach_hang()}</th><th class="num">{m.cn_phat_sinh()}</th><th class="num">{m.cn_da_thu()}</th><th class="num">{m.cn_phi_vc()}</th>
        <th class="num">{m.cn_tra_hang_giam()}</th><th class="num">{m.cn_con_no()}</th><th class="num">{m.seg_no_nhom_tach_rieng()}</th><th>{m.cn_qua_han()}</th>
      </tr></thead>
      <tbody>
        {#if loading && !rows.length}<tr class="empty-row"><td colspan="8">{m.dang_doc_so_cong_no()}</td></tr>
        {:else if rows.length}
          {#each rows as row (row.partnerId)}
            {@const level = row.overdueLevel ? overdueLevel[row.overdueLevel] : null}
            <tr>
              <td>
                <a class="link name" href={`/receivables/customers/${row.partnerId}`}>{row.name}</a>
                <small>{row.code}{row.province ? ` · ${row.province}` : ''}{row.salesRepName ? ` · ${row.salesRepName}` : ''}</small>
                {#if row.status === 'ON_HOLD'}<span class="pill danger">{m.cn_dang_khoa()}</span>{/if}
                {#if row.autoHoldExempt}<span class="pill neutral" title={m.cn_khong_tu_khoa_giai_thich()}><ShieldOff size={11} />{m.cn_khong_tu_khoa()}</span>{/if}
              </td>
              <td class="num">{num(row.debit)}</td>
              <td class="num muted">{num(row.receipt)}</td>
              <td class="num muted">{num(row.freight)}</td>
              <td class="num muted">{num(row.returns)}</td>
              <td class="num"><b class:credit={Number(row.balance) < 0}>{num(row.balance)}</b>{#if Number(row.prepayment) > 0}<small>{m.cn_tra_truoc_ngan({ amount: num(row.prepayment) })}</small>{/if}</td>
              <td class="num">{#if Number(row.segmentOutstanding) > 0}<span class="segment">{num(row.segmentOutstanding)}</span>{#each row.segments as part (part.code)}<small>{segmentName(part.code)}</small>{/each}<small>{m.seg_con_lai_tru_nhom()}: {num(row.normalBalance)}</small>{:else}<span class="muted">—</span>{/if}</td>
              <td>{#if level}<span class={`pill ${level.tone}`}>{m.qua_han()} {row.maxDaysOverdue} {m.ngay()}</span>{:else if row.openDocuments}<span class="muted">{m.cn_trong_han()}</span>{:else}—{/if}</td>
            </tr>
          {/each}
        {:else}<tr class="empty-row"><td colspan="8">{m.cn_khong_co_khach()}</td></tr>{/if}
      </tbody>
      {#if totals && rows.length}
        <tfoot><tr><td>{m.cong()}</td><td class="num">{num(totals.debit)}</td><td class="num">{num(totals.receipt)}</td><td class="num">{num(totals.freight)}</td><td class="num">{num(totals.returns)}</td><td class="num"><b>{num(totals.balance)}</b></td><td class="num">{num(totals.segmentOutstanding)}</td><td></td></tr></tfoot>
      {/if}
    </table>
  </div>
  <Pagination page={pageNo} {pageSize} {total} {loading} onchange={changePage} />
</section>

<CustomerPaymentDrawer bind:open={drawerOpen} bind:kind={drawerKind} onposted={posted} />

<style>
  .filters { grid-template-columns: 1.6fr 1fr 1fr; }
  .total { display: grid; gap: 4px; padding-bottom: 6px; text-align: right; }
  .total span { color: var(--subtle); font-size: 12px; }
  .total b { font-size: 18px; }
  .name { font-weight: 600; }
  .pill { margin: 4px 4px 0 0; }
  .pill :global(svg) { vertical-align: -1px; margin-right: 3px; }
  .credit { color: var(--green); }
  .segment { color: var(--navy-2); font-weight: 600; }
  td small { display: block; color: var(--subtle); font-size: 11.5px; }
  tfoot td { font-weight: 600; }
  @media (max-width: 800px) { .filters { grid-template-columns: 1fr; } .total { text-align: left; } }
</style>
