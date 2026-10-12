<script lang="ts">
  /**
   * Ảnh trên phiếu bảo hành: tình trạng khi nhận, phiếu đã ký khi trả, ảnh khác.
   * Ảnh đi qua API (quét mã độc, kiểm tra đúng là ảnh, lưu S3); trình duyệt chỉ xem qua API sau khi kiểm tra quyền.
   */
  import type { WarrantyPhoto } from '@inoxpran/contracts';
  import { Camera, CircleAlert, Trash2 } from 'lucide-svelte';
  import { m } from '$lib/paraglide/messages';
  import { ApiRequestError, localizedErrorMessage } from '$lib/api';
  import { dateTime } from '$lib/format';
  import { session } from '$lib/session.svelte';
  import { MAX_WARRANTY_PHOTOS, WARRANTY_PHOTO_KINDS, type WarrantyPhotoKind } from '$shared/warranty';

  let { ticketId, photos = [], canUpload = false, locked = false, onchange }: {
    ticketId: string;
    photos?: WarrantyPhoto[];
    canUpload?: boolean;
    /** Phiếu đã trả: ảnh là chứng từ, không xóa. */
    locked?: boolean;
    onchange: () => void;
  } = $props();

  let busy = $state<WarrantyPhotoKind | ''>('');
  let error = $state('');
  let preview = $state<WarrantyPhoto | null>(null);
  const kindLabel = (kind: string) => (kind === 'RECEIPT' ? m.wr_photo_receipt() : kind === 'SIGNED_FORM' ? m.wr_photo_signed() : m.wr_photo_other());
  const src = (photo: WarrantyPhoto) => `/api/v1/warranty/tickets/${ticketId}/photos/${photo.id}`;
  const canDelete = (photo: WarrantyPhoto) => canUpload && !locked && (session.user?.roles.includes('ADMIN') || photo.uploadedByName === session.user?.displayName);

  function csrf() {
    return decodeURIComponent(document.cookie.split('; ').find((entry) => entry.startsWith('erp_csrf='))?.split('=').slice(1).join('=') ?? '');
  }

  async function upload(kind: WarrantyPhotoKind, files: FileList | null) {
    if (!files?.length) return;
    busy = kind;
    error = '';
    try {
      for (const file of [...files]) {
        const response = await fetch(`/api/v1/warranty/tickets/${ticketId}/photos?kind=${kind}`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': file.type || 'application/octet-stream', 'x-file-name': encodeURIComponent(file.name), 'x-csrf-token': csrf() },
          body: file,
        });
        if (!response.ok) {
          const payload = await response.json().catch(() => ({ code: '', message: m.wr_photo_error() }));
          throw new ApiRequestError(payload);
        }
      }
      onchange();
    } catch (caught) {
      error = caught instanceof ApiRequestError ? localizedErrorMessage(caught.payload) : m.wr_photo_error();
    } finally {
      busy = '';
    }
  }

  async function remove(photo: WarrantyPhoto) {
    error = '';
    const response = await fetch(src(photo), { method: 'DELETE', credentials: 'include', headers: { 'x-csrf-token': csrf() } });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({ code: '', message: m.wr_photo_error() }));
      error = localizedErrorMessage(payload);
      return;
    }
    onchange();
  }
</script>

<section class="card photos">
  <header class="card-head head">
    <h2>{m.wr_photos_title()} <span class="pill neutral">{photos.length}/{MAX_WARRANTY_PHOTOS}</span></h2>
    {#if canUpload && photos.length < MAX_WARRANTY_PHOTOS}
      <div class="uploads">
        {#each WARRANTY_PHOTO_KINDS as kind}
          <label class="btn small" class:primary={kind === 'RECEIPT'} aria-disabled={busy !== ''}>
            <Camera size={14} />{busy === kind ? m.wr_photo_uploading() : kindLabel(kind)}
            <input type="file" accept="image/png,image/jpeg,image/webp" capture="environment" multiple disabled={busy !== ''} onchange={(event) => { void upload(kind, event.currentTarget.files); event.currentTarget.value = ''; }} />
          </label>
        {/each}
      </div>
    {/if}
  </header>
  {#if error}<div class="banner error inset"><CircleAlert size={17} /><span>{error}</span></div>{/if}
  {#if photos.length}
    <ul class="grid">
      {#each photos as photo (photo.id)}
        <li>
          <button class="thumb" onclick={() => (preview = photo)} aria-label={`${kindLabel(photo.kind)} — ${photo.fileName}`}><img src={src(photo)} alt={photo.fileName} loading="lazy" /></button>
          <div class="meta">
            <span class="pill" class:success={photo.kind === 'SIGNED_FORM'}>{kindLabel(photo.kind)}</span>
            <small>{photo.uploadedByName} · {dateTime(photo.uploadedAt)}</small>
          </div>
          {#if canDelete(photo)}<button class="icon-btn danger del" title={m.crud_xoa()} aria-label={`${m.crud_xoa()} ${photo.fileName}`} onclick={() => remove(photo)}><Trash2 size={14} /></button>{/if}
        </li>
      {/each}
    </ul>
  {:else}
    <p class="muted empty">{m.wr_photos_empty()}</p>
  {/if}
  <p class="hint">{m.wr_photos_hint()}</p>
</section>

{#if preview}
  <div class="lightbox" role="presentation" onclick={() => (preview = null)}>
    <img src={src(preview)} alt={preview.fileName} />
  </div>
{/if}

<style>
  .photos { margin-bottom: 16px; }
  .head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px; padding-bottom: 12px; }
  .uploads { display: flex; flex-wrap: wrap; gap: 8px; }
  .uploads label { position: relative; cursor: pointer; }
  .uploads input { position: absolute; inset: 0; opacity: 0; cursor: pointer; }
  .inset { margin: 0 20px 12px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 14px; margin: 0; padding: 0 20px 8px; list-style: none; }
  li { position: relative; display: grid; gap: 6px; }
  .thumb { display: block; overflow: hidden; aspect-ratio: 4 / 3; padding: 0; border: 1px solid var(--line); border-radius: 8px; background: var(--surface-2); }
  .thumb img { width: 100%; height: 100%; object-fit: cover; }
  .meta { display: grid; gap: 3px; }
  .meta .pill { width: fit-content; }
  .meta small { color: var(--subtle); font-size: 11.5px; }
  .del { position: absolute; top: 6px; right: 6px; background: var(--surface); }
  .empty, .hint { margin: 0; padding: 0 20px 14px; font-size: 12.5px; }
  .hint { color: var(--subtle); }
  .lightbox { position: fixed; inset: 0; z-index: 60; display: grid; place-items: center; padding: 24px; background: rgba(10, 20, 30, 0.75); cursor: zoom-out; }
  .lightbox img { max-width: 100%; max-height: 100%; border-radius: 8px; box-shadow: 0 20px 60px rgba(0, 0, 0, 0.4); }
</style>
