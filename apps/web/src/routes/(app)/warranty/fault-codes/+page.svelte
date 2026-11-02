<script lang="ts">
  import { m } from '$lib/paraglide/messages';
  import type { WarrantyFaultCode } from '@inoxpran/contracts';
  import { onMount } from 'svelte';
  import { CircleAlert, CircleCheck, Pencil, Plus, Trash2 } from 'lucide-svelte';
  import { api, ApiRequestError } from '$lib/api';
  import { hasRole } from '$lib/labels';
  import { session } from '$lib/session.svelte';
  import ConfirmDelete from '$lib/components/ConfirmDelete.svelte';
  import Dialog from '$lib/components/Dialog.svelte';

  type Category = { id: string; code: string; name: string };
  let codes = $state<WarrantyFaultCode[]>([]);
  let categories = $state<Category[]>([]);
  let categoryId = $state('');
  let loading = $state(true);
  let error = $state('');
  let success = $state('');
  let formOpen = $state(false);
  let editing = $state<WarrantyFaultCode | null>(null);
  let form = $state({ code: '', name: '', categoryIds: [] as string[], active: true });
  let formError = $state('');
  let saving = $state(false);
  let deleteOpen = $state(false);
  let deleting = $state<WarrantyFaultCode | null>(null);
  const editable = $derived(hasRole(session.user?.roles, ['WARRANTY', 'WAREHOUSE_MANAGER']));
  const shown = $derived(categoryId ? codes.filter((row) => !row.categoryIds.length || row.categoryIds.includes(categoryId)) : codes);

  async function load() {
    try {
      [codes, categories] = await Promise.all([api<WarrantyFaultCode[]>('/warranty/fault-codes?all=1'), api<Category[]>('/product-categories')]);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.wr_load_error();
    } finally {
      loading = false;
    }
  }
  onMount(load);

  function open(row: WarrantyFaultCode | null) {
    editing = row;
    form = row ? { code: row.code, name: row.name, categoryIds: [...row.categoryIds], active: row.active } : { code: '', name: '', categoryIds: categoryId ? [categoryId] : [], active: true };
    formError = '';
    formOpen = true;
  }
  async function save(event: SubmitEvent) {
    event.preventDefault();
    formError = '';
    if (!editing && !/^[A-Z0-9][A-Z0-9._/-]{1,39}$/.test(form.code)) {
      formError = m.kh_ma_quy_tac();
      return;
    }
    if (form.name.trim().length < 2) {
      formError = m.kh_ten_toi_thieu();
      return;
    }
    saving = true;
    try {
      const body = { name: form.name.trim(), categoryIds: form.categoryIds, active: form.active };
      await api(editing ? `/warranty/fault-codes/${editing.id}` : '/warranty/fault-codes', { method: editing ? 'PATCH' : 'POST', body: JSON.stringify(editing ? body : { ...body, code: form.code }) });
      success = editing ? m.crud_da_luu({ name: form.code }) : m.crud_da_them({ name: form.code });
      formOpen = false;
      await load();
    } catch (caught) {
      formError = caught instanceof ApiRequestError || caught instanceof Error ? caught.message : m.crud_loi_luu();
    } finally {
      saving = false;
    }
  }
  async function remove() {
    if (!deleting) return;
    await api(`/warranty/fault-codes/${deleting.id}`, { method: 'DELETE' });
    success = m.crud_da_xoa({ name: deleting.code });
    await load();
  }
  async function deactivate() {
    if (!deleting) return;
    await api(`/warranty/fault-codes/${deleting.id}`, { method: 'PATCH', body: JSON.stringify({ active: false }) });
    success = m.crud_da_ngung({ name: deleting.code });
    await load();
  }
</script>

<svelte:head><title>{m.wr_nav_fault_codes()} · INOXPRAN ERP</title></svelte:head>

<section class="page-head">
  <div>
    <nav class="crumbs" aria-label={m.duong_dan()}><a href="/warranty">{m.wr_nav()}</a><span>{m.wr_nav_fault_codes()}</span></nav>
    <h1 class="page-title">{m.wr_nav_fault_codes()}</h1>
    <p class="page-sub">{m.wr_fault_codes_sub()}</p>
  </div>
  {#if editable}<div class="actions"><button class="btn primary" onclick={() => open(null)}><Plus size={16} />{m.wr_fault_add()}</button></div>{/if}
</section>

<section class="cats">
  <button class:active={!categoryId} onclick={() => (categoryId = '')}>{m.tat_ca()}<b>{codes.length}</b></button>
  {#each categories as category}<button class:active={categoryId === category.id} onclick={() => (categoryId = category.id)}>{category.name}</button>{/each}
</section>

{#if error}<div class="banner error"><CircleAlert size={17} />{error}</div>{/if}
{#if success}<div class="banner success"><CircleCheck size={17} />{success}</div>{/if}

<section class="card">
  <div class="table-wrap">
    <table class="table">
      <thead><tr><th>{m.wr_col_fault()}</th><th>{m.wr_fault_name()}</th><th>{m.nhom_hang()}</th><th class="num">{m.wr_used_times()}</th><th>{m.trang_thai()}</th>{#if editable}<th class="actions-col"><span class="sr-only">{m.crud_thao_tac()}</span></th>{/if}</tr></thead>
      <tbody>
        {#if loading}<tr class="empty-row"><td colspan="6">{m.dang_tai()}</td></tr>
        {:else}
          {#each shown as row (row.id)}
            <tr class:inactive={!row.active}>
              <td class="code">{row.code}</td>
              <td>{row.name}</td>
              <td class="muted">{row.categoryNames.length ? row.categoryNames.join(', ') : m.wr_fault_all_categories()}</td>
              <td class="num">{row.usageCount}</td>
              <td><span class={`pill ${row.active ? 'success' : 'neutral'}`}>{row.active ? m.dang_hoat_dong() : m.ngung()}</span></td>
              {#if editable}
                <td class="row-actions">
                  <button class="icon-btn" title={m.crud_sua()} aria-label={`${m.crud_sua()} ${row.code}`} onclick={() => open(row)}><Pencil size={15} /></button>
                  <button class="icon-btn danger" title={m.crud_xoa()} aria-label={`${m.crud_xoa()} ${row.code}`} onclick={() => { deleting = row; deleteOpen = true; }}><Trash2 size={15} /></button>
                </td>
              {/if}
            </tr>
          {:else}<tr class="empty-row"><td colspan="6">{m.wr_report_empty()}</td></tr>{/each}
        {/if}
      </tbody>
    </table>
  </div>
</section>

<Dialog bind:open={formOpen} title={editing ? m.wr_fault_edit({ code: editing.code }) : m.wr_fault_add()} wide>
  <form id="fault-form" class="grid" onsubmit={save} novalidate>
    {#if formError}<div class="banner error span"><CircleAlert size={17} /><span>{formError}</span></div>{/if}
    <div class="field">
      <label for="fc-code">{m.wr_col_fault()} <span class="req">*</span></label>
      <input id="fc-code" value={form.code} readonly={Boolean(editing)} maxlength="40" placeholder="VD: QUAT-08" oninput={(event) => (form.code = event.currentTarget.value.toUpperCase())} />
      {#if editing}<span class="hint">{m.wr_fault_code_fixed()}</span>{/if}
    </div>
    <label class="check"><input type="checkbox" bind:checked={form.active} />{m.dang_hoat_dong()}</label>
    <div class="field span">
      <label for="fc-name">{m.wr_fault_name()} <span class="req">*</span></label>
      <input id="fc-name" bind:value={form.name} maxlength="160" />
    </div>
    <fieldset class="span categories">
      <legend>{m.nhom_hang()}</legend>
      {#each categories as category}<label><input type="checkbox" value={category.id} bind:group={form.categoryIds} />{category.name}</label>{/each}
      <p class="hint">{m.wr_fault_categories_hint()}</p>
    </fieldset>
  </form>
  {#snippet footer()}
    <button type="button" class="btn" onclick={() => (formOpen = false)}>{m.huy()}</button>
    <button type="submit" class="btn primary" form="fault-form" disabled={saving}>{saving ? m.kh_dang_luu() : m.crud_luu()}</button>
  {/snippet}
</Dialog>
<ConfirmDelete bind:open={deleteOpen} name={deleting ? `${deleting.code} — ${deleting.name}` : ''} ondelete={remove} ondeactivate={deleting?.active ? deactivate : undefined} />

<style>
  .cats { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 14px; }
  .cats button { display: inline-flex; align-items: center; gap: 8px; padding: 7px 12px; border: 1px solid var(--line); border-radius: 999px; background: var(--surface); color: var(--muted); font-size: 13px; }
  .cats button b { padding: 0 7px; border-radius: 999px; background: var(--surface-2); color: var(--text); font-size: 11.5px; }
  .cats button.active { border-color: var(--navy); background: var(--navy); color: #fff; }
  .cats button.active b { background: rgba(255, 255, 255, 0.18); color: #fff; }
  tr.inactive td { color: var(--subtle); }
  .actions-col { width: 76px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px 16px; align-items: end; }
  .span { grid-column: 1 / -1; }
  .req { color: var(--red); }
  .check { display: flex; align-items: center; gap: 8px; min-height: 42px; font-size: 13.5px; }
  .categories { display: flex; flex-wrap: wrap; gap: 10px 18px; margin: 0; padding: 12px; border: 1px solid var(--line); border-radius: var(--radius-sm); }
  .categories legend { padding: 0 4px; font-size: 13px; font-weight: 500; }
  .categories label { display: flex; align-items: center; gap: 6px; font-size: 13.5px; }
  .categories .hint { flex-basis: 100%; margin: 0; color: var(--subtle); font-size: 12px; }
  @media (max-width: 640px) { .grid { grid-template-columns: 1fr; } }
</style>
