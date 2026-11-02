<script lang="ts">
  /**
   * Sửa thông tin tiếp nhận phiếu bảo hành (PATCH /warranty/tickets/:id — 20/10/2026): phiếu chưa trả / chưa hủy, bắt buộc lý do,
   * lịch sử ghi trường cũ → mới. Sản phẩm, hóa đơn, ngày tiếp nhận (quyết định diện bảo hành) chỉ sửa khi phiếu còn "Đã tiếp nhận".
   * Ngày hẹn trả sửa bằng "Dời hẹn".
   */
  import type { Product, WarrantyTicket } from '@inoxpran/contracts';
  import { untrack } from 'svelte';
  import { CircleAlert, Info } from 'lucide-svelte';
  import { m } from '$lib/paraglide/messages';
  import { api } from '$lib/api';
  import { todayIso } from '$lib/format';
  import { channelText } from '$lib/warranty';
  import { WARRANTY_CHANNELS, type WarrantyChannel } from '$shared/warranty';
  import Dialog from './Dialog.svelte';

  type Dealer = { id: string; code: string; name: string; phone?: string; address?: string; status: string };
  type Technician = { id: string; displayName: string };
  type Ticket = WarrantyTicket;

  let { open = $bindable(false), ticket, onsaved }: { open?: boolean; ticket: Ticket; onsaved?: (next: Ticket) => void } = $props();

  let dealers = $state<Dealer[]>([]);
  let products = $state<Product[]>([]);
  let technicians = $state<Technician[]>([]);
  let error = $state('');
  let saving = $state(false);
  let form = $state({
    channel: 'DEALER' as WarrantyChannel, customerId: '', customerName: '', customerPhone: '', customerAddress: '', productId: '', serial: '',
    noInvoice: false, noInvoiceDecision: '' as '' | 'WARRANTY' | 'PAID', declaredPurchaseDate: '', invoiceNumber: '', invoiceDate: '', receivedDate: '', technicianId: '', accessories: '', condition: '', loaner: '', symptom: '', reason: '',
  });
  /** Đã chẩn đoán: không đổi sản phẩm / hóa đơn / ngày tiếp nhận. */
  const locked = $derived(ticket.status !== 'RECEIVED');
  const productOptions = $derived(products.some((row) => row.id === ticket.product.productId) ? products : [{ id: ticket.product.productId, sku: ticket.product.sku, name: ticket.product.name } as Product, ...products]);

  $effect(() => {
    if (!open) return;
    untrack(() => {
      form = {
        channel: ticket.channel,
        customerId: ticket.customer.partnerId ?? '',
        customerName: ticket.customer.name,
        customerPhone: ticket.customer.phone ?? '',
        customerAddress: ticket.customer.address ?? '',
        productId: ticket.product.productId,
        serial: ticket.product.serial ?? '',
        noInvoice: !ticket.invoice,
        noInvoiceDecision: ticket.invoice ? '' : ticket.invoicelessWarranty ? 'WARRANTY' : 'PAID',
        declaredPurchaseDate: ticket.declaredPurchaseDate ?? '',
        invoiceNumber: ticket.invoice?.number ?? '',
        invoiceDate: ticket.invoice?.date ?? '',
        receivedDate: ticket.receivedDate,
        technicianId: ticket.technicianId ?? '',
        accessories: ticket.accessories ?? '',
        condition: ticket.condition ?? '',
        loaner: ticket.loaner ?? '',
        symptom: ticket.lines[0]?.symptom ?? '',
        reason: '',
      };
      error = '';
      if (!dealers.length) {
        void Promise.all([api<{ rows: Dealer[] }>('/dealers'), api<Product[]>('/products?status=ACTIVE'), api<Technician[]>('/warranty/technicians')])
          .then(([dealerResult, productRows, technicianRows]) => {
            dealers = dealerResult.rows.filter((row) => row.status !== 'INACTIVE' || row.id === ticket.customer.partnerId);
            products = productRows;
            technicians = technicianRows;
          })
          .catch((caught) => (error = caught instanceof Error ? caught.message : m.wr_load_error()));
      }
    });
  });

  function chooseDealer(id: string) {
    form.customerId = id;
    const dealer = dealers.find((row) => row.id === id);
    if (!dealer) return;
    form.customerName = dealer.name;
    form.customerPhone = dealer.phone ?? '';
    form.customerAddress = dealer.address ?? '';
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    error = '';
    if (form.reason.trim().length < 3) {
      error = m.inv_ghi_chu_toi_thieu();
      return;
    }
    saving = true;
    const optional = (value: string) => value.trim() || undefined;
    try {
      const next = await api<Ticket>(`/warranty/tickets/${ticket.id}`, {
        method: 'PATCH',
        idempotentCommand: true,
        body: JSON.stringify({
          version: ticket.version,
          reason: form.reason.trim(),
          channel: form.channel,
          customerId: form.customerId || undefined,
          customerName: form.customerName.trim(),
          customerPhone: optional(form.customerPhone),
          customerAddress: optional(form.customerAddress),
          productId: form.productId,
          serial: optional(form.serial),
          invoiceNumber: form.noInvoice ? undefined : optional(form.invoiceNumber),
          invoiceDate: form.noInvoice || !form.invoiceDate ? undefined : form.invoiceDate,
          noInvoiceWarranty: form.noInvoice ? form.noInvoiceDecision === 'WARRANTY' : undefined,
          declaredPurchaseDate: form.noInvoice && form.declaredPurchaseDate ? form.declaredPurchaseDate : undefined,
          receivedDate: form.receivedDate,
          technicianId: form.technicianId || undefined,
          accessories: optional(form.accessories),
          condition: optional(form.condition),
          loaner: optional(form.loaner),
          symptom: form.symptom.trim(),
        }),
      });
      open = false;
      onsaved?.(next);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.wr_load_error();
    } finally {
      saving = false;
    }
  }
</script>

<Dialog bind:open title={m.wr_edit_title({ code: ticket.code })} wide>
  <form id="warranty-edit" class="grid" onsubmit={submit}>
    {#if error}<div class="banner error span"><CircleAlert size={17} /><span>{error}</span></div>{/if}
    {#if locked}<p class="lock span"><Info size={16} />{m.wr_edit_locked_hint()}</p>{/if}
    <div class="field">
      <label for="we-channel">{m.wr_channel()}</label>
      <select id="we-channel" bind:value={form.channel}>{#each WARRANTY_CHANNELS as item}<option value={item}>{channelText(item)}</option>{/each}</select>
    </div>
    <div class="field wide">
      <label for="we-dealer">{m.wr_dealer()}</label>
      <select id="we-dealer" value={form.customerId} onchange={(event) => chooseDealer(event.currentTarget.value)}>
        <option value="">{m.wr_retail_customer()}</option>
        {#each dealers as row}<option value={row.id}>{row.code} — {row.name}</option>{/each}
      </select>
    </div>
    <div class="field"><label for="we-name">{m.wr_customer_name()} <span class="req">*</span></label><input id="we-name" bind:value={form.customerName} required minlength="2" maxlength="240" /></div>
    <div class="field"><label for="we-phone">{m.dien_thoai()}</label><input id="we-phone" type="tel" bind:value={form.customerPhone} maxlength="30" /></div>
    <div class="field"><label for="we-address">{m.dia_chi()}</label><input id="we-address" bind:value={form.customerAddress} maxlength="500" /></div>
    <div class="field wide">
      <label for="we-product">{m.wr_product()} <span class="req">*</span></label>
      <select id="we-product" bind:value={form.productId} required disabled={locked}>
        {#each productOptions as row}<option value={row.id}>{row.sku} — {row.name}</option>{/each}
      </select>
    </div>
    <div class="field"><label for="we-serial">{m.wr_serial()}</label><input id="we-serial" bind:value={form.serial} maxlength="80" /></div>
    {#if !form.noInvoice}
      <div class="field"><label for="we-invoice">{m.wr_invoice_no()} <span class="req">*</span></label><input id="we-invoice" bind:value={form.invoiceNumber} maxlength="40" disabled={locked} required /></div>
      <div class="field"><label for="we-invoice-date">{m.wr_invoice_date()} <span class="req">*</span></label><input id="we-invoice-date" type="date" bind:value={form.invoiceDate} max={form.receivedDate} disabled={locked} required /></div>
    {/if}
    <label class="check"><input type="checkbox" bind:checked={form.noInvoice} disabled={locked} />{m.wr_no_invoice()}</label>
    {#if form.noInvoice}
      <fieldset class="decision wide" disabled={locked}>
        <legend>{m.wr_noinv_decision()} <span class="req">*</span></legend>
        <label><input type="radio" name="we-no-invoice-decision" value="WARRANTY" bind:group={form.noInvoiceDecision} required />{m.wr_noinv_warranty()}</label>
        <label><input type="radio" name="we-no-invoice-decision" value="PAID" bind:group={form.noInvoiceDecision} />{m.wr_noinv_paid()}</label>
      </fieldset>
      <div class="field"><label for="we-declared">{m.wr_noinv_declared_date()}</label><input id="we-declared" type="date" bind:value={form.declaredPurchaseDate} max={form.receivedDate} disabled={locked} /></div>
    {/if}
    <div class="field"><label for="we-received">{m.wr_received_date()} <span class="req">*</span></label><input id="we-received" type="date" bind:value={form.receivedDate} max={todayIso()} required disabled={locked} /></div>
    <div class="field">
      <label for="we-technician">{m.wr_technician()}</label>
      <select id="we-technician" bind:value={form.technicianId}>
        <option value="">—</option>
        {#each technicians as row}<option value={row.id}>{row.displayName}</option>{/each}
      </select>
    </div>
    <div class="field span"><label for="we-symptom">{m.wr_symptom()} <span class="req">*</span></label><textarea id="we-symptom" rows="2" bind:value={form.symptom} required minlength="3" maxlength="500"></textarea></div>
    <div class="field"><label for="we-accessories">{m.wr_accessories()}</label><input id="we-accessories" bind:value={form.accessories} maxlength="300" /></div>
    <div class="field"><label for="we-condition">{m.wr_condition()}</label><input id="we-condition" bind:value={form.condition} maxlength="300" /></div>
    <div class="field"><label for="we-loaner">{m.wr_loaner()}</label><input id="we-loaner" bind:value={form.loaner} maxlength="200" /></div>
    <div class="field span"><label for="we-reason">{m.wr_edit_reason()} <span class="req">*</span></label><input id="we-reason" bind:value={form.reason} maxlength="300" required minlength="3" /></div>
  </form>
  {#snippet footer()}
    <button type="button" class="btn" onclick={() => (open = false)}>{m.huy()}</button>
    <button type="submit" class="btn primary" form="warranty-edit" disabled={saving}>{saving ? m.kh_dang_luu() : m.inv_luu_thay_doi()}</button>
  {/snippet}
</Dialog>

<style>
  .grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px 16px; align-items: start; }
  .span { grid-column: 1 / -1; }
  .wide { grid-column: span 2; }
  .req { color: var(--red); }
  .check { display: flex; align-items: center; gap: 8px; align-self: center; font-size: 13.5px; }
  .decision { display: flex; flex-wrap: wrap; gap: 8px 22px; margin: 0; padding: 10px 14px; border: 1px solid var(--line); border-radius: var(--radius-sm); }
  .decision legend { padding: 0 4px; color: var(--muted); font-size: 12.5px; font-weight: 600; }
  .decision label { display: flex; align-items: center; gap: 8px; font-size: 13.5px; cursor: pointer; }
  .lock { display: flex; align-items: flex-start; gap: 8px; margin: 0; padding: 10px 12px; border-radius: var(--radius-sm); background: var(--amber-soft); color: var(--amber); font-size: 13px; }
  @media (max-width: 760px) { .grid { grid-template-columns: 1fr; } .wide { grid-column: auto; } }
</style>
