<script lang="ts" module>
  export interface SheetLine {
    itemNo: string;
    sku: string;
    nameEn: string;
    nameZh: string;
    spec: string;
    hsCode: string;
    unit: string;
    quantity: number;
    unitPrice?: string | undefined;
    amount?: string | undefined;
    packSize?: number | undefined;
    cartons: number;
    netKg: number;
    grossKg: number;
    cbm: number;
  }
  export interface SheetHeader {
    title: 'contract' | 'packing';
    number: string;
    date: string;
    seller: { name: string; address?: string | undefined; phone?: string | undefined; taxCode?: string | undefined };
    currency: string;
    incoterm?: string | undefined;
    portOfLoading?: string | undefined;
    portOfDischarge?: string | undefined;
    shippingMethod?: string | undefined;
    etd?: string | undefined;
    eta?: string | undefined;
    paymentTerms?: string | undefined;
    depositPercent?: string | undefined;
    partialShipment?: boolean | undefined;
    shippingMark?: string | undefined;
    containerNo?: string | undefined;
    containerType?: string | undefined;
    billOfLading?: string | undefined;
    vessel?: string | undefined;
    reference?: string | undefined;
    total?: string | undefined;
    container: string;
  }
</script>

<script lang="ts">
  /**
   * Bản in hợp đồng mua (PURCHASE CONTRACT / 采购合同) và phiếu đóng gói (PACKING LIST / 装箱单) song ngữ Anh – Trung,
   * khổ A4 ngang, theo mẫu chứng từ của công ty mẹ. Không đổi theo ngôn ngữ giao diện.
   */
  import { company } from '$lib/company';

  let { header, lines }: { header: SheetHeader; lines: SheetLine[] } = $props();

  const amount = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const price = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
  const qty = new Intl.NumberFormat('en-US', { maximumFractionDigits: 3 });
  const vndFormat = new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 0 });
  const isContract = $derived(header.title === 'contract');
  const fmtMoney = (value: string | undefined) => (value === undefined ? '' : header.currency === 'VND' ? vndFormat.format(Number(value)) : amount.format(Number(value)));
  const fmtPrice = (value: string | undefined) => (value === undefined ? '' : header.currency === 'VND' ? vndFormat.format(Number(value)) : price.format(Number(value)));
  const fmtDate = (value: string | undefined) => (value ? value.slice(0, 10) : '');
  const totals = $derived({
    quantity: lines.reduce((sum, line) => sum + line.quantity, 0),
    cartons: lines.reduce((sum, line) => sum + line.cartons, 0),
    netKg: lines.reduce((sum, line) => sum + line.netKg, 0),
    grossKg: lines.reduce((sum, line) => sum + line.grossKg, 0),
    cbm: lines.reduce((sum, line) => sum + line.cbm, 0),
  });
  const method = (value: string | undefined) => ({ SEA: 'By sea / 海运', AIR: 'By air / 空运', ROAD: 'By road / 陆运', RAIL: 'By rail / 铁路', EXPRESS: 'Express / 快递' })[value ?? ''] ?? '';
</script>

<article class="sheet">
  <header class="band">
    <img src="/brand/inoxpran-logo.png" alt="INOXPRAN" />
    <div><b>{company.legalNameEn} (INOXPRAN)</b><i>{company.legalNameZh}</i></div>
  </header>
  <h1>{isContract ? 'PURCHASE CONTRACT' : 'PACKING LIST'}<small>{isContract ? '采购合同' : '装箱单'}</small></h1>

  <table class="info">
    <colgroup><col style="width:14%" /><col style="width:36%" /><col style="width:14%" /><col style="width:36%" /></colgroup>
    <tbody>
      <tr><th>{isContract ? 'Contract No.' : 'Invoice / Ref. No.'}<i>{isContract ? '合同编号' : '发票 / 参考号'}</i></th><td class="strong">{header.number}</td><th>Date<i>日期</i></th><td>{fmtDate(header.date)}</td></tr>
      <tr>
        <th>Buyer<i>买方</i></th>
        <td><b>{company.legalNameEn}</b><br />{company.legalNameZh}<br />{company.addressEn}</td>
        <th>Seller<i>卖方</i></th>
        <td><b>{header.seller.name}</b>{#if header.seller.address}<br />{header.seller.address}{/if}{#if header.seller.phone}<br />Tel: {header.seller.phone}{/if}</td>
      </tr>
      {#if isContract}
        <tr><th>Price term<i>价格条款</i></th><td>{header.incoterm ?? ''} {header.incoterm === 'FOB' || header.incoterm === 'EXW' ? header.portOfLoading ?? '' : header.portOfDischarge ?? ''} · {header.currency}</td><th>Payment<i>付款方式</i></th><td>{header.paymentTerms ?? ''}{header.depositPercent ? ` · Deposit / 定金 ${header.depositPercent}%` : ''}</td></tr>
      {/if}
      <tr><th>Shipment<i>运输</i></th><td>{method(header.shippingMethod)} {header.portOfLoading ? `· ${header.portOfLoading}` : ''} → {header.portOfDischarge ?? ''}</td><th>ETD / ETA<i>开船 / 到港</i></th><td>{fmtDate(header.etd)} / {fmtDate(header.eta)}{#if isContract} · Partial shipment / 分批装运: {header.partialShipment === false ? 'Not allowed / 不允许' : 'Allowed / 允许'}{/if}</td></tr>
      {#if header.containerNo || header.billOfLading}
        <tr><th>Container<i>柜号</i></th><td>{header.containerNo ?? ''} {header.containerType ?? ''}</td><th>B/L · Vessel<i>提单 · 船名</i></th><td>{header.billOfLading ?? ''} {header.vessel ? `· ${header.vessel}` : ''}</td></tr>
      {/if}
    </tbody>
  </table>

  <table class="lines">
    <colgroup>
      <col style="width:4%" /><col style="width:12%" /><col />{#if isContract}<col style="width:8%" />{/if}<col style="width:6%" /><col style="width:8%" />
      {#if isContract}<col style="width:9%" /><col style="width:10%" />{:else}<col style="width:7%" />{/if}<col style="width:7%" /><col style="width:8%" /><col style="width:8%" /><col style="width:7%" />
    </colgroup>
    <thead>
      <tr>
        <th>No.<i>序号</i></th><th>Item No.<i>货号</i></th><th>Description<i>品名规格</i></th>{#if isContract}<th>HS Code<i>海关编码</i></th>{/if}<th>Unit<i>单位</i></th><th>Qty<i>数量</i></th>
        {#if isContract}<th>Unit price ({header.currency})<i>单价</i></th><th>Amount ({header.currency})<i>金额</i></th>{:else}<th>Pcs/ctn<i>每箱数量</i></th>{/if}
        <th>Cartons<i>箱数</i></th><th>N.W. (kg)<i>净重</i></th><th>G.W. (kg)<i>毛重</i></th><th>CBM<i>体积</i></th>
      </tr>
    </thead>
    <tbody>
      {#each lines as line, index}
        <tr>
          <td class="center">{index + 1}</td>
          <td><b>{line.itemNo}</b>{#if line.itemNo !== line.sku}<small>{line.sku}</small>{/if}</td>
          <td>{line.nameEn}{#if line.nameZh}<br /><span class="zh">{line.nameZh}</span>{/if}{#if line.spec}<small>{line.spec}</small>{/if}</td>
          {#if isContract}<td class="center">{line.hsCode}</td>{/if}
          <td class="center">{line.unit}</td>
          <td class="num">{qty.format(line.quantity)}</td>
          {#if isContract}<td class="num">{fmtPrice(line.unitPrice)}</td><td class="num">{fmtMoney(line.amount)}</td>{:else}<td class="num">{line.packSize ?? ''}</td>{/if}
          <td class="num">{line.cartons || ''}</td>
          <td class="num">{line.netKg ? qty.format(line.netKg) : ''}</td>
          <td class="num">{line.grossKg ? qty.format(line.grossKg) : ''}</td>
          <td class="num">{line.cbm ? line.cbm.toFixed(3) : ''}</td>
        </tr>
      {/each}
    </tbody>
    <tfoot>
      <tr>
        <td colspan={isContract ? 5 : 4} class="right">TOTAL / 合计</td>
        <td class="num">{qty.format(totals.quantity)}</td>
        {#if isContract}<td></td><td class="num">{fmtMoney(header.total)}</td>{:else}<td></td>{/if}
        <td class="num">{totals.cartons}</td>
        <td class="num">{qty.format(totals.netKg)}</td>
        <td class="num">{qty.format(totals.grossKg)}</td>
        <td class="num">{totals.cbm.toFixed(3)}</td>
      </tr>
    </tfoot>
  </table>

  <table class="terms">
    <tbody>
      <tr><th>Container plan<i>装柜建议</i></th><td>{header.container}</td><th>Shipping mark<i>唛头</i></th><td class="mark">{header.shippingMark ?? 'N/M'}</td></tr>
      {#if isContract}
        <tr><td colspan="4" class="clauses">
          1. Quality / 质量: as per confirmed samples and specifications / 按确认的样品及规格。
          2. Packing / 包装: export cartons suitable for sea freight, marked as above / 适合海运的出口纸箱，唛头如上。
          3. Documents / 单据: commercial invoice, packing list, B/L, certificate of origin (Form E if applicable) / 商业发票、装箱单、提单、原产地证（如适用 Form E）。
          4. This contract is made in two originals, each party holds one / 本合同一式两份，双方各执一份。
        </td></tr>
      {/if}
    </tbody>
  </table>

  <table class="signatures">
    <tbody>
      <tr><th>The Buyer / 买方<i>{company.legalNameEn}</i></th><th>The Seller / 卖方<i>{header.seller.name}</i></th></tr>
      <tr><td>(Signature & stamp / 签字盖章)</td><td>(Signature & stamp / 签字盖章)</td></tr>
    </tbody>
  </table>
</article>

<style>
  .sheet { width: 297mm; min-height: 210mm; margin: 18px auto; padding: 9mm 11mm; background: #fff; box-shadow: 0 6px 30px rgba(0, 0, 0, 0.15); color: #111; font: 10px/1.35 Arial, 'Noto Sans SC', 'Microsoft YaHei', 'SimSun', sans-serif; }
  .band { display: flex; align-items: center; gap: 12px; padding: 5px 10px; background: #1f4e79; color: #fff; }
  .band img { height: 26px; width: auto; border-radius: 2px; }
  .band div { display: grid; flex: 1; text-align: center; }
  .band b { font-size: 13px; letter-spacing: 0.02em; }
  .band i { font-size: 11px; font-style: normal; font-weight: 700; }
  h1 { margin: 6px 0 6px; font-size: 15px; letter-spacing: 0.06em; text-align: center; }
  h1 small { display: block; font-size: 12px; letter-spacing: 0.3em; }
  table { width: 100%; border-collapse: collapse; table-layout: fixed; }
  th, td { border: 1px solid #9aa7b4; padding: 3px 5px; vertical-align: middle; }
  th i { display: block; font-style: normal; font-weight: 400; font-size: 9px; }
  .info th, .terms th { background: #dce8f5; font-weight: 700; text-align: center; }
  .info .strong { font-weight: 700; font-size: 11px; }
  .lines { margin-top: -1px; }
  .lines thead th { background: #1f4e79; color: #fff; font-weight: 700; text-align: center; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .lines td small { display: block; color: #555; font-size: 9px; }
  .lines .zh { color: #333; }
  .lines tfoot td { background: #f1f5fa; font-weight: 700; }
  .num { text-align: right; white-space: nowrap; }
  .center { text-align: center; }
  .right { text-align: right; }
  .terms { margin-top: -1px; }
  .terms .mark { white-space: pre-line; }
  .clauses { font-size: 9px; line-height: 1.5; }
  .signatures { margin-top: -1px; }
  .signatures th { background: #dfe3f2; text-align: center; }
  .signatures td { height: 24mm; text-align: center; vertical-align: top; color: #444; font-size: 9px; }
  @page { size: A4 landscape; margin: 8mm; }
  @media print {
    .sheet { width: auto; min-height: 0; margin: 0; padding: 0; box-shadow: none; }
    .band, .info th, .terms th, .signatures th, .lines tfoot td { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  }
  @media screen and (max-width: 1100px) { .sheet { width: auto; margin: 12px; } }
</style>
