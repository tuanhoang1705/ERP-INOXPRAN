<script lang="ts">
  /**
   * Hồ sơ sản phẩm dạng cửa sổ chứng từ (theo 产品资料 của công ty mẹ): thông tin chính, đóng gói & hải quan,
   * mô tả Việt / Trung / Anh, ảnh & tài liệu, tồn theo kho, lịch sử mua / bán, lịch sử thay đổi.
   * Sửa trực tiếp trên trang; chỉ gửi trường đã đổi (kèm version để chặn ghi đè), trường để trống thì xóa giá trị.
   */
  import type { Product } from '@inoxpran/contracts';
  import { cartonCbm, cartonsNeeded, packingLine } from '$shared/packing';
  import { CURRENCIES } from '$shared/currency';
  import { VAT_RATES, vatLabel } from '$shared/sales-math';
  import { untrack } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { CircleAlert, CircleCheck, RefreshCw } from 'lucide-svelte';
  import { m } from '$lib/paraglide/messages';
  import { api, ApiRequestError } from '$lib/api';
  import { date, num, vnd } from '$lib/format';
  import { availabilityLabel } from '$lib/labels';
  import { can } from '$lib/permissions';
  import { decimalInput, productName, productTypeLabel } from '$lib/product';
  import ConfirmDelete from '$lib/components/ConfirmDelete.svelte';
  import ProductDialog from '$lib/components/ProductDialog.svelte';
  import RecordWindow from '$lib/components/record/RecordWindow.svelte';
  import RecordSection from '$lib/components/record/RecordSection.svelte';
  import HistoryPanel from '$lib/components/record/HistoryPanel.svelte';
  import AttachmentsPanel from '$lib/components/record/AttachmentsPanel.svelte';
  import NumberInput from '$lib/components/NumberInput.svelte';

  type Detail = Product & { categoryName?: string; onHand?: string; available?: string; priceNeedsReview?: boolean; priceReviewNote?: string };
  type Overview = {
    stock: Array<{ warehouseId: string; warehouseCode?: string; warehouseName?: string; locationCode: string | null; onHand: string; reserved: string; available: string }>;
    purchases: { recent: Array<{ id: string; code: string; supplierName: string; status: string; date: string; currency: string; unit: string; quantity: string; unitCost: string }>; last12Months: { quantity: string; amount: string; orders: number } };
    sales: { recent: Array<{ id: string; code: string; customerName: string; status: string; date: string; unit: string; quantity: string; unitPrice: string }>; last12Months: { quantity: string; amount: string; orders: number } };
  };
  type Option = { id: string; code: string; name: string; status?: string };

  const PACK_UNIT = 'Thùng';
  /** Trường chữ / số trên form (giá trị chuỗi như người dùng gõ). */
  const TEXT_FIELDS = [
    'model', 'name', 'nameZh', 'nameEn', 'categoryId', 'productType', 'baseUnit', 'brand', 'material', 'barcode', 'status', 'availability',
    'listPrice', 'standardCost', 'minimumStock', 'defaultVatRate', 'defaultLocationCode',
    'purchaseCurrency', 'purchasePrice', 'defaultSupplierId', 'supplierItemCode',
    'packSize', 'innerPack', 'cartonBarcode', 'cartonLengthCm', 'cartonWidthCm', 'cartonHeightCm', 'grossKgPerCarton', 'netKgPerCarton',
    'hsCode', 'customsName', 'customsElements', 'specZh', 'specEn', 'specification', 'descriptionZh', 'descriptionEn',
  ] as const;
  type FieldKey = (typeof TEXT_FIELDS)[number];
  const REQUIRED: FieldKey[] = ['name', 'baseUnit', 'listPrice', 'minimumStock', 'status', 'availability'];
  const INTEGER: FieldKey[] = ['packSize', 'innerPack'];
  const MONEY: FieldKey[] = ['listPrice', 'standardCost', 'minimumStock'];
  const DECIMAL: FieldKey[] = ['purchasePrice', 'cartonLengthCm', 'cartonWidthCm', 'cartonHeightCm', 'grossKgPerCarton', 'netKgPerCarton'];

  const id = $derived(page.params.id ?? '');
  let product = $state<Detail | null>(null);
  let overview = $state<Overview | null>(null);
  let categories = $state<Option[]>([]);
  let suppliers = $state<Option[]>([]);
  let form = $state<Record<FieldKey, string>>(Object.fromEntries(TEXT_FIELDS.map((key) => [key, ''])) as Record<FieldKey, string>);
  let clearance = $state(false);
  let baseline = $state('');
  let tab = $state('main');
  let loading = $state(true);
  let saving = $state(false);
  let error = $state('');
  let conflict = $state(false);
  let success = $state('');
  let errors = $state<Partial<Record<FieldKey, string>>>({});
  let historyReload = $state(0);
  let attachmentCount = $state<number | undefined>(undefined);
  let createOpen = $state(false);
  let copyFrom = $state<Detail | null>(null);
  let deleteOpen = $state(false);

  const editable = $derived(can.editProducts());
  const snapshot = () => JSON.stringify({ form, clearance });
  const dirty = $derived(Boolean(product) && editable && JSON.stringify({ form, clearance }) !== baseline);
  const digits = (value: unknown) => (value === undefined || value === null || value === '' ? '' : String(value));

  function fill(source: Detail) {
    const pack = source.unitConversions.find((item) => item.unit === PACK_UNIT);
    const values = Object.fromEntries(TEXT_FIELDS.map((key) => [key, digits((source as Record<string, unknown>)[key])])) as Record<FieldKey, string>;
    values.packSize = source.packSize ? String(source.packSize) : pack ? String(Math.round(Number(pack.factorToBase))) : '';
    values.cartonBarcode = pack?.barcode ?? '';
    for (const key of MONEY) values[key] = values[key] ? String(Math.round(Number(values[key]))) : values[key];
    form = values;
    clearance = source.clearance;
    baseline = snapshot();
  }

  async function load() {
    loading = true;
    error = '';
    conflict = false;
    try {
      const [detail, info] = await Promise.all([api<Detail>(`/products/${id}`), api<Overview>(`/products/${id}/overview`)]);
      product = detail;
      overview = info;
      fill(detail);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.rw_loi_tai();
    } finally {
      loading = false;
    }
  }

  // untrack: load() đọc / ghi dữ liệu form — effect chỉ chạy lại khi đổi bản ghi (id).
  $effect(() => {
    void id;
    untrack(() => {
      success = '';
      void load();
    });
  });
  $effect(() => {
    void api<Option[]>(`/product-categories${editable ? '?all=1' : ''}`).then((rows) => (categories = rows)).catch(() => undefined);
    void api<Option[]>('/partners?kind=SUPPLIER').then((rows) => (suppliers = rows)).catch(() => undefined);
  });

  function validate(): Partial<Record<FieldKey, string>> {
    const found: Partial<Record<FieldKey, string>> = {};
    for (const key of REQUIRED) if (!form[key].trim()) found[key] = m.kh_bat_buoc_chon();
    if (form.name.trim().length < 2) found.name = m.kh_ten_toi_thieu();
    for (const key of MONEY) if (form[key] && !/^\d+$/.test(form[key])) found[key] = m.kh_gia_tri_khong_hop_le();
    for (const key of INTEGER) if (form[key] && (!/^\d+$/.test(form[key]) || Number(form[key]) < 1)) found[key] = m.kh_gia_tri_khong_hop_le();
    for (const key of DECIMAL) if (form[key] && !/^\d+(\.\d{1,4})?$/.test(decimalInput(form[key]))) found[key] = m.kh_gia_tri_khong_hop_le();
    if (form.hsCode && !/^[0-9.]{4,20}$/.test(form.hsCode.trim())) found.hsCode = m.sp_hs_khong_hop_le();
    if (form.defaultLocationCode && !/^[A-Z0-9][A-Z0-9._/-]{1,39}$/.test(form.defaultLocationCode.trim())) found.defaultLocationCode = m.kh_ma_quy_tac();
    return found;
  }

  /** PATCH chỉ chứa trường đã đổi; trường tùy chọn bị xóa trắng gửi trong `clear`. */
  function changes(): Record<string, unknown> {
    if (!product) return {};
    const before = JSON.parse(baseline) as { form: Record<FieldKey, string>; clearance: boolean };
    const body: Record<string, unknown> = {};
    const clear: string[] = [];
    for (const key of TEXT_FIELDS) {
      if (key === 'cartonBarcode') continue;
      const value = form[key].trim();
      if (value === before.form[key].trim()) continue;
      if (value === '') {
        if (!REQUIRED.includes(key)) clear.push(key);
        continue;
      }
      body[key] = INTEGER.includes(key) ? Number(value) : DECIMAL.includes(key) ? decimalInput(value) : key === 'defaultLocationCode' ? value.toUpperCase() : value;
    }
    if (clearance !== before.clearance) body.clearance = clearance;
    if (form.packSize !== before.form.packSize || form.cartonBarcode !== before.form.cartonBarcode) {
      const others = product.unitConversions.filter((item) => item.unit !== PACK_UNIT);
      body.unitConversions = form.packSize
        ? [{ unit: PACK_UNIT, factorToBase: form.packSize, ...(form.cartonBarcode.trim() ? { barcode: form.cartonBarcode.trim() } : {}) }, ...others]
        : others;
    }
    return { ...body, ...(clear.length ? { clear } : {}) };
  }

  async function save() {
    if (!product) return;
    errors = validate();
    error = '';
    success = '';
    if (Object.keys(errors).length) {
      error = m.rw_kiem_tra_lai();
      return;
    }
    const body = changes();
    if (!Object.keys(body).length) {
      baseline = snapshot();
      return;
    }
    saving = true;
    try {
      await api(`/products/${product.id}`, { method: 'PATCH', body: JSON.stringify({ ...body, version: product.version }) });
      success = m.crud_da_luu({ name: product.sku });
      historyReload += 1;
      await load();
    } catch (caught) {
      conflict = caught instanceof ApiRequestError && caught.payload.code === 'VERSION_CONFLICT';
      error = caught instanceof Error ? caught.message : m.crud_loi_luu();
    } finally {
      saving = false;
    }
  }

  async function setPrimary(attachmentId: string) {
    if (!product) return;
    await api(`/products/${product.id}`, { method: 'PATCH', body: JSON.stringify({ primaryImageId: attachmentId, version: product.version }) });
    historyReload += 1;
    const keep = dirty ? { form: $state.snapshot(form), clearance } : null;
    await load();
    if (keep) {
      form = keep.form;
      clearance = keep.clearance;
    }
  }

  async function removeProduct() {
    if (!product) return;
    await api(`/products/${product.id}`, { method: 'DELETE' });
    baseline = snapshot();
    await goto('/catalog/products');
  }
  async function deactivate() {
    if (!product) return;
    await api(`/products/${product.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'INACTIVE', version: product.version }) });
    await load();
  }

  const unitCbm = $derived(cartonCbm(decimalInput(form.cartonLengthCm), decimalInput(form.cartonWidthCm), decimalInput(form.cartonHeightCm)));
  const sample = $derived(packingLine({ quantity: 1000, packSize: form.packSize, cartonLengthCm: decimalInput(form.cartonLengthCm), cartonWidthCm: decimalInput(form.cartonWidthCm), cartonHeightCm: decimalInput(form.cartonHeightCm), grossKgPerCarton: decimalInput(form.grossKgPerCarton) }));
  const title = $derived(product ? `${product.sku} — ${productName(product)}` : m.dang_tai());
  const tabs = $derived([
    { id: 'main', label: m.rw_thong_tin_chinh() },
    { id: 'packing', label: m.sp_dong_goi_hai_quan() },
    { id: 'description', label: m.sp_mo_ta() },
    { id: 'attachments', label: m.sp_anh_tai_lieu(), badge: attachmentCount },
    { id: 'stock', label: m.sp_ton_kho(), badge: overview?.stock.length },
    { id: 'trade', label: m.sp_mua_ban() },
    { id: 'history', label: m.rw_lich_su() },
  ]);
  const fieldLabels = $derived<Record<string, string>>({
    model: m.crud_model_in(), name: m.ten_san_pham(), nameZh: m.sp_ten_trung(), nameEn: m.sp_ten_anh(), categoryId: m.nhom_hang(), productType: m.sp_phan_loai(),
    baseUnit: m.crud_don_vi_co_ban(), brand: m.sp_thuong_hieu(), material: m.sp_chat_lieu(), barcode: m.sp_ma_vach_don_vi(), status: m.trang_thai(), availability: m.tinh_trang_hang(),
    clearance: m.crud_hang_clear(), listPrice: m.gia_ban_le(), standardCost: m.crud_gia_von(), minimumStock: m.dinh_muc_toi_thieu(), defaultVatRate: m.sp_thue_mac_dinh(),
    defaultLocationCode: m.sp_vi_tri_mac_dinh(), purchaseCurrency: m.sp_tien_te_mua(), purchasePrice: m.sp_gia_mua(), defaultSupplierId: m.sp_ncc_mac_dinh(),
    defaultSupplierName: m.sp_ncc_mac_dinh(), supplierItemCode: m.sp_ma_hang_ncc(), packSize: m.crud_quy_cach_thung(), innerPack: m.sp_hop_trong(), unitConversions: m.sp_quy_doi_don_vi(),
    cartonLengthCm: m.sp_dai(), cartonWidthCm: m.sp_rong(), cartonHeightCm: m.sp_cao(), grossKgPerCarton: m.sp_kg_ca_bi(), netKgPerCarton: m.sp_kg_tinh(),
    hsCode: m.sp_ma_hs(), customsName: m.sp_ten_hai_quan(), customsElements: m.sp_yeu_to_khai_bao(), specZh: m.sp_quy_cach_trung(), specEn: m.sp_quy_cach_anh(),
    specification: m.sp_mo_ta_viet(), descriptionZh: m.sp_mo_ta_trung(), descriptionEn: m.sp_mo_ta_anh(), primaryImageId: m.rw_anh_dai_dien(),
  });
  const actionLabels = $derived<Record<string, string>>({
    PRODUCT_CREATED: m.rw_tao_moi(), PRODUCT_UPDATED: m.rw_cap_nhat(), PRODUCT_DELETED: m.crud_xoa(),
    PRODUCT_FILE_UPLOADED: m.rw_tai_len_file(), PRODUCT_FILE_DELETED: m.rw_xoa_file(), PRODUCT_FILE_MALWARE_BLOCKED: m.rw_chan_ma_doc(),
  });
  const statusTone = (status: string) => (status === 'RECEIVED' || status === 'DELIVERED' ? 'success' : status === 'CANCELLED' ? 'neutral' : '');
</script>

<svelte:head><title>{title} · INOXPRAN ERP</title></svelte:head>

{#snippet text(key: FieldKey, label: string, options: { required?: boolean; hint?: string; maxlength?: number; inputmode?: 'numeric' | 'decimal' | 'text'; decimals?: number; span?: boolean; upper?: boolean } = {})}
  <div class="field" class:span={options.span}>
    <label for={`p-${key}`}>{label}{#if options.required} <span class="req">*</span>{/if}</label>
    {#if options.decimals !== undefined}
      <NumberInput id={`p-${key}`} bind:value={form[key]} decimals={options.decimals} readonly={!editable} aria-invalid={Boolean(errors[key])} />
    {:else}
      <input id={`p-${key}`} bind:value={form[key]} readonly={!editable} maxlength={options.maxlength ?? 240} inputmode={options.inputmode ?? 'text'} aria-invalid={Boolean(errors[key])}
        oninput={options.upper ? (event) => (form[key] = event.currentTarget.value.toUpperCase()) : undefined} />
    {/if}
    {#if errors[key]}<span class="error">{errors[key]}</span>{:else if options.hint}<span class="hint">{options.hint}</span>{/if}
  </div>
{/snippet}
{#snippet area(key: FieldKey, label: string, rows = 5)}
  <div class="field span">
    <label for={`p-${key}`}>{label}</label>
    <textarea id={`p-${key}`} bind:value={form[key]} readonly={!editable} {rows} maxlength="2000"></textarea>
  </div>
{/snippet}
{#snippet select(key: FieldKey, label: string, options: Array<{ value: string; label: string }>, blank = true)}
  <div class="field">
    <label for={`p-${key}`}>{label}</label>
    <select id={`p-${key}`} bind:value={form[key]} disabled={!editable}>
      {#if blank}<option value="">—</option>{/if}
      {#each options as option}<option value={option.value}>{option.label}</option>{/each}
    </select>
  </div>
{/snippet}

{#if error && !product}
  <div class="banner error"><CircleAlert size={17} /><span>{error}</span></div>
{:else if product}
  <RecordWindow
    {title}
    crumbs={[{ href: '/catalog/products', label: m.danh_muc_san_pham() }]}
    listKey="products"
    recordId={product.id}
    detailHref={(target) => `/catalog/products/${target}`}
    {dirty}
    {saving}
    {tabs}
    bind:tab
    onsave={editable ? save : undefined}
    onreset={editable ? () => { if (product) fill(product); errors = {}; error = ''; } : undefined}
    onnew={editable ? () => { copyFrom = null; createOpen = true; } : undefined}
    oncopy={editable ? () => { copyFrom = product; createOpen = true; } : undefined}
    ondelete={editable ? () => (deleteOpen = true) : undefined}
  >
    {#snippet badges()}
      {#if product}
        {#if product.status === 'INACTIVE'}<span class="pill neutral">{m.crud_ngung_kinh_doanh()}</span>
        {:else}{@const info = availabilityLabel[product.availability]}<span class={`pill ${info?.tone ?? ''}`}>{info?.label ?? product.availability}</span>{/if}
        {#if product.clearance}<span class="pill orange">{m.ma_hang_clear()}</span>{/if}
        <span class="muted">{m.ton_kha_dung()}: <b>{num(product.available ?? 0)}</b> {product.baseUnit}</span>
      {/if}
    {/snippet}
    {#snippet children(active)}
      {#if product}
      {#if error}<div class="banner error"><CircleAlert size={17} /><span>{error}</span>{#if conflict}<button class="btn small" onclick={load}><RefreshCw size={14} />{m.rw_tai_lai()}</button>{/if}</div>{/if}
      {#if success}<div class="banner success"><CircleCheck size={17} />{success}</div>{/if}
      {#if !editable && (active === 'main' || active === 'packing' || active === 'description')}<div class="banner">{m.rw_chi_xem()}</div>{/if}

      {#if active === 'main'}
        <RecordSection id="product-main" title={m.rw_thong_tin_chinh()}>
          <div class="grid">
            <div class="field"><label for="p-sku">{m.crud_ma_sku()}</label><input id="p-sku" value={product.sku} readonly /><span class="hint">{m.crud_sku_khong_doi()}</span></div>
            {@render text('model', m.crud_model_in(), { maxlength: 60 })}
            {@render text('name', m.ten_san_pham(), { required: true, span: true })}
            {@render text('nameZh', m.sp_ten_trung())}
            {@render text('nameEn', m.sp_ten_anh())}
            {@render select('categoryId', m.nhom_hang(), categories.filter((row) => row.status !== 'INACTIVE' || row.id === form.categoryId).map((row) => ({ value: row.id, label: row.name })))}
            {@render select('productType', m.sp_phan_loai(), ['FINISHED', 'SET', 'PART'].map((value) => ({ value, label: productTypeLabel(value) })))}
            {@render text('baseUnit', m.crud_don_vi_co_ban(), { required: true, maxlength: 30 })}
            {@render text('barcode', m.sp_ma_vach_don_vi(), { maxlength: 80 })}
            {@render text('brand', m.sp_thuong_hieu(), { maxlength: 80 })}
            {@render text('material', m.sp_chat_lieu(), { maxlength: 120 })}
            {@render select('status', m.trang_thai(), [{ value: 'ACTIVE', label: m.dang_hoat_dong() }, { value: 'INACTIVE', label: m.crud_ngung_kinh_doanh() }], false)}
            {@render select('availability', m.tinh_trang_hang(), Object.entries(availabilityLabel).map(([value, item]) => ({ value, label: item.label })), false)}
            <label class="check span"><input type="checkbox" bind:checked={clearance} disabled={!editable} />{m.crud_hang_clear()}</label>
          </div>
        </RecordSection>
        <RecordSection id="product-price" title={m.sp_gia_ton()}>
          <div class="grid">
            {@render text('listPrice', m.gia_ban_le(), { required: true, decimals: 0, hint: vnd(form.listPrice || 0) })}
            {@render text('standardCost', m.crud_gia_von(), { decimals: 0, hint: m.crud_gia_von_goi_y() })}
            {@render text('minimumStock', m.dinh_muc_toi_thieu(), { required: true, decimals: 0 })}
            {@render select('defaultVatRate', m.sp_thue_mac_dinh(), VAT_RATES.map((value) => ({ value, label: vatLabel(value) })))}
            {@render text('defaultLocationCode', m.sp_vi_tri_mac_dinh(), { maxlength: 40, upper: true, hint: m.sp_vi_tri_goi_y() })}
          </div>
        </RecordSection>
        <RecordSection id="product-purchase" title={m.sp_thong_tin_mua()}>
          <div class="grid">
            {@render select('defaultSupplierId', m.sp_ncc_mac_dinh(), suppliers.filter((row) => row.status !== 'INACTIVE' || row.id === form.defaultSupplierId).map((row) => ({ value: row.id, label: `${row.code} — ${row.name}` })))}
            {@render text('supplierItemCode', m.sp_ma_hang_ncc(), { maxlength: 60, hint: m.sp_ma_hang_ncc_goi_y() })}
            {@render select('purchaseCurrency', m.sp_tien_te_mua(), CURRENCIES.map((value) => ({ value, label: value })))}
            {@render text('purchasePrice', m.sp_gia_mua(), { decimals: 4, hint: form.purchaseCurrency ? m.sp_gia_mua_goi_y({ currency: form.purchaseCurrency, unit: form.baseUnit || '—' }) : '' })}
          </div>
        </RecordSection>
      {:else if active === 'packing'}
        <RecordSection id="product-packing" title={m.sp_dong_goi()} note={unitCbm ? m.sp_cbm_thung({ cbm: String(unitCbm) }) : ''}>
          <div class="grid three">
            {@render text('packSize', m.crud_quy_cach_thung(), { decimals: 0, hint: m.crud_quy_cach_thung_goi_y({ unit: form.baseUnit || '—' }) })}
            {@render text('innerPack', m.sp_hop_trong(), { decimals: 0 })}
            {@render text('cartonBarcode', m.crud_ma_vach_thung(), { maxlength: 80 })}
            {@render text('cartonLengthCm', m.sp_dai(), { decimals: 2 })}
            {@render text('cartonWidthCm', m.sp_rong(), { decimals: 2 })}
            {@render text('cartonHeightCm', m.sp_cao(), { decimals: 2 })}
            {@render text('grossKgPerCarton', m.sp_kg_ca_bi(), { decimals: 2 })}
            {@render text('netKgPerCarton', m.sp_kg_tinh(), { decimals: 2 })}
            <div class="field"><span class="label">{m.sp_the_tich_thung()}</span><output class="calc">{unitCbm ? `${unitCbm} m³` : '—'}</output></div>
          </div>
          {#if form.packSize && unitCbm}
            <p class="example">{m.sp_vi_du_dong_goi({ cartons: String(cartonsNeeded(1000, form.packSize)), unit: form.baseUnit, cbm: String(sample.cbm), kg: String(sample.grossKg) })}</p>
          {/if}
        </RecordSection>
        <RecordSection id="product-customs" title={m.sp_hai_quan()}>
          <div class="grid">
            {@render text('hsCode', m.sp_ma_hs(), { maxlength: 20, inputmode: 'numeric' })}
            {@render text('customsName', m.sp_ten_hai_quan())}
            {@render text('specZh', m.sp_quy_cach_trung())}
            {@render text('specEn', m.sp_quy_cach_anh())}
            {@render text('customsElements', m.sp_yeu_to_khai_bao(), { maxlength: 500, span: true })}
          </div>
        </RecordSection>
      {:else if active === 'description'}
        <RecordSection id="product-description" title={m.sp_mo_ta()}>
          <div class="grid">
            {@render area('specification', m.sp_mo_ta_viet())}
            {@render area('descriptionZh', m.sp_mo_ta_trung())}
            {@render area('descriptionEn', m.sp_mo_ta_anh())}
          </div>
        </RecordSection>
      {:else if active === 'attachments'}
        <AttachmentsPanel type="products" id={product.id} primaryId={product.primaryImageId ?? ''} onprimary={setPrimary} onchange={(count) => (attachmentCount = count)}
          purposes={[{ purpose: 'PRODUCT_IMAGE', label: m.sp_anh_san_pham(), pdf: false }, { purpose: 'PRODUCT_DOCUMENT', label: m.sp_tai_lieu_ky_thuat(), pdf: true }]} />
      {:else if active === 'stock'}
        <section class="card">
          <div class="table-wrap">
            <table class="table">
              <thead><tr><th>{m.kho()}</th><th>{m.sp_vi_tri()}</th><th class="num">{m.sp_ton_thuc_te()}</th><th class="num">{m.sp_dang_giu()}</th><th class="num">{m.ton_kha_dung()}</th></tr></thead>
              <tbody>
                {#each overview?.stock ?? [] as row}
                  <tr><td><b>{row.warehouseCode}</b><small>{row.warehouseName}</small></td><td>{row.locationCode ?? '—'}</td><td class="num">{num(row.onHand)}</td><td class="num">{num(row.reserved)}</td><td class="num"><b>{num(row.available)}</b></td></tr>
                {:else}<tr class="empty-row"><td colspan="5">{m.sp_chua_co_ton()}</td></tr>{/each}
              </tbody>
              {#if overview?.stock.length}<tfoot><tr><td colspan="2">{m.rw_tong_cong()}</td><td class="num">{num(product.onHand ?? 0)}</td><td></td><td class="num">{num(product.available ?? 0)}</td></tr></tfoot>{/if}
            </table>
          </div>
        </section>
      {:else if active === 'trade' && overview}
        <div class="kpis two">
          <div class="card kpi"><p class="label">{m.sp_mua_12_thang()}</p><p class="value">{num(overview.purchases.last12Months.quantity)} {product.baseUnit}</p><p class="note">{m.sp_so_don({ count: overview.purchases.last12Months.orders })} · {vnd(overview.purchases.last12Months.amount)}</p></div>
          <div class="card kpi"><p class="label">{m.sp_ban_12_thang()}</p><p class="value">{num(overview.sales.last12Months.quantity)} {product.baseUnit}</p><p class="note">{m.sp_so_don({ count: overview.sales.last12Months.orders })} · {vnd(overview.sales.last12Months.amount)}</p></div>
        </div>
        <RecordSection id="product-purchases" title={m.sp_lan_mua_gan_day()}>
          <div class="table-wrap">
            <table class="table">
              <thead><tr><th>{m.sp_so_don_mua()}</th><th>{m.ngay()}</th><th>{m.nha_cung_cap()}</th><th class="num">{m.so_luong()}</th><th class="num">{m.sp_don_gia()}</th><th>{m.trang_thai()}</th></tr></thead>
              <tbody>
                {#each overview.purchases.recent as row}
                  <tr><td><a class="link" href={`/procurement/${row.id}`}>{row.code}</a></td><td>{date(row.date)}</td><td>{row.supplierName}</td><td class="num">{num(row.quantity)} {row.unit}</td><td class="num">{row.currency === 'VND' ? vnd(row.unitCost) : `${row.unitCost} ${row.currency}`}</td><td><span class={`pill ${statusTone(row.status)}`}>{row.status}</span></td></tr>
                {:else}<tr class="empty-row"><td colspan="6">{m.sp_chua_mua()}</td></tr>{/each}
              </tbody>
            </table>
          </div>
        </RecordSection>
        <RecordSection id="product-sales" title={m.sp_lan_ban_gan_day()}>
          <div class="table-wrap">
            <table class="table">
              <thead><tr><th>{m.sp_so_phieu_ban()}</th><th>{m.ngay()}</th><th>{m.khach_hang()}</th><th class="num">{m.so_luong()}</th><th class="num">{m.sp_don_gia()}</th></tr></thead>
              <tbody>
                {#each overview.sales.recent as row}
                  <tr><td><a class="link" href={`/sales/orders/${row.id}`}>{row.code}</a></td><td>{date(row.date)}</td><td>{row.customerName}</td><td class="num">{num(row.quantity)} {row.unit}</td><td class="num">{vnd(row.unitPrice)}</td></tr>
                {:else}<tr class="empty-row"><td colspan="5">{m.sp_chua_ban()}</td></tr>{/each}
              </tbody>
            </table>
          </div>
        </RecordSection>
      {:else if active === 'history'}
        <HistoryPanel type="products" id={product.id} {fieldLabels} {actionLabels} reload={historyReload} />
      {/if}
      {/if}
    {/snippet}
  </RecordWindow>

  <ProductDialog bind:open={createOpen} product={null} template={copyFrom} {categories} onsaved={(saved) => goto(`/catalog/products/${saved.id}`)} />
  <ConfirmDelete bind:open={deleteOpen} name={`${product.sku} — ${product.name}`} ondelete={removeProduct} ondeactivate={product.status === 'ACTIVE' ? deactivate : undefined} />
{:else if loading}
  <div class="card skeleton" style="height: 320px"></div>
{/if}

<style>
  .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px 16px; align-items: start; }
  .grid.three { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .span { grid-column: 1 / -1; }
  .check { display: flex; align-items: center; gap: 8px; font-size: 13.5px; }
  .check input { width: 17px; height: 17px; accent-color: var(--navy); }
  .calc { display: flex; align-items: center; min-height: 42px; padding: 0 12px; border-radius: var(--radius-sm); background: var(--blue-soft); color: var(--navy); font-weight: 700; }
  .example { margin: 14px 0 0; color: var(--muted); font-size: 13px; }
  .kpis.two { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .banner .btn { margin-left: auto; }
  @media (max-width: 900px) { .grid.three { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  @media (max-width: 640px) { .grid, .grid.three, .kpis.two { grid-template-columns: 1fr; } }
</style>
