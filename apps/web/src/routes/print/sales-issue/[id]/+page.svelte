<script lang="ts">
  /**
   * Bản in "PHIẾU XUẤT KHO BÁN HÀNG" khổ A4, dựng lại theo mẫu chứng từ giấy của công ty.
   * ?type=BH: phiếu kế toán lập (số BH, ngày chứng từ); ?type=SWK: phiếu kho lập khi xuất hàng (số SWK, ngày xuất).
   */
  import type { SalesOrder } from '@inoxpran/contracts';
  import { vndInWords } from '$lib/vnd-words';
  import { m } from '$lib/paraglide/messages';
  import { vatLabel } from '$shared/sales-math';
  import { salesIssueTemplate } from '$shared/sales-templates';
  import { page } from '$app/state';
  import { onMount } from 'svelte';
  import { company } from '$lib/company';
  import { api } from '$lib/api';

  type Order = SalesOrder & { templateCode?: string; warehouseKeeperName?: string; issuedByName?: string; shippedAt?: string; shippedByName?: string; issuedAt?: string };

  let order = $state<Order | null>(null);
  let error = $state('');
  const type = $derived(page.url.searchParams.get('type') === 'SWK' ? 'SWK' : 'BH');
  const slipNo = $derived(order ? (type === 'SWK' ? order.warehouseSlipNo : order.code) : '');
  const slipDate = $derived(order ? new Date(type === 'SWK' ? order.shippedAt ?? order.updatedAt : order.orderDate ?? order.createdAt) : new Date());
  const draft = $derived(order?.status === 'DRAFT' || order?.status === 'PENDING_APPROVAL');
  const netTotal = $derived(order ? order.netTotal ?? String(Number(order.subtotal) - Number(order.discountTotal)) : '0');

  const money = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
  const price = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const quantity = new Intl.NumberFormat('en-US', { maximumFractionDigits: 3 });

  function dayParts(value: Date) {
    const [year, month, day] = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(value).split('-');
    return `Ngày ${day} tháng ${month} năm ${year}`;
  }

  onMount(async () => {
    try {
      order = await api<Order>(`/sales-orders/${page.params.id}`);
      if (type === 'SWK' && !order.warehouseSlipNo) error = m.phieu_chua_co_so_swk();
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.khong_tai_duoc_phieu();
    }
  });
</script>

<svelte:head><title>{slipNo || 'Phiếu xuất kho'} — Phiếu xuất kho bán hàng</title></svelte:head>

<div class="toolbar">
  <span title={m.ban_in_luon_tieng_viet()}>{m.ban_in_phieu_xuat_kho_ban_hang()}{order ? ` · ${slipNo}` : ''}</span>
  {#if order?.warehouseSlipNo}
    <a class:active={type === 'BH'} href={`?type=BH`}>Phiếu BH</a>
    <a class:active={type === 'SWK'} href={`?type=SWK`}>Phiếu SWK</a>
  {/if}
  <button class="primary" onclick={() => window.print()} disabled={!order || Boolean(error)}>{m.in_phieu()}</button>
  <button onclick={() => window.close()}>{m.dong()}</button>
</div>

{#if error}
  <p class="error">{error} <a href="/login">{m.dang_nhap_lai()}</a> {m.hoac_2()} <a href={`/sales/orders/${page.params.id}`}>{m.quay_lai_phieu_2()}</a>.</p>
{:else if order}
  <article class="sheet">
    {#if draft}<div class="watermark">BẢN NHÁP — CHƯA PHÁT HÀNH</div>{/if}
    <header class="company">
      <div>
        <div>{company.legalName}</div>
        <div>{company.address}</div>
      </div>
      <div class="form-code">Mẫu số: <b>{salesIssueTemplate(order.templateCode).code}</b></div>
    </header>

    {#if order.status === 'CANCELLED'}<div class="void-stamp" role="note">ĐÃ HỦY</div>{/if}
    <h1>PHIẾU XUẤT KHO BÁN HÀNG</h1>
    <p class="date">{dayParts(slipDate)}</p>
    <p class="no">Số: {slipNo}</p>

    <table class="buyer">
      <tbody>
        <tr><th>Người mua:</th><td>{order.buyer?.name ?? order.customerName}</td><th class="right-label">Mã khách hàng:</th><td class="right-value">{order.customerCode}</td></tr>
        <tr><th>Tên khách hàng:</th><td colspan="3">{order.contactName ?? ''}</td></tr>
        <tr><th>Địa chỉ:</th><td colspan="3">{order.buyer?.address ?? ''}</td></tr>
        <tr><th>Điện thoại:</th><td colspan="3">{order.buyer?.phone ?? ''}</td></tr>
        <tr><th>Mã số thuế:</th><td colspan="3">{order.buyer?.taxCode ?? ''}</td></tr>
        <tr><th>Diễn giải:</th><td colspan="3">{order.description ?? `Bán hàng ${order.customerName}`}</td></tr>
        <tr><th>Nhân viên bán hàng:</th><td colspan="3">{order.salesRepName ?? ''}</td></tr>
        <tr><th>Địa điểm giao hàng:</th><td colspan="3">{order.deliveryLocation ?? ''}</td></tr>
      </tbody>
    </table>

    <p class="currency">Loại tiền: VND</p>
    <table class="lines">
      <colgroup><col style="width:5%" /><col style="width:11%" /><col /><col style="width:7%" /><col style="width:9%" /><col style="width:12%" /><col style="width:13%" /></colgroup>
      <thead><tr><th>STT</th><th>Mã hàng</th><th>Tên hàng</th><th>Đơn vị</th><th>Số lượng</th><th>Đơn giá</th><th>Thành tiền</th></tr></thead>
      <tbody>
        {#each order.lines as line, index}
          <tr>
            <td class="center">{index + 1}</td>
            <td>{line.sku}</td>
            <td class="center">{line.productName}</td>
            <td>{line.unit}</td>
            <td class="center">{quantity.format(Number(line.quantity))}</td>
            <td class="center">{price.format(Number(line.unitPrice))}</td>
            <td class="center">{money.format(Number(line.netAmount ?? line.lineTotal))}</td>
          </tr>
        {/each}
      </tbody>
      <tfoot>
        <tr class="sum"><td colspan="6"><b>Cộng</b></td><td class="amount"><b>{money.format(Number(netTotal))}</b></td></tr>
        <tr><td colspan="4"></td><td colspan="2" class="caption">Cộng tiền hàng</td><td class="amount"><b>{money.format(Number(netTotal))}</b></td></tr>
        <tr><td colspan="3" class="caption">Thuế suất thuế GTGT:</td><td colspan="1" class="rate"><b>{vatLabel(order.taxRate ?? '10')}</b></td><td colspan="2" class="caption">Tiền thuế GTGT:</td><td class="amount"><b>{money.format(Number(order.taxTotal))}</b></td></tr>
        <tr><td colspan="4"></td><td colspan="2" class="caption">Tổng tiền thanh toán</td><td class="amount"><b>{money.format(Number(order.grandTotal))}</b></td></tr>
      </tfoot>
    </table>

    <p class="words">Số tiền bằng chữ: <b>{vndInWords(order.grandTotal)}</b></p>
    <p class="attached">Số chứng từ gốc kèm theo: {type === 'SWK' ? `Phiếu xuất kho bán hàng số ${order.code}` : '…'}</p>
    <div class="closing">
    <p class="sign-date">{dayParts(slipDate)}</p>
    <section class="signatures">
      {#each [
        { title: 'Người mua hàng', name: '' },
        { title: 'Kế toán trưởng', name: '' },
        { title: 'Nhân viên bán hàng', name: order.salesRepName ?? '' },
        { title: 'Thủ kho', name: order.warehouseKeeperName ?? '' },
        { title: 'Người lập biểu', name: type === 'SWK' ? order.shippedByName ?? '' : order.issuedByName ?? '' },
      ] as signer}
        <div><b>{signer.title}</b><i>(Ký, họ tên)</i><span>{signer.name}</span></div>
      {/each}
    </section>
    </div>
  </article>
{:else}
  <p class="loading">{m.dang_tai_phieu_2()}</p>
{/if}

<style>
  :global(html), :global(body) { background: #e7ebf0; }
  .toolbar { position: sticky; top: 0; z-index: 2; display: flex; align-items: center; gap: 10px; padding: 10px 24px; background: #123b5e; color: #fff; font: 500 13.5px/1.4 Inter, system-ui, sans-serif; }
  .toolbar span { margin-right: auto; }
  .toolbar a { padding: 6px 12px; border-radius: 6px; color: #cfe0ef; text-decoration: none; }
  .toolbar a.active { background: rgba(255, 255, 255, 0.16); color: #fff; }
  .toolbar button { padding: 7px 16px; border: 1px solid rgba(255, 255, 255, 0.35); border-radius: 7px; background: transparent; color: #fff; font: inherit; cursor: pointer; }
  .toolbar button.primary { border-color: #e2703a; background: #e2703a; }
  .toolbar button:disabled { opacity: 0.5; cursor: default; }
  .error, .loading { max-width: 210mm; margin: 40px auto; padding: 16px 20px; border-radius: 8px; background: #fff; font: 14px Inter, system-ui, sans-serif; }
  .error { color: #b42318; }

  .sheet { position: relative; box-sizing: border-box; width: 210mm; min-height: 297mm; margin: 24px auto; padding: 14mm 16mm 18mm 20mm; background: #fff; box-shadow: 0 6px 24px rgba(18, 39, 58, 0.18); color: #000; font: 13px/1.45 'Times New Roman', Times, serif; }
  .watermark { position: absolute; top: 42%; left: 50%; transform: translate(-50%, -50%) rotate(-24deg); color: rgba(180, 35, 24, 0.13); font-size: 44px; font-weight: 700; white-space: nowrap; pointer-events: none; }
  .company { display: flex; justify-content: space-between; gap: 12px; font-size: 12px; line-height: 1.35; }
  .company > div:first-child > div:first-child { text-transform: uppercase; }
  .form-code { white-space: nowrap; }
  h1 { margin: 18px 0 4px; font-size: 19px; font-weight: 700; text-align: center; }
  /* Phiếu đã hủy: dấu đỏ chéo trên bản in để không dùng nhầm làm chứng từ giao hàng. */
  .void-stamp { position: absolute; top: 34mm; right: 22mm; padding: 4px 16px; border: 3px solid #c62828; border-radius: 6px; color: #c62828; font: 700 26px/1.2 Arial, sans-serif; letter-spacing: 0.08em; transform: rotate(-12deg); opacity: 0.85; }
  .date, .no { margin: 2px 0; font-size: 12px; font-weight: 700; text-align: center; }
  .no { margin-bottom: 10px; }

  .buyer { width: 100%; border-collapse: collapse; }
  .buyer th, .buyer td { padding: 1.5px 0; font-weight: 400; text-align: left; vertical-align: top; }
  .buyer th { width: 33mm; padding-right: 3mm; white-space: nowrap; }
  .buyer .right-label { width: 26mm; padding-left: 8mm; }
  .buyer .right-value { width: 22mm; padding-left: 2mm; }

  .currency { margin: 6px 0 3px; text-align: right; }
  .lines { width: 100%; border-collapse: collapse; font-size: 12px; }
  .lines th, .lines td { padding: 2px 5px; border: 1px solid #000; line-height: 1.25; }
  .lines th { font-weight: 700; text-align: center; vertical-align: top; }
  .lines .center { text-align: center; }
  /* Chân bảng: mỗi dòng tổng là một khung ngang liền, không có vạch dọc bên trong như phiếu giấy. */
  .lines tfoot td { border: 0; }
  .lines tfoot tr { border: 1px solid #000; }
  .lines .amount { text-align: right; }
  .lines .caption { font-size: 11px; }
  .lines .rate { text-align: right; }
  .lines .sum td { padding-top: 2px; }

  .words { margin: 4px 0 8px; }
  .attached { margin: 0 0 10px; }
  .sign-date { margin: 0 4mm 4px 0; text-align: right; }
  .signatures { display: grid; grid-template-columns: 1fr 1fr 1.25fr 0.9fr 1.2fr; text-align: center; }
  .closing { break-inside: avoid; }
  .signatures div { display: grid; align-content: start; justify-items: center; }
  .signatures b { font-size: 13px; }
  .signatures i { font-size: 12px; }
  .signatures span { min-height: 1.4em; margin-top: 15mm; font-size: 12.5px; }

  @page { size: A4 portrait; margin: 10mm 14mm 10mm 18mm; }
  @media print {
    :global(html), :global(body) { background: #fff !important; }
    .toolbar { display: none; }
    .sheet { width: auto; min-height: 0; margin: 0; padding: 0; box-shadow: none; }
    .lines tr { break-inside: avoid; }
  }
  @media screen and (max-width: 820px) {
    .sheet { width: auto; min-height: 0; margin: 12px; padding: 18px 16px; }
    .toolbar { flex-wrap: wrap; padding: 10px 16px; }
  }
</style>
