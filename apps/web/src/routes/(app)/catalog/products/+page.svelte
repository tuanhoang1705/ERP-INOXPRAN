<script lang="ts">
  import { m } from '$lib/paraglide/messages';
  import type { Product } from '@inoxpran/contracts';
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { rememberList } from '$lib/record-nav';
  import { productName } from '$lib/product';
  import { CircleAlert, CircleCheck, FolderTree, Pencil, Plus, Trash2 } from 'lucide-svelte';
  import { api } from '$lib/api';
  import { num } from '$lib/format';
  import { availabilityLabel } from '$lib/labels';
  import { debounce, initialPageSize, pageQuery, rememberPageSize, type Paged } from '$lib/paging';
  import { can } from '$lib/permissions';
  import Pagination from '$lib/components/Pagination.svelte';
  import DateRangeFilter from '$lib/components/DateRangeFilter.svelte';
  import ProductDialog from '$lib/components/ProductDialog.svelte';
  import ConfirmDelete from '$lib/components/ConfirmDelete.svelte';
  import CategoryPurgeDialog from '$lib/components/CategoryPurgeDialog.svelte';
  import { session } from '$lib/session.svelte';
  import Dialog from '$lib/components/Dialog.svelte';
  import RecordDialog, { type RecordValues } from '$lib/components/RecordDialog.svelte';

  type Row = Product & { model?: string; categoryName?: string; onHand?: string; available?: string; priceNeedsReview?: boolean; priceReviewNote?: string };
  type Category = { id: string; code: string; name: string; description?: string; sortOrder?: number; status?: string; productCount: number };

  let rows = $state<Row[]>([]);
  let total = $state(0);
  let all = $state(0);
  let priceReview = $state(0);
  let page = $state(1);
  let pageSize = $state(initialPageSize());
  let categories = $state<Category[]>([]);
  let categoryId = $state('');
  let availability = $state('');
  let status = $state('');
  let search = $state('');
  /** Lọc theo khoảng ngày (LIST-DATE-01). */
  let from = $state('');
  let to = $state('');
  let loading = $state(true);
  let error = $state('');
  let success = $state('');

  let productOpen = $state(false);
  let editing = $state<Row | null>(null);
  let deleteOpen = $state(false);
  let deleting = $state<Row | null>(null);
  let categoriesOpen = $state(false);
  let categoryFormOpen = $state(false);
  let editingCategory = $state<Category | null>(null);
  let categoryDeleteOpen = $state(false);
  let deletingCategory = $state<Category | null>(null);
  let purgeOpen = $state(false);
  let purgingCategory = $state<Category | null>(null);
  const isRoot = $derived(Boolean(session.user?.root));
  const editable = $derived(can.editProducts());

  async function load() {
    loading = true;
    error = '';
    try {
      const filters = { search, categoryId, availability, status, from, to };
      const result = await api<Paged<Row> & { all: number; priceReview: number }>(`/products?${pageQuery(filters, page, pageSize)}`);
      rows = result.rows;
      total = result.total;
      rememberList('products', { endpoint: '/products', filters, page, pageSize, total: result.total, ids: result.rows.map((row) => row.id) });
      all = result.all;
      priceReview = result.priceReview;
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.khong_tai_duoc_danh_muc_san();
    } finally {
      loading = false;
    }
  }
  async function loadCategories() {
    categories = await api<Category[]>(`/product-categories${editable ? '?all=1' : ''}`).catch(() => categories);
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
    void loadCategories();
    void load();
  });

  function openProduct(row: Row | null) {
    editing = row;
    productOpen = true;
  }
  async function productSaved(saved: Product) {
    // Thêm mới xong mở luôn hồ sơ đầy đủ để khai báo tiếp (tên Trung / Anh, đóng gói, hải quan, ảnh).
    if (!editing) {
      await goto(`/catalog/products/${saved.id}`);
      return;
    }
    success = m.crud_da_luu({ name: saved.sku });
    await Promise.all([load(), loadCategories()]);
  }
  function askDelete(row: Row) {
    deleting = row;
    deleteOpen = true;
  }
  async function removeProduct() {
    if (!deleting) return;
    await api(`/products/${deleting.id}`, { method: 'DELETE' });
    success = m.crud_da_xoa({ name: deleting.sku });
    await Promise.all([load(), loadCategories()]);
  }
  /** Quản trị gốc gỡ hẳn mã chỉ có tồn đầu kỳ nhập từ Excel (CAT-PURGE-01). */
  async function purgeProduct() {
    if (!deleting) return;
    const result = await api<{ removed: number; openingQuantity: string }>(`/products/${deleting.id}?purge=1`, { method: 'DELETE' });
    success = m.cp_da_go({ count: result.removed, total: num(result.openingQuantity) });
    await Promise.all([load(), loadCategories()]);
  }
  async function categoryPurged(result: { removed: number; openingQuantity: string }) {
    success = m.cp_da_go({ count: result.removed, total: num(result.openingQuantity) });
    if (purgingCategory && categoryId === purgingCategory.id) categoryId = '';
    await Promise.all([load(), loadCategories()]);
  }
  async function deactivateProduct() {
    if (!deleting) return;
    await api(`/products/${deleting.id}`, { method: 'PATCH', body: JSON.stringify({ version: deleting.version, status: 'INACTIVE' }) });
    success = m.crud_da_ngung({ name: deleting.sku });
    await load();
  }

  const categoryFields = $derived([
    { key: 'code', label: m.crud_ma_nhom(), type: 'code' as const, required: true },
    { key: 'name', label: m.crud_ten_nhom(), required: true, maxlength: 120 },
    { key: 'sortOrder', label: m.crud_thu_tu(), type: 'digits' as const, hint: m.crud_thu_tu_goi_y() },
    ...(editingCategory ? [{ key: 'status', label: m.trang_thai(), type: 'select' as const, options: [{ value: 'ACTIVE', label: m.dang_hoat_dong() }, { value: 'INACTIVE', label: m.ngung() }] }] : []),
    { key: 'description', label: m.crud_mo_ta(), type: 'textarea' as const, maxlength: 300, span: true },
  ]);
  const categoryValues = $derived<RecordValues>(editingCategory
    ? { code: editingCategory.code, name: editingCategory.name, sortOrder: String(editingCategory.sortOrder ?? ''), status: editingCategory.status ?? 'ACTIVE', description: editingCategory.description ?? '' }
    : { sortOrder: String((categories.at(-1)?.sortOrder ?? 0) + 1) });
  function openCategory(row: Category | null) {
    editingCategory = row;
    categoryFormOpen = true;
  }
  async function saveCategory(values: RecordValues) {
    const body = {
      code: values.code,
      name: values.name,
      description: values.description || undefined,
      sortOrder: values.sortOrder ? Number(values.sortOrder) : undefined,
      ...(editingCategory ? { status: values.status } : {}),
    };
    await api(editingCategory ? `/product-categories/${editingCategory.id}` : '/product-categories', { method: editingCategory ? 'PATCH' : 'POST', body: JSON.stringify(body) });
    success = editingCategory ? m.crud_da_luu({ name: String(values.name) }) : m.crud_da_them({ name: String(values.name) });
    await loadCategories();
  }
  async function removeCategory() {
    if (!deletingCategory) return;
    await api(`/product-categories/${deletingCategory.id}`, { method: 'DELETE' });
    success = m.crud_da_xoa({ name: deletingCategory.name });
    if (categoryId === deletingCategory.id) categoryId = '';
    await loadCategories();
  }
  async function deactivateCategory() {
    if (!deletingCategory) return;
    await api(`/product-categories/${deletingCategory.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'INACTIVE' }) });
    success = m.crud_da_ngung({ name: deletingCategory.name });
    await loadCategories();
  }
</script>

<svelte:head><title>{m.danh_muc_san_pham_inoxpran_erp()}</title></svelte:head>

<section class="page-head">
  <div>
    <nav class="crumbs" aria-label={m.duong_dan()}><a href="/catalog/products">{m.danh_muc()}</a><span>{m.san_pham_sku()}</span></nav>
    <h1 class="page-title">{m.danh_muc_san_pham()}</h1>
    <p class="page-sub">{all} {m.ma_hang_inoxpran_theo_bang_bao()}</p>
  </div>
  <div class="actions">
    <a class="btn" href="/pricing">{m.xem_bang_gia_theo_cap()}</a>
    {#if editable}
      <button class="btn" onclick={() => (categoriesOpen = true)}><FolderTree size={16} />{m.crud_quan_ly_nhom()}</button>
      <button class="btn primary" onclick={() => openProduct(null)}><Plus size={16} />{m.crud_them_san_pham()}</button>
    {/if}
  </div>
</section>

<section class="cats">
  <button class:active={!categoryId} onclick={() => { categoryId = ''; refilter(); }}>{m.tat_ca()}<b>{all}</b></button>
  {#each categories.filter((row) => row.status !== 'INACTIVE') as category}<button class:active={categoryId === category.id} onclick={() => { categoryId = category.id; refilter(); }}>{category.name}<b>{category.productCount}</b></button>{/each}
</section>

<section class="card filters">
  <div class="field"><label for="search">{m.tim_kiem()}</label><input id="search" bind:value={search} oninput={searchChanged} placeholder={m.ma_model_hoac_ten_san_pham()} /></div>
  <DateRangeFilter bind:from bind:to label={m.dr_ngay_tao_ma()} id="product-date" onchange={refilter} />
  <div class="field"><label for="availability">{m.tinh_trang_hang()}</label><select id="availability" bind:value={availability} onchange={refilter}><option value="">{m.tat_ca()}</option>{#each Object.entries(availabilityLabel) as [value, item]}<option {value}>{item.label}</option>{/each}</select></div>
  <div class="field"><label for="status">{m.trang_thai()}</label><select id="status" bind:value={status} onchange={refilter}><option value="">{m.tat_ca()}</option><option value="ACTIVE">{m.dang_hoat_dong()}</option><option value="INACTIVE">{m.crud_ngung_kinh_doanh()}</option></select></div>
</section>

{#if error}<div class="banner error"><CircleAlert size={17} />{error}</div>{/if}
{#if success}<div class="banner success"><CircleCheck size={17} />{success}</div>{/if}
{#if priceReview}<div class="banner warning"><CircleAlert size={17} /><span>{priceReview} {m.ma_hang_co_ghi_chu_gia()}</span></div>{/if}

<section class="card">
  <div class="table-wrap">
    <table class="table">
      <thead><tr><th>{m.ma_sp()}</th><th>{m.ten_san_pham()}</th><th>{m.nhom_hang()}</th><th>{m.dvt()}</th><th class="num">{m.sp_thung()}</th><th class="num">{m.gia_ban_le()}</th><th class="num">{m.ton_kha_dung()}</th><th class="num">{m.dinh_muc()}</th><th>{m.tinh_trang()}</th>{#if editable}<th class="actions-col"><span class="sr-only">{m.crud_thao_tac()}</span></th>{/if}</tr></thead>
      <tbody>
        {#if loading && !rows.length}<tr class="empty-row"><td colspan="10">{m.dang_tai_danh_muc()}</td></tr>
        {:else if rows.length}
          {#each rows as row (row.id)}
            {@const info = availabilityLabel[row.availability] ?? { label: row.availability, tone: '' }}
            <tr class:inactive={row.status === 'INACTIVE'}>
              <td><a class="code link" href={`/catalog/products/${row.id}`}>{row.sku}</a>{#if row.model && row.model !== row.sku}<small>Model in: {row.model}</small>{/if}</td>
              <td>{productName(row)}{#if row.priceNeedsReview}<small class="review">⚠ {row.priceReviewNote}</small>{/if}</td>
              <td class="muted">{row.categoryName ?? '—'}</td>
              <td>{row.baseUnit}</td>
              <td class="num">{row.packSize ?? '—'}</td>
              <td class="num">{num(row.listPrice)}</td>
              <td class="num"><b class:low={Number(row.available) <= Number(row.minimumStock) && Number(row.minimumStock) > 0}>{num(row.available ?? 0)}</b></td>
              <td class="num muted">{num(row.minimumStock)}</td>
              <td>
                {#if row.status === 'INACTIVE'}<span class="pill neutral">{m.crud_ngung_kinh_doanh()}</span>
                {:else}<span class={`pill ${info.tone}`}>{info.label}</span>{/if}
                {#if row.clearance}<span class="pill orange clear">{m.ma_hang_clear()}</span>{/if}
              </td>
              {#if editable}
                <td class="row-actions">
                  <button class="icon-btn" title={m.crud_sua()} aria-label={`${m.crud_sua()} ${row.sku}`} onclick={() => openProduct(row)}><Pencil size={15} /></button>
                  <button class="icon-btn danger" title={m.crud_xoa()} aria-label={`${m.crud_xoa()} ${row.sku}`} onclick={() => askDelete(row)}><Trash2 size={15} /></button>
                </td>
              {/if}
            </tr>
          {/each}
        {:else}<tr class="empty-row"><td colspan="10">{m.khong_co_san_pham_phu_hop()}</td></tr>{/if}
      </tbody>
    </table>
  </div>
  <Pagination {page} {pageSize} {total} {loading} onchange={changePage} />
</section>

<ProductDialog bind:open={productOpen} product={editing} {categories} onsaved={productSaved} />
<ConfirmDelete bind:open={deleteOpen} name={deleting ? `${deleting.sku} — ${deleting.name}` : ''} ondelete={removeProduct} ondeactivate={deleting?.status === 'ACTIVE' ? deactivateProduct : undefined} onpurge={isRoot ? purgeProduct : undefined} />

<Dialog bind:open={categoriesOpen} title={m.crud_quan_ly_nhom()} wide>
  <div class="cat-head"><p class="muted">{m.crud_nhom_ghi_chu()}</p><button class="btn small primary" onclick={() => openCategory(null)}><Plus size={15} />{m.crud_them_nhom()}</button></div>
  <table class="table">
    <thead><tr><th>{m.ma()}</th><th>{m.crud_ten_nhom()}</th><th class="num">{m.crud_so_ma()}</th><th>{m.trang_thai()}</th><th class="actions-col"></th></tr></thead>
    <tbody>
      {#each categories as row (row.id)}
        <tr class:inactive={row.status === 'INACTIVE'}>
          <td class="code">{row.code}</td>
          <td>{row.name}{#if row.description}<small>{row.description}</small>{/if}</td>
          <td class="num">{row.productCount}</td>
          <td><span class={`pill ${row.status === 'INACTIVE' ? 'neutral' : 'success'}`}>{row.status === 'INACTIVE' ? m.ngung() : m.dang_hoat_dong()}</span></td>
          <td class="row-actions">
            <button class="icon-btn" title={m.crud_sua()} aria-label={`${m.crud_sua()} ${row.name}`} onclick={() => openCategory(row)}><Pencil size={15} /></button>
            <button class="icon-btn danger" title={m.crud_xoa()} aria-label={`${m.crud_xoa()} ${row.name}`} onclick={() => { deletingCategory = row; categoryDeleteOpen = true; }}><Trash2 size={15} /></button>
            {#if isRoot && row.productCount > 0}<button class="btn small danger-soft purge" title={m.cp_giai_thich()} onclick={() => { purgingCategory = row; purgeOpen = true; }}>{m.cp_nut()}</button>{/if}
          </td>
        </tr>
      {/each}
    </tbody>
  </table>
</Dialog>
<RecordDialog bind:open={categoryFormOpen} formId="category-form" title={editingCategory ? m.crud_sua_nhom() : m.crud_them_nhom()} fields={categoryFields} values={categoryValues} onsubmit={saveCategory} />
<CategoryPurgeDialog bind:open={purgeOpen} category={purgingCategory} onpurged={categoryPurged} />
<ConfirmDelete bind:open={categoryDeleteOpen} name={deletingCategory?.name ?? ''} ondelete={removeCategory} ondeactivate={deletingCategory?.status !== 'INACTIVE' ? deactivateCategory : undefined} />

<style>
  .cats { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 14px; }
  .cats button { display: inline-flex; align-items: center; gap: 8px; padding: 7px 12px; border: 1px solid var(--line); border-radius: 999px; background: var(--surface); color: var(--muted); font-size: 13px; }
  .cats button b { padding: 0 7px; border-radius: 999px; background: var(--surface-2); color: var(--text); font-size: 11.5px; }
  .cats button.active { border-color: var(--navy); background: var(--navy); color: #fff; }
  .cats button.active b { background: rgba(255, 255, 255, 0.18); color: #fff; }
  .filters { grid-template-columns: 2fr 1.4fr 1fr 1fr; }
  .review { color: #8a6508 !important; }
  .low { color: var(--orange); }
  .clear { margin-left: 6px; }
  tr.inactive td { color: var(--subtle); }
  .actions-col { width: 76px; }
  .cat-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .cat-head p { margin: 0; font-size: 13px; }
  @media (max-width: 720px) { .filters { grid-template-columns: 1fr; } }
</style>
