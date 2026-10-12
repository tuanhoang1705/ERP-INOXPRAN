<script lang="ts" module>
  export interface AttachmentPurpose {
    purpose: string;
    label: string;
    /** Nhận PDF (tài liệu) hay chỉ ảnh. */
    pdf: boolean;
  }
  export interface AttachmentFile {
    id: string;
    fileName: string;
    contentType: string;
    size: number;
    purpose: string;
    uploadedAt: string;
    uploadedByName: string;
  }
</script>

<script lang="ts">
  /**
   * Tab "Đính kèm": ảnh / PDF đi qua API (quét mã độc, kiểm tra chữ ký file, lưu S3);
   * trình duyệt chỉ xem file qua API sau khi máy chủ kiểm tra quyền xem hồ sơ.
   */
  import { CircleAlert, FileText, ImagePlus, Star, Trash2, Upload } from 'lucide-svelte';
  import { m } from '$lib/paraglide/messages';
  import { api, ApiRequestError, localizedErrorMessage } from '$lib/api';
  import { dateTime } from '$lib/format';

  let { type, id, purposes, primaryId = '', onprimary, onchange }: {
    type: string;
    id: string;
    purposes: AttachmentPurpose[];
    /** Ảnh đại diện hiện tại (sản phẩm). */
    primaryId?: string;
    onprimary?: ((attachmentId: string) => void | Promise<void>) | undefined;
    /** Gọi sau khi thêm / xóa (cập nhật số đếm trên tab). */
    onchange?: ((count: number) => void) | undefined;
  } = $props();

  let rows = $state<AttachmentFile[]>([]);
  let canEdit = $state(false);
  let busy = $state('');
  let error = $state('');
  let preview = $state<AttachmentFile | null>(null);
  const src = (file: AttachmentFile) => `/api/v1/attachments/${type}/${id}/${file.id}`;
  const isImage = (file: AttachmentFile) => file.contentType.startsWith('image/');
  const size = (bytes: number) => (bytes >= 1_048_576 ? `${(bytes / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

  async function load() {
    try {
      const result = await api<{ rows: AttachmentFile[]; canEdit: boolean }>(`/attachments/${type}/${id}`);
      rows = result.rows;
      canEdit = result.canEdit;
      onchange?.(rows.length);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.rw_loi_tai();
    }
  }
  $effect(() => {
    void id;
    void load();
  });

  function csrf() {
    return decodeURIComponent(document.cookie.split('; ').find((entry) => entry.startsWith('erp_csrf='))?.split('=').slice(1).join('=') ?? '');
  }

  async function upload(purpose: AttachmentPurpose, files: FileList | null) {
    if (!files?.length) return;
    busy = purpose.purpose;
    error = '';
    try {
      for (const file of [...files]) {
        const response = await fetch(`/api/v1/attachments/${type}/${id}?purpose=${purpose.purpose}`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': file.type || 'application/octet-stream', 'x-file-name': encodeURIComponent(file.name), 'x-csrf-token': csrf() },
          body: file,
        });
        if (!response.ok) {
          const payload = await response.json().catch(() => ({ code: '', message: m.rw_loi_tai_len() }));
          throw new ApiRequestError(payload);
        }
      }
      await load();
    } catch (caught) {
      error = caught instanceof ApiRequestError ? localizedErrorMessage(caught.payload) : m.rw_loi_tai_len();
      await load();
    } finally {
      busy = '';
    }
  }

  async function remove(file: AttachmentFile) {
    if (!confirm(m.rw_xoa_file_hoi({ name: file.fileName }))) return;
    error = '';
    try {
      await api(`/attachments/${type}/${id}/${file.id}`, { method: 'DELETE' });
      await load();
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.rw_loi_tai_len();
    }
  }
</script>

{#each purposes as purpose (purpose.purpose)}
  {@const files = rows.filter((row) => row.purpose === purpose.purpose)}
  <section class="card group">
    <header class="card-head head">
      <h2>{purpose.label} <span class="pill neutral">{files.length}</span></h2>
      {#if canEdit}
        <label class="btn small" class:primary={!purpose.pdf} aria-disabled={busy !== ''}>
          {#if purpose.pdf}<Upload size={14} />{:else}<ImagePlus size={14} />{/if}{busy === purpose.purpose ? m.rw_dang_tai_len() : m.rw_tai_len()}
          <input type="file" accept={purpose.pdf ? 'image/png,image/jpeg,image/webp,application/pdf' : 'image/png,image/jpeg,image/webp'} multiple disabled={busy !== ''}
            onchange={(event) => { void upload(purpose, event.currentTarget.files); event.currentTarget.value = ''; }} />
        </label>
      {/if}
    </header>
    {#if error && busy === ''}<div class="banner error inset"><CircleAlert size={17} /><span>{error}</span></div>{/if}
    {#if files.length}
      <ul class="grid">
        {#each files as file (file.id)}
          <li class:primary={file.id === primaryId}>
            {#if isImage(file)}
              <button class="thumb" onclick={() => (preview = file)} aria-label={file.fileName}><img src={src(file)} alt={file.fileName} loading="lazy" /></button>
            {:else}
              <a class="thumb doc" href={src(file)} target="_blank" rel="noopener"><FileText size={34} /><span>PDF</span></a>
            {/if}
            <div class="meta">
              <a class="name" href={src(file)} target="_blank" rel="noopener" title={file.fileName}>{file.fileName}</a>
              <small>{size(file.size)} · {file.uploadedByName} · {dateTime(file.uploadedAt)}</small>
            </div>
            <div class="tools">
              {#if onprimary && isImage(file)}
                {#if file.id === primaryId}<span class="pill orange">{m.rw_anh_dai_dien()}</span>
                {:else if canEdit}<button class="icon-btn" title={m.rw_dat_anh_dai_dien()} aria-label={m.rw_dat_anh_dai_dien()} onclick={() => onprimary?.(file.id)}><Star size={14} /></button>{/if}
              {/if}
              {#if canEdit}<button class="icon-btn danger" title={m.crud_xoa()} aria-label={`${m.crud_xoa()} ${file.fileName}`} onclick={() => remove(file)}><Trash2 size={14} /></button>{/if}
            </div>
          </li>
        {/each}
      </ul>
    {:else}
      <p class="muted empty">{m.rw_chua_co_file()}</p>
    {/if}
  </section>
{/each}
<p class="hint">{m.rw_dinh_kem_ghi_chu()}</p>

{#if preview}
  <div class="lightbox" role="presentation" onclick={() => (preview = null)}>
    <img src={src(preview)} alt={preview.fileName} />
  </div>
{/if}

<style>
  .group { margin-bottom: 14px; }
  .head { flex-wrap: wrap; padding-bottom: 12px; }
  .head h2 { display: flex; align-items: center; gap: 8px; }
  .head label { position: relative; cursor: pointer; }
  .head input { position: absolute; inset: 0; opacity: 0; cursor: pointer; }
  .inset { margin: 0 20px 12px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 14px; margin: 0; padding: 0 20px 18px; list-style: none; }
  li { position: relative; display: grid; gap: 6px; padding: 8px; border: 1px solid var(--line-soft); border-radius: 10px; }
  li.primary { border-color: var(--orange); }
  .thumb { display: grid; overflow: hidden; aspect-ratio: 4 / 3; place-items: center; padding: 0; border-radius: 8px; background: var(--surface-2); }
  .thumb img { width: 100%; height: 100%; object-fit: cover; }
  .doc { gap: 4px; color: var(--navy); font-weight: 700; font-size: 12px; }
  .meta { display: grid; min-width: 0; }
  .name { overflow: hidden; color: var(--navy); font-size: 12.5px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
  .name:hover { text-decoration: underline; }
  .meta small { color: var(--subtle); font-size: 11.5px; }
  .tools { display: flex; align-items: center; justify-content: flex-end; gap: 4px; min-height: 26px; }
  .empty { margin: 0; padding: 0 20px 18px; font-size: 13px; }
  .hint { margin: 0 0 16px; color: var(--subtle); font-size: 12px; }
  .lightbox { position: fixed; inset: 0; z-index: 80; display: grid; place-items: center; padding: 24px; background: rgba(10, 22, 34, 0.82); cursor: zoom-out; }
  .lightbox img { max-width: 100%; max-height: 100%; border-radius: 8px; }
</style>
