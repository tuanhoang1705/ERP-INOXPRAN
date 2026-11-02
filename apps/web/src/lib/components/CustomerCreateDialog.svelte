<script module lang="ts">
  /**
   * Vai trò được thêm khách hàng — theo canCreatePartnerKind($shared/catalog-access.ts); ADMIN luôn được.
   * Kế toán thêm khách ngay khi lập phiếu BH; phòng Kinh doanh quản lý (sửa / xóa) hồ sơ khách; Giám đốc chỉ xem.
   */
  export const CUSTOMER_CREATE_ROLES = ['ACCOUNTANT', 'CATALOG_MANAGER', 'SALES_MANAGER', 'PROCUREMENT_MANAGER'];

  /** Mã KHnnn kế tiếp theo các mã đang có — chỉ là gợi ý, khách đã có mã trên sổ sách/MISA thì dùng mã đó. */
  export function nextCustomerCode(codes: string[]): string {
    const highest = codes.reduce((max, code) => {
      const match = /^KH(\d+)$/.exec(code);
      return match ? Math.max(max, Number(match[1])) : max;
    }, 0);
    return `KH${String(highest + 1).padStart(3, '0')}`;
  }
</script>

<script lang="ts">
  /**
   * Thêm khách hàng mới (POST /partners) hoặc sửa hồ sơ (PATCH /partners/:id kèm version) — ghi audit PARTNER_CREATED / PARTNER_UPDATED.
   * Mã khách không đổi khi sửa. Hạn mức, số ngày nợ, khóa công nợ chỉ Giám đốc / kế toán đổi (máy chủ kiểm tra lại).
   * Kiểm tra phía giao diện chỉ lặp lại quy tắc của schema để báo lỗi sớm; máy chủ vẫn là nơi quyết định.
   */
  import type { Partner } from '@inoxpran/contracts';
  import { untrack } from 'svelte';
  import { CircleAlert } from 'lucide-svelte';
  import { m } from '$lib/paraglide/messages';
  import { api, ApiRequestError } from '$lib/api';
  import { vnd } from '$lib/format';
  import { hasRole, partnerStatus, tierLabel } from '$lib/labels';
  import { can } from '$lib/permissions';
  import { session } from '$lib/session.svelte';
  import Dialog from './Dialog.svelte';
  import NumberInput from './NumberInput.svelte';
  import TerritoryFields from './TerritoryFields.svelte';

  type Employee = { id: string; code: string; name: string; role: string; status?: string };
  type Field = 'code' | 'name' | 'customerTier' | 'email' | 'creditLimit' | 'paymentTermDays';

  type Editable = Pick<Partner, 'id' | 'code' | 'name' | 'version' | 'creditLimit' | 'paymentTermDays' | 'status'> & {
    customerTier?: string | undefined; regionCode?: string | undefined; province?: string | undefined; salesRepId?: string | undefined;
    provinceOldCode?: string | undefined; provinceNewCode?: string | undefined; territoryChannel?: string | undefined; territoryException?: { reason: string; byName: string } | undefined;
    taxCode?: string | undefined; phone?: string | undefined; email?: string | undefined; address?: string | undefined;
  };
  let { open = $bindable(false), existingCodes = [], partner = null, allowProspect = false, oncreated }: {
    open?: boolean;
    existingCodes?: string[];
    /** Hồ sơ khách hàng (CRM): cho tạo khách "cơ hội" (chưa cấp giá / công nợ). Phiếu bán hàng chỉ tạo khách chính thức. */
    allowProspect?: boolean;
    /** Có hồ sơ = chế độ sửa. */
    partner?: Editable | null;
    oncreated?: (partner: Partner) => void;
  } = $props();

  const blank = () => ({
    code: '', name: '', customerTier: '', provinceNewCode: '', provinceOldCode: '', territoryChannel: '', exceptionReason: '', salesRepId: '',
    taxCode: '', phone: '', email: '', address: '', creditLimit: '0', paymentTermDays: '0', status: 'ACTIVE', stage: 'CUSTOMER',
  });
  let form = $state(blank());
  let errors = $state<Partial<Record<Field, string>>>({});
  let error = $state('');
  let saving = $state(false);
  let employees = $state<Employee[]>([]);
  let referenceLoaded = false;

  const suggestedCode = $derived(nextCustomerCode(existingCodes));
  /** Nhân viên kinh doanh chỉ được tạo khách cơ hội. */
  const prospectOnly = $derived(allowProspect && !hasRole(session.user?.roles, CUSTOMER_CREATE_ROLES) && can.createProspects());
  const prospect = $derived(!partner && allowProspect && form.stage === 'PROSPECT');
  const retail = $derived(form.customerTier === 'RETAIL');
  const editing = $derived(Boolean(partner));
  /** Sửa hồ sơ: hạn mức / số ngày nợ / khóa công nợ chỉ Giám đốc, kế toán. */
  const creditLocked = $derived(editing && !can.editCreditTerms());

  $effect(() => {
    if (!open) return;
    untrack(() => {
      form = partner
        ? {
            code: partner.code, name: partner.name, customerTier: partner.customerTier ?? '',
            provinceNewCode: partner.provinceNewCode ?? '', provinceOldCode: partner.provinceOldCode ?? '', territoryChannel: partner.territoryChannel ?? '', exceptionReason: partner.territoryException?.reason ?? '',
            salesRepId: partner.salesRepId ?? '', taxCode: partner.taxCode ?? '', phone: partner.phone ?? '', email: partner.email ?? '', address: partner.address ?? '',
            creditLimit: String(Math.round(Number(partner.creditLimit ?? 0))), paymentTermDays: String(partner.paymentTermDays ?? 0), status: partner.status, stage: 'CUSTOMER',
          }
        : { ...blank(), code: suggestedCode, stage: prospectOnly ? 'PROSPECT' : 'CUSTOMER' };
      errors = {};
      error = '';
      if (!referenceLoaded) void loadReference();
    });
  });

  async function loadReference() {
    referenceLoaded = true;
    try {
      const employeeRows = await api<Employee[]>('/employees');
      employees = employeeRows.filter((row) => row.role === 'SALES' || row.role === 'SALES_MANAGER');
    } catch (caught) {
      referenceLoaded = false;
      error = caught instanceof Error ? caught.message : m.khong_tai_duoc_du_lieu_danh();
    }
  }

  const fieldMessage: Record<Field, () => string> = {
    code: () => m.kh_ma_quy_tac(),
    name: () => m.kh_ten_toi_thieu(),
    customerTier: () => m.kh_bat_buoc_chon(),
    email: () => m.kh_email_khong_hop_le(),
    creditLimit: () => m.kh_gia_tri_khong_hop_le(),
    paymentTermDays: () => m.kh_gia_tri_khong_hop_le(),
  };

  /** Cùng quy tắc với CodeSchema / CreatePartnerSchema trong packages/contracts. */
  function validate(): Partial<Record<Field, string>> {
    const found: Partial<Record<Field, string>> = {};
    const code = form.code.trim();
    if (code.length < 2 || code.length > 40 || !/^[A-Z0-9][A-Z0-9._/-]*$/.test(code)) found.code = fieldMessage.code();
    if (form.name.trim().length < 2) found.name = fieldMessage.name();
    if (!prospect && !form.customerTier) found.customerTier = fieldMessage.customerTier();
    if (form.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) found.email = fieldMessage.email();
    if (!prospect && !retail && !/^\d+$/.test(form.creditLimit)) found.creditLimit = fieldMessage.creditLimit();
    const days = Number(form.paymentTermDays);
    if (!prospect && !retail && (!/^\d+$/.test(form.paymentTermDays) || days > 365)) found.paymentTermDays = fieldMessage.paymentTermDays();
    return found;
  }

  /** Lỗi kiểm tra của máy chủ (zod issues) → hiện dưới đúng ô nhập. */
  function serverFieldErrors(details: unknown): Partial<Record<Field, string>> {
    const found: Partial<Record<Field, string>> = {};
    if (!Array.isArray(details)) return found;
    for (const issue of details as Array<{ path?: unknown[] }>) {
      const field = issue.path?.[0];
      if (typeof field === 'string' && field in fieldMessage) found[field as Field] ??= fieldMessage[field as Field]();
    }
    return found;
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    errors = validate();
    error = '';
    if (Object.keys(errors).length) return;
    const optional = (value: string) => value.trim() || undefined;
    saving = true;
    try {
      const saved = await api<Partner>(partner ? `/partners/${partner.id}` : '/partners', {
        method: partner ? 'PATCH' : 'POST',
        body: JSON.stringify({
          ...(partner ? { version: partner.version, status: form.status } : { code: form.code.trim(), kind: 'CUSTOMER', stage: prospect ? 'PROSPECT' : 'CUSTOMER' }),
          name: form.name.trim(),
          ...(prospect ? {} : { customerTier: form.customerTier }),
          provinceNewCode: optional(form.provinceNewCode),
          provinceOldCode: optional(form.provinceOldCode),
          territoryChannel: optional(form.territoryChannel),
          salesRepId: optional(form.salesRepId),
          territoryExceptionReason: optional(form.exceptionReason),
          ...(partner ? { clear: (['provinceNewCode', 'provinceOldCode', 'territoryChannel'] as const).filter((key) => !form[key] && partner?.[key]) } : {}),
          taxCode: optional(form.taxCode),
          phone: optional(form.phone),
          email: optional(form.email),
          address: optional(form.address),
          creditLimit: retail || prospect ? '0' : form.creditLimit,
          paymentTermDays: retail || prospect ? 0 : Number(form.paymentTermDays),
        }),
      });
      open = false;
      oncreated?.(saved);
    } catch (caught) {
      if (caught instanceof ApiRequestError) {
        errors = serverFieldErrors(caught.payload.details);
        if (caught.payload.code === 'PARTNER_CODE_EXISTS') errors = { ...errors, code: caught.message };
      }
      error = caught instanceof Error ? caught.message : m.kh_gia_tri_khong_hop_le();
    } finally {
      saving = false;
    }
  }
</script>

<Dialog bind:open title={partner ? m.crud_sua_ho_so({ code: partner.code }) : m.them_khach_hang_moi()} wide>
  <form id="customer-create" class="grid" onsubmit={submit} novalidate>
    {#if error}<div class="banner error span"><CircleAlert size={17} /><span>{error}</span></div>{/if}
    {#if allowProspect && !editing}
      <fieldset class="stage span">
        <legend>{m.crm_loai_khach()}</legend>
        <label><input type="radio" bind:group={form.stage} value="PROSPECT" />{m.crm_khach_co_hoi()}<small>{m.crm_co_hoi_mo_ta()}</small></label>
        <label class:disabled={prospectOnly}><input type="radio" bind:group={form.stage} value="CUSTOMER" disabled={prospectOnly} />{m.crm_khach_chinh_thuc()}<small>{m.crm_chinh_thuc_mo_ta()}</small></label>
      </fieldset>
    {/if}
    <div class="field">
      <label for="kh-code">{m.ma_khach_hang()} <span class="req">*</span></label>
      <input id="kh-code" value={form.code} readonly={editing} maxlength="40" autocomplete="off" aria-invalid={Boolean(errors.code)}
        oninput={(event) => (form.code = event.currentTarget.value.toUpperCase())} />
      {#if errors.code}<span class="error">{errors.code}</span>{:else if !editing}<span class="hint">{m.kh_goi_y_ma({ code: suggestedCode })}</span>{/if}
    </div>
    {#if !prospect}
    <div class="field">
      <label for="kh-tier">{m.cap_khach_hang()} <span class="req">*</span></label>
      <select id="kh-tier" bind:value={form.customerTier} aria-invalid={Boolean(errors.customerTier)}>
        <option value="">—</option>
        {#each Object.entries(tierLabel) as [value, label]}<option {value}>{label}</option>{/each}
      </select>
      {#if errors.customerTier}<span class="error">{errors.customerTier}</span>{/if}
    </div>
    {/if}
    <div class="field span">
      <label for="kh-name">{m.kh_ten_phap_ly()} <span class="req">*</span></label>
      <input id="kh-name" bind:value={form.name} maxlength="240" aria-invalid={Boolean(errors.name)} />
      {#if errors.name}<span class="error">{errors.name}</span>{/if}
    </div>
    <div class="field">
      <label for="kh-tax">{m.ma_so_thue()}</label>
      <input id="kh-tax" bind:value={form.taxCode} maxlength="30" placeholder={m.khong_bat_buoc()} />
    </div>
    <div class="field">
      <label for="kh-phone">{m.dien_thoai()}</label>
      <input id="kh-phone" type="tel" bind:value={form.phone} maxlength="30" />
    </div>
    <div class="field span">
      <label for="kh-address">{m.dia_chi()}</label>
      <input id="kh-address" bind:value={form.address} maxlength="500" />
    </div>
    <div class="field">
      <label for="kh-email">{m.kh_email()}</label>
      <input id="kh-email" type="email" bind:value={form.email} aria-invalid={Boolean(errors.email)} />
      {#if errors.email}<span class="error">{errors.email}</span>{/if}
    </div>
    <TerritoryFields idPrefix="kh" {employees} bind:provinceNewCode={form.provinceNewCode} bind:provinceOldCode={form.provinceOldCode}
      bind:territoryChannel={form.territoryChannel} bind:salesRepId={form.salesRepId} bind:exceptionReason={form.exceptionReason}
      currentException={partner?.territoryException ?? null} />
    {#if !prospect}
    <div class="field">
      <label for="kh-credit">{m.kh_han_muc_cong_no()}</label>
      <NumberInput id="kh-credit" value={retail ? '0' : form.creditLimit} disabled={retail || creditLocked} aria-invalid={Boolean(errors.creditLimit)}
        onvalue={(value) => (form.creditLimit = value)} />
      {#if errors.creditLimit}<span class="error">{errors.creditLimit}</span>{:else if !retail}<span class="hint">{vnd(form.creditLimit || 0)}</span>{/if}
    </div>
    <div class="field">
      <label for="kh-term">{m.kh_so_ngay_no()}</label>
      <NumberInput id="kh-term" value={retail ? '0' : form.paymentTermDays} disabled={retail || creditLocked} aria-invalid={Boolean(errors.paymentTermDays)}
        onvalue={(value) => (form.paymentTermDays = value)} />
      {#if errors.paymentTermDays}<span class="error">{errors.paymentTermDays}</span>{/if}
    </div>
    {/if}
    {#if editing}
      <div class="field">
        <label for="kh-status">{m.trang_thai()}</label>
        <select id="kh-status" bind:value={form.status} disabled={creditLocked && form.status === 'ON_HOLD'}>
          <option value="ACTIVE">{partnerStatus.ACTIVE?.label}</option>
          {#if !creditLocked || form.status === 'ON_HOLD'}<option value="ON_HOLD">{partnerStatus.ON_HOLD?.label}</option>{/if}
          <option value="INACTIVE">{partnerStatus.INACTIVE?.label}</option>
        </select>
      </div>
    {/if}
    {#if creditLocked}<p class="note span">{m.crud_han_muc_khoa()}</p>{/if}
    {#if prospect}<p class="note span">{m.crm_co_hoi_ghi_chu()}</p>
    {:else if retail}<p class="note span">{m.kh_khach_le_tra_ngay()}</p>
    {:else if form.customerTier && Number(form.creditLimit || 0) === 0}<p class="note span warn">{m.kh_han_muc_0()}</p>{/if}
  </form>
  {#snippet footer()}
    <button type="button" class="btn" onclick={() => (open = false)}>{m.huy()}</button>
    <button type="submit" class="btn primary" form="customer-create" disabled={saving}>{saving ? m.kh_dang_luu() : m.kh_luu()}</button>
  {/snippet}
</Dialog>

<style>
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px 16px; align-items: start; }
  .span { grid-column: 1 / -1; }
  .note { margin: 0; color: var(--muted); font-size: 12.5px; }
  .note.warn { color: var(--amber); }
  .req { color: var(--red); }
  @media (max-width: 640px) {
    .grid { grid-template-columns: 1fr; }
  }
  .stage { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin: 0; padding: 0; border: 0; }
  .stage legend { margin-bottom: 6px; font-size: 13px; font-weight: 500; }
  .stage label { display: grid; grid-template-columns: auto 1fr; gap: 2px 8px; align-items: center; padding: 10px 12px; border: 1px solid var(--line); border-radius: var(--radius-sm); cursor: pointer; font-weight: 600; font-size: 13.5px; }
  .stage label:has(input:checked) { border-color: var(--navy); background: var(--blue-soft); }
  .stage label.disabled { opacity: 0.5; cursor: not-allowed; }
  .stage small { grid-column: 2; color: var(--muted); font-size: 12px; font-weight: 400; }
</style>
