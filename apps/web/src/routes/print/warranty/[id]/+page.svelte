<script lang="ts">
  /**
   * Bản in "PHIẾU SỬA CHỮA / BẢO HÀNH / DỊCH VỤ — 维修 / 保修 / 服务单" khổ A4 ngang, dựng lại theo mẫu giấy của công ty.
   * Chứng từ luôn song ngữ Việt – Trung (không đổi theo ngôn ngữ giao diện). Thêm dòng "Ngày hẹn trả" vì Luật 19/2023
   * (Điều 30) yêu cầu văn bản tiếp nhận bảo hành ghi rõ thời gian thực hiện bảo hành.
   */
  import type { WarrantyTicket } from '@inoxpran/contracts';
  import { page } from '$app/state';
  import { onMount, tick } from 'svelte';
  import { m } from '$lib/paraglide/messages';
  import { api } from '$lib/api';
  import { company } from '$lib/company';
  import { applyPrintFit } from '$lib/print-fit';
  import { resolutionText, statusText, ticketCoverageText } from '$lib/warranty';
  import { daysBetween, remainingWarrantyDays } from '$shared/warranty';

  let ticket = $state<WarrantyTicket | null>(null);
  let error = $state('');
  const vi = { locale: 'vi' } as const;
  const zh = { locale: 'zh' } as const;
  const day = new Intl.DateTimeFormat('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Asia/Ho_Chi_Minh' });
  const dayTime = new Intl.DateTimeFormat('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Ho_Chi_Minh' });
  const money = new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 0 });
  const fmtDay = (value: string | undefined) => (value ? day.format(new Date(value.length === 10 ? `${value}T12:00:00+07:00` : value)) : '');
  const fmtTime = (value: string | undefined) => (value ? dayTime.format(new Date(value)) : '');
  const today = new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);
  const rows = $derived(ticket ? Array.from({ length: Math.max(3, ticket.lines.length) }, (_, index) => ticket?.lines[index]) : []);
  const remaining = $derived(ticket?.warranty.expiresOn ? remainingWarrantyDays(ticket.warranty.expiresOn, today) : null);

  /** Phiếu luôn in trên 1 tờ A4 ngang, lề 8mm: vùng in 281 × 194mm. Nội dung dài hơn thì tự thu nhỏ. */
  const PRINT_PAGE = { contentWidthMm: 281, printableHeightMm: 194 };
  let sheet = $state<HTMLElement | undefined>();
  let fit = $state(1);
  function measure() {
    // Chỉ đo theo bố cục màn hình: đang ở bố cục in (tờ đã thu nhỏ / bị khung cắt) thì giữ tỷ lệ đã đo.
    if (sheet && !matchMedia('print').matches) fit = applyPrintFit(sheet, PRINT_PAGE);
  }

  onMount(() => {
    void (async () => {
      try {
        ticket = await api<WarrantyTicket>(`/warranty/tickets/${page.params.id}`);
        await tick();
        measure();
        await document.fonts?.ready;
        measure();
      } catch (caught) {
        error = caught instanceof Error ? caught.message : m.wr_load_error();
      }
    })();
    window.addEventListener('beforeprint', measure);
    return () => window.removeEventListener('beforeprint', measure);
  });
</script>

<svelte:head><title>{ticket?.code ?? 'Phiếu bảo hành'} — Phiếu sửa chữa / bảo hành</title></svelte:head>

<div class="toolbar">
  <span>{m.wr_print()}{ticket ? ` · ${ticket.code}` : ''}{#if ticket && fit < 1}<em>{m.in_vua_mot_trang({ percent: Math.round(fit * 100) })}</em>{/if}</span>
  <button class="primary" onclick={() => window.print()} disabled={!ticket}>{m.in_phieu()}</button>
  <button onclick={() => window.close()}>{m.dong()}</button>
</div>

{#if error}
  <p class="error">{error} <a href={`/warranty/${page.params.id}`}>{m.quay_lai_phieu_2()}</a></p>
{:else if ticket}
  <div class="page-frame" class:fitted={fit < 1}>
  <article class="sheet" bind:this={sheet}>
    <header class="band">
      <img src="/brand/inoxpran-logo.png" alt="INOXPRAN" />
      <div><b>{company.legalName} (INOXPRAN)</b><i>胜旺投资有限责任公司（INOXPRAN）</i></div>
    </header>
    <h1>PHIẾU SỬA CHỮA / BẢO HÀNH / DỊCH VỤ<small>维修 / 保修 / 服务单</small></h1>

    <table class="info">
      <colgroup><col style="width:13%" /><col style="width:37%" /><col style="width:14%" /><col style="width:36%" /></colgroup>
      <tbody>
        <tr><th>Số phiếu / <i>工单编号</i></th><td class="strong">{ticket.code}</td><th>Ngày tiếp nhận / <i>接收日期</i></th><td>{fmtTime(ticket.receivedAt)}</td></tr>
        <tr><th>Khách hàng / Đại lý /<br /><i>客户 / 经销商</i></th><td>{ticket.customer.name}{ticket.customer.code ? ` (${ticket.customer.code})` : ''}</td><th>SĐT / <i>联系电话</i></th><td>{ticket.customer.phone ?? ''}</td></tr>
        <tr><th>Địa chỉ / <i>地址</i></th><td>{ticket.customer.address ?? ''}</td><th>Nhân viên tiếp nhận / <i>接待人员</i></th><td>{ticket.receivedByName}</td></tr>
        <tr><th>Sản phẩm / Model /<br /><i>产品 / 型号</i></th><td>{ticket.product.sku} — {ticket.product.name}</td><th>Số Serial / <i>序列号</i></th><td>{ticket.product.serial ?? 'Chưa in serial — nhận diện theo mã hàng + hóa đơn / 暂无序列号'}</td></tr>
        <tr>
          <th>Ngày mua / Ngày xuất bán /<br /><i>购买日期 / 出售日期</i></th>
          <td>{ticket.invoice ? `${fmtDay(ticket.invoice.date)} — HĐ số / 发票号 ${ticket.invoice.number}` : ticket.invoicelessWarranty ? 'Không có hóa đơn — bảo hành theo xác nhận của nhân viên / 无发票——经受理人员确认予以保修' : 'Không có hóa đơn / 无发票'}{ticket.declaredPurchaseDate ? ` · khách khai mua / 客户自述购买 ${fmtDay(ticket.declaredPurchaseDate)}` : ''}</td>
          <th>Trạng thái bảo hành / <i>保修状态</i></th>
          <td>{ticketCoverageText(ticket, vi)} / {ticketCoverageText(ticket, zh)}{ticket.warranty.expiresOn ? ` — đến / 至 ${fmtDay(ticket.warranty.expiresOn)}` : ''}</td>
        </tr>
        <tr>
          <th>Ngày hẹn trả /<br /><i>约定交付日期</i></th>
          <td class="strong">{fmtDay(ticket.promisedDate)} — thời gian thực hiện bảo hành {daysBetween(ticket.receivedDate, ticket.promisedDate)} ngày / 保修处理时间 {daysBetween(ticket.receivedDate, ticket.promisedDate)} 天</td>
          <th>Kỹ thuật phụ trách / <i>负责技术员</i></th>
          <td>{ticket.technicianName ?? ''}</td>
        </tr>
      </tbody>
    </table>

    <table class="lines">
      <colgroup><col style="width:5%" /><col style="width:9%" /><col style="width:9%" /><col style="width:15%" /><col style="width:15%" /><col style="width:15%" /><col style="width:15%" /><col style="width:17%" /></colgroup>
      <thead>
        <tr><th>STT<i>序号</i></th><th>Mã lỗi / Mã SP<i>故障代码 / 产品代码</i></th><th>Ngày nhận<i>接收日期</i></th><th>Tình trạng / Hiện tượng<i>故障现象</i></th><th>Nguyên nhân xác định<i>确定原因</i></th><th>Biện pháp khắc phục<i>处理措施</i></th><th>Mã BH / Linh kiện<i>保修代码 / 零部件</i></th><th>Ghi chú<i>备注</i></th></tr>
      </thead>
      <tbody>
        {#each rows as line, index}
          <tr><td class="center">{index + 1}</td><td>{line?.faultCode ?? (line ? ticket.product.sku : '')}</td><td class="center">{line ? fmtDay(line.receivedDate) : ''}</td><td>{line?.symptom ?? ''}</td><td>{line?.rootCause ?? ''}</td><td>{line?.action ?? ''}</td><td>{line?.partCode ?? ''}</td><td>{line?.note ?? ''}</td></tr>
        {/each}
      </tbody>
    </table>

    <div class="band-title">KẾT QUẢ &amp; XÁC NHẬN / 处理结果及确认</div>
    <table class="info result">
      <colgroup><col style="width:13%" /><col style="width:37%" /><col style="width:14%" /><col style="width:36%" /></colgroup>
      <tbody>
        <tr><th>Kết quả xử lý /<br /><i>处理结果</i></th><td>{ticket.result ? `${resolutionText(ticket.result.resolution, vi)} / ${resolutionText(ticket.result.resolution, zh)}` : ''}</td><th>Ngày hoàn tất / <i>完成日期</i></th><td>{fmtTime(ticket.returnedAt ?? ticket.result?.completedAt)}</td></tr>
        <tr><th>Linh kiện thay thế /<br /><i>更换零部件</i></th><td>{ticket.result?.replacedParts ?? ''}</td><th>Chi phí / Giá trị dịch vụ / <i>费用 / 服务金额</i></th><td>{ticket.result ? `${money.format(Number(ticket.result.cost))} đ — ${ticket.result.chargedTo === 'COMPANY' ? 'Công ty chịu / 公司承担' : 'Khách trả / 客户支付'}` : ''}</td></tr>
        <tr><th>Thời gian bảo hành còn lại / <i>剩余保修期</i></th><td>{remaining === null ? 'Không thuộc diện bảo hành / 不在保修范围' : remaining >= 0 ? `${remaining} ngày / 剩余 ${remaining} 天` : 'Đã hết bảo hành / 已过保'}</td><th>Trạng thái cuối / <i>最终状态</i></th><td>{statusText(ticket.status, vi)} / {statusText(ticket.status, zh)}</td></tr>
      </tbody>
    </table>

    <table class="signatures">
      <tbody>
        <tr><th>Khách hàng / Đại lý xác nhận<i>客户 / 经销商确认</i></th><th>Kỹ thuật / Bộ phận Bảo hành xác nhận<i>技术人员 / 保修部门确认</i></th></tr>
        <tr><td>Ký tên / Họ tên<span>{ticket.returnedTo ?? ''}</span></td><td>Ký tên / Họ tên<span>{ticket.technicianName ?? ''}</span></td></tr>
      </tbody>
    </table>

    <div class="notes">
      <p class="manager">
        <b>GHI CHÚ QUẢN LÝ / 管理备注：</b>Ghi rõ hiện tượng, nguyên nhân gốc, linh kiện thay thế, kết quả kiểm tra sau sửa chữa và trường hợp từ chối bảo hành.<br />
        请详细填写故障现象、根本原因、更换零部件、维修后的测试结果，以及拒绝保修的原因。
      </p>
      <div class="guide">
        <b>说明 / HƯỚNG DẪN:</b>
        <ol>
          <li>故障现象：详细描述客户反馈及实际检查现象。 / Mô tả chi tiết phản ánh của khách hàng và hiện tượng thực tế kiểm tra.</li>
          <li>原因：优先填写根本原因，不仅填写表面现象。 / Ưu tiên ghi nguyên nhân gốc, không chỉ ghi hiện tượng.</li>
          <li>处理措施：记录维修、更换零件、调整参数等内容。 / Ghi rõ sửa chữa, thay linh kiện, điều chỉnh thông số...</li>
          <li>测试结果：维修后必须进行功能、安全及性能确认。 / Sau sửa chữa phải xác nhận chức năng, an toàn và hiệu suất.</li>
          <li>保修拒绝：必须注明拒保原因并取得客户确认。 / Trường hợp từ chối bảo hành phải ghi rõ lý do và có xác nhận của khách hàng.</li>
        </ol>
      </div>
    </div>
  </article>
  </div>
{:else}
  <p class="loading">{m.dang_tai()}</p>
{/if}

<style>
  :global(body) { background: #e9edf2; }
  .toolbar { position: sticky; top: 0; z-index: 2; display: flex; align-items: center; gap: 10px; padding: 10px 24px; background: #123b5e; color: #fff; font: 500 13.5px/1.4 Inter, system-ui, sans-serif; }
  .toolbar span { margin-right: auto; }
  .toolbar em { margin-left: 12px; padding: 2px 9px; border-radius: 999px; background: rgba(255, 255, 255, 0.14); font-size: 12px; font-style: normal; }
  .toolbar button { padding: 7px 16px; border: 1px solid rgba(255, 255, 255, 0.35); border-radius: 7px; background: transparent; color: #fff; font: inherit; cursor: pointer; }
  .toolbar button.primary { border-color: #e2703a; background: #e2703a; }
  .toolbar button:disabled { opacity: 0.5; cursor: default; }
  .error, .loading { margin: 32px; font: 14px Inter, system-ui, sans-serif; }

  .sheet { width: 297mm; min-height: 210mm; margin: 18px auto; padding: 9mm 11mm; background: #fff; box-shadow: 0 6px 30px rgba(0, 0, 0, 0.15); color: #111; font: 10.5px/1.35 'Times New Roman', 'Noto Serif SC', 'SimSun', serif; }
  .band { display: flex; align-items: center; gap: 12px; padding: 5px 10px; background: #1f4e79; color: #fff; }
  .band img { height: 26px; width: auto; border-radius: 2px; }
  .band div { display: grid; flex: 1; text-align: center; }
  .band b { font-size: 13px; letter-spacing: 0.02em; }
  .band i { font-size: 11px; font-weight: 700; }
  h1 { margin: 6px 0 6px; font-size: 14px; text-align: center; }
  h1 small { display: block; font-size: 11px; font-style: italic; }
  table { width: 100%; border-collapse: collapse; table-layout: fixed; }
  th, td { border: 1px solid #9aa7b4; padding: 4px 6px; vertical-align: middle; }
  th i { font-style: normal; font-weight: 700; }
  .info th { background: #dce8f5; font-weight: 700; text-align: center; }
  .info th, .info td { padding-top: 2px; padding-bottom: 2px; }
  .info td { height: 6.5mm; }
  .info .strong { font-weight: 700; }
  .lines { margin-top: -1px; }
  .lines thead th { padding-top: 2px; padding-bottom: 2px; background: #1f4e79; color: #fff; font-weight: 700; text-align: center; }
  .lines thead th i { display: block; }
  .lines td { height: 7mm; }
  .center { text-align: center; }
  .band-title { margin-top: -1px; padding: 2px; background: #1f4e79; color: #fff; font-size: 10.5px; font-weight: 700; text-align: center; }
  .result th { background: #dce8f5; }
  .signatures { margin-top: -1px; }
  .signatures th { padding-top: 2px; padding-bottom: 2px; background: #dfe3f2; text-align: center; }
  .signatures th i { display: block; }
  .signatures td { height: 17mm; text-align: center; vertical-align: top; color: #444; font-size: 9.5px; }
  .signatures td span { display: block; margin-top: 9mm; color: #111; font-size: 11px; font-weight: 700; }
  .notes { display: grid; grid-template-columns: 2fr 3fr; gap: 8px; margin-top: 4px; font-size: 9px; line-height: 1.3; }
  .manager { margin: 0; padding: 4px 6px; border: 1px solid #e6d28a; background: #fff3c4; }
  .guide ol { margin: 1px 0 0; padding-left: 15px; }

  /* Lề 8mm → vùng in 281 × 194mm. Nội dung cao hơn thì thu nhỏ theo `--print-fit` (xem $lib/print-fit) bằng transform —
     Chrome bỏ qua CSS zoom khi in — trong khung cao 193mm để trình duyệt không chia sang trang 2. */
  @page { size: A4 landscape; margin: 8mm; }
  @media print {
    :global(html), :global(body) { background: #fff !important; }
    .toolbar { display: none; }
    .sheet { width: auto; min-height: 0; margin: 0; padding: 0; box-shadow: none; }
    .page-frame { height: 193mm; overflow: hidden; break-inside: avoid; }
    .page-frame.fitted .sheet { width: calc(100% / var(--print-fit, 1)); transform: scale(var(--print-fit, 1)); transform-origin: 0 0; }
    .band, .lines thead th, .band-title, .info th, .signatures th, .manager { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  }
  @media screen and (max-width: 1100px) { .sheet { width: auto; margin: 12px; } }
</style>
