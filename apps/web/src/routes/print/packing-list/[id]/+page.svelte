<script lang="ts">
  /** Packing list song ngữ Anh – Trung (装箱单) từ đơn mua, hoặc từ lô hàng nhập khi id dạng "shipment-<id>". */
  import { page } from '$app/state';
  import { onMount } from 'svelte';
  import { m } from '$lib/paraglide/messages';
  import { api } from '$lib/api';
  import type { PurchaseOrderDetail } from '$lib/purchase';
  import type { ShipmentDetail } from '$lib/components/record/ImportShipmentRecord.svelte';
  import PurchaseSheet, { type SheetHeader, type SheetLine } from '$lib/components/print/PurchaseSheet.svelte';
  import { orderSheet, shipmentSheet } from '$lib/purchase-print';

  let data = $state<{ header: SheetHeader; lines: SheetLine[] } | null>(null);
  let error = $state('');

  onMount(async () => {
    try {
      const id = page.params.id ?? '';
      if (id.startsWith('shipment-')) {
        const shipment = await api<ShipmentDetail>(`/import-shipments/${id.slice('shipment-'.length)}`);
        const first = shipment.purchaseOrders[0];
        const order = first ? await api<PurchaseOrderDetail & { supplier?: { name: string; address?: string; phone?: string } }>(`/purchase-orders/${first.id}`) : null;
        data = shipmentSheet(shipment, order);
      } else {
        data = orderSheet(await api<PurchaseOrderDetail & { supplier?: { name: string; address?: string; phone?: string } }>(`/purchase-orders/${id}`), 'packing');
      }
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.rw_loi_tai();
    }
  });
</script>

<svelte:head><title>{data?.header.number ?? 'Packing list'} — Packing list</title></svelte:head>

<div class="toolbar">
  <span>Packing list / 装箱单{data ? ` · ${data.header.number}` : ''}</span>
  <button class="primary" onclick={() => window.print()} disabled={!data}>{m.in_phieu()}</button>
  <button onclick={() => window.close()}>{m.dong()}</button>
</div>
{#if error}<p class="error">{error}</p>{:else if data}<PurchaseSheet header={data.header} lines={data.lines} />{/if}

<style>
  :global(body) { background: #e9edf2; }
  .toolbar { position: sticky; top: 0; z-index: 2; display: flex; align-items: center; gap: 10px; padding: 10px 24px; background: #123b5e; color: #fff; font: 500 13.5px/1.4 Inter, system-ui, sans-serif; }
  .toolbar span { margin-right: auto; }
  .toolbar button { padding: 7px 16px; border: 1px solid rgba(255, 255, 255, 0.35); border-radius: 7px; background: transparent; color: #fff; font: inherit; cursor: pointer; }
  .toolbar button.primary { border-color: #e2703a; background: #e2703a; }
  .error { margin: 32px; font: 14px Inter, system-ui, sans-serif; }
  @media print { :global(html), :global(body) { background: #fff !important; } .toolbar { display: none; } }
</style>
