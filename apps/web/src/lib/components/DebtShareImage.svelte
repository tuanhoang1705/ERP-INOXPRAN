<script lang="ts" module>
  export interface DebtShareRow {
    label: string;
    /** Số tiền (chuỗi số); dòng cuối "còn lại" tô đỏ như file Excel của kế toán. */
    value: string;
    emphasis?: boolean;
  }
</script>

<script lang="ts">
  /**
   * Ảnh công nợ gửi khách (CN-SHARE-01, 10/11/2026): bảng tóm tắt đúng mẫu Excel kế toán đang chụp gửi khách qua Zalo
   * (Tổng công nợ / Đã thanh toán / Phí vận chuyển / Công nợ nhóm tách riêng / Còn lại / Còn lại trừ nhóm — chữ đỏ),
   * số lấy từ sổ công nợ ERP lúc bấm. Vẽ thẳng lên canvas (không thư viện) → Sao chép ảnh (dán vào Zalo) hoặc Tải ảnh PNG.
   */
  import { Copy, Download } from 'lucide-svelte';
  import { m } from '$lib/paraglide/messages';
  import Dialog from './Dialog.svelte';

  let { open = $bindable(false), customer, code, asOf, rows }: {
    open?: boolean;
    customer: string;
    code: string;
    /** Ngày chốt số, dạng dd/mm/yyyy. */
    asOf: string;
    rows: DebtShareRow[];
  } = $props();

  let preview = $state('');
  let message = $state('');
  let failed = $state(false);
  let canvas: HTMLCanvasElement | null = null;

  const money = (value: string) => `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(Math.round(Number(value) || 0))} ₫`;

  /** Xuống dòng nhãn dài trong ô nhãn. */
  function wrap(ctx: CanvasRenderingContext2D, text: string, width: number): string[] {
    const words = text.split(' ');
    const lines: string[] = [];
    let line = '';
    for (const word of words) {
      const next = line ? `${line} ${word}` : word;
      if (ctx.measureText(next).width > width && line) {
        lines.push(line);
        line = word;
      } else line = next;
    }
    if (line) lines.push(line);
    return lines;
  }

  function draw(): HTMLCanvasElement {
    const scale = 2;
    const pad = 18;
    const labelWidth = 330;
    const valueWidth = 190;
    const lineHeight = 21;
    const font = (size: number, weight = 'bold') => `${weight} ${size}px "Times New Roman", Times, serif`;
    const measure = document.createElement('canvas').getContext('2d')!;
    measure.font = font(16);
    const wrapped = rows.map((row) => wrap(measure, row.label, labelWidth - 16));
    const heights = wrapped.map((lines) => Math.max(34, lines.length * lineHeight + 12));
    const titleHeight = 54;
    const footHeight = 26;
    const width = pad * 2 + labelWidth + valueWidth;
    const height = pad + titleHeight + heights.reduce((sum, value) => sum + value, 0) + footHeight + pad;
    const element = document.createElement('canvas');
    element.width = width * scale;
    element.height = height * scale;
    const ctx = element.getContext('2d')!;
    ctx.scale(scale, scale);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = '#000000';
    ctx.textBaseline = 'middle';
    ctx.font = font(17);
    ctx.textAlign = 'center';
    ctx.fillText(`CÔNG NỢ ${customer.toUpperCase()}`.slice(0, 70), width / 2, pad + 14);
    ctx.font = font(13.5, 'italic');
    ctx.fillText(`${code} · Tính đến ngày ${asOf}`, width / 2, pad + 38);
    let y = pad + titleHeight;
    const left = pad;
    const middle = pad + labelWidth;
    const right = pad + labelWidth + valueWidth;
    const top = y;
    rows.forEach((row, index) => {
      const rowHeight = heights[index]!;
      ctx.font = font(16);
      ctx.textAlign = 'left';
      ctx.fillStyle = '#000000';
      const lines = wrapped[index]!;
      lines.forEach((text, lineIndex) => ctx.fillText(text, left + 8, y + rowHeight / 2 + (lineIndex - (lines.length - 1) / 2) * lineHeight));
      ctx.textAlign = 'right';
      ctx.fillStyle = row.emphasis ? '#c00000' : '#000000';
      ctx.font = font(17);
      ctx.fillText(money(row.value), right - 8, y + rowHeight / 2);
      y += rowHeight;
      if (index < rows.length - 1) {
        ctx.strokeStyle = '#000000';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(left, y);
        ctx.lineTo(right, y);
        ctx.stroke();
      }
    });
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 2;
    ctx.strokeRect(left, top, right - left, y - top);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(middle, top);
    ctx.lineTo(middle, y);
    ctx.stroke();
    ctx.fillStyle = '#666666';
    ctx.font = font(11.5, 'normal');
    ctx.textAlign = 'left';
    ctx.fillText(`INOXPRAN · lập từ ERP ${new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', dateStyle: 'short', timeStyle: 'short' }).format(new Date())}`, left, y + 16);
    return element;
  }

  $effect(() => {
    if (!open) return;
    message = '';
    failed = false;
    canvas = draw();
    preview = canvas.toDataURL('image/png');
  });

  async function copyImage() {
    message = '';
    failed = false;
    try {
      if (!canvas || typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) throw new Error('unsupported');
      const blob = await new Promise<Blob>((resolve, reject) => canvas!.toBlob((value) => (value ? resolve(value) : reject(new Error('blob'))), 'image/png'));
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      message = m.cn_anh_da_sao_chep();
    } catch {
      failed = true;
      message = m.cn_anh_khong_sao_chep();
    }
  }

  function downloadImage() {
    if (!canvas) return;
    const link = document.createElement('a');
    link.href = canvas.toDataURL('image/png');
    link.download = `CongNo_${code}_${asOf.split('/').reverse().join('')}.png`;
    link.click();
    message = m.cn_anh_da_tai();
    failed = false;
  }
</script>

<Dialog bind:open title={m.cn_anh_gui_khach()} wide>
  <div class="share">
    <p class="hint">{m.cn_anh_goi_y()}</p>
    {#if preview}<img src={preview} alt={m.cn_anh_gui_khach()} />{/if}
    {#if message}<p class="message" class:failed role="status">{message}</p>{/if}
  </div>
  {#snippet footer()}
    <button class="btn" onclick={() => (open = false)}>{m.dong()}</button>
    <button class="btn" onclick={downloadImage}><Download size={16} />{m.cn_anh_tai()}</button>
    <button class="btn primary" onclick={copyImage}><Copy size={16} />{m.cn_anh_sao_chep()}</button>
  {/snippet}
</Dialog>

<style>
  .share { display: grid; gap: 12px; justify-items: center; }
  .hint { margin: 0; justify-self: stretch; color: var(--muted); font-size: 13px; }
  img { width: 100%; max-width: 556px; height: auto; border: 1px solid var(--line); border-radius: var(--radius-sm); background: #fff; }
  .message { margin: 0; color: var(--green); font-size: 13px; font-weight: 600; }
  .message.failed { color: var(--red); }
</style>
