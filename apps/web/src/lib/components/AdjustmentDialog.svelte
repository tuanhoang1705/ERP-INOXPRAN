<script lang="ts">
  /**
   * Phiếu điều chỉnh tồn (POST /inventory/adjustments): tăng / giảm theo kiểm kê, hàng hỏng, thất lạc...
   * Chọn loại phát sinh (hao hụt, hàng mẫu xuất / trả, kiểm kê) để báo cáo tồn kho tháng cộng đúng cột.
   * Máy chủ ghi thẻ kho ADJUSTMENT_IN / ADJUSTMENT_OUT, chặn giảm quá tồn khả dụng và ghi nhật ký.
   */
  import type { Warehouse } from '@inoxpran/contracts';
  import { untrack } from 'svelte';
  import { CircleAlert, Plus, X } from 'lucide-svelte';
  import { m } from '$lib/paraglide/messages';
  import { api } from '$lib/api';
  import { categoryLabel } from '$lib/inventory';
  import { ADJUSTMENT_CATEGORIES, type AdjustmentCategory } from '$shared/inventory-categories';
  import Dialog from './Dialog.svelte';
  import NumberInput from './NumberInput.svelte';

  type ProductOption = { id: string; sku: string; name: string; baseUnit: string };
  type Line = { productId: string; quantity: string; locationCode: string };

  let { open = $bindable(false), warehouses = [], warehouseId = '', productId = '', onsaved }: {
    open?: boolean;
    warehouses?: Warehouse[];
    warehouseId?: string;
    /** Điều chỉnh nhanh từ một dòng tồn kho. */
    productId?: string;
    onsaved?: () => void;
  } = $props();

  let products = $state<ProductOption[]>([]);
  let locations = $state<Array<{ code: string; name: string; active: boolean }>>([]);
  let form = $state({ warehouseId: '', direction: 'IN' as 'IN' | 'OUT', category: 'ADJUST_IN' as AdjustmentCategory, reason: '' });
  let lines = $state<Line[]>([]);
  let error = $state('');
  let saving = $state(false);

  $effect(() => {
    if (!open) return;
    untrack(() => {
      form = { warehouseId: warehouseId || warehouses.find((row) => row.active)?.id || '', direction: 'IN', category: 'ADJUST_IN', reason: '' };
      lines = [{ productId, quantity: '', locationCode: '' }];
      error = '';
      if (!products.length) void api<ProductOption[]>('/products?status=ACTIVE').then((rows) => (products = rows)).catch(() => undefined);
      void loadLocations();
    });
  });

  async function loadLocations() {
    locations = form.warehouseId ? await api<typeof locations>(`/locations?warehouseId=${form.warehouseId}`).catch(() => []) : [];
  }
  const unitOf = (id: string) => products.find((row) => row.id === id)?.baseUnit ?? '';

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    error = '';
    const filled = lines.filter((line) => line.productId && line.quantity);
    if (!form.warehouseId || form.reason.trim().length < 3 || !filled.length || filled.some((line) => !(Number(line.quantity) > 0))) {
      error = m.crud_dc_thieu_thong_tin();
      return;
    }
    saving = true;
    try {
      await api('/inventory/adjustments', {
        method: 'POST',
        idempotentCommand: true,
        body: JSON.stringify({
          warehouseId: form.warehouseId,
          direction: form.direction,
          category: form.category,
          reason: form.reason.trim(),
          lines: filled.map((line) => ({ productId: line.productId, quantity: line.quantity, ...(line.locationCode ? { locationCode: line.locationCode } : {}) })),
        }),
      });
      open = false;
      onsaved?.();
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.crud_loi_luu();
    } finally {
      saving = false;
    }
  }
</script>

<Dialog bind:open title={m.crud_dieu_chinh_ton()} wide>
  <form id="adjustment-form" class="grid" onsubmit={submit} novalidate>
    {#if error}<div class="banner error span"><CircleAlert size={17} /><span>{error}</span></div>{/if}
    <div class="field">
      <label for="adj-warehouse">{m.kho()}</label>
      <select id="adj-warehouse" bind:value={form.warehouseId} onchange={loadLocations}>
        {#each warehouses.filter((row) => row.active) as row}<option value={row.id}>{row.name}</option>{/each}
      </select>
    </div>
    <fieldset class="field direction">
      <legend class="label">{m.crud_loai_dieu_chinh()}</legend>
      <label><input type="radio" value="IN" bind:group={form.direction} onchange={() => (form.category = 'ADJUST_IN')} />{m.dieu_chinh_tang()}</label>
      <label><input type="radio" value="OUT" bind:group={form.direction} onchange={() => (form.category = 'ADJUST_OUT')} />{m.dieu_chinh_giam()}</label>
    </fieldset>
    <div class="field span">
      <label for="adj-category">{m.inv_loai_phat_sinh()}</label>
      <select id="adj-category" bind:value={form.category}>
        {#each ADJUSTMENT_CATEGORIES[form.direction] as code}<option value={code}>{categoryLabel(code)}</option>{/each}
      </select>
      <span class="hint">{m.inv_loai_phat_sinh_goi_y()}</span>
    </div>
    <div class="field span">
      <label for="adj-reason">{m.crud_ly_do()} <span class="req">*</span></label>
      <input id="adj-reason" bind:value={form.reason} maxlength="500" placeholder={m.crud_ly_do_goi_y()} />
    </div>
    <div class="span lines">
      <table class="table">
        <thead><tr><th>{m.ten_san_pham()}</th><th class="qty">{m.so_luong()}</th><th>{m.crud_vi_tri()}</th><th></th></tr></thead>
        <tbody>
          {#each lines as line, index}
            <tr>
              <td>
                <select class="input" aria-label={m.ten_san_pham()} bind:value={line.productId}>
                  <option value="">—</option>
                  {#each products as product}<option value={product.id}>{product.sku} — {product.name}</option>{/each}
                </select>
              </td>
              <td class="qty"><span class="qty-box"><NumberInput class="input" decimals={4} aria-label={m.so_luong()} bind:value={line.quantity} /><small>{unitOf(line.productId)}</small></span></td>
              <td>
                <select class="input" aria-label={m.crud_vi_tri()} bind:value={line.locationCode}>
                  <option value="">—</option>
                  {#each locations.filter((row) => row.active) as location}<option value={location.code}>{location.code}</option>{/each}
                </select>
              </td>
              <td><button type="button" class="icon-btn danger" aria-label={m.crud_xoa()} disabled={lines.length === 1} onclick={() => lines.splice(index, 1)}><X size={15} /></button></td>
            </tr>
          {/each}
        </tbody>
      </table>
      <button type="button" class="btn small" onclick={() => lines.push({ productId: '', quantity: '', locationCode: '' })}><Plus size={15} />{m.crud_them_dong()}</button>
    </div>
    <p class="note span">{form.direction === 'OUT' ? m.crud_dc_giam_ghi_chu() : m.crud_dc_tang_ghi_chu()}</p>
  </form>
  {#snippet footer()}
    <button type="button" class="btn" onclick={() => (open = false)}>{m.huy()}</button>
    <button type="submit" class="btn primary" form="adjustment-form" disabled={saving}>{saving ? m.kh_dang_luu() : m.crud_ghi_dieu_chinh()}</button>
  {/snippet}
</Dialog>

<style>
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px 16px; align-items: start; }
  .span { grid-column: 1 / -1; }
  .req { color: var(--red); }
  .direction { display: flex; flex-wrap: wrap; gap: 16px; margin: 0; padding: 0; border: 0; }
  .direction legend { margin-bottom: 6px; padding: 0; font-size: 13px; font-weight: 500; }
  .direction label { display: flex; align-items: center; gap: 6px; min-height: 42px; font-size: 13.5px; }
  .lines { display: grid; gap: 10px; justify-items: start; }
  .lines table { width: 100%; }
  .lines td { padding: 6px 8px; }
  .qty { width: 150px; }
  .qty-box { display: flex; align-items: center; gap: 6px; }
  .note { margin: 0; color: var(--muted); font-size: 12.5px; }
  @media (max-width: 640px) { .grid { grid-template-columns: 1fr; } }
</style>
