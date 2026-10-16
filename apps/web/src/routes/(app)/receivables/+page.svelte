<script lang="ts">
  import { m } from '$lib/paraglide/messages';
  import { page } from '$app/state';
  import { onMount } from 'svelte';
  import { CircleAlert, CircleCheck, X } from 'lucide-svelte';
  import { api } from '$lib/api';
  import { date, num, todayIso, vnd } from '$lib/format';
  import { hasRole, overdueLevel, receivableStatus } from '$lib/labels';
  import { session } from '$lib/session.svelte';
  import { debounce, initialPageSize, pageQuery, rememberPageSize, type Paged } from '$lib/paging';
  import Pagination from '$lib/components/Pagination.svelte';
  import DateRangeFilter from '$lib/components/DateRangeFilter.svelte';
  import NumberInput from '$lib/components/NumberInput.svelte';

  type Receivable = {
    id: string; code: string; partnerId: string; partnerName: string; partnerCode: string; partnerStatus: string; province?: string;
    salesOrderId?: string; salesOrderCode?: string; openingDocumentNo?: string; sourceType?: string; note?: string; warrantyTicketId?: string; warrantyCode?: string; payerName?: string; payerPhone?: string; amount: string; paidAmount: string; outstandingAmount: string; dueDate: string;
    daysOverdue: number; overdueLevel: string | null; status: string; createdAt: string;
  };
  let rows = $state<Receivable[]>([]);
  let filter = $state<'open' | 'overdue' | 'all'>('open');
  let search = $state(page.url.searchParams.get('search') ?? '');
  /** Lọc theo ngày phát sinh (LIST-DATE-01). */
  let from = $state('');
  let to = $state('');
  let loading = $state(true);
  let error = $state('');
  let success = $state('');
  let selected = $state<Receivable | null>(null);
  let amount = $state('');
  let method = $state<'BANK_TRANSFER' | 'CASH' | 'OTHER'>('BANK_TRANSFER');
  let receivedOn = $state(todayIso());
  let reference = $state('');
  let saving = $state(false);
  const canCollect = $derived(hasRole(session.user?.roles, ['ACCOUNTANT']));

  let total = $state(0);
  /** Tổng dư nợ theo bộ lọc hiện tại (mọi trang), máy chủ tính. */
  let totalOutstanding = $state('0');
  let pageNo = $state(1);
  let pageSize = $state(initialPageSize());

  async function load() {
    loading = true;
    error = '';
    try {
      const query = pageQuery({
        partnerId: page.url.searchParams.get('partnerId'),
        includePaid: filter === 'all' ? 'true' : '',
        overdueOnly: filter === 'overdue' ? 'true' : '',
        search,
        from,
        to,
      }, pageNo, pageSize);
      const result = await api<Paged<Receivable> & { totalOutstanding: string }>(`/receivables?${query}`);
      rows = result.rows;
      total = result.total;
      totalOutstanding = result.totalOutstanding;
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
  function openPayment(row: Receivable) {
    selected = row;
    amount = String(Math.round(Number(row.outstandingAmount)));
    reference = '';
    receivedOn = todayIso();
    success = '';
  }
  async function postPayment() {
    if (!selected) return;
    saving = true;
    error = '';
    try {
      await api('/payments', {
        method: 'POST',
        idempotentCommand: true,
        body: JSON.stringify({
          partnerId: selected.partnerId, amount, method, receivedAt: new Date(`${receivedOn}T12:00:00+07:00`).toISOString(),
          reference: reference || undefined, allocations: [{ receivableId: selected.id, amount }],
        }),
      });
      success = m.da_ghi_nhan_phieu_thu_cho({ p0: vnd(amount), code: selected.code, p2: selected.partnerStatus === 'ON_HOLD' ? m.he_thong_tu_mo_khoa_dat() : '' });
      selected = null;
      await load();
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.khong_the_ghi_nhan_thanh_toan();
    } finally {
      saving = false;
    }
  }
  onMount(load);
</script>

<svelte:head><title>{m.so_chi_tiet_cong_no_inoxpran()}</title></svelte:head>

<section class="page-head">
  <div>
    <nav class="crumbs" aria-label={m.duong_dan()}><a href="/receivables">{m.cong_no()}</a><span>{m.so_chi_tiet_cong_no()}</span></nav>
    <h1 class="page-title">{m.so_chi_tiet_cong_no_phai()}</h1>
    <p class="page-sub">{m.moi_lan_xuat_kho_sinh_mot()}</p>
  </div>
  <div class="actions"><a class="btn" href="/receivables/overdue">{m.tuoi_no_canh_bao()}</a></div>
</section>

<section class="card filters">
  <div class="field"><label for="search">{m.tim_kiem()}</label><input id="search" bind:value={search} oninput={searchChanged} placeholder={m.ma_chung_tu_don_hang_dai()} /></div>
  <DateRangeFilter bind:from bind:to label={m.dr_ngay_phat_sinh()} id="receivable-date" onchange={refilter} />
  <div class="field"><label for="filter">{m.hien_thi()}</label><select id="filter" bind:value={filter} onchange={refilter}><option value="open">{m.con_du_no()}</option><option value="overdue">{m.chi_qua_han()}</option><option value="all">{m.tat_ca_chung_tu()}</option></select></div>
  <div class="total"><span>{m.tong_du_no_dang_hien_thi()}</span><b>{vnd(totalOutstanding)}</b></div>
</section>

{#if error}<div class="banner error"><CircleAlert size={17} />{error}</div>{/if}
{#if success}<div class="banner success"><CircleCheck size={17} />{success}</div>{/if}

<section class="card">
  <div class="table-wrap">
    <table class="table">
      <thead><tr><th>{m.chung_tu()}</th><th>{m.dai_ly_khach_hang()}</th><th>{m.ngay_phat_sinh()}</th><th>{m.han_thanh_toan()}</th><th class="num">{m.gia_tri()}</th><th class="num">{m.da_thu()}</th><th class="num">{m.con_lai()}</th><th>{m.trang_thai()}</th><th></th></tr></thead>
      <tbody>
        {#if loading && !rows.length}<tr class="empty-row"><td colspan="9">{m.dang_doc_so_cong_no()}</td></tr>
        {:else if rows.length}
          {#each rows as row (row.id)}
            {@const info = receivableStatus[row.status] ?? { label: row.status, tone: '' }}
            {@const level = row.overdueLevel ? overdueLevel[row.overdueLevel] : null}
            {@const credit = row.sourceType === 'SALES_VOID_CREDIT'}
            <tr>
              <td><span class="code">{row.code}</span>{#if row.sourceType === 'SALES_VOID_CREDIT'}<small class="credit">{m.cn_khach_tra_truoc({ code: row.salesOrderCode ?? '' })}</small>{:else if row.salesOrderCode}<small><a class="link" href={`/sales/orders/${row.salesOrderId}`}>{row.salesOrderCode}</a></small>{:else if row.warrantyCode}<small><a class="link" href={`/warranty/${row.warrantyTicketId}`}>{m.wr_service_fee_of({ code: row.warrantyCode })}</a></small>{:else if row.openingDocumentNo}<small>{m.imp_chung_tu_dau_ky({ no: row.openingDocumentNo })}</small>{/if}</td>
              <td>{row.partnerName}<small>{row.partnerCode}{row.province ? ` · ${row.province}` : ''}{row.payerName ? ` · ${row.payerName}${row.payerPhone ? ` (${row.payerPhone})` : ''}` : ''}</small></td>
              <td class="muted">{date(row.createdAt)}</td>
              <td>{credit ? '—' : date(row.dueDate)}{#if level && !credit}<small class={`late ${level.tone}`}>{m.qua_han()} {row.daysOverdue} {m.ngay()}</small>{/if}</td>
              <td class="num">{num(row.amount)}</td>
              <td class="num muted">{num(row.paidAmount)}</td>
              <td class="num"><b>{num(row.outstandingAmount)}</b></td>
              <td>{#if credit}<span class="pill success">{m.cn_tra_truoc()}</span>{:else if level}<span class={`pill ${level.tone}`}>{level.label}</span>{:else}<span class={`pill ${info.tone}`}>{info.label}</span>{/if}</td>
              <td>{#if row.status !== 'PAID' && row.status !== 'VOIDED' && !credit && canCollect}<button class="btn small" onclick={() => openPayment(row)}>{m.thu_tien()}</button>{/if}</td>
            </tr>
          {/each}
        {:else}<tr class="empty-row"><td colspan="9">{m.khong_co_chung_tu_phu_hop()}</td></tr>{/if}
      </tbody>
    </table>
  </div>
  <Pagination page={pageNo} {pageSize} {total} {loading} onchange={changePage} />
</section>

{#if selected}
  <button class="scrim" onclick={() => (selected = null)} aria-label={m.dong()}></button>
  <aside class="drawer" aria-label={m.ghi_nhan_thu_tien()}>
    <header><div><h2>{m.ghi_nhan_thu_tien()}</h2><p>{selected.code} · {selected.partnerName}</p></div><button onclick={() => (selected = null)} aria-label={m.dong()}><X size={20} /></button></header>
    <div class="balance"><span>{m.du_no_chung_tu()}</span><b>{vnd(selected.outstandingAmount)}</b></div>
    <div class="field"><label for="amount">{m.so_tien_thu_vnd()}</label><NumberInput id="amount" bind:value={amount} /></div>
    <div class="field"><label for="received">{m.ngay_thu()}</label><input id="received" type="date" max={todayIso()} bind:value={receivedOn} /></div>
    <div class="field"><label for="method">{m.hinh_thuc()}</label><select id="method" bind:value={method}><option value="BANK_TRANSFER">{m.chuyen_khoan()}</option><option value="CASH">{m.tien_mat()}</option><option value="OTHER">{m.khac()}</option></select></div>
    <div class="field"><label for="reference">{m.ma_giao_dich_ngan_hang()}</label><input id="reference" bind:value={reference} placeholder={m.vi_du_ft26100012345()} /></div>
    <button class="btn primary" disabled={saving || !Number(amount)} onclick={postPayment}>{saving ? m.dang_ghi_so() : m.lap_phieu_thu()}</button>
    <p class="note">{m.phieu_thu_duoc_bao_ve_chong()}</p>
  </aside>
{/if}

<style>
  .filters { grid-template-columns: 1.5fr 1.3fr 1fr 1fr; }
  .total { display: grid; gap: 4px; padding-bottom: 6px; text-align: right; }
  .total span { color: var(--subtle); font-size: 12px; }
  .total b { font-size: 18px; }
  .late { font-weight: 600; }
  .late.warning { color: var(--amber) !important; }
  .late.danger { color: var(--red) !important; }
  .scrim { position: fixed; inset: 0; z-index: 70; background: rgba(18, 39, 59, 0.45); }
  .drawer { position: fixed; top: 0; right: 0; z-index: 71; display: grid; align-content: start; gap: 16px; width: min(420px, 100vw); height: 100vh; padding: 24px; background: var(--surface); box-shadow: -20px 0 50px rgba(18, 59, 94, 0.2); }
  .drawer header { display: flex; justify-content: space-between; gap: 12px; }
  .drawer h2 { margin: 0; font-size: 20px; }
  .drawer header p { margin: 4px 0 0; color: var(--muted); }
  .balance { display: grid; gap: 4px; padding: 14px 16px; border-left: 4px solid var(--orange); border-radius: 0 8px 8px 0; background: var(--orange-soft); }
  .balance span { color: var(--muted); font-size: 12.5px; }
  .balance b { color: var(--orange); font-size: 20px; }
  .note { margin: 0; color: var(--subtle); font-size: 12.5px; }
  @media (max-width: 800px) { .filters { grid-template-columns: 1fr; } .total { text-align: left; } }
</style>
