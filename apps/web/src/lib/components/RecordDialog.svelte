<script module lang="ts">
  export type FieldType = 'text' | 'code' | 'digits' | 'select' | 'textarea' | 'checkbox' | 'email' | 'tel';
  export interface FieldSpec {
    key: string;
    label: string;
    type?: FieldType;
    required?: boolean;
    readonly?: boolean;
    maxlength?: number;
    options?: Array<{ value: string; label: string }>;
    hint?: string;
    /** Chiếm cả hàng (2 cột). */
    span?: boolean;
  }
  export type RecordValues = Record<string, string | boolean>;
</script>

<script lang="ts">
  /**
   * Hộp thoại thêm / sửa bản ghi danh mục đơn giản theo cấu hình trường (nhóm hàng, kho, vị trí lưu, khu vực, nhân viên, nhà cung cấp).
   * Kiểm tra sớm phía giao diện (bắt buộc, mã viết hoa); máy chủ vẫn là nơi quyết định và lỗi trả về hiện dưới đúng ô.
   */
  import { untrack } from 'svelte';
  import { CircleAlert } from 'lucide-svelte';
  import { m } from '$lib/paraglide/messages';
  import { ApiRequestError } from '$lib/api';
  import Dialog from './Dialog.svelte';
  import NumberInput from './NumberInput.svelte';

  let { open = $bindable(false), title, fields, values = {}, onsubmit, formId }: {
    open?: boolean;
    title: string;
    fields: FieldSpec[];
    values?: RecordValues;
    onsubmit: (values: RecordValues) => Promise<void>;
    formId: string;
  } = $props();

  let form = $state<RecordValues>({});
  let errors = $state<Record<string, string>>({});
  let error = $state('');
  let saving = $state(false);

  $effect(() => {
    if (!open) return;
    untrack(() => {
      form = Object.fromEntries(fields.map((field) => [field.key, values[field.key] ?? (field.type === 'checkbox' ? false : '')]));
      errors = {};
      error = '';
    });
  });

  function validate() {
    const found: Record<string, string> = {};
    for (const field of fields) {
      const value = form[field.key];
      if (field.readonly || typeof value === 'boolean') continue;
      const text = String(value ?? '').trim();
      if (field.required && !text) found[field.key] = m.kh_bat_buoc_chon();
      else if (field.type === 'code' && text && !/^[A-Z0-9][A-Z0-9._/-]{1,39}$/.test(text)) found[field.key] = m.kh_ma_quy_tac();
      else if (field.type === 'email' && text && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) found[field.key] = m.kh_email_khong_hop_le();
    }
    return found;
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    errors = validate();
    error = '';
    if (Object.keys(errors).length) return;
    saving = true;
    try {
      const trimmed = Object.fromEntries(Object.entries(form).map(([key, value]) => [key, typeof value === 'string' ? value.trim() : value]));
      await onsubmit(trimmed);
      open = false;
    } catch (caught) {
      if (caught instanceof ApiRequestError) {
        const details = Array.isArray(caught.payload.details) ? (caught.payload.details as Array<{ path?: unknown[] }>) : [];
        for (const issue of details) {
          const key = issue.path?.[0];
          if (typeof key === 'string' && fields.some((field) => field.key === key)) errors[key] ??= m.kh_gia_tri_khong_hop_le();
        }
        if (/_CODE_EXISTS$/.test(caught.payload.code ?? '')) errors.code = caught.message;
      }
      error = caught instanceof Error ? caught.message : m.crud_loi_luu();
    } finally {
      saving = false;
    }
  }
</script>

<Dialog bind:open {title} wide={fields.length > 4}>
  <form id={formId} class="grid" class:single={fields.length <= 4} onsubmit={submit} novalidate>
    {#if error}<div class="banner error span"><CircleAlert size={17} /><span>{error}</span></div>{/if}
    {#each fields as field (field.key)}
      {@const id = `${formId}-${field.key}`}
      {#if field.type === 'checkbox'}
        <label class="check span"><input type="checkbox" checked={Boolean(form[field.key])} onchange={(event) => (form[field.key] = event.currentTarget.checked)} />{field.label}</label>
      {:else}
        <div class="field" class:span={field.span}>
          <label for={id}>{field.label}{#if field.required && !field.readonly} <span class="req">*</span>{/if}</label>
          {#if field.type === 'select'}
            <select {id} value={String(form[field.key] ?? '')} disabled={field.readonly} onchange={(event) => (form[field.key] = event.currentTarget.value)}>
              {#each field.options ?? [] as option}<option value={option.value}>{option.label}</option>{/each}
            </select>
          {:else if field.type === 'textarea'}
            <textarea {id} rows="3" maxlength={field.maxlength ?? 500} value={String(form[field.key] ?? '')} oninput={(event) => (form[field.key] = event.currentTarget.value)}></textarea>
          {:else if field.type === 'digits'}
            <NumberInput {id} value={String(form[field.key] ?? '')} readonly={field.readonly} aria-invalid={Boolean(errors[field.key])} onvalue={(value) => (form[field.key] = value)} />
          {:else}
            <input {id} type={field.type === 'email' ? 'email' : field.type === 'tel' ? 'tel' : 'text'}
              value={String(form[field.key] ?? '')} readonly={field.readonly} maxlength={field.maxlength ?? (field.type === 'code' ? 40 : 240)} autocomplete="off"
              aria-invalid={Boolean(errors[field.key])}
              oninput={(event) => {
                const raw = event.currentTarget.value;
                form[field.key] = field.type === 'code' ? raw.toUpperCase() : raw;
              }} />
          {/if}
          {#if errors[field.key]}<span class="error">{errors[field.key]}</span>{:else if field.hint}<span class="hint">{field.hint}</span>{/if}
        </div>
      {/if}
    {/each}
  </form>
  {#snippet footer()}
    <button type="button" class="btn" onclick={() => (open = false)}>{m.huy()}</button>
    <button type="submit" class="btn primary" form={formId} disabled={saving}>{saving ? m.kh_dang_luu() : m.crud_luu()}</button>
  {/snippet}
</Dialog>

<style>
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px 16px; align-items: start; }
  .grid.single { grid-template-columns: 1fr; }
  .span { grid-column: 1 / -1; }
  .req { color: var(--red); }
  .check { display: flex; align-items: center; gap: 8px; color: var(--text); font-size: 13.5px; }
  .check input { width: 17px; height: 17px; accent-color: var(--navy); }
  @media (max-width: 640px) { .grid { grid-template-columns: 1fr; } }
</style>
