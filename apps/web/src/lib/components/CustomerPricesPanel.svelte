<script lang="ts">
  /**
   * Giá riêng của khách (PRI-CUST-01, 31/10/2026): giá chốt từng mã (gồm VAT như bảng giá, theo đơn vị cơ bản). Phiếu BH của khách
   * tự lấy giá này, không chiết khấu thêm. Kế toán / Admin thêm từng mã hoặc dán 2 cột "mã SP – giá" từ Excel; người khác chỉ xem.
   */
  import type { CustomerPriceRow } from '@inoxpran/contracts';
  import { CircleAlert, CircleCheck, ClipboardPaste, Plus, Trash2 } from 'lucide-svelte';
  import { m } from '$lib/paraglide/messages';
  import { api, ApiRequestError } from '$lib/api';
  import { dateTime, num, vnd } from '$lib/format';
  import Dialog from '$lib/components/Dialog.svelte';
  import NumberInput from '$lib/components/NumberInput.svelte';

  type Product = { id: string; sku: string; name: string; baseUnit: string };
  type Draft = { productId: string; sku: string; productName: string; unit: string; unitPrice: string; tierPrice?: string; tierDiscountRate?: string; updatedAt?: string; updatedByName?: string };

  let { partnerId, editable = false, oncount }: { partnerId: string; editable?: boolean; oncount?: (count: number) => void } = $props();

  let rows = $state<Draft[]>([]);
  let baseline = $state('');
  let removed = $state<string[]>([]);
  let products = $state<Product[]>([]);
  let search = $state('');
  let loading = $state(true);
  let saving = $state(false);
  let error = $state('');
  let success = $state('');
  let pasteOpen = $state(false);
  let pasteText = $state('');

  const dirty = $derived(JSON.stringify(rows.map((row) => [row.productId, row.unitPrice])) !== baseline || removed.length > 0);
  const fold = (text: string) => text.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toLowerCase();
  const suggestions = $derived(search.trim().length < 2 ? [] : products
    .filter((product) => !rows.some((row) => row.productId === product.id))
    .filter((product) => fold(`${product.sku} ${product.name}`).includes(fold(search.trim())))
    .slice(0, 8));
  const bySku = $derived(new Map(products.map((product) => [product.sku.toUpperCase(), product])));
  /** Dòng dán từ Excel: mã ở cột 1, giá ở cột cuối (bỏ dấu chấm / phẩy ngăn cách nghìn). */
  const pasted = $derived(pasteText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const cells = line.split(/\t|;|\s{2,}/).map((cell) => cell.trim()).filter(Boolean);
    const sku = (cells[0] ?? '').toUpperCase();
    const price = (cells[cells.length - 1] ?? '').replace(/[.,\s](?=\d{3}(\D|$))/g, '').replace(',', '.').replace(/[^\d.]/g, '');
    const product = bySku.get(sku);
    return { sku, price, product, ok: Boolean(product) && Number(price) > 0 };
  }).filter((row) => !/^(MA|MÃ|SKU)/i.test(row.sku)));

  function fromServer(list: CustomerPriceRow[]) {
    rows = list.map((row) => ({ ...row, unitPrice: String(Number(row.unitPrice)) }));
    baseline = JSON.stringify(rows.map((row) => [row.productId, row.unitPrice]));
    removed = [];
    oncount?.(list.length);
  }

  async function load() {
    loading = true;
    error = '';
    try {
      fromServer(await api<CustomerPriceRow[]>(`/partners/${partnerId}/prices`));
      if (editable && !products.length) {
        products = (await api<Array<{ id: string; sku: string; name: string; baseUnit: string }>>('/products?status=ACTIVE')).map((row) => ({ id: row.id, sku: row.sku, name: row.name, baseUnit: row.baseUnit }));
      }
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.rw_loi_tai();
    } finally {
      loading = false;
    }
  }
  $effect(() => {
    void partnerId;
    void load();
  });

  function add(product: Product, unitPrice = '') {
    const existing = rows.find((row) => row.productId === product.id);
    if (existing) {
      if (unitPrice) existing.unitPrice = unitPrice;
      return;
    }
    rows = [...rows, { productId: product.id, sku: product.sku, productName: product.name, unit: product.baseUnit, unitPrice }];
    removed = removed.filter((id) => id !== product.id);
    search = '';
  }
  function remove(row: Draft) {
    rows = rows.filter((item) => item.productId !== row.productId);
    if (row.updatedAt) removed = [...removed, row.productId];
  }
  function applyPaste() {
    for (const row of pasted) if (row.ok && row.product) add(row.product, String(Number(row.price)));
    pasteOpen = false;
    pasteText = '';
  }

  async function save() {
    error = '';
    success = '';
    if (rows.some((row) => !(Number(row.unitPrice) > 0))) {
      error = m.gr_gia_phai_lon_hon_0();
      return;
    }
    saving = true;
    try {
      const result = await api<CustomerPriceRow[]>(`/partners/${partnerId}/prices`, {
        method: 'PUT',
        body: JSON.stringify({ upsert: rows.map((row) => ({ productId: row.productId, unitPrice: String(row.unitPrice) })), remove: removed }),
      });
      fromServer(result);
      success = m.gr_da_luu({ count: result.length });
    } catch (caught) {
      error = caught instanceof ApiRequestError || caught instanceof Error ? caught.message : m.crud_loi_luu();
    } finally {
      saving = false;
    }
  }

  const diff = (row: Draft) => {
    const tier = Number(row.tierPrice ?? 0) * (1 - Number(row.tierDiscountRate ?? 0) / 100);
    return tier > 0 && Number(row.unitPrice) > 0 ? ((Number(row.unitPrice) - tier) / tier) * 100 : null;
  };
</script>

<section class="card prices">
  <header class="card-head head">
    <div><h2>{m.gr_tieu_de()}</h2><p class="muted">{m.gr_giai_thich()}</p></div>
    {#if editable}
      <div class="tools">
        <button class="btn small" onclick={() => { pasteText = ''; pasteOpen = true; }}><ClipboardPaste size={14} />{m.gr_dan_excel()}</button>
        <button class="btn small primary" disabled={!dirty || saving} onclick={save}>{saving ? m.kh_dang_luu() : m.crud_luu()}</button>
      </div>
    {/if}
  </header>
  {#if error}<div class="banner error"><CircleAlert size={17} /><span>{error}</span></div>{/if}
  {#if success}<div class="banner success"><CircleCheck size={17} />{success}</div>{/if}
  {#if editable}
    <div class="add">
      <input id="gr-search" class="input" bind:value={search} placeholder={m.gr_tim_ma()} aria-label={m.gr_tim_ma()} autocomplete="off" />
      {#if suggestions.length}
        <div class="suggest">
          {#each suggestions as product (product.id)}
            <button type="button" onclick={() => add(product)}><Plus size={13} /><b>{product.sku}</b><span>{product.name}</span></button>
          {/each}
        </div>
      {/if}
    </div>
  {/if}
  <div class="table-wrap">
    <table class="table">
      <thead><tr><th>{m.ma_sp()}</th><th>{m.ten_san_pham()}</th><th>{m.dvt()}</th><th class="num">{m.gr_gia_cap()}</th><th class="num">{m.gr_gia_rieng()}</th><th class="num">{m.gr_chenh_lech()}</th><th>{m.gr_cap_nhat()}</th>{#if editable}<th></th>{/if}</tr></thead>
      <tbody>
        {#if loading}<tr class="empty-row"><td colspan="8">{m.dang_tai()}</td></tr>
        {:else if rows.length}
          {#each rows as row (row.productId)}
            {@const delta = diff(row)}
            <tr>
              <td class="code">{row.sku}</td>
              <td>{row.productName}</td>
              <td>{row.unit}</td>
              <td class="num muted">{row.tierPrice ? vnd(row.tierPrice) : '—'}{#if Number(row.tierDiscountRate ?? 0) > 0}<small>−{num(row.tierDiscountRate)}%</small>{/if}</td>
              <td class="num">{#if editable}<NumberInput class="input price" decimals={2} bind:value={row.unitPrice} aria-label={m.gr_gia_rieng_sku({ sku: row.sku })} />{:else}<b>{vnd(row.unitPrice)}</b>{/if}</td>
              <td class="num muted">{delta === null ? '—' : `${delta > 0 ? '+' : ''}${delta.toFixed(1)}%`}</td>
              <td class="muted nowrap">{row.updatedAt ? `${dateTime(row.updatedAt)} · ${row.updatedByName ?? ''}` : m.gr_chua_luu()}</td>
              {#if editable}<td class="row-actions"><button class="icon-btn danger" aria-label={`${m.crud_xoa()} ${row.sku}`} onclick={() => remove(row)}><Trash2 size={15} /></button></td>{/if}
            </tr>
          {/each}
        {:else}<tr class="empty-row"><td colspan="8">{m.gr_chua_co()}</td></tr>{/if}
      </tbody>
    </table>
  </div>
</section>

<Dialog bind:open={pasteOpen} title={m.gr_dan_excel()} wide>
  <div class="paste">
    <p class="muted">{m.gr_dan_huong_dan()}</p>
    <textarea class="input" rows="8" bind:value={pasteText} placeholder={'INP1001\t1250000\nINP6005\t890000'} aria-label={m.gr_dan_excel()}></textarea>
    {#if pasted.length}
      <div class="table-wrap preview">
        <table class="table">
          <thead><tr><th>{m.ma_sp()}</th><th>{m.ten_san_pham()}</th><th class="num">{m.gr_gia_rieng()}</th></tr></thead>
          <tbody>
            {#each pasted as row, index (index)}
              <tr class:bad={!row.ok}><td class="code">{row.sku}</td><td>{row.product?.name ?? m.gr_khong_co_ma()}</td><td class="num">{Number(row.price) > 0 ? vnd(row.price) : m.gr_gia_sai()}</td></tr>
            {/each}
          </tbody>
        </table>
      </div>
      <p class="muted">{m.gr_dan_tong({ ok: pasted.filter((row) => row.ok).length, bad: pasted.filter((row) => !row.ok).length })}</p>
    {/if}
  </div>
  {#snippet footer()}
    <button class="btn" onclick={() => (pasteOpen = false)}>{m.dong()}</button>
    <button class="btn primary" disabled={!pasted.some((row) => row.ok)} onclick={applyPaste}>{m.gr_ap_dung()}</button>
  {/snippet}
</Dialog>

<style>
  .prices .head { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: 12px; }
  .prices .head p { margin: 4px 0 0; font-size: 12.5px; }
  .tools { display: flex; gap: 8px; }
  .add { position: relative; padding: 0 20px 12px; }
  .add input { width: min(420px, 100%); }
  .suggest { position: absolute; z-index: 5; top: 44px; left: 20px; display: grid; width: min(520px, calc(100% - 40px)); max-height: 280px; overflow: auto; border: 1px solid var(--line); border-radius: 8px; background: var(--surface); box-shadow: 0 8px 24px rgba(18, 59, 94, 0.12); }
  .suggest button { display: grid; grid-template-columns: auto 90px 1fr; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--line-soft); text-align: left; font-size: 13px; }
  .suggest button:hover { background: var(--surface-2); }
  .suggest span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); }
  td :global(.price) { width: 140px; text-align: right; }
  td small { display: block; font-size: 11.5px; }
  .paste { display: grid; gap: 10px; }
  .paste textarea { min-height: 150px; font-family: ui-monospace, monospace; font-size: 13px; }
  .preview { max-height: 260px; overflow: auto; }
  tr.bad td { color: var(--red); }
</style>
