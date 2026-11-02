<script lang="ts">
  import { NEW_PROVINCES } from '$shared/provinces';
  import { m } from '$lib/paraglide/messages';
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page as current } from '$app/state';
  import { CalendarClock, CircleAlert, CircleCheck, Pencil, Plus, Trash2 } from 'lucide-svelte';
  import { CRM_ROLES, PARTNER_MANAGER_ROLES } from '$shared/catalog-access';
  import { date, todayIso } from '$lib/format';
  import { rememberList } from '$lib/record-nav';
  import FollowUpPanel from '$lib/components/record/FollowUpPanel.svelte';
  import { api } from '$lib/api';
  import CustomerCreateDialog, { CUSTOMER_CREATE_ROLES } from '$lib/components/CustomerCreateDialog.svelte';
  import ConfirmDelete from '$lib/components/ConfirmDelete.svelte';
  import Pagination from '$lib/components/Pagination.svelte';
  import DateRangeFilter from '$lib/components/DateRangeFilter.svelte';
  import { debounce, initialPageSize, pageQuery, rememberPageSize, type Paged } from '$lib/paging';
  import { can } from '$lib/permissions';
  import { num, percent } from '$lib/format';
  import { hasRole, partnerStatus, tierLabel } from '$lib/labels';
  import { periodText } from '$lib/server-text';
  import { session } from '$lib/session.svelte';

  type Dealer = {
    id: string; code: string; name: string; customerTier?: string; regionCode?: string; regionName?: string; province?: string; salesRepName?: string;
    phone?: string; taxCode?: string; address?: string; email?: string; salesRepId?: string; creditLimit: string; paymentTermDays: number; status: 'ACTIVE' | 'ON_HOLD' | 'INACTIVE'; holdReason?: string;
    outstanding: string; overdue: string; periodRevenue: string; version: number;
    stage?: 'PROSPECT' | 'CUSTOMER'; grade?: string; nextFollowUp?: { on: string; note?: string } | null;
  };
  let rows = $state<Dealer[]>([]);
  let periodLabel = $state('');
  let region = $state('');
  let tier = $state('');
  let stage = $state('');
  let grade = $state('');
  let followUpOpen = $state(false);
  let followUpCounts = $state({ overdue: 0, today: 0 });
  const today = todayIso();
  const crmViewer = $derived(hasRole(session.user?.roles, [...CRM_ROLES, ...PARTNER_MANAGER_ROLES, 'ACCOUNTANT', 'AUDITOR', 'DIRECTOR']));
  let search = $state('');
  /** Lọc theo khoảng ngày (LIST-DATE-01). */
  let from = $state('');
  let to = $state('');
  let loading = $state(true);
  let error = $state('');
  let success = $state('');
  let createOpen = $state(false);
  let editing = $state<Dealer | null>(null);
  let deleteOpen = $state(false);
  let deleting = $state<Dealer | null>(null);
  let existingCodes = $state<string[]>([]);
  let total = $state(0);
  let page = $state(1);
  let pageSize = $state(initialPageSize());
  const canCreate = $derived(hasRole(session.user?.roles, CUSTOMER_CREATE_ROLES) || can.createProspects());
  const editable = $derived(can.editCustomers());

  async function load() {
    loading = true;
    error = '';
    try {
      const filters = { region, tier, search, stage, grade, from, to };
      const result = await api<Paged<Dealer> & { periodLabel: string }>(`/dealers?${pageQuery(filters, page, pageSize)}`);
      rows = result.rows;
      total = result.total;
      rememberList('dealers', { endpoint: '/dealers', filters, page, pageSize, total: result.total, ids: result.rows.map((row) => row.id) });
      periodLabel = result.periodLabel;
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.khong_tai_duoc_ho_so_dai();
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

  onMount(() => {
    void load();
    // Từ thông báo "lịch chăm sóc" (?followUp=due) hoặc nút "Mới" trên hồ sơ (?new=1).
    if (current.url.searchParams.get('followUp')) followUpOpen = true;
    if (current.url.searchParams.get('new') && canCreate) void openCreate();
  });

  async function openCreate() {
    editing = null;
    createOpen = true;
    // Gợi ý mã KHnnn kế tiếp cần toàn bộ mã khách (danh sách đang phân trang chỉ có một trang).
    existingCodes = await api<Array<{ code: string }>>('/partners?kind=CUSTOMER').then((list) => list.map((row) => row.code)).catch(() => rows.map((row) => row.code));
  }
  function openEdit(row: Dealer) {
    void goto(`/catalog/dealers/${row.id}`);
  }
  async function created(partner: { id: string; code: string; name: string }) {
    if (!editing) {
      // Khách mới mở luôn hồ sơ đầy đủ để khai báo người liên hệ, địa chỉ nhận hàng, nhật ký chăm sóc.
      await goto(`/catalog/dealers/${partner.id}`);
      return;
    }
    success = m.crud_da_luu({ name: partner.code });
    await load();
  }
  async function removeDealer() {
    if (!deleting) return;
    await api(`/partners/${deleting.id}`, { method: 'DELETE' });
    success = m.crud_da_xoa({ name: deleting.code });
    await load();
  }
  async function deactivateDealer() {
    if (!deleting) return;
    await api(`/partners/${deleting.id}`, { method: 'PATCH', body: JSON.stringify({ version: deleting.version, status: 'INACTIVE' }) });
    success = m.crud_da_ngung({ name: deleting.code });
    await load();
  }
</script>

<svelte:head><title>{m.ho_so_dai_ly_inoxpran_erp()}</title></svelte:head>

<section class="page-head">
  <div>
    <nav class="crumbs" aria-label={m.duong_dan()}><a href="/catalog/products">{m.danh_muc()}</a><span>{m.ho_so_dai_ly_khach_hang()}</span></nav>
    <h1 class="page-title">{m.ho_so_dai_ly_khach_hang()}</h1>
    <p class="page-sub">{m.cap_dai_ly_quyet_dinh_bang()}</p>
  </div>
  <div class="actions">
    {#if crmViewer}<button class="btn" class:soft={followUpOpen} onclick={() => (followUpOpen = !followUpOpen)}><CalendarClock size={16} />{m.crm_lich_cham_soc()}{#if followUpCounts.overdue + followUpCounts.today > 0}<span class="count" class:late={followUpCounts.overdue > 0}>{followUpCounts.overdue + followUpCounts.today}</span>{/if}</button>{/if}
    {#if canCreate}<button class="btn primary" onclick={openCreate}><Plus size={16} />{m.them_khach_hang()}</button>{/if}
  </div>
</section>

<section class="card filters">
  <div class="field"><label for="search">{m.tim_kiem()}</label><input id="search" bind:value={search} oninput={searchChanged} placeholder={m.ma_ten_dai_ly_tinh_thanh()} /></div>
  <DateRangeFilter bind:from bind:to label={m.dr_ky_doanh_so()} id="dealer-period" onchange={refilter} />
  <div class="field"><label for="region">{m.khu_vuc()}</label><select id="region" bind:value={region} onchange={refilter}><option value="">{m.tat_ca_khu_vuc()}</option>{#each NEW_PROVINCES as item}<option value={item.code}>{item.name}</option>{/each}</select></div>
  <div class="field"><label for="tier">{m.cap()}</label><select id="tier" bind:value={tier} onchange={refilter}><option value="">{m.tat_ca_cac_cap()}</option><option value="TIER_1">{m.cap_1_nha_phan_phoi()}</option><option value="TIER_2">{m.cap_2_dai_ly()}</option><option value="RETAIL">{m.khach_le()}</option></select></div>
  <div class="field"><label for="stage">{m.crm_loai_khach()}</label><select id="stage" bind:value={stage} onchange={refilter}><option value="">{m.tat_ca()}</option><option value="CUSTOMER">{m.crm_khach_chinh_thuc()}</option><option value="PROSPECT">{m.crm_khach_co_hoi()}</option></select></div>
  <div class="field"><label for="grade">{m.crm_xep_hang()}</label><select id="grade" bind:value={grade} onchange={refilter}><option value="">{m.tat_ca()}</option>{#each ['A', 'B', 'C', 'D'] as value}<option {value}>{m.crm_hang({ grade: value })}</option>{/each}</select></div>
</section>

{#if crmViewer}<FollowUpPanel bind:open={followUpOpen} oncounts={(counts) => (followUpCounts = counts)} />{/if}

{#if error}<div class="banner error"><CircleAlert size={17} />{error}</div>{/if}
{#if success}<div class="banner success"><CircleCheck size={17} />{success}</div>{/if}

<section class="card">
  <div class="table-wrap">
    <table class="table compact">
      <thead><tr><th>{m.ma()}</th><th>{m.ten_dai_ly_khach_hang()} · {m.cap()}</th><th>{m.crm_hen_cham_soc()}</th><th>{m.khu_vuc()} · {m.nv_phu_trach()}</th><th class="num">{m.han_muc()} · {m.dieu_khoan()}</th><th class="num">{m.du_no()} · {m.qua_han()}</th><th class="num">{m.doanh_so()} {periodText(periodLabel)}</th><th>{m.trang_thai()}</th>{#if editable}<th class="actions-col"><span class="sr-only">{m.crud_thao_tac()}</span></th>{/if}</tr></thead>
      <tbody>
        {#if loading && !rows.length}<tr class="empty-row"><td colspan="9">{m.dang_tai()}</td></tr>
        {:else if rows.length}
          {#each rows as row (row.id)}
            {@const info = partnerStatus[row.status] ?? { label: row.status, tone: '' }}
            {@const usage = Number(row.creditLimit) > 0 ? (Number(row.outstanding) / Number(row.creditLimit)) * 100 : null}
            <tr>
              <td><a class="code link" href={`/catalog/dealers/${row.id}`}>{row.code}</a></td>
              <td class="dealer-name">{row.name}{#if row.grade}<span class="grade">{row.grade}</span>{/if}<small>{row.province ?? ''}{row.phone ? ` · ${row.phone}` : ''}</small>{#if row.stage === 'PROSPECT'}<span class="pill warning">{m.crm_khach_co_hoi()}</span>{:else}<span class="pill" class:orange={row.customerTier === 'TIER_1'} class:neutral={row.customerTier === 'RETAIL'}>{tierLabel[row.customerTier ?? 'RETAIL']}</span>{/if}</td>
              <td>{#if row.nextFollowUp}<span class:late={row.nextFollowUp.on < today} class:due={row.nextFollowUp.on === today}>{date(row.nextFollowUp.on)}</span>{#if row.nextFollowUp.note}<small>{row.nextFollowUp.note}</small>{/if}{:else}<span class="muted">—</span>{/if}</td>
              <td class="muted">{row.regionName ?? m.toan_quoc()}<small>{row.salesRepName ?? '—'}</small></td>
              <td class="num">{Number(row.creditLimit) ? num(row.creditLimit) : '—'}<small>{row.paymentTermDays ? m.ngay_2({ paymentTermDays: row.paymentTermDays }) : m.tra_ngay_2()}</small></td>
              <td class="num"><b>{num(row.outstanding)}</b>{#if usage !== null}<small class:over={usage > 100}>{percent(usage, 0)} {m.han_muc_2()}</small>{/if}{#if Number(row.overdue) > 0}<small class="red">{m.qua_han()} {num(row.overdue)}</small>{/if}</td>
              <td class="num">{num(row.periodRevenue)}</td>
              <td><span class={`pill ${info.tone}`}>{info.label}</span>{#if row.holdReason === 'OVERDUE_60'}<small>{m.no_qua_han_60_ngay()}</small>{/if}</td>
              {#if editable}
                <td class="row-actions">
                  <button class="icon-btn" title={m.crud_sua()} aria-label={`${m.crud_sua()} ${row.code}`} onclick={() => openEdit(row)}><Pencil size={15} /></button>
                  <button class="icon-btn danger" title={m.crud_xoa()} aria-label={`${m.crud_xoa()} ${row.code}`} onclick={() => { deleting = row; deleteOpen = true; }}><Trash2 size={15} /></button>
                </td>
              {/if}
            </tr>
          {/each}
        {:else}<tr class="empty-row"><td colspan="9">{m.khong_co_dai_ly_phu_hop()}</td></tr>{/if}
      </tbody>
    </table>
  </div>
  <Pagination {page} {pageSize} {total} {loading} onchange={changePage} />
</section>
{#if hasRole(session.user?.roles, ['SALES', 'SALES_MANAGER'])}<p class="hint">{m.mo_tab_don_hang_tao_don()}</p>{/if}

<CustomerCreateDialog bind:open={createOpen} partner={editing} {existingCodes} allowProspect oncreated={created} />
<ConfirmDelete bind:open={deleteOpen} name={deleting ? `${deleting.code} — ${deleting.name}` : ''} ondelete={removeDealer} ondeactivate={deleting?.status !== 'INACTIVE' ? deactivateDealer : undefined} />

<style>
  .filters { grid-template-columns: 2fr 1.4fr repeat(4, 1fr); }
  .count { padding: 0 7px; border-radius: 999px; background: var(--amber-soft); color: var(--amber); font-size: 12px; }
  .count.late { background: var(--red-soft); color: var(--red); }
  .grade { margin-left: 6px; padding: 0 6px; border-radius: 4px; background: var(--orange-soft); color: var(--orange); font-size: 11px; font-weight: 700; }
  .late { color: var(--red); font-weight: 600; }
  .due { color: var(--amber); font-weight: 600; }
  @media (max-width: 900px) { .filters { grid-template-columns: 1fr 1fr; } }
  .red { color: var(--red); font-weight: 600; }
  .over { color: var(--red) !important; font-weight: 600; }
  .hint { color: var(--subtle); font-size: 12.5px; }
  .actions-col { width: 76px; }
  .dealer-name { min-width: 180px; }
  .dealer-name .pill { margin-top: 4px; }
  td small.red { color: var(--red); }
</style>
