<script lang="ts">
  import { m } from '$lib/paraglide/messages';
  import type { Partner } from '@inoxpran/contracts';
  import { onMount } from 'svelte';
  import { page as current } from '$app/state';
  import { rememberList } from '$lib/record-nav';
  import { CircleAlert, CircleCheck, Pencil, Plus, Trash2 } from 'lucide-svelte';
  import { api } from '$lib/api';
  import { date, num } from '$lib/format';
  import { partnerStatus } from '$lib/labels';
  import { debounce, initialPageSize, pageQuery, rememberPageSize, type Paged } from '$lib/paging';
  import { can } from '$lib/permissions';
  import Pagination from '$lib/components/Pagination.svelte';
  import DateRangeFilter from '$lib/components/DateRangeFilter.svelte';
  import ConfirmDelete from '$lib/components/ConfirmDelete.svelte';
  import RecordDialog, { type RecordValues } from '$lib/components/RecordDialog.svelte';

  type Supplier = Partner & { orderCount: number; purchaseTotal: string; lastOrderAt: string | null };
  let suppliers = $state<Supplier[]>([]);
  let total = $state(0);
  let page = $state(1);
  let pageSize = $state(initialPageSize());
  let search = $state('');
  /** Lọc theo khoảng ngày (LIST-DATE-01). */
  let from = $state('');
  let to = $state('');
  let loading = $state(true);
  let error = $state('');
  let success = $state('');
  let formOpen = $state(false);
  let editing = $state<Supplier | null>(null);
  let deleteOpen = $state(false);
  let deleting = $state<Supplier | null>(null);
  const editable = $derived(can.editSuppliers());

  async function load() {
    loading = true;
    error = '';
    try {
      const filters = { kind: 'SUPPLIER', search, from, to };
      const result = await api<Paged<Supplier>>(`/partners?${pageQuery(filters, page, pageSize)}`);
      suppliers = result.rows;
      total = result.total;
      rememberList('suppliers', { endpoint: '/partners', filters, page, pageSize, total: result.total, ids: result.rows.map((row) => row.id) });
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.khong_tai_duoc_nha_cung_cap();
    } finally {
      loading = false;
    }
  }
  const searchChanged = debounce(() => {
    page = 1;
    void load();
  });
  function changePage(next: number, size: number) {
    if (size !== pageSize) rememberPageSize(size);
    page = next;
    pageSize = size;
    void load();
  }
  onMount(() => {
    void load();
    // Nút "Mới" trên hồ sơ nhà cung cấp mở form thêm ở đây.
    if (current.url.searchParams.get('new') && editable) open(null);
  });

  const fields = $derived([
    { key: 'code', label: m.ma_ncc(), type: 'code' as const, required: true, readonly: Boolean(editing) },
    { key: 'paymentTermDays', label: m.crud_so_ngay_thanh_toan(), type: 'digits' as const },
    { key: 'name', label: m.ten_nha_cung_cap(), required: true, span: true },
    { key: 'taxCode', label: m.ma_so_thue(), maxlength: 30 },
    { key: 'phone', label: m.dien_thoai(), type: 'tel' as const, maxlength: 30 },
    { key: 'email', label: m.kh_email(), type: 'email' as const },
    ...(editing ? [{ key: 'status', label: m.trang_thai(), type: 'select' as const, options: [{ value: 'ACTIVE', label: m.hoat_dong() }, { value: 'INACTIVE', label: m.ngung_giao_dich() }] }] : []),
    { key: 'address', label: m.dia_chi(), span: true, maxlength: 500 },
  ]);
  const values = $derived<RecordValues>(editing
    ? { code: editing.code, name: editing.name, taxCode: editing.taxCode ?? '', phone: editing.phone ?? '', email: editing.email ?? '', address: editing.address ?? '', paymentTermDays: String(editing.paymentTermDays ?? 0), status: editing.status }
    : { paymentTermDays: '30' });

  function open(row: Supplier | null) {
    editing = row;
    formOpen = true;
  }
  async function save(input: RecordValues) {
    const optional = (key: string) => (input[key] ? String(input[key]) : undefined);
    const body = {
      name: input.name,
      taxCode: optional('taxCode'),
      phone: optional('phone'),
      email: optional('email'),
      address: optional('address'),
      paymentTermDays: Number(input.paymentTermDays || 0),
      ...(editing ? { version: editing.version, status: input.status } : { code: input.code, kind: 'SUPPLIER' }),
    };
    await api(editing ? `/partners/${editing.id}` : '/partners', { method: editing ? 'PATCH' : 'POST', body: JSON.stringify(body) });
    success = editing ? m.crud_da_luu({ name: String(input.code) }) : m.crud_da_them({ name: String(input.code) });
    await load();
  }
  async function remove() {
    if (!deleting) return;
    await api(`/partners/${deleting.id}`, { method: 'DELETE' });
    success = m.crud_da_xoa({ name: deleting.code });
    await load();
  }
  async function deactivate() {
    if (!deleting) return;
    await api(`/partners/${deleting.id}`, { method: 'PATCH', body: JSON.stringify({ version: deleting.version, status: 'INACTIVE' }) });
    success = m.crud_da_ngung({ name: deleting.code });
    await load();
  }
</script>

<svelte:head><title>{m.nha_cung_cap_inoxpran_erp()}</title></svelte:head>

<section class="page-head">
  <div>
    <nav class="crumbs" aria-label={m.duong_dan()}><a href="/catalog/products">{m.danh_muc()}</a><span>{m.nha_cung_cap()}</span></nav>
    <h1 class="page-title">{m.nha_cung_cap()}</h1>
    <p class="page-sub">{m.nguon_hang_nhap_va_lich_su()}</p>
  </div>
  <div class="actions">
    {#if editable}<button class="btn" onclick={() => open(null)}><Plus size={16} />{m.crud_them_ncc()}</button>{/if}
    <a class="btn primary" href="/procurement/new">{m.lap_don_mua()}</a>
  </div>
</section>

<section class="card filters">
  <div class="field"><label for="search">{m.tim_kiem()}</label><input id="search" bind:value={search} oninput={searchChanged} placeholder={m.crud_tim_ncc()} /></div>
  <DateRangeFilter bind:from bind:to label={m.dr_ngay_tao()} id="supplier-date" onchange={() => { page = 1; void load(); }} />
</section>

{#if error}<div class="banner error"><CircleAlert size={17} />{error}</div>{/if}
{#if success}<div class="banner success"><CircleCheck size={17} />{success}</div>{/if}

<section class="card">
  <div class="table-wrap">
    <table class="table">
      <thead><tr><th>{m.ma_ncc()}</th><th>{m.ten_nha_cung_cap()}</th><th>{m.ma_so_thue()}</th><th>{m.dieu_khoan()}</th><th class="num">{m.so_don_mua()}</th><th class="num">{m.tong_gia_tri_mua()}</th><th>{m.don_gan_nhat()}</th><th>{m.trang_thai()}</th>{#if editable}<th class="actions-col"><span class="sr-only">{m.crud_thao_tac()}</span></th>{/if}</tr></thead>
      <tbody>
        {#if loading && !suppliers.length}<tr class="empty-row"><td colspan="9">{m.dang_tai()}</td></tr>
        {:else if suppliers.length}
          {#each suppliers as supplier (supplier.id)}
            {@const info = partnerStatus[supplier.status] ?? { label: supplier.status, tone: '' }}
            <tr>
              <td><a class="code link" href={`/catalog/suppliers/${supplier.id}`}>{supplier.code}</a></td>
              <td>{supplier.name}{#if supplier.phone || supplier.address}<small>{[supplier.phone, supplier.address].filter(Boolean).join(' · ')}</small>{/if}</td>
              <td class="muted">{supplier.taxCode ?? '—'}</td>
              <td class="muted">{supplier.paymentTermDays ? m.ngay_2({ paymentTermDays: supplier.paymentTermDays }) : '—'}</td>
              <td class="num">{supplier.orderCount}</td>
              <td class="num"><b>{num(supplier.purchaseTotal)}</b></td>
              <td class="muted">{date(supplier.lastOrderAt ?? undefined)}</td>
              <td><span class={`pill ${info.tone}`}>{info.label}</span></td>
              {#if editable}
                <td class="row-actions">
                  <button class="icon-btn" title={m.crud_sua()} aria-label={`${m.crud_sua()} ${supplier.code}`} onclick={() => open(supplier)}><Pencil size={15} /></button>
                  <button class="icon-btn danger" title={m.crud_xoa()} aria-label={`${m.crud_xoa()} ${supplier.code}`} onclick={() => { deleting = supplier; deleteOpen = true; }}><Trash2 size={15} /></button>
                </td>
              {/if}
            </tr>
          {/each}
        {:else}<tr class="empty-row"><td colspan="9">{m.chua_co_nha_cung_cap()}</td></tr>{/if}
      </tbody>
    </table>
  </div>
  <Pagination {page} {pageSize} {total} {loading} onchange={changePage} />
</section>

<RecordDialog bind:open={formOpen} formId="supplier-form" title={editing ? m.crud_sua_ncc({ code: editing.code }) : m.crud_them_ncc()} {fields} {values} onsubmit={save} />
<ConfirmDelete bind:open={deleteOpen} name={deleting ? `${deleting.code} — ${deleting.name}` : ''} ondelete={remove} ondeactivate={deleting?.status !== 'INACTIVE' ? deactivate : undefined} />

<style>
  .filters { grid-template-columns: minmax(0, 420px) minmax(220px, 340px); }
  .actions-col { width: 76px; }
</style>
