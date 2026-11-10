<script lang="ts">
  import { page } from '$app/state';
  import { onMount } from 'svelte';
  import { api } from '$lib/api';
  import { company } from '$lib/company';
  import { m } from '$lib/paraglide/messages';
  import { returnPrintDate, type StockReturnPrint } from '$lib/stock-return-print';
  import { vndInWords } from '$lib/vnd-words';

  let data = $state<StockReturnPrint | null>(null);
  let error = $state('');
  let debitAccount = $state('');
  let creditAccount = $state('');
  // Giá trên bản in (09/11/2026): chỉ hàng bán chậm trả lại hiện giá mặc định; loại khác bật khi cần. Kế toán / kho nhập giá tay
  // cho trường hợp ngoại lệ — chỉ dùng trên bản in, không lưu vào phiếu.
  let showPrices = $state(false);
  let manual = $state(false);
  let manualPrices = $state<string[]>([]);
  let manualRate = $state('10');
  const supplier = $derived(data?.slip.kind === 'SUPPLIER');
  const sample = $derived(data?.slip.kind === 'SAMPLE');
  const title = $derived(supplier ? 'PHIẾU XUẤT KHO' : 'PHIẾU NHẬP KHO');
  const slipDate = $derived(data ? returnPrintDate(data.slip.receivedAt ?? data.slip.postedAt ?? data.slip.createdAt) : '');
  const sourceCode = $derived(data?.slip.salesOrderCode ?? data?.slip.preErpSalesCode ?? data?.slip.purchaseOrderCode ?? '');
  const money = (value: string | null | undefined) => value == null ? '' : new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(Number(value));
  const quantity = (value: string) => new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(Number(value));
  const price = (value: string | null | undefined) => value == null ? '' : new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(Number(value));
  const rate = (value: string | null | undefined) => value == null ? '' : value === 'MIXED' ? 'Theo từng dòng' : value === 'KCT' ? 'KCT' : `${value} %`;
  const amount = (value: string) => { const parsed = Number(String(value).replace(/[^\d.]/g, '')); return Number.isFinite(parsed) && String(value).trim() ? parsed : null; };
  type Pricing = StockReturnPrint['pricing'];
  const blank = (count: number): Pricing => ({ lines: Array.from({ length: count }, () => ({ unitPrice: null, net: null, tax: null, rate: null })), net: null, tax: null, total: null, rate: null, status: 'UNPRICED' });
  /** Giá hiện trên bản in: ẩn → để trống; nhập tay → tính từ đơn giá (chưa VAT) × số lượng và thuế suất chung. */
  const shown = $derived.by<Pricing | null>(() => {
    if (!data) return null;
    if (!showPrices) return blank(data.slip.lines.length);
    if (!manual) return data.pricing;
    const percent = manualRate === 'KCT' ? 0 : Number(manualRate);
    const lines = data.slip.lines.map((line, index) => {
      const unit = amount(manualPrices[index] ?? '');
      if (unit === null) return { unitPrice: null, net: null, tax: null, rate: manualRate };
      const net = Math.round(unit * Number(line.quantity));
      return { unitPrice: String(unit), net: String(net), tax: String(Math.round((net * percent) / 100)), rate: manualRate };
    });
    if (lines.some((line) => line.net === null)) return { lines, net: null, tax: null, total: null, rate: manualRate, status: 'UNPRICED' };
    const net = lines.reduce((sum, line) => sum + Number(line.net), 0);
    const tax = Math.round((net * percent) / 100);
    return { lines, net: String(net), tax: String(tax), total: String(net + tax), rate: manualRate, status: 'VALUED' };
  });

  onMount(async () => {
    try {
      data = await api<StockReturnPrint>(`/inventory/returns/${page.params.id}/print`);
      showPrices = data.slip.category === 'SLOW_RETURN_IN';
      manualPrices = data.pricing.lines.map((line) => (line.unitPrice == null ? '' : String(Math.round(Number(line.unitPrice)))));
      manualRate = data.pricing.rate && data.pricing.rate !== 'MIXED' ? data.pricing.rate : '10';
    }
    catch (caught) { error = caught instanceof Error ? caught.message : 'Không tải được phiếu trả hàng.'; }
  });
</script>

<svelte:head><title>{data?.slip.code ?? 'Phiếu trả hàng'} · {title} · INOXPRAN</title></svelte:head>

<div class="toolbar">
  <a href="/inventory/returns">← {m.inv_phieu_tra_hang()}</a>
  <span>{data?.slip.code ?? m.dang_tai()}</span>
  <button class="primary" onclick={() => window.print()} disabled={!data || Boolean(error)}>{m.in_phieu()} / PDF</button>
  <button onclick={() => window.close()}>{m.dong()}</button>
</div>
{#if data}
  <div class="options" aria-label="Tùy chọn bản in">
    <label>Nợ <input aria-label="Tài khoản nợ trên bản in" bind:value={debitAccount} maxlength="20" placeholder="Tài khoản" /></label>
    <label>Có <input aria-label="Tài khoản có trên bản in" bind:value={creditAccount} maxlength="20" placeholder="Tài khoản" /></label>
    <small>{m.ban_in_luon_tieng_viet()} · A4 · Chọn “Lưu dưới dạng PDF” trong hộp thoại in.</small>
    <label class="check"><input id="print-show-prices" type="checkbox" bind:checked={showPrices} />{m.in_tra_hien_gia()}</label>
    {#if showPrices}<label class="check"><input id="print-manual-prices" type="checkbox" bind:checked={manual} />{m.in_tra_nhap_gia()}</label>{/if}
    <small class="price-hint">{m.in_tra_gia_goi_y()}</small>
    {#if showPrices && manual}
      <div class="manual">
        {#each data.slip.lines as line, index}
          <label><span>{line.sku} × {quantity(line.quantity)}</span><input class="manual-price" inputmode="numeric" bind:value={manualPrices[index]} placeholder={m.in_tra_don_gia()} /></label>
        {/each}
        <label><span>{m.in_tra_thue_suat()}</span><select id="print-manual-rate" bind:value={manualRate}>{#each ['0', '5', '8', '10', 'KCT'] as item}<option value={item}>{rate(item)}</option>{/each}</select></label>
      </div>
    {/if}
  </div>
  {#if showPrices && !manual && data.pricing.status !== 'VALUED'}<p class="notice">{data.pricing.status === 'UNPRICED' ? 'Giá trị hàng trả chưa được xác nhận. Các ô tiền để trống.' : 'Tổng tiền theo giá trị đã lưu; đơn giá chưa đủ thông tin xác nhận được để trống.'}</p>{/if}
{/if}

{#if error}
  <p class="error" role="alert">{error} <a href="/inventory/returns">Quay lại phiếu trả hàng</a></p>
{:else if data}
  <article class="sheet" lang="vi">
    <header class="company"><div>{company.legalName}</div><div>{company.address}</div></header>
    {#if data.slip.status === 'VOIDED'}<div class="void-stamp">ĐÃ HỦY</div>{/if}
    <h1>{title}</h1>
    <p class="date">{slipDate}</p>
    <p class="number">Số: {data.slip.code}</p>

    <div class="details">
      <dl class="party">
        <dt>{supplier ? 'Người giao hàng:' : 'Người mua:'}</dt><dd>{sample ? '' : data.party.contactName}</dd>
        <dt>{supplier ? 'Nhà cung cấp:' : 'Tên khách hàng:'}</dt><dd>{sample ? '' : data.slip.partnerName}</dd>
        <dt>Địa chỉ:</dt><dd>{data.party.address}</dd>
        <dt>Điện thoại:</dt><dd>{data.party.phone}</dd>
        <dt>Mã số thuế:</dt><dd>{data.party.taxCode}</dd>
        <dt>Diễn giải:</dt><dd class="description">{data.slip.note || (sample ? 'MANG TRẢ KHO HÀNG MẪU' : supplier ? 'Trả hàng nhà cung cấp' : 'Khách trả hàng nhập kho')}</dd>
        <dt>Nhân viên bán hàng:</dt><dd>{data.staffName}</dd>
        <dt>Địa điểm giao hàng:</dt><dd>{data.destination}</dd>
      </dl>
      <dl class="accounts"><dt>Nợ:</dt><dd>{debitAccount}</dd><dt>Có:</dt><dd>{creditAccount}</dd><dt>Loại tiền:</dt><dd>VND</dd></dl>
    </div>

    {#if sourceCode}<p class="source">Phiếu gốc: {sourceCode}{data.slip.preErpSalesCode ? ' (trước ERP)' : ''}{#if data.slip.legacyCode} · Mã cũ: {data.slip.legacyCode}{/if}</p>{/if}
    <table class="lines">
      <colgroup><col style="width:5.5%" /><col style="width:11%" /><col /><col style="width:8%" /><col style="width:11%" /><col style="width:12%" /><col style="width:15%" /></colgroup>
      <thead><tr><th>STT</th><th>Mã hàng</th><th>Tên hàng</th><th>Đơn vị</th><th>Số lượng</th><th>Đơn giá</th><th>Thành tiền</th></tr></thead>
      <tbody>
        {#each data.slip.lines as line, index}
          <tr><td class="center">{index + 1}</td><td class="sku">{line.sku}</td><td>{line.productName}{#if line.note}<small>{line.note}</small>{/if}{#if shown?.rate === 'MIXED'}<small>VAT: {rate(shown?.lines[index]?.rate)}</small>{/if}</td><td>{line.unit}</td><td class="numeric">{quantity(line.quantity)}</td><td class="numeric">{price(shown?.lines[index]?.unitPrice)}</td><td class="numeric">{money(shown?.lines[index]?.net)}</td></tr>
        {/each}
        {#each Array(Math.max(0, 6 - data.slip.lines.length)) as _}<tr class="blank" aria-hidden="true"><td>&nbsp;</td><td></td><td></td><td></td><td></td><td></td><td class="numeric">{sample && showPrices && !manual ? '0' : ''}</td></tr>{/each}
      </tbody>
      <tfoot>
        <tr><td colspan="6"><b>Cộng</b></td><td class="numeric">{money(shown?.net)}</td></tr>
        <tr><td colspan="4"></td><td colspan="2">Cộng tiền hàng</td><td class="numeric">{money(shown?.net)}</td></tr>
        <tr><td colspan="3">Thuế suất thuế GTGT:</td><td class="numeric">{rate(shown?.rate)}</td><td colspan="2">Tiền thuế GTGT:</td><td class="numeric">{money(shown?.tax)}</td></tr>
        <tr><td colspan="4"></td><td colspan="2">Tổng tiền thanh toán</td><td class="numeric">{money(shown?.total)}</td></tr>
      </tfoot>
    </table>
    {#if showPrices && shown?.status === 'UNPRICED'}<p class="pending-value">Giá trị hàng trả: chờ xác nhận.</p>{/if}
    {#if showPrices && shown?.total != null && !sample}<p class="words">Số tiền bằng chữ: {vndInWords(shown.total)}</p>{/if}
    <div class="closing">
      <p class="sign-date">{slipDate}</p>
      <section class="signatures" aria-label="Chữ ký">
        {#each [
          { title: supplier ? 'Người giao hàng' : 'Người mua hàng', name: sample ? data.staffName : '', stamp: false },
          { title: 'Kế toán trưởng', name: '', stamp: false },
          { title: 'Giám đốc', name: '', stamp: true },
          { title: 'Thủ kho', name: data.slip.createdByName, stamp: false },
          { title: 'Kế toán', name: data.slip.accountingByName ?? '', stamp: false },
        ] as signer}<div><b>{signer.title}</b><i>({signer.stamp ? 'Ký, họ tên, đóng dấu' : 'Ký, họ tên'})</i><span>{signer.name}</span></div>{/each}
      </section>
    </div>
  </article>
{:else}<p class="loading">{m.dang_tai_phieu_2()}</p>{/if}

<style>
  :global(html), :global(body) { background: #e7ebf0; }
  .toolbar { position: sticky; top: 0; z-index: 2; display: flex; align-items: center; gap: 12px; padding: 10px 24px; background: #123b5e; color: white; font-size: 13px; }
  .toolbar a { color: inherit; text-decoration: none; }
  .toolbar span { margin-right: auto; }
  .toolbar button { padding: 7px 16px; border: 1px solid #ffffff60; border-radius: 7px; background: transparent; color: inherit; font: inherit; cursor: pointer; }
  .toolbar button.primary { border-color: #e2703a; background: #e2703a; }
  .toolbar button:disabled { opacity: .5; cursor: default; }
  .options { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; max-width: 210mm; box-sizing: border-box; margin: 16px auto 0; padding: 12px 16px; border-radius: 8px; background: white; font-size: 13px; }
  .options label { display: flex; align-items: center; gap: 6px; }
  .options input { width: 95px; padding: 5px 8px; border: 1px solid #cbd5e1; border-radius: 5px; font: inherit; }
  .options small { flex: 1; color: #64748b; }
  .options .check { gap: 6px; cursor: pointer; }
  .options .check input { width: auto; }
  .options .price-hint { flex-basis: 100%; }
  .manual { display: flex; flex-wrap: wrap; gap: 8px 14px; flex-basis: 100%; padding-top: 8px; border-top: 1px dashed #cbd5e1; }
  .manual label { flex-direction: column; align-items: flex-start; gap: 3px; font-size: 12px; color: #334155; }
  .manual input { width: 130px; text-align: right; }
  .manual select { padding: 5px 8px; border: 1px solid #cbd5e1; border-radius: 5px; font: inherit; }
  .error, .loading, .notice { max-width: 210mm; box-sizing: border-box; margin: 16px auto; padding: 12px 16px; background: white; border-radius: 8px; }
  .error { color: #b42318; }
  .notice { color: #854d0e; background: #fffbeb; font-size: 13px; }
  .sheet { position: relative; box-sizing: border-box; width: 210mm; min-height: 297mm; margin: 20px auto; padding: 14mm 14mm 18mm 18mm; background: white; box-shadow: 0 6px 24px #12273a2e; color: black; font: 13px/1.4 'Times New Roman', Times, serif; }
  .company { font-size: 12px; line-height: 1.35; }
  .company div:first-child { font-weight: 700; }
  h1 { margin: 22px 0 5px; text-align: center; font-size: 21px; font-weight: 700; }
  .date, .number { margin: 3px 0; text-align: center; font-weight: 700; }
  .number { margin-bottom: 14px; }
  .details { display: grid; grid-template-columns: minmax(0, 1fr) 27mm; gap: 4mm; }
  dl { margin: 0; }
  .party { display: grid; grid-template-columns: 35mm minmax(0, 1fr); gap: 4px 2mm; }
  dt, dd { margin: 0; overflow-wrap: anywhere; }
  .party dd { min-height: 18px; white-space: pre-wrap; }
  .description { white-space: pre-wrap; }
  .accounts { align-self: start; margin-top: 22px; display: grid; grid-template-columns: auto minmax(10mm, 1fr); gap: 4px; }
  .source { margin: 7px 0 4px; font-size: 12px; }
  .lines { width: 100%; margin-top: 7px; border-collapse: collapse; table-layout: fixed; font-size: 12px; }
  .lines th, .lines td { border: 1px solid black; padding: 3px 4px; line-height: 1.3; overflow-wrap: anywhere; }
  .lines th { font-weight: 700; text-align: center; vertical-align: middle; }
  .lines tbody tr { height: 23px; }
  .lines small { display: block; font-size: 10px; }
  .center { text-align: center; }
  .numeric { text-align: right; font-variant-numeric: tabular-nums; }
  .lines tfoot { display: table-row-group; break-inside: avoid; }
  .lines tfoot tr { border: 1px solid black; break-inside: avoid; }
  .lines tfoot td { border: none; }
  .pending-value, .words { margin: 6px 0; font-size: 12px; }
  .closing { margin-top: 20mm; break-inside: avoid; }
  .sign-date { margin: 0 0 5px; text-align: right; }
  .signatures { display: grid; grid-template-columns: 1fr 1fr 1.25fr 1fr 1fr; gap: 6px; text-align: center; }
  .signatures div { display: grid; align-content: start; justify-items: center; }
  .signatures i { font-size: 12px; white-space: nowrap; }
  .signatures span { min-height: 1.4em; margin-top: 17mm; }
  .void-stamp { position: absolute; top: 27mm; right: 17mm; border: 3px solid #b42318; color: #b42318; padding: 4px 12px; transform: rotate(-12deg); font-size: 24px; font-weight: 700; }
  @page { size: A4 portrait; margin: 12mm 14mm 12mm 18mm; }
  @media print {
    :global(html), :global(body) { background: white !important; }
    .toolbar, .options, .notice, .error { display: none; }
    .sheet { width: auto; min-height: 0; margin: 0; padding: 0; box-shadow: none; }
    .lines thead { display: table-header-group; }
    .lines tbody tr { break-inside: avoid; }
    .void-stamp { print-color-adjust: exact; -webkit-print-color-adjust: exact; }
  }
  @media screen and (max-width: 820px) {
    .toolbar { flex-wrap: wrap; padding: 10px 12px; }
    .options, .notice { margin: 12px; }
    .sheet { margin: 12px; }
  }
</style>
