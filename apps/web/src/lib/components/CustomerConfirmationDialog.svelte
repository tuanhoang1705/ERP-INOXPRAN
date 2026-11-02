<script lang="ts">
  import { m } from '$lib/paraglide/messages';
  /**
   * Bước "KD đối chiếu với khách": phải đính kèm ít nhất 1 ảnh chụp màn hình làm bằng chứng
   * (VD: tin nhắn Zalo "xuất đi em, đúng rồi") thì phiếu mới chuyển sang thủ kho.
   * Ảnh dán bằng Ctrl+V, kéo-thả hoặc chọn file; ảnh được quét mã độc (ClamAV) và tải lên ngay, lưu vết (người tải, thời điểm, SHA-256).
   */
  import type { AttachmentMeta } from '@inoxpran/contracts';
  import { CircleAlert, ClipboardPaste, ImagePlus, LoaderCircle, ShieldCheck, X } from 'lucide-svelte';
  import Dialog from './Dialog.svelte';
  import { api } from '$lib/api';
  import { prepareImage } from '$lib/image';

  type Target = { id: string; code: string; version: number; customerName?: string | undefined; warehouseKeeperName?: string | undefined };
  type Item = { key: string; name: string; preview: string; size: number; status: 'uploading' | 'done' | 'error'; attachment?: AttachmentMeta; error?: string };

  // image/jpeg đứng đầu: Safari / iPhone đổi ảnh HEIC sang định dạng đầu danh sách accept.
  const ACCEPTED = ['image/jpeg', 'image/png', 'image/webp'];
  const MAX_BYTES = 8 * 1024 * 1024;
  const MAX_FILES = 6;

  let { order = $bindable(null), ondone }: { order?: Target | null; ondone: (count: number) => void } = $props();

  let open = $state(false);
  let items = $state<Item[]>([]);
  let note = $state('');
  let error = $state('');
  let working = $state(false);
  let dragging = $state(false);
  let picker = $state<HTMLInputElement>();

  const uploaded = $derived(items.filter((item) => item.status === 'done' && item.attachment));
  const uploading = $derived(items.some((item) => item.status === 'uploading'));
  const canConfirm = $derived(uploaded.length > 0 && !uploading && !working);

  $effect(() => {
    if (order) {
      items = [];
      note = '';
      error = '';
      open = true;
    }
  });
  $effect(() => {
    if (!open && order) {
      discardPending();
      order = null;
    }
  });
  $effect(() => {
    if (!open) return;
    const onPaste = (event: ClipboardEvent) => {
      const files = [...(event.clipboardData?.items ?? [])].filter((entry) => entry.kind === 'file').map((entry) => entry.getAsFile()).filter((file): file is File => Boolean(file));
      if (files.length) {
        event.preventDefault();
        addFiles(files);
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  });

  const kb = (size: number) => (size >= 1024 * 1024 ? `${(size / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(size / 1024))} KB`);

  function addFiles(files: File[]) {
    error = '';
    for (const file of files) {
      if (items.length >= MAX_FILES) {
        error = m.toi_da_anh_cho_mot_lan({ MAX_FILES: MAX_FILES });
        break;
      }
      if (!ACCEPTED.includes(file.type)) {
        error = m.khong_phai_anh_png_jpeg_hoac({ name: file.name });
        continue;
      }
      const name = file.name && file.name !== 'image.png' ? file.name : `zalo-xac-nhan-${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')}.png`;
      const item: Item = { key: crypto.randomUUID(), name, preview: URL.createObjectURL(file), size: file.size, status: 'uploading' };
      items.push(item);
      upload(item.key, file, name);
    }
  }

  async function upload(key: string, file: File, name: string) {
    const target = order;
    if (!target) return;
    const update = (patch: Partial<Item>) => {
      const index = items.findIndex((item) => item.key === key);
      if (index >= 0) items[index] = { ...(items[index] as Item), ...patch };
    };
    try {
      // Ảnh chụp màn hình lớn hơn 2 MB được nén (chữ vẫn nét) — lib/image.ts.
      const blob = await prepareImage(file, 'screenshot');
      if (blob.size > MAX_BYTES) throw new Error(m.anh_vuot_qua_8_mb());
      const attachment = await api<AttachmentMeta>(`/sales-orders/${target.id}/attachments`, {
        method: 'POST',
        body: blob,
        headers: { 'content-type': blob.type, 'x-file-name': encodeURIComponent(blob === file ? name : name.replace(/\.\w+$/, blob.name.slice(blob.name.lastIndexOf('.')))) },
      });
      if (!items.some((item) => item.key === key)) {
        // Người dùng đã bỏ ảnh trong lúc đang tải: xóa luôn trên máy chủ.
        api(`/sales-orders/${target.id}/attachments/${attachment.id}`, { method: 'DELETE' }).catch(() => undefined);
        return;
      }
      update({ status: 'done', attachment, size: attachment.size });
    } catch (caught) {
      update({ status: 'error', error: caught instanceof Error ? caught.message : m.tai_anh_that_bai() });
    }
  }

  function remove(item: Item) {
    items = items.filter((entry) => entry.key !== item.key);
    URL.revokeObjectURL(item.preview);
    if (item.attachment && order) api(`/sales-orders/${order.id}/attachments/${item.attachment.id}`, { method: 'DELETE' }).catch(() => undefined);
  }

  /** Đóng hộp thoại mà chưa xác nhận: xóa ảnh đã tải (máy chủ cũng tự xóa sau 24 giờ). */
  function discardPending() {
    const target = order;
    for (const item of items) {
      URL.revokeObjectURL(item.preview);
      if (target && item.attachment && !working) api(`/sales-orders/${target.id}/attachments/${item.attachment.id}`, { method: 'DELETE' }).catch(() => undefined);
    }
    items = [];
  }

  function onDrop(event: DragEvent) {
    event.preventDefault();
    dragging = false;
    addFiles([...(event.dataTransfer?.files ?? [])]);
  }

  async function confirm() {
    if (!order || !canConfirm) return;
    working = true;
    error = '';
    try {
      await api(`/sales-orders/${order.id}/customer-confirmation`, {
        method: 'POST',
        idempotentCommand: true,
        body: JSON.stringify({
          version: order.version,
          decision: 'CONFIRMED',
          evidenceIds: uploaded.map((item) => item.attachment?.id),
          ...(note.trim() ? { note: note.trim() } : {}),
        }),
      });
      const count = uploaded.length;
      for (const item of items) URL.revokeObjectURL(item.preview);
      items = [];
      open = false;
      ondone(count);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.khong_xac_nhan_duoc();
    } finally {
      working = false;
    }
  }
</script>

<Dialog bind:open title={order ? m.xac_nhan_doi_chieu_phieu({ code: order.code }) : m.xac_nhan_doi_chieu()}>
  {#if order}
    <p class="lead">
      {m.dinh_kem()} <b>{m.anh_chup_man_hinh_xac_nhan()}</b> {m.cua_kinh_doanh_khach_cho_phieu()} <b>{order.customerName ?? ''}</b> {m.vi_du_tin_nhan_zalo_xuat()}{order.warehouseKeeperName ? ` ${order.warehouseKeeperName}` : ''}.
    </p>
    <div
      class="drop"
      class:dragging
      role="button"
      tabindex="0"
      aria-label={m.dan_keo_tha_hoac_chon_anh()}
      ondragover={(event) => { event.preventDefault(); dragging = true; }}
      ondragleave={() => (dragging = false)}
      ondrop={onDrop}
      onclick={() => picker?.click()}
      onkeydown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); picker?.click(); } }}
    >
      <ClipboardPaste size={22} />
      <b>{m.dan_anh_ctrl_v_hoac_keo()}</b>
      <span>{m.hoac()} <u>{m.chon_anh_tu_may()}</u> {m.png_jpeg_webp_toi_da_8()} {MAX_FILES} {m.anh()}</span>
      <input bind:this={picker} type="file" accept={ACCEPTED.join(',')} multiple hidden onchange={(event) => { addFiles([...(event.currentTarget.files ?? [])]); event.currentTarget.value = ''; }} />
    </div>
    {#if items.length}
      <ul class="thumbs">
        {#each items as item (item.key)}
          <li class:failed={item.status === 'error'}>
            <img src={item.preview} alt={item.name} />
            <div class="meta">
              <b title={item.name}>{item.name}</b>
              <small>
                {#if item.status === 'uploading'}<LoaderCircle size={12} class="spin" /> {m.dang_tai_len_quet_ma_doc()}
                {:else if item.status === 'error'}<CircleAlert size={12} /> {item.error}
                {:else}<ShieldCheck size={12} class="safe" /> {item.attachment?.scan?.result === 'CLEAN' ? m.sach_ma_doc() : m.chua_quet_may_dev()} {m.da_luu()} {kb(item.size)} · SHA-256 {item.attachment?.sha256.slice(0, 10)}…{/if}
              </small>
            </div>
            <button class="remove" onclick={() => remove(item)} aria-label={m.bo_anh({ name: item.name })}><X size={14} /></button>
          </li>
        {/each}
      </ul>
    {/if}
    <div class="field">
      <label for="confirm-note">{m.ghi_chu_khong_bat_buoc()}</label>
      <input id="confirm-note" bind:value={note} maxlength="500" placeholder={m.vd_anh_tuan_xac_nhan_qua()} />
    </div>
    {#if error}<div class="banner error"><CircleAlert size={17} /><span>{error}</span></div>{/if}
  {/if}
  {#snippet footer()}
    <button class="btn" onclick={() => (open = false)}>{m.huy()}</button>
    <button class="btn primary" disabled={!canConfirm} onclick={confirm} title={uploaded.length ? '' : m.can_it_nhat_1_anh_bang()}>
      <ImagePlus size={16} />{working ? m.dang_xac_nhan() : m.xac_nhan_chuyen_thu_kho({ p0: uploaded.length ? m.anh_2({ length: uploaded.length }) : '' })}
    </button>
  {/snippet}
</Dialog>

<style>
  .lead { margin: 0; color: var(--muted); font-size: 13.5px; line-height: 1.5; }
  .lead b { color: var(--text); }
  .drop { display: grid; justify-items: center; gap: 6px; padding: 22px 16px; border: 2px dashed #b9c7d4; border-radius: 10px; background: var(--surface-2); color: var(--navy); text-align: center; cursor: pointer; }
  .drop:hover, .drop:focus-visible, .drop.dragging { border-color: var(--orange); background: var(--orange-soft); outline: none; }
  .drop b { font-size: 14px; }
  .drop span { color: var(--muted); font-size: 12.5px; }
  .thumbs { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
  .thumbs li { display: grid; grid-template-columns: 64px minmax(0, 1fr) auto; align-items: center; gap: 12px; padding: 8px; border: 1px solid var(--line); border-radius: 8px; }
  .thumbs li.failed { border-color: #f3c9c9; background: var(--red-soft); }
  .thumbs img { width: 64px; height: 64px; border-radius: 6px; object-fit: cover; background: var(--surface-2); }
  .meta { display: grid; gap: 2px; min-width: 0; }
  .meta b { overflow: hidden; font-size: 13px; white-space: nowrap; text-overflow: ellipsis; }
  .meta small { display: flex; align-items: center; gap: 4px; color: var(--muted); font-size: 11.5px; }
  .failed small { color: var(--red); }
  .remove { display: grid; width: 28px; height: 28px; place-items: center; border-radius: 50%; background: var(--red-soft); color: var(--red); }
  :global(.spin) { animation: spin 1s linear infinite; }
  .meta :global(.safe) { color: var(--green); }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
