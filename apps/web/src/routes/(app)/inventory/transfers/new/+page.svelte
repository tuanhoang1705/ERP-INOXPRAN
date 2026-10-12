<script lang="ts">
  import { m } from '$lib/paraglide/messages';
  import type { InventoryBalance, Product, Warehouse } from '@inoxpran/contracts';
  import { onMount } from 'svelte';
  import { CircleAlert, CircleCheck, Plus, X } from 'lucide-svelte';
  import { api } from '$lib/api';
  import NumberInput from '$lib/components/NumberInput.svelte';

  type TransferLine = {
    productId: string;
    quantity: string;
    fromLocationCode: string;
    toLocationCode: string;
  };

  let warehouses = $state<Warehouse[]>([]);
  let products = $state<Product[]>([]);
  let balances = $state<InventoryBalance[]>([]);
  let fromWarehouseId = $state('');
  let toWarehouseId = $state('');
  let reason = $state(m.dieu_chuyen_bo_sung_ton_kho());
  let lines = $state<TransferLine[]>([
    { productId: '', quantity: '1', fromLocationCode: '', toLocationCode: '' },
  ]);
  let loadingStock = $state(false);
  let saving = $state(false);
  let error = $state('');
  let result = $state<{ id: string; code: string } | null>(null);

  onMount(async () => {
    try {
      [warehouses, products] = await Promise.all([
        api<Warehouse[]>('/warehouses'),
        api<Product[]>('/products?status=ACTIVE'),
      ]);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.khong_tai_duoc_du_lieu_danh();
    }
  });

  async function loadStock() {
    balances = [];
    if (!fromWarehouseId) return;
    loadingStock = true;
    try {
      balances = await api<InventoryBalance[]>(`/inventory/balances?warehouseId=${fromWarehouseId}`);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.khong_doc_duoc_ton_kha_dung();
    } finally {
      loadingStock = false;
    }
  }

  function productFor(productId: string) {
    return products.find((product) => product.id === productId);
  }

  function balanceFor(productId: string) {
    return balances.find((balance) => balance.productId === productId);
  }

  function canSubmit() {
    return Boolean(
      fromWarehouseId &&
      toWarehouseId &&
      fromWarehouseId !== toWarehouseId &&
      reason.trim().length >= 3 &&
      lines.length > 0 &&
      lines.every((line) => line.productId && Number(line.quantity) > 0),
    );
  }

  function addLine() {
    lines.push({ productId: '', quantity: '1', fromLocationCode: '', toLocationCode: '' });
  }

  async function submit() {
    if (!canSubmit()) return;
    saving = true;
    error = '';
    try {
      result = await api<{ id: string; code: string }>('/inventory/transfers', {
        method: 'POST',
        idempotentCommand: true,
        body: JSON.stringify({
          fromWarehouseId,
          toWarehouseId,
          reason: reason.trim(),
          lines: lines.map((line) => ({
            productId: line.productId,
            quantity: line.quantity,
            fromLocationCode: line.fromLocationCode.trim() || undefined,
            toLocationCode: line.toLocationCode.trim() || undefined,
          })),
        }),
      });
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.khong_the_ghi_nhan_chuyen_kho();
    } finally {
      saving = false;
    }
  }
</script>

<svelte:head><title>{m.chuyen_kho_inoxpran_erp()}</title></svelte:head>

<section class="page-head">
  <div>
    <nav class="crumbs" aria-label={m.duong_dan()}><a href="/inventory">{m.kho_giao_hang()}</a><span>{m.dieu_chuyen_kho()}</span></nav>
    <h1 class="page-title">{m.dieu_chuyen_kho()}</h1>
    <p class="page-sub">{m.xuat_kho_nguon_va_nhap_kho()}</p>
  </div>
  {#if !result}<div class="actions"><button class="btn primary" disabled={saving || !canSubmit()} onclick={submit}>{saving ? m.dang_ghi_so() : m.ghi_nhan_chuyen_kho()}</button></div>{/if}
</section>

{#if warehouses.length > 0 && warehouses.length < 2}
  <div class="banner warning"><CircleAlert size={17} /><span>{m.hien_chi_co_mot_kho_dang()}</span></div>
{/if}
{#if error}<div class="banner error"><CircleAlert size={17} />{error}</div>{/if}

{#if result}
  <div class="banner success"><CircleCheck size={17} /><span>{m.da_ghi_so_phieu()} {result.code}{m.kho_nguon_giam_va_kho_dich()} <a class="link" href="/inventory">{m.xem_ton_kho()}</a></span></div>
{:else}
  <section class="card block">
    <div class="grid">
      <div class="field"><label for="from-warehouse">{m.kho_nguon()}</label><select id="from-warehouse" bind:value={fromWarehouseId} onchange={loadStock}><option value="">{m.chon_kho_xuat()}</option>{#each warehouses as warehouse}<option value={warehouse.id} disabled={warehouse.id === toWarehouseId}>{warehouse.code} — {warehouse.name}</option>{/each}</select></div>
      <div class="field"><label for="to-warehouse">{m.kho_dich()}</label><select id="to-warehouse" bind:value={toWarehouseId}><option value="">{m.chon_kho_nhan()}</option>{#each warehouses as warehouse}<option value={warehouse.id} disabled={warehouse.id === fromWarehouseId}>{warehouse.code} — {warehouse.name}</option>{/each}</select></div>
    </div>
  </section>

  <section class="card block">
    <header class="card-head head"><h2>{m.hang_dieu_chuyen()}</h2><button class="btn soft small" onclick={addLine}><Plus size={15} />{m.them_dong()}</button></header>
    <div class="table-wrap">
      <table class="table">
        <thead><tr><th>{m.san_pham()}</th><th class="num">{m.kha_dung()}</th><th class="num">{m.so_luong()}</th><th>{m.vi_tri_nguon()}</th><th>{m.vi_tri_dich()}</th><th></th></tr></thead>
        <tbody>
          {#each lines as line, index}
            {@const product = productFor(line.productId)}
            {@const balance = balanceFor(line.productId)}
            <tr>
              <td><select class="input product" aria-label={m.san_pham_dong({ p0: index + 1 })} bind:value={line.productId}><option value="">{m.chon_ma_hang()}</option>{#each products as item}<option value={item.id}>{item.sku} — {item.name}</option>{/each}</select></td>
              <td class="num" class:bad={Number(line.quantity) > Number(balance?.available ?? 0)}>{product ? `${balance?.available ?? '0'} ${product.baseUnit.toLowerCase()}` : ''}</td>
              <td class="num"><NumberInput class="input qty" decimals={4} aria-label={m.so_luong_dong({ p0: index + 1 })} bind:value={line.quantity} /></td>
              <td><input class="input loc" aria-label={m.vi_tri_nguon_dong({ p0: index + 1 })} maxlength="40" bind:value={line.fromLocationCode} placeholder={m.vd_vi_tri_a1_01()} /></td>
              <td><input class="input loc" aria-label={m.vi_tri_dich_dong({ p0: index + 1 })} maxlength="40" bind:value={line.toLocationCode} placeholder={m.vd_vi_tri_b1_02()} /></td>
              <td><button class="remove" disabled={lines.length === 1} onclick={() => lines.splice(index, 1)} aria-label={m.xoa_dong({ p0: index + 1 })}><X size={14} /></button></td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
    <div class="field reason"><label for="reason">{m.ly_do_dieu_chuyen()}</label><textarea id="reason" rows="3" maxlength="500" bind:value={reason}></textarea>{#if loadingStock}<span class="hint">{m.dang_doc_ton_kha_dung()}</span>{/if}</div>
  </section>
{/if}

<style>
  .block { margin-bottom: 18px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; padding: 20px; }
  .head { padding-bottom: 14px; }
  .product { min-width: 320px; }
  td :global(.qty) { width: 100px; text-align: center; }
  .loc { width: 130px; }
  .bad { color: var(--red); font-weight: 700; }
  .remove { display: grid; width: 26px; height: 26px; place-items: center; border-radius: 50%; background: var(--red-soft); color: var(--red); }
  .remove:disabled { opacity: 0.35; }
  .reason { padding: 16px 20px 20px; }
  @media (max-width: 760px) { .grid { grid-template-columns: 1fr; } }
</style>
