<script lang="ts">
  /**
   * Nhóm công nợ tách riêng (CN-SEG-01, 17/10/2026) — VD "Quạt & vợt muỗi": phần nợ của hàng thuộc nhóm được theo dõi riêng trên
   * từng chứng từ, không tính quá hạn / cảnh báo / tự khóa. Admin cấu hình nhóm, ghép mã hàng cũ trong sổ công nợ với danh mục,
   * xem trước → áp dụng cho chứng từ đã có (phân bổ lại tiền đã thu, nợ thường trước) → hoàn tác lần gần nhất.
   */
  import { m } from '$lib/paraglide/messages';
  import { onMount } from 'svelte';
  import { CircleAlert, CircleCheck, Eye, Plus, RotateCcw, TriangleAlert } from 'lucide-svelte';
  import { api } from '$lib/api';
  import { dateTime, num, vnd } from '$lib/format';
  import { session } from '$lib/session.svelte';
  import Dialog from '$lib/components/Dialog.svelte';
  import CustomerPicker from '$lib/components/CustomerPicker.svelte';
  import type { CustomerOption } from '$lib/customer-search';
  import { Trash2, X } from 'lucide-svelte';
  import SegmentItemsDialog, { type SegmentHolder } from '$lib/components/SegmentItemsDialog.svelte';

  type Segment = {
    id: string; code: string; name: string; categoryIds: string[]; categoryNames: string[]; skus: string[]; manualOnly: boolean; active: boolean; sortOrder: number;
    scope: 'ALL' | 'SELECTED'; partnerIds: string[]; partners: Array<{ id: string; code: string; name: string }>;
    taggedPartners: Array<{ id: string; code: string; name: string }>; holders: SegmentHolder[];
  };
  type Category = { id: string; code: string; name: string };
  type Apply = { id: string; appliedAt: string; appliedBy: string; status: 'APPLIED' | 'UNDONE' | 'CLOSED'; counts: { customers: number; receivables: number; payments: number }; undoneAt?: string };
  type SkuRow = { sku: string; lines: number; name: string; status: 'ALIAS' | 'MISSING'; productSku?: string; suggestions?: Array<{ sku: string; name: string }> };
  type Sum = { balance: string; segment: string; normal: string; overdue60: string };
  type PreviewRow = { partnerId: string; code: string; name: string; before?: Sum; after?: Sum; changes?: { receivables: number; payments: number }; error?: string };
  type Preview = { rows: PreviewRow[]; totals: { segmentBefore: string; segmentAfter: string; overdue60Before: string; overdue60After: string }; errors: number };

  let segments = $state<Segment[]>([]);
  let categories = $state<Category[]>([]);
  let pending = $state(false);
  let skuRows = $state<SkuRow[]>([]);
  let skuCounts = $state({ total: 0, catalog: 0, alias: 0, missing: 0 });
  let aliasInput = $state<Record<string, string>>({});
  let applies = $state<Apply[]>([]);
  let preview = $state<Preview | null>(null);
  let loading = $state(true);
  let busy = $state(false);
  let error = $state('');
  let success = $state('');
  let editOpen = $state(false);
  let editing = $state<Segment | null>(null);
  let form = $state({ code: '', name: '', categoryIds: [] as string[], skus: '', manualOnly: false, active: true, sortOrder: 10, scope: 'SELECTED' as 'ALL' | 'SELECTED', partnerIds: [] as string[] });
  let customers = $state<CustomerOption[]>([]);
  let customersLoading = $state(false);
  const customerOf = (id: string) => customers.find((row) => row.id === id);
  const isAdmin = $derived(Boolean(session.user?.roles?.includes('ADMIN')) || Boolean(session.user?.root));
  const changed = $derived(preview?.rows.filter((row) => row.changes && (row.changes.receivables || row.changes.payments)) ?? []);

  const fail = (caught: unknown, fallback: string) => (error = caught instanceof Error ? caught.message : fallback);
  // Hàng khách đang nợ của nhóm (mã + số lượng theo chứng từ còn nợ).
  let itemsOpen = $state(false);
  let itemsSegment = $state<Segment | null>(null);
  const owed = (segment: Segment) => segment.holders.reduce((sum, row) => sum + Number(row.outstanding), 0);
  const qty = (value: string) => Number(value).toLocaleString('vi-VN', { maximumFractionDigits: 3 });

  async function load() {
    loading = true;
    error = '';
    try {
      const list = await api<{ segments: Segment[]; categories: Category[]; state: { pending: boolean } }>('/receivables/segments');
      segments = list.segments;
      categories = list.categories;
      pending = list.state.pending;
      if (isAdmin) {
        const [report, history] = await Promise.all([
          api<{ rows: SkuRow[]; counts: typeof skuCounts }>('/receivables/segments/sku-report'),
          api<Apply[]>('/receivables/segments/applies'),
        ]);
        skuRows = report.rows;
        skuCounts = report.counts;
        aliasInput = Object.fromEntries(report.rows.map((row) => [row.sku, row.productSku ?? row.suggestions?.[0]?.sku ?? '']));
        applies = history;
      }
    } catch (caught) {
      fail(caught, m.khong_tai_duoc_cong_no());
    } finally {
      loading = false;
    }
  }

  function openEdit(segment: Segment | null) {
    editing = segment;
    form = segment
      ? { code: segment.code, name: segment.name, categoryIds: [...segment.categoryIds], skus: segment.skus.join(', '), manualOnly: segment.manualOnly, active: segment.active, sortOrder: segment.sortOrder, scope: segment.scope, partnerIds: [...segment.partnerIds] }
      : { code: '', name: '', categoryIds: [], skus: '', manualOnly: false, active: true, sortOrder: (segments.at(-1)?.sortOrder ?? 0) + 1, scope: 'SELECTED', partnerIds: [] };
    editOpen = true;
    if (!customers.length && !customersLoading) {
      customersLoading = true;
      void api<CustomerOption[]>('/partners?kind=CUSTOMER')
        .then((rows) => (customers = rows))
        .catch(() => undefined)
        .finally(() => (customersLoading = false));
    }
  }
  function addPartner(id: string) {
    if (id && !form.partnerIds.includes(id)) form.partnerIds = [...form.partnerIds, id];
  }
  function toggleCategory(id: string, on: boolean) {
    form.categoryIds = on ? [...new Set([...form.categoryIds, id])] : form.categoryIds.filter((item) => item !== id);
  }
  async function save(event: SubmitEvent) {
    event.preventDefault();
    busy = true;
    error = '';
    const body = {
      name: form.name, categoryIds: form.manualOnly ? [] : form.categoryIds, skus: form.manualOnly ? [] : form.skus.split(/[,;\n]/).map((item) => item.trim()).filter(Boolean),
      manualOnly: form.manualOnly, active: form.active, sortOrder: Number(form.sortOrder) || 0,
      scope: form.manualOnly ? 'ALL' : form.scope, partnerIds: form.manualOnly || form.scope === 'ALL' ? [] : form.partnerIds,
    };
    try {
      const nextCode = form.code.trim().toUpperCase();
      if (editing) await api(`/receivables/segments/${editing.code}`, { method: 'PATCH', body: JSON.stringify({ ...body, ...(nextCode && nextCode !== editing.code ? { code: nextCode } : {}) }) });
      else await api('/receivables/segments', { method: 'POST', body: JSON.stringify({ ...body, code: form.code }) });
      editOpen = false;
      preview = null;
      await load();
    } catch (caught) {
      fail(caught, m.crud_loi_luu());
    } finally {
      busy = false;
    }
  }

  /** Xóa nhóm: phần nợ nhóm của các khách chuyển về nợ thường (tổng nợ không đổi). */
  async function removeSegment() {
    if (!editing) return;
    const target = editing;
    if (!confirm(m.seg_xoa_hoi({ code: target.code, customers: target.holders.length, amount: vnd(owed(target)) }))) return;
    busy = true;
    error = '';
    try {
      const done = await api<{ customers: number; movedToNormal: string }>(`/receivables/segments/${target.code}`, { method: 'DELETE' });
      editOpen = false;
      preview = null;
      success = m.seg_da_xoa({ code: target.code, customers: done.customers, amount: vnd(done.movedToNormal) });
      await load();
    } catch (caught) {
      fail(caught, m.crud_loi_luu());
    } finally {
      busy = false;
    }
  }

  async function saveAlias(row: SkuRow, productSku: string | null) {
    busy = true;
    error = '';
    try {
      await api('/receivables/segments/sku-aliases', { method: 'PUT', body: JSON.stringify({ oldSku: row.sku, productSku }) });
      preview = null;
      await load();
    } catch (caught) {
      fail(caught, m.crud_loi_luu());
    } finally {
      busy = false;
    }
  }

  async function runPreview() {
    busy = true;
    error = '';
    success = '';
    try {
      preview = await api<Preview>('/receivables/segments/preview', { method: 'POST' });
    } catch (caught) {
      fail(caught, m.khong_tai_duoc_cong_no());
    } finally {
      busy = false;
    }
  }
  async function apply() {
    if (!preview || !confirm(m.seg_ap_dung_hoi({ customers: changed.length }))) return;
    busy = true;
    error = '';
    try {
      const result = await api<Apply>('/receivables/segments/apply', { method: 'POST' });
      success = m.seg_da_ap_dung({ customers: result.counts.customers, receivables: result.counts.receivables, payments: result.counts.payments });
      preview = null;
      await load();
    } catch (caught) {
      fail(caught, m.crud_loi_luu());
    } finally {
      busy = false;
    }
  }
  async function undo(row: Apply) {
    if (!confirm(m.seg_hoan_tac_hoi({ time: dateTime(row.appliedAt) }))) return;
    busy = true;
    error = '';
    try {
      await api(`/receivables/segments/applies/${row.id}/undo`, { method: 'POST' });
      success = m.seg_da_hoan_tac();
      preview = null;
      await load();
    } catch (caught) {
      fail(caught, m.crud_loi_luu());
    } finally {
      busy = false;
    }
  }
  const latestApplied = $derived(applies.find((row) => row.status === 'APPLIED')?.id);
  onMount(load);
</script>

<svelte:head><title>{m.seg_nav()} · INOXPRAN ERP</title></svelte:head>

<section class="page-head">
  <div>
    <nav class="crumbs" aria-label={m.duong_dan()}><a href="/receivables">{m.cong_no()}</a><span>{m.seg_nav()}</span></nav>
    <h1 class="page-title">{m.seg_nav()}</h1>
    <p class="page-sub">{m.seg_mo_ta()}</p>
  </div>
  {#if isAdmin}<div class="actions"><button class="btn primary" onclick={() => openEdit(null)}><Plus size={16} />{m.seg_them()}</button></div>{/if}
</section>

{#if error}<div class="banner error"><CircleAlert size={17} />{error}</div>{/if}
{#if success}<div class="banner success"><CircleCheck size={17} />{success}</div>{/if}
{#if isAdmin && pending && segments.length}<div class="banner warning"><TriangleAlert size={17} />{m.seg_cho_ap_dung()}</div>{/if}

<section class="card">
  <div class="table-wrap">
    <table class="table">
      <thead><tr><th>{m.seg_ma()}</th><th>{m.seg_ten()}</th><th>{m.seg_nhom_hang()}</th><th>{m.seg_ma_them()}</th><th>{m.seg_hang_dang_no()}</th><th>{m.seg_ap_dung_cho()}</th><th>{m.trang_thai()}</th>{#if isAdmin}<th></th>{/if}</tr></thead>
      <tbody>
        {#if loading && !segments.length}<tr class="empty-row"><td colspan="8">{m.dang_tai()}</td></tr>
        {:else}
          {#each segments as segment (segment.id)}
            <tr class:inactive={!segment.active}>
              <td class="code">{segment.code}</td>
              <td><b>{segment.name}</b>{#if segment.manualOnly}<small>{m.seg_chi_gan_tay()}</small>{/if}</td>
              <td>{segment.categoryNames.join(', ') || '—'}</td>
              <td class="code">{segment.skus.join(', ') || '—'}</td>
              <td class="holders">
                {#each segment.holders.slice(0, 3) as holder (holder.partnerId)}
                  <div><b>{holder.partner?.code}</b> · {m.seg_hang_tom_tat({ skus: holder.skuCount, quantity: qty(holder.quantity), amount: num(holder.outstanding) })}<small class="code">{holder.items.slice(0, 4).map((item) => `${item.sku} ×${qty(item.quantity)}`).join(', ')}{holder.items.length > 4 ? ` +${holder.items.length - 4}` : ''}</small></div>
                {:else}—{/each}
                {#if segment.holders.length > 3}<small>{m.seg_them_khach_nua({ count: segment.holders.length - 3 })}</small>{/if}
                {#if segment.holders.length}<button type="button" class="btn small soft" onclick={() => { itemsSegment = segment; itemsOpen = true; }}>{m.seg_xem_ma_hang()}</button>{/if}
              </td>
              <td>
                {#if segment.manualOnly}{#if segment.taggedPartners.length}<b>{segment.taggedPartners.map((row) => row.code).join(', ')}</b><small>{m.seg_khach_da_gan()}</small>{:else}{m.seg_chua_gan_chung_tu()}{/if}
                {:else if segment.scope === 'ALL'}{m.seg_moi_khach()}
                {:else}<b>{m.seg_so_khach({ count: segment.partners.length })}</b><small>{segment.partners.map((row) => row.code).join(', ') || '—'}</small>{/if}
              </td>
              <td><span class={`pill ${segment.active ? 'success' : 'neutral'}`}>{segment.active ? m.seg_dang_dung() : m.seg_ngung()}</span></td>
              {#if isAdmin}<td class="num"><button class="btn small" onclick={() => openEdit(segment)}>{m.crud_sua()}</button></td>{/if}
            </tr>
          {:else}<tr class="empty-row"><td colspan="8">{m.seg_chua_co()}</td></tr>{/each}
        {/if}
      </tbody>
    </table>
  </div>
</section>

{#if isAdmin}
  {#if skuCounts.total > 0}
  <section class="card">
    <header class="card-head"><div><h2>{m.seg_ma_cu_tieu_de()}</h2><p>{m.seg_ma_cu_mo_ta()}</p></div></header>
    {#if !skuRows.length}
      <p class="done">{m.seg_ma_cu_xong({ count: skuCounts.total })}</p>
    {:else}
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>{m.seg_ma_cu()}</th><th>{m.ten_hang()}</th><th class="num">{m.seg_so_dong()}</th><th>{m.trang_thai()}</th><th>{m.seg_ghep_voi()}</th><th></th></tr></thead>
          <tbody>
            {#each skuRows as row (row.sku)}
              <tr>
                <td class="code">{row.sku}</td>
                <td>{row.name}</td>
                <td class="num">{row.lines}</td>
                <td><span class={`pill ${row.status === 'ALIAS' ? 'success' : 'warning'}`}>{row.status === 'ALIAS' ? m.seg_da_ghep() : m.seg_chua_ghep()}</span></td>
                <td>
                  <input class="input alias" list={`alias-${row.sku}`} bind:value={aliasInput[row.sku]} aria-label={m.seg_ghep_voi()} />
                  <datalist id={`alias-${row.sku}`}>{#each row.suggestions ?? [] as option (option.sku)}<option value={option.sku}>{option.name}</option>{/each}</datalist>
                </td>
                <td class="num nowrap">
                  <button class="btn small soft" disabled={busy || !aliasInput[row.sku]?.trim() || aliasInput[row.sku] === row.productSku} onclick={() => saveAlias(row, aliasInput[row.sku] ?? '')}>{m.seg_ghep()}</button>
                  {#if row.status === 'ALIAS'}<button class="btn small" disabled={busy} onclick={() => saveAlias(row, null)}>{m.seg_bo_ghep()}</button>{/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </section>
  {/if}

  <section class="card">
    <header class="card-head">
      <div><h2>{m.seg_ap_dung_tieu_de()}</h2><p>{m.seg_ap_dung_mo_ta()}</p></div>
      <div class="actions">
        <button class="btn" onclick={runPreview} disabled={busy}><Eye size={16} />{m.seg_xem_truoc()}</button>
        <button class="btn primary" onclick={apply} disabled={busy || !preview || preview.errors > 0 || !changed.length}>{m.seg_ap_dung()}</button>
      </div>
    </header>
    {#if preview}
      <p class="summary">{m.seg_tong({ segment: vnd(preview.totals.segmentAfter), before: vnd(preview.totals.overdue60Before), after: vnd(preview.totals.overdue60After) })}</p>
      <div class="table-wrap">
        <table class="table compact">
          <thead><tr><th>{m.khach_hang()}</th><th class="num">{m.seg_no_nhom()}</th><th class="num">{m.seg_no_thuong_qua_60()}</th><th>{m.seg_thay_doi()}</th></tr></thead>
          <tbody>
            {#each preview.rows as row (row.partnerId)}
              <tr class:bad={Boolean(row.error)}>
                <td><a class="link" href={`/receivables/customers/${row.partnerId}`}><b>{row.code}</b> {row.name}</a></td>
                <td class="num">{#if row.after}<span class="muted">{num(row.before?.segment ?? '0')} →</span> <b>{num(row.after.segment)}</b>{/if}</td>
                <td class="num">{#if row.after}<span class="muted">{num(row.before?.overdue60 ?? '0')} →</span> <b>{num(row.after.overdue60)}</b>{/if}</td>
                <td>{#if row.error}<span class="pill danger">{m.seg_loi_du_lieu()}</span><small>{row.error}</small>{:else if row.changes && (row.changes.receivables || row.changes.payments)}{m.seg_thay_doi_ngan({ receivables: row.changes.receivables, payments: row.changes.payments })}{:else}—{/if}</td>
              </tr>
            {:else}<tr class="empty-row"><td colspan="4">{m.seg_khong_thay_doi()}</td></tr>{/each}
          </tbody>
        </table>
      </div>
    {/if}
    {#if applies.length}
      <h3 class="sub">{m.seg_lan_ap_dung()}</h3>
      <div class="table-wrap">
        <table class="table compact">
          <tbody>
            {#each applies as row (row.id)}
              <tr>
                <td class="nowrap">{dateTime(row.appliedAt)}</td>
                <td>{row.appliedBy}</td>
                <td>{m.seg_da_ap_dung({ customers: row.counts.customers, receivables: row.counts.receivables, payments: row.counts.payments })}</td>
                <td><span class={`pill ${row.status === 'APPLIED' ? 'success' : 'neutral'}`}>{row.status === 'APPLIED' ? m.seg_nhan_da_ap_dung() : row.status === 'CLOSED' ? m.seg_nhan_da_khoa() : m.seg_nhan_da_hoan_tac()}</span></td>
                <td class="num">{#if row.id === latestApplied}<button class="btn small" disabled={busy} onclick={() => undo(row)}><RotateCcw size={14} />{m.seg_hoan_tac()}</button>{/if}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </section>
{/if}

<Dialog bind:open={editOpen} title={editing ? m.seg_sua({ code: editing.code }) : m.seg_them()}>
  <form id="segment-form" class="form" onsubmit={save}>
    <div class="row2">
      <div class="field"><label for="seg-code">{m.seg_ma()}</label><input id="seg-code" bind:value={form.code} required maxlength="30" placeholder="QUAT-VOT" />{#if editing}<span class="hint">{m.seg_doi_ma_goi_y()}</span>{/if}</div>
      <div class="field"><label for="seg-order">{m.seg_thu_tu()}</label><input id="seg-order" type="number" min="0" max="999" bind:value={form.sortOrder} /></div>
    </div>
    <div class="field"><label for="seg-name">{m.seg_ten()}</label><input id="seg-name" bind:value={form.name} required maxlength="80" placeholder="Quạt & vợt muỗi" /></div>
    <label class="check"><input type="checkbox" bind:checked={form.manualOnly} /><span><b>{m.seg_chi_gan_tay()}</b><small>{m.seg_chi_gan_tay_giai_thich()}</small></span></label>
    {#if !form.manualOnly}
      <fieldset class="field">
        <legend class="label">{m.seg_nhom_hang()}</legend>
        <div class="categories">
          {#each categories as category (category.id)}
            <label class="check"><input type="checkbox" checked={form.categoryIds.includes(category.id)} onchange={(event) => toggleCategory(category.id, (event.currentTarget as HTMLInputElement).checked)} /><span>{category.code} — {category.name}</span></label>
          {/each}
        </div>
      </fieldset>
      <div class="field"><label for="seg-skus">{m.seg_ma_them()}</label><input id="seg-skus" bind:value={form.skus} placeholder="INP7901, INP7902" /><span class="hint">{m.seg_ma_them_goi_y()}</span></div>
      <fieldset class="field">
        <legend class="label">{m.seg_ap_dung_cho()}</legend>
        <label class="check"><input type="radio" name="seg-scope" value="SELECTED" bind:group={form.scope} /><span>{m.seg_khach_duoc_chon()}</span></label>
        <label class="check"><input type="radio" name="seg-scope" value="ALL" bind:group={form.scope} /><span>{m.seg_moi_khach()}</span></label>
        {#if form.scope === 'SELECTED'}
          <div class="chips">
            {#each form.partnerIds as partnerId (partnerId)}
              {@const partner = customerOf(partnerId) ?? editing?.partners.find((row) => row.id === partnerId)}
              <span class="chip">{partner?.code ?? '?'} {partner?.name ?? ''}<button type="button" aria-label={m.seg_bo()} onclick={() => (form.partnerIds = form.partnerIds.filter((id) => id !== partnerId))}><X size={12} /></button></span>
            {:else}<span class="hint">{m.seg_chua_chon_khach()}</span>{/each}
          </div>
          <CustomerPicker id="seg-customer" options={customers} value="" loading={customersLoading} placeholder={m.seg_them_khach()} onchoose={addPartner} />
        {/if}
      </fieldset>
    {/if}
    <label class="check"><input type="checkbox" bind:checked={form.active} /><span>{m.seg_dang_dung()}</span></label>
  </form>
  {#snippet footer()}
    {#if editing}<button type="button" class="btn danger delete-segment" disabled={busy} onclick={removeSegment}><Trash2 size={15} />{m.seg_xoa()}</button>{/if}
    <button type="button" class="btn" onclick={() => (editOpen = false)}>{m.huy()}</button>
    <button class="btn primary" form="segment-form" disabled={busy}>{busy ? m.kh_dang_luu() : m.crud_luu()}</button>
  {/snippet}
</Dialog>

<SegmentItemsDialog bind:open={itemsOpen} title={itemsSegment ? m.seg_hang_dang_no_tieu_de({ name: itemsSegment.name }) : ''} holders={itemsSegment?.holders ?? []} />

<style>
  tr.inactive td { color: var(--muted); }
  .holders { min-width: 220px; }
  .holders > div + div { margin-top: 6px; }
  .holders .btn { margin-top: 6px; }
  .delete-segment { margin-right: auto; }
  td small { display: block; color: var(--subtle); font-size: 11.5px; }
  .done { margin: 0; padding: 4px 20px 18px; color: var(--green); font-size: 13px; }
  .alias { width: 160px; min-height: 32px; }
  .summary { margin: 0; padding: 4px 20px 10px; font-size: 13px; color: var(--muted); }
  .sub { margin: 16px 20px 6px; font-size: 13.5px; }
  .compact td, .compact th { padding: 6px 10px; }
  tr.bad td { background: var(--red-soft); }
  .form { display: grid; gap: 14px; }
  .row2 { display: grid; grid-template-columns: 2fr 1fr; gap: 12px; }
  fieldset { margin: 0; padding: 0; border: 0; }
  .categories { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 6px 12px; }
  .check { display: flex; align-items: flex-start; gap: 8px; font-size: 13px; cursor: pointer; }
  .check input { width: 16px; height: 16px; margin-top: 2px; accent-color: var(--navy); }
  .check span { display: grid; gap: 2px; }
  .check small { color: var(--muted); font-size: 12px; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .chip { display: inline-flex; align-items: center; gap: 6px; padding: 3px 4px 3px 10px; border-radius: 999px; background: var(--blue-soft); color: var(--navy-2); font-size: 12.5px; font-weight: 600; }
  .chip button { display: grid; width: 20px; height: 20px; place-items: center; border: 0; border-radius: 50%; background: transparent; color: inherit; cursor: pointer; }
  .chip button:hover { background: rgba(18, 59, 94, 0.12); }
  @media (max-width: 480px) { .row2 { grid-template-columns: 1fr; } }
</style>
