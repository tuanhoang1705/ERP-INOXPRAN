<script lang="ts">
  /**
   * Thêm / sửa sản phẩm (POST /products, PATCH /products/:id kèm version để chặn ghi đè).
   * Mã SKU cố định sau khi tạo. Quy cách thùng là quy đổi "Thùng" đầu tiên; các quy đổi khác giữ nguyên.
   */
  import type { Product } from '@inoxpran/contracts';
  import { untrack } from 'svelte';
  import { CircleAlert } from 'lucide-svelte';
  import { m } from '$lib/paraglide/messages';
  import { api, ApiRequestError } from '$lib/api';
  import { vnd } from '$lib/format';
  import { availabilityLabel } from '$lib/labels';
  import Dialog from './Dialog.svelte';
  import NumberInput from './NumberInput.svelte';

  type Category = { id: string; code: string; name: string; status?: string };
  type Editable = Product & { model?: string };
  type Field = 'sku' | 'name' | 'baseUnit' | 'listPrice' | 'standardCost' | 'minimumStock' | 'packSize';

  let { open = $bindable(false), product = null, template = null, categories = [], onsaved }: {
    open?: boolean;
    /** null = thêm mới. */
    product?: Editable | null;
    /** Thêm mới bằng cách sao chép một sản phẩm có sẵn (mã SKU để trống; ảnh / tồn không sao chép). */
    template?: Editable | null;
    categories?: Category[];
    onsaved?: (saved: Product) => void;
  } = $props();

  const PACK_UNIT = 'Thùng';
  const digits = (value: unknown) => (value === undefined || value === null || value === '' ? '' : String(Math.round(Number(value))));
  const blank = () => ({
    sku: '', model: '', name: '', categoryId: '', baseUnit: 'Cái', packSize: '', barcode: '',
    listPrice: '', standardCost: '', minimumStock: '0', availability: 'IN_STOCK', clearance: false, status: 'ACTIVE', specification: '',
  });
  let form = $state(blank());
  let errors = $state<Partial<Record<Field, string>>>({});
  let error = $state('');
  let saving = $state(false);
  const editing = $derived(Boolean(product));

  $effect(() => {
    if (!open) return;
    untrack(() => {
      errors = {};
      error = '';
      const source = product ?? template;
      if (!source) {
        form = blank();
        return;
      }
      const pack = source.unitConversions.find((item) => item.unit === PACK_UNIT);
      form = {
        sku: product ? source.sku : '', model: source.model ?? '', name: source.name, categoryId: source.categoryId ?? '', baseUnit: source.baseUnit,
        packSize: source.packSize ? String(source.packSize) : digits(pack?.factorToBase), barcode: product ? (pack?.barcode ?? '') : '',
        listPrice: digits(source.listPrice), standardCost: digits(source.standardCost), minimumStock: digits(source.minimumStock) || '0',
        availability: source.availability, clearance: source.clearance, status: product ? source.status : 'ACTIVE', specification: source.specification ?? '',
      };
    });
  });

  function validate(): Partial<Record<Field, string>> {
    const found: Partial<Record<Field, string>> = {};
    if (!editing && !/^[A-Z0-9][A-Z0-9._/-]{1,39}$/.test(form.sku.trim())) found.sku = m.kh_ma_quy_tac();
    if (form.name.trim().length < 2) found.name = m.kh_ten_toi_thieu();
    if (!form.baseUnit.trim()) found.baseUnit = m.kh_bat_buoc_chon();
    if (!/^\d+$/.test(form.listPrice)) found.listPrice = m.kh_gia_tri_khong_hop_le();
    if (form.standardCost && !/^\d+$/.test(form.standardCost)) found.standardCost = m.kh_gia_tri_khong_hop_le();
    if (!/^\d+$/.test(form.minimumStock)) found.minimumStock = m.kh_gia_tri_khong_hop_le();
    if (form.packSize && (!/^\d+$/.test(form.packSize) || Number(form.packSize) < 1)) found.packSize = m.kh_gia_tri_khong_hop_le();
    return found;
  }

  /** Trường hồ sơ đầy đủ (Trung / Anh, hải quan, đóng gói, mua) mang theo khi sao chép. */
  const COPIED_PROFILE = ['nameZh', 'nameEn', 'specZh', 'specEn', 'descriptionZh', 'descriptionEn', 'brand', 'material', 'productType', 'hsCode', 'customsName', 'customsElements', 'defaultVatRate', 'innerPack', 'cartonLengthCm', 'cartonWidthCm', 'cartonHeightCm', 'grossKgPerCarton', 'netKgPerCarton', 'purchaseCurrency', 'purchasePrice', 'defaultSupplierId', 'defaultLocationCode'] as const;

  function body() {
    const optional = (value: string) => value.trim() || undefined;
    const copied = !product && template
      ? Object.fromEntries(COPIED_PROFILE.map((key) => [key, (template as Record<string, unknown>)[key]]).filter(([, value]) => value !== undefined && value !== ''))
      : {};
    const others = (product?.unitConversions ?? []).filter((item) => item.unit !== PACK_UNIT);
    const unitConversions = form.packSize
      ? [{ unit: PACK_UNIT, factorToBase: form.packSize, ...(form.barcode.trim() ? { barcode: form.barcode.trim() } : {}) }, ...others]
      : others;
    return {
      ...copied,
      ...(editing ? { version: product?.version } : { sku: form.sku.trim() }),
      model: optional(form.model),
      name: form.name.trim(),
      categoryId: optional(form.categoryId),
      baseUnit: form.baseUnit.trim(),
      unitConversions,
      packSize: form.packSize ? Number(form.packSize) : undefined,
      listPrice: form.listPrice,
      standardCost: optional(form.standardCost),
      minimumStock: form.minimumStock,
      availability: form.availability,
      clearance: form.clearance,
      status: form.status,
      specification: optional(form.specification),
    };
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    errors = validate();
    error = '';
    if (Object.keys(errors).length) return;
    saving = true;
    try {
      const saved = await api<Product>(editing ? `/products/${product?.id}` : '/products', { method: editing ? 'PATCH' : 'POST', body: JSON.stringify(body()) });
      open = false;
      onsaved?.(saved);
    } catch (caught) {
      if (caught instanceof ApiRequestError && caught.payload.code === 'SKU_EXISTS') errors = { sku: caught.message };
      error = caught instanceof Error ? caught.message : m.crud_loi_luu();
    } finally {
      saving = false;
    }
  }
</script>

<Dialog bind:open title={editing ? m.crud_sua_san_pham({ sku: product?.sku ?? '' }) : template ? m.sp_sao_chep_tu({ sku: template.sku }) : m.crud_them_san_pham()} wide>
  <form id="product-form" class="grid" onsubmit={submit} novalidate>
    {#if error}<div class="banner error span"><CircleAlert size={17} /><span>{error}</span></div>{/if}
    <div class="field">
      <label for="p-sku">{m.crud_ma_sku()} <span class="req">*</span></label>
      <input id="p-sku" value={form.sku} readonly={editing} maxlength="40" autocomplete="off" aria-invalid={Boolean(errors.sku)}
        oninput={(event) => (form.sku = event.currentTarget.value.toUpperCase())} />
      {#if errors.sku}<span class="error">{errors.sku}</span>{:else if editing}<span class="hint">{m.crud_sku_khong_doi()}</span>{/if}
    </div>
    <div class="field">
      <label for="p-model">{m.crud_model_in()}</label>
      <input id="p-model" bind:value={form.model} maxlength="60" />
    </div>
    <div class="field span">
      <label for="p-name">{m.ten_san_pham()} <span class="req">*</span></label>
      <input id="p-name" bind:value={form.name} maxlength="240" aria-invalid={Boolean(errors.name)} />
      {#if errors.name}<span class="error">{errors.name}</span>{/if}
    </div>
    <div class="field">
      <label for="p-category">{m.nhom_hang()}</label>
      <select id="p-category" bind:value={form.categoryId}>
        <option value="">—</option>
        {#each categories.filter((row) => row.status !== 'INACTIVE' || row.id === form.categoryId) as row}<option value={row.id}>{row.name}</option>{/each}
      </select>
    </div>
    <div class="field">
      <label for="p-unit">{m.crud_don_vi_co_ban()} <span class="req">*</span></label>
      <input id="p-unit" bind:value={form.baseUnit} maxlength="30" aria-invalid={Boolean(errors.baseUnit)} />
    </div>
    <div class="field">
      <label for="p-pack">{m.crud_quy_cach_thung()}</label>
      <NumberInput id="p-pack" bind:value={form.packSize} aria-invalid={Boolean(errors.packSize)} />
      {#if errors.packSize}<span class="error">{errors.packSize}</span>{:else}<span class="hint">{m.crud_quy_cach_thung_goi_y({ unit: form.baseUnit || '—' })}</span>{/if}
    </div>
    <div class="field">
      <label for="p-barcode">{m.crud_ma_vach_thung()}</label>
      <input id="p-barcode" bind:value={form.barcode} maxlength="80" disabled={!form.packSize} />
    </div>
    <div class="field">
      <label for="p-price">{m.gia_ban_le()} <span class="req">*</span></label>
      <NumberInput id="p-price" bind:value={form.listPrice} aria-invalid={Boolean(errors.listPrice)} />
      {#if errors.listPrice}<span class="error">{errors.listPrice}</span>{:else}<span class="hint">{vnd(form.listPrice || 0)}</span>{/if}
    </div>
    <div class="field">
      <label for="p-cost">{m.crud_gia_von()}</label>
      <NumberInput id="p-cost" bind:value={form.standardCost} aria-invalid={Boolean(errors.standardCost)} />
      {#if errors.standardCost}<span class="error">{errors.standardCost}</span>{:else}<span class="hint">{m.crud_gia_von_goi_y()}</span>{/if}
    </div>
    <div class="field">
      <label for="p-min">{m.dinh_muc_toi_thieu()}</label>
      <NumberInput id="p-min" bind:value={form.minimumStock} aria-invalid={Boolean(errors.minimumStock)} />
      {#if errors.minimumStock}<span class="error">{errors.minimumStock}</span>{:else}<span class="hint">{m.crud_dinh_muc_goi_y()}</span>{/if}
    </div>
    <div class="field">
      <label for="p-availability">{m.tinh_trang_hang()}</label>
      <select id="p-availability" bind:value={form.availability}>
        {#each Object.entries(availabilityLabel) as [value, item]}<option {value}>{item.label}</option>{/each}
      </select>
    </div>
    <div class="field">
      <label for="p-status">{m.trang_thai()}</label>
      <select id="p-status" bind:value={form.status}>
        <option value="ACTIVE">{m.dang_hoat_dong()}</option>
        <option value="INACTIVE">{m.crud_ngung_kinh_doanh()}</option>
      </select>
    </div>
    <label class="check span"><input type="checkbox" bind:checked={form.clearance} />{m.crud_hang_clear()}</label>
    <div class="field span">
      <label for="p-spec">{m.crud_tinh_nang()}</label>
      <textarea id="p-spec" rows="3" bind:value={form.specification} maxlength="2000"></textarea>
    </div>
  </form>
  {#snippet footer()}
    <button type="button" class="btn" onclick={() => (open = false)}>{m.huy()}</button>
    <button type="submit" class="btn primary" form="product-form" disabled={saving}>{saving ? m.kh_dang_luu() : m.crud_luu()}</button>
  {/snippet}
</Dialog>

<style>
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px 16px; align-items: start; }
  .span { grid-column: 1 / -1; }
  .req { color: var(--red); }
  .check { display: flex; align-items: center; gap: 8px; color: var(--text); font-size: 13.5px; }
  .check input { width: 17px; height: 17px; accent-color: var(--navy); }
  @media (max-width: 640px) { .grid { grid-template-columns: 1fr; } }
</style>
