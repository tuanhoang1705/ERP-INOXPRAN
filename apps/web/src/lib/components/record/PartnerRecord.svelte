<script lang="ts">
  /**
   * Hồ sơ đối tác dạng cửa sổ chứng từ (theo hồ sơ khách hàng CRM của công ty mẹ).
   * Khách hàng: thông tin chính, người liên hệ, nhật ký chăm sóc, địa chỉ nhận hàng, ngân hàng, lịch sử bán, công nợ,
   * bảo hành, đính kèm, lịch sử thay đổi; khách "cơ hội" phải được chuyển thành khách chính thức mới bán được.
   * Nhà cung cấp: thông tin chính, người liên hệ, ngân hàng, đơn mua, đính kèm, lịch sử.
   */
  import { untrack } from 'svelte';
  import type { Partner, PartnerAddress, PartnerBankAccount, PartnerContact } from '@inoxpran/contracts';
  import { goto } from '$app/navigation';
  import { ArrowUpRight, CircleAlert, CircleCheck, Plus, RefreshCw, Trash2, UserCheck } from 'lucide-svelte';
  import { m } from '$lib/paraglide/messages';
  import { api, ApiRequestError } from '$lib/api';
  import { date, num, vnd } from '$lib/format';
  import { partnerStatus, purchaseStatus, receivableStatus, salesStatus, tierLabel } from '$lib/labels';
  import { can } from '$lib/permissions';
  import { session } from '$lib/session.svelte';
  import { statusText as warrantyStatusText, statusTone as warrantyTone } from '$lib/warranty';
  import ConfirmDelete from '$lib/components/ConfirmDelete.svelte';
  import Dialog from '$lib/components/Dialog.svelte';
  import NumberInput from '$lib/components/NumberInput.svelte';
  import RecordWindow from './RecordWindow.svelte';
  import RecordSection from './RecordSection.svelte';
  import HistoryPanel from './HistoryPanel.svelte';
  import AttachmentsPanel from './AttachmentsPanel.svelte';
  import ActivityLog from './ActivityLog.svelte';
  import RelatedTable from './RelatedTable.svelte';

  type Summary = {
    outstanding: string; overdue: string; revenueTotal: string; revenueYearToDate: string; orderCount: number;
    lastOrder: { id: string; code: string; date: string } | null;
    purchaseOrderCount: number; purchaseTotal: string; lastPurchaseAt: string | null;
    nextFollowUp: { on: string; note?: string } | null;
  };
  type Detail = Partner & { regionName?: string; summary: Summary };
  type Option = { id: string; code: string; name: string; status?: string };
  type Row = { id: string } & Record<string, unknown>;

  let { id, kind }: { id: string; kind: 'customer' | 'supplier' } = $props();

  const isCustomer = $derived(kind === 'customer');
  const listHref = $derived(isCustomer ? '/catalog/dealers' : '/catalog/suppliers');
  const TEXT_FIELDS = ['name', 'shortName', 'taxCode', 'phone', 'email', 'website', 'address', 'province', 'regionCode', 'salesRepId', 'customerTier', 'grade', 'source', 'businessLines', 'paymentMethod', 'note', 'status', 'creditLimit', 'paymentTermDays'] as const;
  type FieldKey = (typeof TEXT_FIELDS)[number];
  const CLEARABLE: FieldKey[] = ['shortName', 'taxCode', 'phone', 'email', 'website', 'address', 'province', 'regionCode', 'grade', 'source', 'businessLines', 'paymentMethod', 'note'];
  const CREDIT: FieldKey[] = ['creditLimit', 'paymentTermDays'];
  const SOURCES = [m.crm_nguon_gioi_thieu(), m.crm_nguon_hoi_cho(), 'Zalo', 'Website', 'Facebook', m.crm_nguon_cong_ty_me(), m.crm_nguon_khac()];

  let partner = $state<Detail | null>(null);
  let regions = $state<Array<{ code: string; name: string }>>([]);
  let employees = $state<Option[]>([]);
  let form = $state<Record<FieldKey, string>>(Object.fromEntries(TEXT_FIELDS.map((key) => [key, ''])) as Record<FieldKey, string>);
  let contacts = $state<PartnerContact[]>([]);
  let addresses = $state<PartnerAddress[]>([]);
  let banks = $state<PartnerBankAccount[]>([]);
  let baseline = $state('');
  let tab = $state('main');
  let loading = $state(true);
  let saving = $state(false);
  let error = $state('');
  let conflict = $state(false);
  let success = $state('');
  let errors = $state<Partial<Record<string, string>>>({});
  let historyReload = $state(0);
  let attachmentCount = $state<number | undefined>(undefined);
  let deleteOpen = $state(false);
  let convertOpen = $state(false);
  let convert = $state({ customerTier: 'TIER_2', creditLimit: '0', paymentTermDays: '0', salesRepId: '' });
  let converting = $state(false);
  let convertError = $state('');

  const roles = $derived(session.user?.roles ?? []);
  const prospect = $derived(isCustomer && partner?.stage === 'PROSPECT');
  const editable = $derived(isCustomer ? can.editCustomers() || (prospect && roles.includes('SALES')) : can.editSuppliers());
  /** Kế toán: không sửa hồ sơ khách nhưng được đặt hạn mức / số ngày nợ (API chỉ nhận các trường công nợ). */
  const creditOnly = $derived(isCustomer && !editable && !prospect && can.editCreditTerms());
  const creditEditable = $derived((editable || creditOnly) && can.editCreditTerms() && !prospect);
  const snapshot = () => JSON.stringify({ form, contacts, addresses, banks });
  const dirty = $derived(Boolean(partner) && (editable || creditOnly) && JSON.stringify({ form, contacts, addresses, banks }) !== baseline);
  const text = (value: unknown) => (value === undefined || value === null ? '' : String(value));

  function fill(source: Detail) {
    form = Object.fromEntries(TEXT_FIELDS.map((key) => [key, text((source as Record<string, unknown>)[key])])) as Record<FieldKey, string>;
    form.creditLimit = String(Math.round(Number(source.creditLimit ?? 0)));
    contacts = structuredClone($state.snapshot(source.contacts ?? []) as PartnerContact[]);
    addresses = structuredClone($state.snapshot(source.addresses ?? []) as PartnerAddress[]);
    banks = structuredClone($state.snapshot(source.bankAccounts ?? []) as PartnerBankAccount[]);
    baseline = snapshot();
  }

  async function load() {
    loading = true;
    error = '';
    conflict = false;
    try {
      partner = await api<Detail>(`/partners/${id}`);
      fill(partner);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.rw_loi_tai();
    } finally {
      loading = false;
    }
  }
  // untrack: load() đọc / ghi dữ liệu form — effect chỉ chạy lại khi đổi bản ghi (id).
  $effect(() => {
    void id;
    untrack(() => {
      success = '';
      void load();
    });
  });
  $effect(() => {
    if (!isCustomer) return;
    void api<Array<{ code: string; name: string }>>('/regions').then((rows) => (regions = rows)).catch(() => undefined);
    void api<Option[]>('/employees').then((rows) => (employees = rows)).catch(() => undefined);
  });

  const cleanContacts = () => contacts.map((row) => Object.fromEntries(Object.entries(row).filter(([, value]) => value !== '' && value !== undefined))).filter((row) => row.name) as PartnerContact[];
  const cleanAddresses = () => addresses.map((row) => Object.fromEntries(Object.entries(row).filter(([, value]) => value !== '' && value !== undefined))).filter((row) => row.address) as PartnerAddress[];
  const cleanBanks = () => banks.map((row) => Object.fromEntries(Object.entries(row).filter(([, value]) => value !== '' && value !== undefined))).filter((row) => row.bankName || row.accountNumber) as PartnerBankAccount[];

  function validate(): Record<string, string> {
    const found: Record<string, string> = {};
    if (form.name.trim().length < 2) found.name = m.kh_ten_toi_thieu();
    if (form.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) found.email = m.kh_email_khong_hop_le();
    if (form.creditLimit && !/^\d+$/.test(form.creditLimit)) found.creditLimit = m.kh_gia_tri_khong_hop_le();
    if (form.paymentTermDays && (!/^\d+$/.test(form.paymentTermDays) || Number(form.paymentTermDays) > 365)) found.paymentTermDays = m.kh_gia_tri_khong_hop_le();
    contacts.forEach((row, index) => {
      if ((row.phone || row.email || row.title) && !row.name?.trim()) found[`contact-${index}`] = m.crm_ten_lien_he_bat_buoc();
      if (row.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.email.trim())) found[`contact-${index}`] = m.kh_email_khong_hop_le();
    });
    addresses.forEach((row, index) => {
      if ((row.receiver || row.phone || row.label) && (row.address ?? '').trim().length < 3) found[`address-${index}`] = m.crm_dia_chi_bat_buoc();
    });
    banks.forEach((row, index) => {
      if ((row.bankName || row.accountNumber) && (!(row.bankName ?? '').trim() || (row.accountNumber ?? '').trim().length < 3)) found[`bank-${index}`] = m.crm_ngan_hang_bat_buoc();
    });
    return found;
  }

  function changes(): Record<string, unknown> {
    const before = JSON.parse(baseline) as { form: Record<FieldKey, string>; contacts: unknown; addresses: unknown; banks: unknown };
    const body: Record<string, unknown> = {};
    const clear: string[] = [];
    for (const key of TEXT_FIELDS) {
      const value = form[key].trim();
      if (value === before.form[key].trim()) continue;
      if (CREDIT.includes(key) && !creditEditable) continue;
      if (creditOnly && !CREDIT.includes(key)) continue;
      if (value === '') {
        if (CLEARABLE.includes(key)) clear.push(key);
        continue;
      }
      body[key] = key === 'paymentTermDays' ? Number(value) : value;
    }
    if (JSON.stringify(contacts) !== JSON.stringify(before.contacts)) body.contacts = cleanContacts();
    if (JSON.stringify(addresses) !== JSON.stringify(before.addresses)) body.addresses = cleanAddresses();
    if (JSON.stringify(banks) !== JSON.stringify(before.banks)) body.bankAccounts = cleanBanks();
    return { ...body, ...(clear.length ? { clear } : {}) };
  }

  async function save() {
    if (!partner) return;
    errors = validate();
    error = '';
    success = '';
    if (Object.keys(errors).length) {
      error = m.rw_kiem_tra_lai();
      return;
    }
    const body = changes();
    if (!Object.keys(body).length) {
      baseline = snapshot();
      return;
    }
    saving = true;
    try {
      await api(`/partners/${partner.id}`, { method: 'PATCH', body: JSON.stringify({ ...body, version: partner.version }) });
      success = m.crud_da_luu({ name: partner.code });
      historyReload += 1;
      await load();
    } catch (caught) {
      conflict = caught instanceof ApiRequestError && caught.payload.code === 'VERSION_CONFLICT';
      error = caught instanceof Error ? caught.message : m.crud_loi_luu();
    } finally {
      saving = false;
    }
  }

  async function doConvert(event: SubmitEvent) {
    event.preventDefault();
    if (!partner) return;
    convertError = '';
    // Khách chính thức bắt buộc có NVKD phụ trách (máy chủ cũng kiểm tra).
    if (!convert.salesRepId) {
      convertError = m.crm_can_nvkd();
      return;
    }
    converting = true;
    try {
      await api(`/partners/${partner.id}/convert`, {
        method: 'POST',
        body: JSON.stringify({
          version: partner.version,
          customerTier: convert.customerTier,
          ...(convert.salesRepId ? { salesRepId: convert.salesRepId } : {}),
          ...(can.editCreditTerms() ? { creditLimit: convert.creditLimit || '0', paymentTermDays: Number(convert.paymentTermDays || 0) } : {}),
        }),
      });
      convertOpen = false;
      success = m.crm_da_chuyen({ name: partner.name });
      historyReload += 1;
      await load();
    } catch (caught) {
      convertError = caught instanceof Error ? caught.message : m.crud_loi_luu();
    } finally {
      converting = false;
    }
  }

  async function removePartner() {
    if (!partner) return;
    await api(`/partners/${partner.id}`, { method: 'DELETE' });
    baseline = snapshot();
    await goto(listHref);
  }
  async function deactivate() {
    if (!partner) return;
    await api(`/partners/${partner.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'INACTIVE', version: partner.version }) });
    await load();
  }

  const setPrimary = (index: number) => (contacts = contacts.map((row, position) => ({ ...row, primary: position === index })));
  const setDefault = (index: number) => (addresses = addresses.map((row, position) => ({ ...row, isDefault: position === index })));

  const title = $derived(partner ? `${partner.code} — ${partner.name}` : m.dang_tai());
  const tabs = $derived([
    { id: 'main', label: m.rw_thong_tin_chinh() },
    { id: 'contacts', label: m.crm_nguoi_lien_he_tab(), badge: contacts.length },
    { id: 'activities', label: m.crm_nhat_ky_cham_soc(), hidden: !isCustomer },
    { id: 'addresses', label: m.crm_dia_chi_nhan_hang(), badge: addresses.length, hidden: !isCustomer },
    { id: 'bank', label: m.crm_ngan_hang(), badge: banks.length },
    { id: 'sales', label: m.crm_lich_su_ban(), badge: partner?.summary.orderCount, hidden: !isCustomer },
    { id: 'receivables', label: m.crm_cong_no(), hidden: !isCustomer },
    { id: 'warranty', label: m.crm_bao_hanh(), hidden: !isCustomer },
    { id: 'purchases', label: m.crm_don_mua(), badge: partner?.summary.purchaseOrderCount, hidden: isCustomer },
    { id: 'attachments', label: m.rw_dinh_kem(), badge: attachmentCount },
    { id: 'history', label: m.rw_lich_su() },
  ]);
  const fieldLabels = $derived<Record<string, string>>({
    name: isCustomer ? m.kh_ten_phap_ly() : m.ten_nha_cung_cap(), shortName: m.crm_ten_viet_tat(), taxCode: m.ma_so_thue(), phone: m.dien_thoai(), email: m.kh_email(),
    website: 'Website', address: m.dia_chi(), province: m.kh_tinh_thanh(), regionCode: m.crm_khu_vuc(), salesRepId: m.crm_nvkd(), salesRepName: m.crm_nvkd(),
    customerTier: m.crm_cap_gia(), grade: m.crm_xep_hang(), source: m.crm_nguon_khach(), businessLines: m.crm_nganh_hang(), paymentMethod: m.crm_hinh_thuc_tt(),
    note: m.ghi_chu(), status: m.trang_thai(), creditLimit: m.kh_han_muc_cong_no(), paymentTermDays: m.kh_so_ngay_no(), contacts: m.crm_nguoi_lien_he_tab(),
    addresses: m.crm_dia_chi_nhan_hang(), bankAccounts: m.crm_ngan_hang(), stage: m.crm_giai_doan(), holdReason: m.crm_ly_do_khoa(),
  });
  const actionLabels = $derived<Record<string, string>>({
    PARTNER_CREATED: m.rw_tao_moi(), PARTNER_UPDATED: m.rw_cap_nhat(), PARTNER_CONVERTED: m.crm_chuyen_chinh_thuc(), PARTNER_DELETED: m.crud_xoa(),
    PARTNER_ACTIVITY_CREATED: m.crm_ghi_nhat_ky(), PARTNER_ACTIVITY_UPDATED: m.crm_sua_nhat_ky(), PARTNER_ACTIVITY_DELETED: m.crm_xoa_nhat_ky(), PARTNER_FOLLOW_UP_DONE: m.crm_danh_dau_xong(),
    PARTNER_FILE_UPLOADED: m.rw_tai_len_file(), PARTNER_FILE_DELETED: m.rw_xoa_file(), PARTNER_FILE_MALWARE_BLOCKED: m.rw_chan_ma_doc(),
  });
</script>

{#snippet input(key: FieldKey, label: string, options: { required?: boolean; maxlength?: number; span?: boolean; type?: string; inputmode?: 'numeric' | 'text'; disabled?: boolean; hint?: string; list?: string } = {})}
  <div class="field" class:span={options.span}>
    <label for={`pt-${key}`}>{label}{#if options.required} <span class="req">*</span>{/if}</label>
    {#if options.inputmode === 'numeric'}
      <NumberInput id={`pt-${key}`} bind:value={form[key]} readonly={options.disabled ?? !editable} aria-invalid={Boolean(errors[key])} />
    {:else}
      <input id={`pt-${key}`} type={options.type ?? 'text'} bind:value={form[key]} readonly={options.disabled ?? !editable} maxlength={options.maxlength ?? 240} inputmode={options.inputmode ?? 'text'} list={options.list} aria-invalid={Boolean(errors[key])} />
    {/if}
    {#if errors[key]}<span class="error">{errors[key]}</span>{:else if options.hint}<span class="hint">{options.hint}</span>{/if}
  </div>
{/snippet}

<svelte:head><title>{title} · INOXPRAN ERP</title></svelte:head>

{#if error && !partner}
  <div class="banner error"><CircleAlert size={17} /><span>{error}</span></div>
{:else if partner}
  <RecordWindow
    {title}
    crumbs={[{ href: listHref, label: isCustomer ? m.crm_ho_so_khach_hang() : m.crm_nha_cung_cap() }]}
    listKey={isCustomer ? 'dealers' : 'suppliers'}
    recordId={partner.id}
    detailHref={(target) => `${listHref}/${target}`}
    {dirty}
    {saving}
    {tabs}
    bind:tab
    onsave={editable || creditOnly ? save : undefined}
    onreset={editable || creditOnly ? () => { if (partner) fill(partner); errors = {}; error = ''; } : undefined}
    onnew={() => goto(`${listHref}?new=1`)}
    ondelete={editable && (isCustomer ? can.editCustomers() : can.editSuppliers()) ? () => (deleteOpen = true) : undefined}
  >
    {#snippet badges()}
      {#if partner}
        {#if isCustomer}<span class={`pill ${prospect ? 'warning' : 'success'}`}>{prospect ? m.crm_khach_co_hoi() : m.crm_khach_chinh_thuc()}</span>{/if}
        {#if partner.grade}<span class="pill orange">{m.crm_hang({ grade: partner.grade })}</span>{/if}
        {@const status = partnerStatus[partner.status]}<span class={`pill ${status?.tone ?? ''}`}>{status?.label ?? partner.status}</span>
        {#if isCustomer && partner.customerTier && !prospect}<span class="muted">{tierLabel[partner.customerTier] ?? partner.customerTier}</span>{/if}
      {/if}
    {/snippet}
    {#snippet extra()}
      {#if prospect && can.convertProspects()}<button class="btn small navy" onclick={() => { convertError = ''; convert.salesRepId = partner?.salesRepId ?? ''; convertOpen = true; }}><UserCheck size={15} />{m.crm_chuyen_chinh_thuc()}</button>{/if}
    {/snippet}
    {#snippet children(active)}
      {#if partner}
      {#if error}<div class="banner error"><CircleAlert size={17} /><span>{error}</span>{#if conflict}<button class="btn small" onclick={load}><RefreshCw size={14} />{m.rw_tai_lai()}</button>{/if}</div>{/if}
      {#if success}<div class="banner success"><CircleCheck size={17} />{success}</div>{/if}
      {#if prospect}<div class="banner warning"><CircleAlert size={17} /><span>{m.crm_co_hoi_ghi_chu()}</span></div>{/if}

      {#if isCustomer}
        <div class="kpis">
          <div class="card kpi"><p class="label">{m.crm_doanh_so_nam()}</p><p class="value">{vnd(partner.summary.revenueYearToDate)}</p><p class="note">{m.crm_tong_doanh_so()} {vnd(partner.summary.revenueTotal)}</p></div>
          <div class="card kpi"><p class="label">{m.crm_du_no()}</p><p class="value">{vnd(partner.summary.outstanding)}</p><p class="note" class:danger={Number(partner.summary.overdue) > 0}>{m.crm_qua_han()} {vnd(partner.summary.overdue)}</p></div>
          <div class="card kpi"><p class="label">{m.crm_don_gan_nhat()}</p><p class="value">{#if partner.summary.lastOrder}<a class="link" href={`/sales/orders/${partner.summary.lastOrder.id}`}>{partner.summary.lastOrder.code}</a>{:else}—{/if}</p><p class="note">{partner.summary.lastOrder ? date(partner.summary.lastOrder.date) : m.crm_chua_mua_hang()}</p></div>
          <div class="card kpi"><p class="label">{m.crm_hen_tiep_theo()}</p><p class="value">{partner.summary.nextFollowUp ? date(partner.summary.nextFollowUp.on) : '—'}</p><p class="note">{partner.summary.nextFollowUp?.note ?? m.crm_chua_hen()}</p></div>
        </div>
      {:else}
        <div class="kpis three">
          <div class="card kpi"><p class="label">{m.crm_so_don_mua()}</p><p class="value">{num(partner.summary.purchaseOrderCount)}</p></div>
          <div class="card kpi"><p class="label">{m.crm_tong_mua()}</p><p class="value">{vnd(partner.summary.purchaseTotal)}</p></div>
          <div class="card kpi"><p class="label">{m.crm_lan_mua_gan_nhat()}</p><p class="value">{partner.summary.lastPurchaseAt ? date(partner.summary.lastPurchaseAt) : '—'}</p></div>
        </div>
      {/if}

      {#if active === 'main'}
        <RecordSection id={`partner-main-${kind}`} title={m.rw_thong_tin_chinh()}>
          <div class="grid">
            <div class="field"><label for="pt-code">{m.ma()}</label><input id="pt-code" value={partner.code} readonly /></div>
            {@render input('shortName', m.crm_ten_viet_tat(), { maxlength: 60 })}
            {@render input('name', isCustomer ? m.kh_ten_phap_ly() : m.ten_nha_cung_cap(), { required: true, span: true })}
            {@render input('taxCode', m.ma_so_thue(), { maxlength: 30 })}
            {@render input('phone', m.dien_thoai(), { maxlength: 30, type: 'tel' })}
            {@render input('email', m.kh_email(), { maxlength: 160, type: 'email' })}
            {@render input('website', 'Website', { maxlength: 200 })}
            {@render input('address', m.dia_chi(), { maxlength: 500, span: true })}
            {#if isCustomer}
              {@render input('province', m.kh_tinh_thanh(), { maxlength: 80 })}
              <div class="field"><label for="pt-region">{m.crm_khu_vuc()}</label><select id="pt-region" bind:value={form.regionCode} disabled={!editable}><option value="">—</option>{#each regions as region}<option value={region.code}>{region.name}</option>{/each}</select></div>
              <div class="field"><label for="pt-rep">{m.crm_nvkd()}</label><select id="pt-rep" bind:value={form.salesRepId} disabled={!editable}><option value="">—</option>{#each employees as employee}<option value={employee.id}>{employee.code} — {employee.name}</option>{/each}</select></div>
              <div class="field"><label for="pt-grade">{m.crm_xep_hang()}</label><select id="pt-grade" bind:value={form.grade} disabled={!editable}><option value="">—</option>{#each ['A', 'B', 'C', 'D'] as grade}<option value={grade}>{m.crm_hang({ grade })}</option>{/each}</select></div>
              {@render input('source', m.crm_nguon_khach(), { maxlength: 60, list: 'pt-sources' })}
              <datalist id="pt-sources">{#each SOURCES as source}<option value={source}></option>{/each}</datalist>
              {@render input('businessLines', m.crm_nganh_hang(), { maxlength: 300 })}
            {/if}
            {@render input('paymentMethod', m.crm_hinh_thuc_tt(), { maxlength: 120 })}
            <div class="field"><label for="pt-status">{m.trang_thai()}</label>
              <select id="pt-status" bind:value={form.status} disabled={!editable || partner.status === 'ON_HOLD'}>
                <option value="ACTIVE">{m.hoat_dong()}</option>
                {#if partner.status === 'ON_HOLD'}<option value="ON_HOLD">{m.tam_khoa_dat_hang()}</option>{/if}
                <option value="INACTIVE">{m.ngung_giao_dich()}</option>
              </select>
            </div>
            <div class="field span"><label for="pt-note">{m.ghi_chu()}</label><textarea id="pt-note" rows="3" bind:value={form.note} readonly={!editable} maxlength="1000"></textarea></div>
          </div>
        </RecordSection>
        {#if isCustomer && !prospect}
          <RecordSection id="partner-credit" title={m.crm_gia_cong_no()} note={creditEditable ? '' : m.crm_cong_no_ghi_chu()}>
            <div class="grid three">
              <div class="field"><label for="pt-tier">{m.crm_cap_gia()}</label><select id="pt-tier" bind:value={form.customerTier} disabled={!editable}>{#each Object.entries(tierLabel) as [value, label]}<option {value}>{label}</option>{/each}</select></div>
              {@render input('creditLimit', m.kh_han_muc_cong_no(), { inputmode: 'numeric', disabled: !creditEditable, hint: vnd(form.creditLimit || 0) })}
              {@render input('paymentTermDays', m.kh_so_ngay_no(), { inputmode: 'numeric', disabled: !creditEditable })}
            </div>
          </RecordSection>
        {/if}
      {:else if active === 'contacts'}
        <section class="card">
          <div class="table-wrap">
            <table class="table edit">
              <thead><tr><th>{m.crm_chinh()}</th><th>{m.crm_ho_ten()} *</th><th>{m.crm_chuc_vu()}</th><th>{m.dien_thoai()}</th><th>{m.kh_email()}</th><th>Zalo</th><th>{m.ghi_chu()}</th>{#if editable}<th></th>{/if}</tr></thead>
              <tbody>
                {#each contacts as contact, index}
                  <tr class:invalid={errors[`contact-${index}`]}>
                    <td><input type="radio" name="primary-contact" checked={Boolean(contact.primary)} disabled={!editable} onchange={() => setPrimary(index)} aria-label={m.crm_chinh()} /></td>
                    <td><input bind:value={contact.name} readonly={!editable} maxlength="120" aria-label={m.crm_ho_ten()} /></td>
                    <td><input bind:value={contact.title} readonly={!editable} maxlength="120" aria-label={m.crm_chuc_vu()} /></td>
                    <td><input bind:value={contact.phone} readonly={!editable} maxlength="30" type="tel" aria-label={m.dien_thoai()} /></td>
                    <td><input bind:value={contact.email} readonly={!editable} maxlength="160" type="email" aria-label={m.kh_email()} /></td>
                    <td><input bind:value={contact.zalo} readonly={!editable} maxlength="60" aria-label="Zalo" /></td>
                    <td><input bind:value={contact.note} readonly={!editable} maxlength="300" aria-label={m.ghi_chu()} /></td>
                    {#if editable}<td><button class="icon-btn danger" aria-label={m.crud_xoa()} onclick={() => (contacts = contacts.filter((_, position) => position !== index))}><Trash2 size={15} /></button></td>{/if}
                  </tr>
                  {#if errors[`contact-${index}`]}<tr class="row-error"><td colspan="8">{errors[`contact-${index}`]}</td></tr>{/if}
                {:else}<tr class="empty-row"><td colspan="8">{m.crm_chua_co_lien_he()}</td></tr>{/each}
              </tbody>
            </table>
          </div>
          {#if editable}<div class="add-row"><button class="btn small" onclick={() => (contacts = [...contacts, { name: '', primary: contacts.length === 0 }])}><Plus size={14} />{m.crm_them_lien_he()}</button></div>{/if}
        </section>
      {:else if active === 'activities' && isCustomer}
        <ActivityLog partnerId={partner.id} contacts={partner.contacts ?? []} onchange={() => { historyReload += 1; void load(); }} />
      {:else if active === 'addresses' && isCustomer}
        <section class="card">
          <div class="table-wrap">
            <table class="table edit">
              <thead><tr><th>{m.crm_mac_dinh()}</th><th>{m.crm_nhan()}</th><th>{m.dia_chi()} *</th><th>{m.crm_nguoi_nhan()}</th><th>{m.dien_thoai()}</th>{#if editable}<th></th>{/if}</tr></thead>
              <tbody>
                {#each addresses as row, index}
                  <tr class:invalid={errors[`address-${index}`]}>
                    <td><input type="radio" name="default-address" checked={Boolean(row.isDefault)} disabled={!editable} onchange={() => setDefault(index)} aria-label={m.crm_mac_dinh()} /></td>
                    <td><input bind:value={row.label} readonly={!editable} maxlength="60" placeholder={m.crm_nhan_goi_y()} aria-label={m.crm_nhan()} /></td>
                    <td class="wide"><input bind:value={row.address} readonly={!editable} maxlength="500" aria-label={m.dia_chi()} /></td>
                    <td><input bind:value={row.receiver} readonly={!editable} maxlength="120" aria-label={m.crm_nguoi_nhan()} /></td>
                    <td><input bind:value={row.phone} readonly={!editable} maxlength="30" type="tel" aria-label={m.dien_thoai()} /></td>
                    {#if editable}<td><button class="icon-btn danger" aria-label={m.crud_xoa()} onclick={() => (addresses = addresses.filter((_, position) => position !== index))}><Trash2 size={15} /></button></td>{/if}
                  </tr>
                  {#if errors[`address-${index}`]}<tr class="row-error"><td colspan="6">{errors[`address-${index}`]}</td></tr>{/if}
                {:else}<tr class="empty-row"><td colspan="6">{m.crm_chua_co_dia_chi()}</td></tr>{/each}
              </tbody>
            </table>
          </div>
          {#if editable}<div class="add-row"><button class="btn small" onclick={() => (addresses = [...addresses, { address: '', isDefault: addresses.length === 0 }])}><Plus size={14} />{m.crm_them_dia_chi()}</button></div>{/if}
        </section>
      {:else if active === 'bank'}
        <section class="card">
          <div class="table-wrap">
            <table class="table edit">
              <thead><tr><th>{m.crm_ten_ngan_hang()} *</th><th>{m.crm_so_tai_khoan()} *</th><th>{m.crm_chu_tai_khoan()}</th><th>{m.crm_chi_nhanh()}</th><th>SWIFT</th>{#if editable}<th></th>{/if}</tr></thead>
              <tbody>
                {#each banks as row, index}
                  <tr class:invalid={errors[`bank-${index}`]}>
                    <td><input bind:value={row.bankName} readonly={!editable} maxlength="120" aria-label={m.crm_ten_ngan_hang()} /></td>
                    <td><input bind:value={row.accountNumber} readonly={!editable} maxlength="40" aria-label={m.crm_so_tai_khoan()} /></td>
                    <td><input bind:value={row.accountName} readonly={!editable} maxlength="160" aria-label={m.crm_chu_tai_khoan()} /></td>
                    <td><input bind:value={row.branch} readonly={!editable} maxlength="160" aria-label={m.crm_chi_nhanh()} /></td>
                    <td><input bind:value={row.swift} readonly={!editable} maxlength="20" aria-label="SWIFT" /></td>
                    {#if editable}<td><button class="icon-btn danger" aria-label={m.crud_xoa()} onclick={() => (banks = banks.filter((_, position) => position !== index))}><Trash2 size={15} /></button></td>{/if}
                  </tr>
                  {#if errors[`bank-${index}`]}<tr class="row-error"><td colspan="6">{errors[`bank-${index}`]}</td></tr>{/if}
                {:else}<tr class="empty-row"><td colspan="6">{m.crm_chua_co_ngan_hang()}</td></tr>{/each}
              </tbody>
            </table>
          </div>
          {#if editable}<div class="add-row"><button class="btn small" onclick={() => (banks = [...banks, { bankName: '', accountNumber: '' }])}><Plus size={14} />{m.crm_them_ngan_hang()}</button></div>{/if}
        </section>
      {:else if active === 'sales' && isCustomer}
        <RelatedTable endpoint={`/sales-orders?customerId=${partner.id}`} empty={m.crm_chua_mua_hang()} columns={[
          { label: m.sp_so_phieu_ban(), value: (row: Row) => text(row.code), href: (row: Row) => `/sales/orders/${row.id}` },
          { label: m.ngay(), value: (row: Row) => date(text(row.orderDate)) },
          { label: m.crm_so_dong(), value: (row: Row) => num(Number(row.lineCount ?? 0)), num: true },
          { label: m.crm_tong_tien(), value: (row: Row) => vnd(text(row.grandTotal)), num: true },
          { label: m.trang_thai(), value: (row: Row) => salesStatus[text(row.status)]?.label ?? text(row.status), tone: (row: Row) => salesStatus[text(row.status)]?.tone ?? '' },
        ]} />
      {:else if active === 'receivables' && isCustomer}
        <p class="ledger-link"><a class="btn small" href={`/receivables/customers/${partner.id}`}>{m.cn_so_khach_title()}</a>{#if partner.autoHoldExempt}<span class="pill neutral" title={m.cn_khong_tu_khoa_giai_thich()}>{m.cn_khong_tu_khoa()}</span>{/if}</p>
        <RelatedTable endpoint={`/receivables?partnerId=${partner.id}&includePaid=true`} empty={m.crm_khong_co_cong_no()} columns={[
          { label: m.crm_chung_tu(), value: (row: Row) => text(row.code) },
          { label: m.crm_nguon(), value: (row: Row) => text(row.salesOrderCode ?? row.warrantyCode ?? row.historyInvoiceNo ?? row.historyDocumentNo ?? row.openingDocumentNo ?? '—') },
          { label: m.crm_han_tra(), value: (row: Row) => date(text(row.dueDate)) },
          { label: m.crm_so_tien(), value: (row: Row) => vnd(text(row.amount)), num: true },
          { label: m.crm_da_thu(), value: (row: Row) => vnd(text(row.paidAmount)), num: true },
          { label: m.trang_thai(), value: (row: Row) => (row.sourceType === 'SALES_VOID_CREDIT' || row.sourceType === 'CUSTOMER_PREPAYMENT' ? m.cn_tra_truoc() : receivableStatus[text(row.status)]?.label ?? text(row.status)), tone: (row: Row) => (row.sourceType === 'SALES_VOID_CREDIT' || row.sourceType === 'CUSTOMER_PREPAYMENT' ? 'success' : receivableStatus[text(row.status)]?.tone ?? '') },
        ]} />
      {:else if active === 'warranty' && isCustomer}
        <RelatedTable endpoint={`/warranty/tickets?customerId=${partner.id}`} empty={m.crm_chua_bao_hanh()} columns={[
          { label: m.crm_so_phieu(), value: (row: Row) => text(row.code), href: (row: Row) => `/warranty/${row.id}` },
          { label: m.ngay(), value: (row: Row) => date(text(row.receivedAt)) },
          { label: m.ten_san_pham(), value: (row: Row) => `${text((row.product as Record<string, unknown> | undefined)?.sku)} ${text((row.product as Record<string, unknown> | undefined)?.name)}` },
          { label: m.trang_thai(), value: (row: Row) => warrantyStatusText(row.status as never), tone: (row: Row) => warrantyTone[row.status as keyof typeof warrantyTone] ?? '' },
        ]} />
      {:else if active === 'purchases' && !isCustomer}
        <RelatedTable endpoint={`/purchase-orders?supplierId=${partner.id}`} empty={m.crm_chua_co_don_mua()} columns={[
          { label: m.sp_so_don_mua(), value: (row: Row) => text(row.code), href: (row: Row) => `/procurement/${row.id}` },
          { label: m.ngay(), value: (row: Row) => date(text(row.createdAt)) },
          { label: m.crm_tong_tien(), value: (row: Row) => vnd(text(row.total)), num: true },
          { label: m.trang_thai(), value: (row: Row) => purchaseStatus[text(row.status)]?.label ?? text(row.status), tone: (row: Row) => purchaseStatus[text(row.status)]?.tone ?? '' },
        ]} />
      {:else if active === 'attachments'}
        <AttachmentsPanel type="partners" id={partner.id} onchange={(count) => (attachmentCount = count)} purposes={[{ purpose: 'PARTNER_DOCUMENT', label: m.crm_giay_to(), pdf: true }]} />
      {:else if active === 'history'}
        <HistoryPanel type="partners" id={partner.id} {fieldLabels} {actionLabels} reload={historyReload} />
      {/if}
      {/if}
    {/snippet}
  </RecordWindow>

  <ConfirmDelete bind:open={deleteOpen} name={`${partner.code} — ${partner.name}`} ondelete={removePartner} ondeactivate={partner.status !== 'INACTIVE' ? deactivate : undefined} />

  <Dialog bind:open={convertOpen} title={m.crm_chuyen_chinh_thuc()}>
    <form id="convert-form" class="convert" onsubmit={doConvert}>
      <p class="muted">{m.crm_chuyen_ghi_chu({ name: partner.name })}</p>
      {#if convertError}<div class="banner error"><CircleAlert size={17} /><span>{convertError}</span></div>{/if}
      <div class="field"><label for="cv-tier">{m.crm_cap_gia()} <span class="req">*</span></label><select id="cv-tier" bind:value={convert.customerTier}>{#each Object.entries(tierLabel) as [value, label]}<option {value}>{label}</option>{/each}</select></div>
      <div class="field"><label for="cv-rep">{m.crm_nvkd()} <span class="req">*</span></label>
        <select id="cv-rep" bind:value={convert.salesRepId}><option value="">—</option>{#each employees.filter((row) => row.status !== 'INACTIVE' || row.id === convert.salesRepId) as employee (employee.id)}<option value={employee.id}>{employee.code} — {employee.name}</option>{/each}</select>
      </div>
      {#if can.editCreditTerms()}
        <div class="field"><label for="cv-limit">{m.kh_han_muc_cong_no()}</label><NumberInput id="cv-limit" bind:value={convert.creditLimit} /><span class="hint">{vnd(convert.creditLimit || 0)}</span></div>
        <div class="field"><label for="cv-days">{m.kh_so_ngay_no()}</label><NumberInput id="cv-days" bind:value={convert.paymentTermDays} /></div>
      {:else}
        <p class="hint">{m.crm_chuyen_khong_han_muc()}</p>
      {/if}
    </form>
    {#snippet footer()}
      <button type="button" class="btn" onclick={() => (convertOpen = false)}>{m.huy()}</button>
      <button type="submit" class="btn primary" form="convert-form" disabled={converting}><ArrowUpRight size={15} />{converting ? m.kh_dang_luu() : m.crm_chuyen_chinh_thuc()}</button>
    {/snippet}
  </Dialog>
{:else if loading}
  <div class="card skeleton" style="height: 320px"></div>
{/if}

<style>
  .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px 16px; align-items: start; }
  .grid.three { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .span { grid-column: 1 / -1; }
  .kpis.three { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .kpi .note.danger { color: var(--red); }
  .kpi .value .link { color: var(--navy); }
  .banner .btn { margin-left: auto; }
  .table.edit td { padding: 6px 8px; }
  .table.edit input:not([type='radio']) { width: 100%; min-width: 110px; min-height: 36px; padding: 6px 9px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface); }
  .table.edit input[readonly] { border-color: transparent; background: transparent; }
  .table.edit td.wide input { min-width: 260px; }
  .table.edit tr.invalid input { border-color: var(--red); }
  .row-error td { padding: 0 10px 8px !important; border: 0; color: var(--red); font-size: 12px; }
  .add-row { padding: 12px 16px; border-top: 1px solid var(--line-soft); }
  .convert { display: grid; gap: 14px; }
  .convert p { margin: 0; }
  @media (max-width: 640px) { .grid, .grid.three, .kpis.three { grid-template-columns: 1fr; } }
  .ledger-link { display: flex; align-items: center; gap: 8px; margin: 0; padding: 12px 16px 0; }
</style>
