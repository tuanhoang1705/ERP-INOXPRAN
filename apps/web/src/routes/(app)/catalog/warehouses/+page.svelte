<script lang="ts">
  import { m } from '$lib/paraglide/messages';
  import type { Warehouse } from '@inoxpran/contracts';
  import { onMount } from 'svelte';
  import { CircleAlert, CircleCheck, MapPin, Pencil, Plus, Trash2 } from 'lucide-svelte';
  import { api } from '$lib/api';
  import { num } from '$lib/format';
  import { can } from '$lib/permissions';
  import ConfirmDelete from '$lib/components/ConfirmDelete.svelte';
  import RecordDialog, { type RecordValues } from '$lib/components/RecordDialog.svelte';

  type WarehouseRow = Warehouse & { locationCount: number; stockedProducts: number; units: string; reserved: string; lowCount: number };
  type Location = { id: string; warehouseId: string; code: string; name: string; active: boolean; stockedProducts: number };

  let warehouses = $state<WarehouseRow[]>([]);
  let locations = $state<Location[]>([]);
  let selectedId = $state('');
  let loading = $state(true);
  let error = $state('');
  let success = $state('');
  const editable = $derived(can.editWarehouses());
  const selected = $derived(warehouses.find((row) => row.id === selectedId));

  let warehouseOpen = $state(false);
  let editingWarehouse = $state<WarehouseRow | null>(null);
  let locationOpen = $state(false);
  let editingLocation = $state<Location | null>(null);
  let deleteOpen = $state(false);
  let deleteTarget = $state<{ kind: 'warehouse'; row: WarehouseRow } | { kind: 'location'; row: Location } | null>(null);

  async function loadWarehouses() {
    try {
      warehouses = await api<WarehouseRow[]>('/warehouses');
      if (!warehouses.some((row) => row.id === selectedId)) selectedId = warehouses[0]?.id ?? '';
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.khong_tai_duoc_danh_sach_kho();
    } finally {
      loading = false;
    }
  }
  async function loadLocations() {
    locations = selectedId ? await api<Location[]>(`/locations?warehouseId=${selectedId}`).catch(() => []) : [];
  }
  async function reload() {
    await loadWarehouses();
    await loadLocations();
  }
  onMount(reload);

  const warehouseFields = $derived([
    { key: 'code', label: m.crud_ma_kho(), type: 'code' as const, required: true, readonly: Boolean(editingWarehouse) },
    { key: 'name', label: m.crud_ten_kho(), required: true, maxlength: 160 },
    { key: 'address', label: m.dia_chi(), maxlength: 500, span: true },
    { key: 'active', label: m.crud_kho_dang_dung(), type: 'checkbox' as const },
    { key: 'defective', label: m.crud_kho_hang_loi(), type: 'checkbox' as const },
  ]);
  const warehouseValues = $derived<RecordValues>(editingWarehouse
    ? { code: editingWarehouse.code, name: editingWarehouse.name, address: editingWarehouse.address, active: editingWarehouse.active, defective: editingWarehouse.purpose === 'DEFECTIVE' }
    : { active: true, defective: false });
  async function saveWarehouse(values: RecordValues) {
    const body = { name: values.name, address: values.address ?? '', active: Boolean(values.active), purpose: values.defective ? 'DEFECTIVE' : 'NORMAL' };
    const saved = await api<Warehouse>(editingWarehouse ? `/warehouses/${editingWarehouse.id}` : '/warehouses', {
      method: editingWarehouse ? 'PATCH' : 'POST',
      body: JSON.stringify(editingWarehouse ? { ...body, version: editingWarehouse.version } : { ...body, code: values.code }),
    });
    success = editingWarehouse ? m.crud_da_luu({ name: saved.name }) : m.crud_da_them_kho({ name: saved.name });
    if (!editingWarehouse) selectedId = saved.id;
    await reload();
  }

  const locationFields = $derived([
    { key: 'code', label: m.crud_ma_vi_tri(), type: 'code' as const, required: true, hint: m.crud_ma_vi_tri_goi_y() },
    { key: 'name', label: m.crud_mo_ta_vi_tri(), required: true, maxlength: 120 },
    { key: 'active', label: m.crud_vi_tri_dang_dung(), type: 'checkbox' as const },
  ]);
  const locationValues = $derived<RecordValues>(editingLocation ? { code: editingLocation.code, name: editingLocation.name, active: editingLocation.active } : { active: true });
  async function saveLocation(values: RecordValues) {
    const body = { code: values.code, name: values.name, active: Boolean(values.active) };
    await api(editingLocation ? `/locations/${editingLocation.id}` : '/locations', {
      method: editingLocation ? 'PATCH' : 'POST',
      body: JSON.stringify(editingLocation ? body : { ...body, warehouseId: selectedId }),
    });
    success = editingLocation ? m.crud_da_luu({ name: String(values.code) }) : m.crud_da_them({ name: String(values.code) });
    await reload();
  }

  function askDelete(target: NonNullable<typeof deleteTarget>) {
    deleteTarget = target;
    deleteOpen = true;
  }
  async function remove() {
    if (!deleteTarget) return;
    const path = deleteTarget.kind === 'warehouse' ? `/warehouses/${deleteTarget.row.id}` : `/locations/${deleteTarget.row.id}`;
    await api(path, { method: 'DELETE' });
    success = m.crud_da_xoa({ name: deleteTarget.row.name });
    await reload();
  }
  async function deactivate() {
    if (!deleteTarget) return;
    if (deleteTarget.kind === 'warehouse') {
      await api(`/warehouses/${deleteTarget.row.id}`, { method: 'PATCH', body: JSON.stringify({ version: deleteTarget.row.version, active: false }) });
    } else {
      await api(`/locations/${deleteTarget.row.id}`, { method: 'PATCH', body: JSON.stringify({ active: false }) });
    }
    success = m.crud_da_ngung({ name: deleteTarget.row.name });
    await reload();
  }
</script>

<svelte:head><title>{m.kho_vi_tri_luu_inoxpran_erp()}</title></svelte:head>

<section class="page-head">
  <div>
    <nav class="crumbs" aria-label={m.duong_dan()}><a href="/catalog/products">{m.danh_muc()}</a><span>{m.kho_vi_tri_luu()}</span></nav>
    <h1 class="page-title">{m.kho_vi_tri_luu()}</h1>
    <p class="page-sub">{m.danh_sach_kho_va_so_do()}</p>
  </div>
  {#if editable}<div class="actions"><button class="btn primary" onclick={() => { editingWarehouse = null; warehouseOpen = true; }}><Plus size={16} />{m.crud_them_kho()}</button></div>{/if}
</section>

{#if error}<div class="banner error"><CircleAlert size={17} />{error}</div>{/if}
{#if success}<div class="banner success"><CircleCheck size={17} />{success}</div>{/if}

<section class="grid">
  {#each warehouses as warehouse (warehouse.id)}
    <article class="card wh" class:selected={warehouse.id === selectedId}>
      <header>
        <span class="wh-icon"><MapPin size={18} /></span>
        <div class="wh-title">
          <h2>{warehouse.name}</h2>
          <p class="wh-tags">
            <span class={`pill ${warehouse.active ? 'success' : 'neutral'}`}>{warehouse.active ? m.dang_hoat_dong() : m.ngung()}</span>
            {#if warehouse.purpose === 'DEFECTIVE'}<span class="pill orange">{m.crud_kho_hang_loi_ngan()}</span>{/if}
          </p>
          <p>{warehouse.code} · {warehouse.address || '—'}</p>
        </div>
        {#if editable}
          <span class="row-actions">
            <button class="icon-btn" title={m.crud_sua()} aria-label={`${m.crud_sua()} ${warehouse.name}`} onclick={() => { editingWarehouse = warehouse; warehouseOpen = true; }}><Pencil size={15} /></button>
            <button class="icon-btn danger" title={m.crud_xoa()} aria-label={`${m.crud_xoa()} ${warehouse.name}`} onclick={() => askDelete({ kind: 'warehouse', row: warehouse })}><Trash2 size={15} /></button>
          </span>
        {/if}
      </header>
      <dl>
        <div><dt>{m.ma_hang_co_ton()}</dt><dd>{num(warehouse.stockedProducts)}</dd></div>
        <div><dt>{m.tong_so_luong_ton()}</dt><dd>{num(warehouse.units)}</dd></div>
        <div><dt>{m.dang_giu_cho_don()}</dt><dd>{num(warehouse.reserved)}</dd></div>
        <div><dt>{m.ma_duoi_dinh_muc()}</dt><dd class:red={warehouse.lowCount > 0}>{num(warehouse.lowCount)}</dd></div>
      </dl>
      <footer>
        <button class="link" onclick={() => { selectedId = warehouse.id; void loadLocations(); }}>{m.crud_vi_tri_luu_count({ count: warehouse.locationCount })}</button>
        <a class="link" href={`/inventory?warehouseId=${warehouse.id}`}>{m.xem_ton_kho()}</a>
        <a class="link" href="/inventory/movements">{m.the_kho()}</a>
      </footer>
    </article>
  {:else}
    {#if !loading}<p class="muted">{m.chua_khai_bao_kho()}</p>{/if}
  {/each}
</section>

{#if selected}
  <section class="card locations">
    <header class="card-head head">
      <h2>{m.crud_vi_tri_luu_cua({ name: selected.name })}</h2>
      {#if editable}<button class="btn small primary" onclick={() => { editingLocation = null; locationOpen = true; }}><Plus size={15} />{m.crud_them_vi_tri()}</button>{/if}
    </header>
    <div class="table-wrap">
      <table class="table">
        <thead><tr><th>{m.crud_ma_vi_tri()}</th><th>{m.crud_mo_ta_vi_tri()}</th><th class="num">{m.ma_hang_co_ton()}</th><th>{m.trang_thai()}</th>{#if editable}<th class="actions-col"><span class="sr-only">{m.crud_thao_tac()}</span></th>{/if}</tr></thead>
        <tbody>
          {#each locations as location (location.id)}
            <tr>
              <td class="code">{location.code}</td>
              <td>{location.name}</td>
              <td class="num">{num(location.stockedProducts)}</td>
              <td><span class={`pill ${location.active ? 'success' : 'neutral'}`}>{location.active ? m.dang_hoat_dong() : m.ngung()}</span></td>
              {#if editable}
                <td class="row-actions">
                  <button class="icon-btn" title={m.crud_sua()} aria-label={`${m.crud_sua()} ${location.code}`} onclick={() => { editingLocation = location; locationOpen = true; }}><Pencil size={15} /></button>
                  <button class="icon-btn danger" title={m.crud_xoa()} aria-label={`${m.crud_xoa()} ${location.code}`} onclick={() => askDelete({ kind: 'location', row: location })}><Trash2 size={15} /></button>
                </td>
              {/if}
            </tr>
          {:else}<tr class="empty-row"><td colspan="5">{m.crud_chua_co_vi_tri()}</td></tr>{/each}
        </tbody>
      </table>
    </div>
  </section>
{/if}

<RecordDialog bind:open={warehouseOpen} formId="warehouse-form" title={editingWarehouse ? m.crud_sua_kho({ name: editingWarehouse.name }) : m.crud_them_kho()} fields={warehouseFields} values={warehouseValues} onsubmit={saveWarehouse} />
<RecordDialog bind:open={locationOpen} formId="location-form" title={editingLocation ? m.crud_sua_vi_tri({ code: editingLocation.code }) : m.crud_them_vi_tri()} fields={locationFields} values={locationValues} onsubmit={saveLocation} />
<ConfirmDelete bind:open={deleteOpen} name={deleteTarget ? `${deleteTarget.row.code} — ${deleteTarget.row.name}` : ''} ondelete={remove} ondeactivate={deleteTarget?.row.active ? deactivate : undefined} />

<style>
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 360px), 1fr)); gap: 18px; align-items: start; }
  .wh.selected { border-color: var(--navy-2); box-shadow: 0 0 0 1px var(--navy-2); }
  .wh header { display: flex; align-items: flex-start; gap: 12px; padding: 18px 20px; border-bottom: 1px solid var(--line-soft); }
  .wh-icon { display: grid; flex: none; width: 38px; height: 38px; place-items: center; border-radius: 9px; background: var(--blue-soft); color: var(--navy); }
  .wh-title { flex: 1; min-width: 0; }
  .wh h2 { margin: 0; font-size: 16px; line-height: 1.35; overflow-wrap: anywhere; }
  .wh header p { margin: 4px 0 0; color: var(--muted); font-size: 13px; overflow-wrap: anywhere; }
  .wh header .wh-tags { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
  .wh header .row-actions { flex: none; margin: -4px -6px 0 0; }
  dl { display: grid; grid-template-columns: repeat(2, 1fr); gap: 14px; margin: 0; padding: 18px 20px; }
  dt { color: var(--subtle); font-size: 12px; }
  dd { margin: 3px 0 0; font-size: 18px; font-weight: 600; }
  .red { color: var(--red); }
  footer { display: flex; flex-wrap: wrap; gap: 18px; padding: 12px 20px 16px; border-top: 1px solid var(--line-soft); }
  footer button.link { padding: 0; font: inherit; font-weight: 600; }
  .locations { margin-top: 18px; }
  .head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding-bottom: 14px; }
  .actions-col { width: 76px; }
  @media (max-width: 480px) { .grid { grid-template-columns: 1fr; } }
</style>
