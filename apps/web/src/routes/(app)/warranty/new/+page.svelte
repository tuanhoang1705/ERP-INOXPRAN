<script lang="ts">
  import { m } from '$lib/paraglide/messages';
  import type { Product, WarrantyTicket } from '@inoxpran/contracts';
  import { goto } from '$app/navigation';
  import { onMount } from 'svelte';
  import { CircleAlert, CircleCheck, Info, TriangleAlert } from 'lucide-svelte';
  import { api } from '$lib/api';
  import { date, dateTime, todayIso } from '$lib/format';
  import { channelText } from '$lib/warranty';
  import { addDays, daysBetween, slaState, WARRANTY_CHANNELS, WARRANTY_DEFAULTS, type WarrantyChannel } from '$shared/warranty';

  type Dealer = { id: string; code: string; name: string; phone?: string; address?: string; status: string };
  type Technician = { id: string; displayName: string };
  type Coverage = {
    coverage: string; exclusion?: string; startsOn?: string; expiresOn?: string; months: number; priorServiceCount: number; extensionDays: number;
    invoiceless?: boolean; declaredExpired?: boolean;
  };

  let dealers = $state<Dealer[]>([]);
  let products = $state<Product[]>([]);
  let technicians = $state<Technician[]>([]);
  let settings = $state({ warrantyMonths: WARRANTY_DEFAULTS.warrantyMonths, turnaroundDays: WARRANTY_DEFAULTS.turnaroundDays, warningRatio: WARRANTY_DEFAULTS.warningRatio });
  let error = $state('');
  let saving = $state(false);

  let channel = $state<WarrantyChannel>('DEALER');
  let customerId = $state('');
  let customerName = $state('');
  let customerPhone = $state('');
  let customerAddress = $state('');
  let productId = $state('');
  let serial = $state('');
  let noInvoice = $state(false);
  /** Không hóa đơn: nhân viên chọn vẫn bảo hành hay sửa có tính phí (WAR-NOINV-01) — không chọn sẵn. */
  let noInvoiceDecision = $state<'' | 'WARRANTY' | 'PAID'>('');
  let declaredPurchaseDate = $state('');
  let invoiceNumber = $state('');
  let invoiceDate = $state('');
  const invoiceComplete = $derived(Boolean(invoiceNumber.trim() && invoiceDate));
  let receivedDate = $state(todayIso());
  let promisedDate = $state(addDays(todayIso(), WARRANTY_DEFAULTS.turnaroundDays));
  let promisedTouched = $state(false);
  let technicianId = $state('');
  let symptom = $state('');
  let accessories = $state('');
  let condition = $state('');
  let loaner = $state('');
  let coverage = $state<Coverage | null>(null);

  const turnaround = $derived(Math.max(0, daysBetween(receivedDate, promisedDate)));
  // Mốc chuyển vàng tính đúng như máy chủ: tiếp nhận hôm nay = bây giờ, ngày khác = 08:00 ngày đó.
  const schedule = $derived(
    receivedDate && promisedDate >= receivedDate
      ? slaState({ receivedAt: receivedDate === todayIso() ? new Date() : new Date(`${receivedDate}T08:00:00+07:00`), promisedDate, now: new Date(), warningRatio: settings.warningRatio })
      : null,
  );

  onMount(async () => {
    try {
      const [dealerResult, productRows, technicianRows, settingRows] = await Promise.all([
        api<{ rows: Dealer[] }>('/dealers'),
        api<Product[]>('/products?status=ACTIVE'),
        api<Technician[]>('/warranty/technicians'),
        api<typeof settings>('/warranty/settings'),
      ]);
      dealers = dealerResult.rows.filter((row) => row.status !== 'INACTIVE');
      products = productRows;
      technicians = technicianRows;
      settings = settingRows;
      if (!promisedTouched) promisedDate = addDays(receivedDate, settings.turnaroundDays);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.wr_load_error();
    }
  });

  function chooseDealer(id: string) {
    customerId = id;
    const dealer = dealers.find((row) => row.id === id);
    customerName = dealer?.name ?? '';
    customerPhone = dealer?.phone ?? '';
    customerAddress = dealer?.address ?? '';
  }

  function changeReceived(value: string) {
    receivedDate = value;
    if (!promisedTouched) promisedDate = addDays(value, settings.turnaroundDays);
  }

  // Xem trước còn / hết bảo hành (cùng cách tính với lúc lưu, kể cả số lần bảo hành trước).
  let previewTimer: ReturnType<typeof setTimeout> | undefined;
  // Chưa nhập đủ hóa đơn / chưa chọn hướng xử lý khi không có hóa đơn: chưa kết luận (không báo đỏ sớm).
  $effect(() => {
    const query = new URLSearchParams({ productId, receivedDate });
    if (noInvoice) {
      query.set('noInvoiceWarranty', String(noInvoiceDecision === 'WARRANTY'));
      if (declaredPurchaseDate) query.set('declaredPurchaseDate', declaredPurchaseDate);
    } else if (invoiceComplete) {
      query.set('invoiceNumber', invoiceNumber.trim());
      query.set('invoiceDate', invoiceDate);
    }
    clearTimeout(previewTimer);
    if (!productId || !receivedDate || (noInvoice ? !noInvoiceDecision : !invoiceComplete)) {
      coverage = null;
      return;
    }
    previewTimer = setTimeout(async () => {
      coverage = await api<Coverage>(`/warranty/coverage?${query}`).catch(() => null);
    }, 250);
  });

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    error = '';
    saving = true;
    const optional = (value: string) => value.trim() || undefined;
    try {
      const ticket = await api<WarrantyTicket>('/warranty/tickets', {
        method: 'POST',
        idempotentCommand: true,
        body: JSON.stringify({
          channel,
          customerId: customerId || undefined,
          customerName: customerName.trim(),
          customerPhone: optional(customerPhone),
          customerAddress: optional(customerAddress),
          productId,
          serial: optional(serial),
          invoiceNumber: noInvoice ? undefined : optional(invoiceNumber),
          invoiceDate: noInvoice || !invoiceDate ? undefined : invoiceDate,
          noInvoiceWarranty: noInvoice ? noInvoiceDecision === 'WARRANTY' : undefined,
          declaredPurchaseDate: noInvoice && declaredPurchaseDate ? declaredPurchaseDate : undefined,
          receivedDate,
          promisedDate,
          technicianId: technicianId || undefined,
          symptom: symptom.trim(),
          accessories: optional(accessories),
          condition: optional(condition),
          loaner: optional(loaner),
        }),
      });
      await goto(`/warranty/${ticket.id}?created=1`);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.wr_load_error();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } finally {
      saving = false;
    }
  }
</script>

<svelte:head><title>{m.wr_nav_new()} · INOXPRAN ERP</title></svelte:head>

<section class="page-head">
  <div>
    <nav class="crumbs" aria-label={m.duong_dan()}><a href="/warranty">{m.wr_nav()}</a><span>{m.wr_nav_new()}</span></nav>
    <h1 class="page-title">{m.wr_nav_new()}</h1>
    <p class="page-sub">{m.wr_new_sub({ months: settings.warrantyMonths })}</p>
  </div>
  <div class="actions">
    <a class="btn" href="/warranty">{m.huy_bo()}</a>
    <button class="btn primary" type="submit" form="warranty-receive" disabled={saving}>{saving ? m.kh_dang_luu() : m.wr_submit_receive()}</button>
  </div>
</section>

{#if error}<div class="banner error"><CircleAlert size={17} /><span>{error}</span></div>{/if}

<form id="warranty-receive" class="layout" onsubmit={submit}>
  <article class="card block">
    <header class="block-head"><span class="step">1</span><h2>{m.wr_sec_customer()}</h2></header>
    <div class="grid">
      <div class="field">
        <label for="channel">{m.wr_channel()}</label>
        <select id="channel" bind:value={channel}>{#each WARRANTY_CHANNELS as item}<option value={item}>{channelText(item)}</option>{/each}</select>
      </div>
      <div class="field wide">
        <label for="dealer">{m.wr_dealer()}</label>
        <select id="dealer" value={customerId} onchange={(event) => chooseDealer(event.currentTarget.value)}>
          <option value="">{m.wr_retail_customer()}</option>
          {#each dealers as row}<option value={row.id}>{row.code} — {row.name}</option>{/each}
        </select>
      </div>
      <div class="field"><label for="customer-name">{m.wr_customer_name()} <span class="req">*</span></label><input id="customer-name" bind:value={customerName} required minlength="2" maxlength="240" /></div>
      <div class="field"><label for="customer-phone">{m.dien_thoai()}</label><input id="customer-phone" type="tel" bind:value={customerPhone} maxlength="30" /></div>
      <div class="field"><label for="customer-address">{m.dia_chi()}</label><input id="customer-address" bind:value={customerAddress} maxlength="500" /></div>
    </div>
  </article>

  <article class="card block">
    <header class="block-head"><span class="step">2</span><h2>{m.wr_sec_product()}</h2></header>
    <div class="grid">
      <div class="field wide">
        <label for="product">{m.wr_product()} <span class="req">*</span></label>
        <select id="product" bind:value={productId} required>
          <option value="">{m.wr_choose_product()}</option>
          {#each products as row}<option value={row.id}>{row.sku} — {row.name}</option>{/each}
        </select>
      </div>
      <div class="field"><label for="serial">{m.wr_serial()}</label><input id="serial" bind:value={serial} maxlength="80" placeholder={m.khong_bat_buoc()} /><small class="hint">{m.wr_serial_hint()}</small></div>
      {#if !noInvoice}
        <div class="field"><label for="invoice-no">{m.wr_invoice_no()} <span class="req">*</span></label><input id="invoice-no" bind:value={invoiceNumber} maxlength="40" required /></div>
        <div class="field"><label for="invoice-date">{m.wr_invoice_date()} <span class="req">*</span></label><input id="invoice-date" type="date" bind:value={invoiceDate} max={receivedDate} required /></div>
      {/if}
      <label class="check"><input type="checkbox" bind:checked={noInvoice} />{m.wr_no_invoice()}</label>
      {#if noInvoice}
        <fieldset class="decision wide">
          <legend>{m.wr_noinv_decision()} <span class="req">*</span></legend>
          <label><input type="radio" name="no-invoice-decision" value="WARRANTY" bind:group={noInvoiceDecision} required />{m.wr_noinv_warranty()}</label>
          <label><input type="radio" name="no-invoice-decision" value="PAID" bind:group={noInvoiceDecision} />{m.wr_noinv_paid()}</label>
        </fieldset>
        <div class="field">
          <label for="declared-date">{m.wr_noinv_declared_date()}</label>
          <input id="declared-date" type="date" bind:value={declaredPurchaseDate} max={receivedDate} />
          <small class="hint">{m.wr_noinv_declared_hint()}</small>
        </div>
      {/if}
    </div>
    {#if productId && !noInvoice && !invoiceComplete}
      <p class="coverage info"><Info size={17} />{m.wr_cov_enter_invoice()}</p>
    {:else if productId && noInvoice && !noInvoiceDecision}
      <p class="coverage info"><Info size={17} />{m.wr_noinv_choose()}</p>
    {/if}
    {#if coverage}
      {#if coverage.invoiceless}
        <p class="coverage ok"><CircleCheck size={17} />{m.wr_cov_invoiceless()}</p>
        {#if coverage.expiresOn && coverage.declaredExpired}
          <p class="coverage warn"><TriangleAlert size={17} />{m.wr_cov_declared_expired({ date: date(coverage.expiresOn) })}</p>
        {:else if coverage.expiresOn}
          <p class="coverage info"><Info size={17} />{m.wr_cov_declared_until({ date: date(coverage.expiresOn) })}</p>
        {/if}
      {:else if coverage.coverage === 'IN_WARRANTY' && coverage.expiresOn}
        <p class="coverage ok"><CircleCheck size={17} />{m.wr_cov_in_until({ date: date(coverage.expiresOn), days: daysBetween(receivedDate, coverage.expiresOn) })}</p>
      {:else if coverage.coverage === 'OUT_OF_WARRANTY' && coverage.expiresOn}
        <p class="coverage warn"><TriangleAlert size={17} />{m.wr_cov_out_since({ date: date(coverage.expiresOn) })}</p>
      {:else}
        <p class="coverage bad"><CircleAlert size={17} />{m.wr_cov_no_invoice()}</p>
      {/if}
      {#if coverage.extensionDays > 0}<p class="coverage info"><Info size={17} />{m.wr_cov_extension({ days: coverage.extensionDays })}</p>{/if}
      {#if coverage.priorServiceCount > 0}<p class="coverage warn"><TriangleAlert size={17} />{m.wr_repeat_warning({ count: coverage.priorServiceCount, next: coverage.priorServiceCount + 1 })}</p>{/if}
    {/if}
  </article>

  <article class="card block">
    <header class="block-head"><span class="step">3</span><h2>{m.wr_sec_schedule()}</h2></header>
    <div class="grid">
      <div class="field"><label for="received">{m.wr_received_date()} <span class="req">*</span></label><input id="received" type="date" value={receivedDate} max={todayIso()} required onchange={(event) => changeReceived(event.currentTarget.value)} /></div>
      <div class="field"><label for="promised">{m.wr_promised_date()} <span class="req">*</span></label><input id="promised" type="date" bind:value={promisedDate} min={receivedDate} required oninput={() => (promisedTouched = true)} /></div>
      <div class="field">
        <label for="technician">{m.wr_technician()}</label>
        <select id="technician" bind:value={technicianId}>
          <option value="">—</option>
          {#each technicians as row}<option value={row.id}>{row.displayName}</option>{/each}
        </select>
      </div>
    </div>
    {#if schedule}<p class="coverage info"><Info size={17} />{m.wr_schedule_hint({ days: turnaround, warning: dateTime(schedule.warningAt), due: date(promisedDate) })}</p>{/if}
  </article>

  <article class="card block">
    <header class="block-head"><span class="step">4</span><h2>{m.wr_sec_condition()}</h2></header>
    <div class="grid">
      <div class="field wide"><label for="symptom">{m.wr_symptom()} <span class="req">*</span></label><textarea id="symptom" rows="2" bind:value={symptom} required minlength="3" maxlength="500"></textarea></div>
      <div class="field"><label for="accessories">{m.wr_accessories()}</label><input id="accessories" bind:value={accessories} maxlength="300" /></div>
      <div class="field"><label for="condition">{m.wr_condition()}</label><input id="condition" bind:value={condition} maxlength="300" /></div>
      <div class="field"><label for="loaner">{m.wr_loaner()}</label><input id="loaner" bind:value={loaner} maxlength="200" placeholder={m.khong_bat_buoc()} /><small class="hint">{m.wr_loaner_hint()}</small></div>
    </div>
  </article>
</form>

<style>
  .layout { display: grid; gap: 16px; }
  .block { padding-bottom: 18px; }
  .block-head { display: flex; align-items: center; gap: 12px; padding: 18px 22px 6px; }
  .block-head h2 { margin: 0; font-size: 14.5px; font-weight: 700; letter-spacing: 0.02em; text-transform: uppercase; }
  .step { display: grid; width: 26px; height: 26px; place-items: center; border-radius: 50%; background: var(--navy); color: #fff; font-size: 13px; font-weight: 700; }
  .grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px 18px; align-items: start; padding: 12px 22px 0; }
  .wide { grid-column: span 2; }
  .hint { color: var(--subtle); font-size: 11.5px; }
  .check { display: flex; align-items: center; gap: 8px; align-self: center; font-size: 13.5px; font-weight: 500; }
  .decision { display: flex; flex-wrap: wrap; gap: 8px 22px; margin: 0; padding: 10px 14px; border: 1px solid var(--line); border-radius: var(--radius-sm); }
  .decision legend { padding: 0 4px; color: var(--muted); font-size: 12.5px; font-weight: 600; }
  .decision label { display: flex; align-items: center; gap: 8px; font-size: 13.5px; cursor: pointer; }
  .coverage { display: flex; align-items: flex-start; gap: 8px; margin: 14px 22px 0; padding: 10px 14px; border-radius: var(--radius-sm); font-size: 13.5px; }
  .coverage.ok { background: var(--green-soft); color: var(--green); }
  .coverage.warn { background: var(--amber-soft); color: var(--amber); }
  .coverage.bad { background: var(--red-soft); color: var(--red); }
  .coverage.info { background: var(--blue-soft); color: var(--navy); }
  @media (max-width: 900px) { .grid { grid-template-columns: 1fr; } .wide { grid-column: auto; } }
</style>
