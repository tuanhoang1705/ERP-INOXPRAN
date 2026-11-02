<script lang="ts" module>
  export interface ShipmentLine {
    purchaseOrderId: string;
    purchaseOrderCode: string;
    productId: string;
    sku: string;
    productName: string;
    baseUnit: string;
    quantity: string;
    receivedQuantity?: string;
    unitCost: string;
    currency: string;
    exchangeRate: string;
    valueVnd: string;
    cartons: number;
    cbm: number;
    grossKg: number;
  }
  export interface ShipmentDetail {
    id: string;
    code: string;
    status: string;
    warehouseId: string;
    warehouseName?: string;
    purchaseOrders: Array<{ id: string; code: string; supplierName: string; currency: string; exchangeRate: string }>;
    containerNo?: string;
    containerType?: string;
    sealNo?: string;
    billOfLading?: string;
    vessel?: string;
    customsDeclarationNo?: string;
    etd?: string;
    eta?: string;
    arrivedAt?: string;
    receivedAt?: string;
    note?: string;
    costs: Array<{ type: string; amount: string; invoiceNo?: string; note?: string }>;
    allocationMethod: 'VALUE' | 'CBM' | 'QUANTITY';
    lines: ShipmentLine[];
    totals: { valueVnd: string; cartons: number; cbm: number; grossKg: number; container: string };
    landed: { lines: Array<{ key: string; valueVnd: string; allocatedVnd: string; landedVnd: string; unitCostVnd: string }>; capitalizedVnd: string; excludedVnd: string; methodUsed: string };
    receiptCodes?: string[];
    costUpdates?: Array<{ sku: string; before?: string; after: string }>;
    version: number;
    createdAt: string;
  }
</script>

<script lang="ts">
  /**
   * Lô hàng nhập khẩu (container / B/L): gom dòng của các đơn mua cùng kho nhận, theo dõi đi đường, chi phí nhập
   * (cước, bảo hiểm, thuế nhập khẩu, phí cảng… — thuế GTGT nhập khẩu không vào giá vốn), xem trước phân bổ giá vốn,
   * nhận hàng cả lô và chốt giá vốn bình quân. Tạo mới: /procurement/shipments/new?po=<đơn mua>.
   */
  import { untrack } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { Anchor, CircleAlert, CircleCheck, PackageCheck, Plus, RefreshCw, Ship, Trash2, XCircle } from 'lucide-svelte';
  import { ALLOCATION_METHODS, IMPORT_COST_TYPES, landedCost, sumAmounts } from '$shared/landed-cost';
  import { m } from '$lib/paraglide/messages';
  import { api, ApiRequestError } from '$lib/api';
  import { date, dateTime, num, vnd } from '$lib/format';
  import { hasRole } from '$lib/labels';
  import { session } from '$lib/session.svelte';
  import { money, type PurchaseOrderDetail } from '$lib/purchase';
  import RecordWindow from './RecordWindow.svelte';
  import RecordSection from './RecordSection.svelte';
  import HistoryPanel from './HistoryPanel.svelte';
  import AttachmentsPanel from './AttachmentsPanel.svelte';
  import NumberInput from '$lib/components/NumberInput.svelte';
  import GoodsReceiptsPanel from '$lib/components/GoodsReceiptsPanel.svelte';

  let { id = '' }: { id?: string } = $props();

  const FIELDS = ['containerNo', 'containerType', 'sealNo', 'billOfLading', 'vessel', 'customsDeclarationNo', 'etd', 'eta', 'note'] as const;
  type FieldKey = (typeof FIELDS)[number];
  type CostRow = { type: string; amount: string; invoiceNo: string; note: string };
  type DraftLine = { purchaseOrderId: string; purchaseOrderCode: string; productId: string; sku: string; productName: string; baseUnit: string; quantity: string; max: number; valueVnd: number; cbm: number };

  let shipment = $state<ShipmentDetail | null>(null);
  let form = $state<Record<FieldKey, string>>(Object.fromEntries(FIELDS.map((key) => [key, ''])) as Record<FieldKey, string>);
  let costs = $state<CostRow[]>([]);
  let method = $state<'VALUE' | 'CBM' | 'QUANTITY'>('VALUE');
  let draftLines = $state<DraftLine[]>([]);
  let source = $state<PurchaseOrderDetail | null>(null);
  let received = $state<Record<string, string>>({});
  let reference = $state('');
  let updateCost = $state(true);
  let baseline = $state('');
  let tab = $state('main');
  let loading = $state(true);
  let saving = $state(false);
  let working = $state(false);
  let error = $state('');
  let conflict = $state(false);
  let success = $state('');
  let historyReload = $state(0);
  let attachmentCount = $state<number | undefined>(undefined);

  const isNew = $derived(!id);
  const roles = $derived(session.user?.roles ?? []);
  const open = $derived(isNew || ['PLANNED', 'IN_TRANSIT', 'ARRIVED'].includes(shipment?.status ?? ''));
  const editable = $derived(open && hasRole(roles, ['PROCUREMENT', 'PROCUREMENT_MANAGER', 'ACCOUNTANT']));
  const linesEditable = $derived(editable && (isNew || shipment?.status === 'PLANNED'));
  // PO-FLOW-02 (31/10/2026): nhận được cả lô chưa bấm "Khởi hành" / "Đã cập cảng" — mốc còn thiếu ghi lúc nhận.
  const canReceive = $derived(!isNew && ['PLANNED', 'IN_TRANSIT', 'ARRIVED'].includes(shipment?.status ?? '') && hasRole(roles, ['WAREHOUSE', 'WAREHOUSE_MANAGER']));
  const snapshot = () => JSON.stringify({ form, costs, method, lines: draftLines.map((line) => line.quantity) });
  const dirty = $derived(editable && JSON.stringify({ form, costs, method, lines: draftLines.map((line) => line.quantity) }) !== baseline);
  const keyOf = (line: { purchaseOrderId: string; productId: string }) => `${line.purchaseOrderId}:${line.productId}`;
  const text = (value: unknown) => (value === undefined || value === null ? '' : String(value));

  function fill(detail: ShipmentDetail) {
    form = Object.fromEntries(FIELDS.map((key) => [key, text((detail as unknown as Record<string, unknown>)[key])])) as Record<FieldKey, string>;
    costs = detail.costs.map((cost) => ({ type: cost.type, amount: String(Math.round(Number(cost.amount))), invoiceNo: cost.invoiceNo ?? '', note: cost.note ?? '' }));
    method = detail.allocationMethod;
    draftLines = detail.lines.map((line) => ({ purchaseOrderId: line.purchaseOrderId, purchaseOrderCode: line.purchaseOrderCode, productId: line.productId, sku: line.sku, productName: line.productName, baseUnit: line.baseUnit, quantity: String(Number(line.quantity)), max: Number(line.quantity), valueVnd: Number(line.valueVnd), cbm: line.cbm }));
    received = Object.fromEntries(detail.lines.map((line) => [keyOf(line), String(Number(line.quantity))]));
    baseline = snapshot();
  }

  async function load() {
    loading = true;
    error = '';
    conflict = false;
    try {
      if (id) {
        shipment = await api<ShipmentDetail>(`/import-shipments/${id}`);
        fill(shipment);
      } else {
        const poId = page.url.searchParams.get('po') ?? '';
        const preview = await api<{ order: PurchaseOrderDetail; lines: Array<Omit<DraftLine, 'max'> & { remaining: string }> }>(`/import-shipments/draft?purchaseOrderId=${poId}`);
        source = preview.order;
        draftLines = preview.lines.map((line) => ({ ...line, quantity: String(Number(line.remaining)), max: Number(line.remaining) }));
        form.eta = preview.order.eta ?? '';
        form.etd = preview.order.etd ?? '';
        baseline = '';
      }
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

  /** Xem trước giá vốn với chi phí / phương pháp đang sửa (cùng hàm với máy chủ). */
  const preview = $derived.by(() => {
    const rows = draftLines.filter((line) => Number(line.quantity) > 0).map((line) => {
      const ratio = line.max > 0 ? Number(line.quantity) / line.max : 1;
      return { key: keyOf(line), quantity: line.quantity, valueVnd: String(Math.round(line.valueVnd * ratio)), cbm: line.cbm * ratio };
    });
    return landedCost(rows, costs.filter((cost) => Number(cost.amount) > 0).map((cost) => ({ type: cost.type, amountVnd: cost.amount })), method);
  });
  const costLabel = (type: string) => ({ FREIGHT: m.ls_cuoc(), INSURANCE: m.ls_bao_hiem(), IMPORT_DUTY: m.ls_thue_nk(), IMPORT_VAT: m.ls_vat_nk(), CUSTOMS_FEE: m.ls_phi_hai_quan(), PORT_FEE: m.ls_phi_cang(), TRUCKING: m.ls_van_chuyen_noi_dia(), OTHER: m.po_khac() })[type] ?? type;
  const methodLabel = (value: string) => ({ VALUE: m.ls_theo_gia_tri(), CBM: m.ls_theo_cbm(), QUANTITY: m.ls_theo_so_luong() })[value] ?? value;
  const statusLabel = (value: string) => ({ PLANNED: m.ls_ke_hoach(), IN_TRANSIT: m.ls_dang_van_chuyen(), ARRIVED: m.ls_da_cap_cang(), RECEIVED: m.ls_da_nhap_kho(), CANCELLED: m.ls_da_huy() })[value] ?? value;
  const statusTone = (value: string) => ({ IN_TRANSIT: 'warning', ARRIVED: '', RECEIVED: 'success', CANCELLED: 'neutral' })[value] ?? 'neutral';

  function payload(): Record<string, unknown> {
    const body: Record<string, unknown> = {};
    for (const key of FIELDS) if (form[key].trim()) body[key] = form[key].trim();
    body.costs = costs.filter((cost) => Number(cost.amount) > 0).map((cost) => ({ type: cost.type, amount: String(Number(cost.amount)), ...(cost.invoiceNo.trim() ? { invoiceNo: cost.invoiceNo.trim() } : {}), ...(cost.note.trim() ? { note: cost.note.trim() } : {}) }));
    body.allocationMethod = method;
    if (linesEditable) body.lines = draftLines.filter((line) => Number(line.quantity) > 0).map((line) => ({ purchaseOrderId: line.purchaseOrderId, productId: line.productId, quantity: line.quantity }));
    return body;
  }

  async function save() {
    error = '';
    success = '';
    if (draftLines.some((line) => Number(line.quantity) > line.max + 1e-9)) {
      error = m.ls_vuot_so_con_lai();
      return;
    }
    if (!draftLines.some((line) => Number(line.quantity) > 0)) {
      error = m.ls_chua_co_dong();
      return;
    }
    saving = true;
    try {
      if (isNew) {
        const created = await api<{ id: string }>('/import-shipments', { method: 'POST', idempotentCommand: true, body: JSON.stringify(payload()) });
        baseline = snapshot();
        await goto(`/procurement/shipments/${created.id}`);
        return;
      }
      if (!shipment) return;
      await api(`/import-shipments/${shipment.id}`, { method: 'PATCH', body: JSON.stringify({ ...payload(), version: shipment.version }) });
      success = m.crud_da_luu({ name: shipment.code });
      historyReload += 1;
      await load();
    } catch (caught) {
      conflict = caught instanceof ApiRequestError && caught.payload.code === 'VERSION_CONFLICT';
      error = caught instanceof Error ? caught.message : m.crud_loi_luu();
    } finally {
      saving = false;
    }
  }

  async function setStatus(status: 'IN_TRANSIT' | 'ARRIVED' | 'CANCELLED') {
    if (!shipment) return;
    if (status === 'CANCELLED' && !confirm(m.ls_huy_hoi({ code: shipment.code }))) return;
    working = true;
    error = '';
    try {
      await api(`/import-shipments/${shipment.id}`, { method: 'PATCH', body: JSON.stringify({ version: shipment.version, status }) });
      // Lô đã hủy chỉ quản trị gốc còn mở được (DOC-HIDE-01): người khác về danh sách kèm thông báo.
      if (status === 'CANCELLED' && !session.user?.root) {
        await goto(`/procurement/shipments?cancelled=${encodeURIComponent(shipment.code)}`);
        return;
      }
      historyReload += 1;
      await load();
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.crud_loi_luu();
    } finally {
      working = false;
    }
  }

  async function receive() {
    if (!shipment) return;
    if (dirty) {
      error = m.ls_luu_truoc_khi_nhan();
      return;
    }
    if (!confirm(m.ls_nhan_hoi({ code: shipment.code }))) return;
    working = true;
    error = '';
    success = '';
    try {
      const result = await api<ShipmentDetail>(`/import-shipments/${shipment.id}/receive`, {
        method: 'POST',
        idempotentCommand: true,
        body: JSON.stringify({
          version: shipment.version,
          updateStandardCost: updateCost,
          ...(reference.trim() ? { supplierDocumentReference: reference.trim() } : {}),
          lines: shipment.lines.map((line) => ({ purchaseOrderId: line.purchaseOrderId, productId: line.productId, quantity: received[keyOf(line)] || '0' })),
        }),
      });
      success = m.ls_da_nhan({ code: result.code, receipts: (result.receiptCodes ?? []).join(', ') });
      historyReload += 1;
      await load();
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.khong_the_ghi_nhan_nhap_kho();
    } finally {
      working = false;
    }
  }

  const title = $derived(isNew ? m.po_tao_lo_hang() : shipment ? `${shipment.code}${shipment.containerNo ? ` — ${shipment.containerNo}` : ''}` : m.dang_tai());
  const tabs = $derived([
    { id: 'main', label: m.ls_thong_tin_lo() },
    { id: 'lines', label: m.po_hang_hoa(), badge: draftLines.length },
    { id: 'costs', label: m.ls_chi_phi_gia_von(), badge: costs.length },
    { id: 'receive', label: m.ls_nhan_hang(), hidden: isNew },
    { id: 'attachments', label: m.rw_dinh_kem(), badge: attachmentCount, hidden: isNew },
    { id: 'history', label: m.rw_lich_su(), hidden: isNew },
  ]);
  const totalCost = $derived(sumAmounts(costs.filter((cost) => Number(cost.amount) > 0).map((cost) => cost.amount), 0));
  const previewByKey = $derived(new Map(preview.lines.map((line) => [line.key, line])));
</script>

<svelte:head><title>{title} · INOXPRAN ERP</title></svelte:head>

{#snippet field(key: FieldKey, label: string, type = 'text')}
  <div class="field">
    <label for={`ls-${key}`}>{label}</label>
    <input id={`ls-${key}`} {type} bind:value={form[key]} readonly={!editable} maxlength="120" />
  </div>
{/snippet}

{#if error && !shipment && !source}
  <div class="banner error"><CircleAlert size={17} /><span>{error}</span></div>
{:else if shipment || source}
  <RecordWindow
    {title}
    crumbs={[{ href: '/procurement', label: m.nhap_kho_don_mua() }, { href: '/procurement/shipments', label: m.ls_lo_hang_nhap() }]}
    listKey={isNew ? '' : 'import-shipments'}
    recordId={shipment?.id ?? ''}
    detailHref={(target) => `/procurement/shipments/${target}`}
    {dirty}
    {saving}
    {tabs}
    bind:tab
    onsave={editable ? save : undefined}
    onreset={editable && shipment ? () => { if (shipment) fill(shipment); error = ''; } : undefined}
    onprint={shipment ? () => window.open(`/print/packing-list/shipment-${shipment?.id}`, '_blank') : undefined}
  >
    {#snippet badges()}
      {#if shipment}<span class={`pill ${statusTone(shipment.status)}`}>{statusLabel(shipment.status)}</span><span class="muted">{shipment.warehouseName ?? ''} · {shipment.purchaseOrders.map((row) => row.code).join(', ')}</span>{/if}
      {#if source}<span class="muted">{m.ls_tu_don({ code: source.code, supplier: source.supplierName })}</span>{/if}
    {/snippet}
    {#snippet extra()}
      {#if shipment && editable}
        {#if shipment.status === 'PLANNED'}<button class="btn small" disabled={working || dirty} onclick={() => setStatus('IN_TRANSIT')}><Ship size={14} />{m.ls_dang_van_chuyen()}</button>{/if}
        {#if shipment.status === 'IN_TRANSIT'}<button class="btn small" disabled={working || dirty} onclick={() => setStatus('ARRIVED')}><Anchor size={14} />{m.ls_da_cap_cang()}</button>{/if}
        <button class="btn small" disabled={working} onclick={() => setStatus('CANCELLED')}><XCircle size={14} />{m.ls_huy_lo()}</button>
      {/if}
    {/snippet}
    {#snippet children(active)}
      {#if error}<div class="banner error"><CircleAlert size={17} /><span>{error}</span>{#if conflict}<button class="btn small" onclick={load}><RefreshCw size={14} />{m.rw_tai_lai()}</button>{/if}</div>{/if}
      {#if success}<div class="banner success"><CircleCheck size={17} />{success}</div>{/if}

      <div class="kpis">
        <div class="card kpi"><p class="label">{m.ls_gia_tri_hang()}</p><p class="value">{vnd(preview.lines.reduce((sum, line) => sum + Number(line.valueVnd), 0))}</p><p class="note">{m.ls_quy_vnd_ty_gia_don()}</p></div>
        <div class="card kpi"><p class="label">{m.ls_chi_phi_von_hoa()}</p><p class="value">{vnd(preview.capitalizedVnd)}</p><p class="note">{m.ls_vat_khong_vao_gia_von({ amount: vnd(preview.excludedVnd) })}</p></div>
        <div class="card kpi"><p class="label">{m.po_so_thung()} / CBM</p><p class="value">{num(shipment?.totals.cartons ?? 0)} · {shipment?.totals.cbm ?? draftLines.reduce((sum, line) => sum + line.cbm, 0).toFixed(3)} m³</p><p class="note">{shipment?.totals.container ?? ''}</p></div>
        <div class="card kpi"><p class="label">ETA</p><p class="value">{form.eta ? date(form.eta) : '—'}</p><p class="note">{shipment?.receivedAt ? `${m.ls_da_nhap_kho()} ${dateTime(shipment.receivedAt)}` : form.billOfLading || '—'}</p></div>
      </div>

      {#if active === 'main'}
        <RecordSection id="shipment-main" title={m.ls_thong_tin_lo()}>
          <div class="grid">
            {@render field('containerNo', m.ls_so_container())}
            <div class="field"><label for="ls-containerType">{m.ls_loai_container()}</label><select id="ls-containerType" bind:value={form.containerType} disabled={!editable}><option value="">—</option>{#each ['20GP', '40GP', '40HQ', 'LCL', 'AIR', 'OTHER'] as value}<option {value}>{value}</option>{/each}</select></div>
            {@render field('sealNo', m.ls_so_chi())}
            {@render field('billOfLading', m.ls_so_van_don())}
            {@render field('vessel', m.ls_tau_chuyen())}
            {@render field('customsDeclarationNo', m.ls_to_khai())}
            {@render field('etd', 'ETD', 'date')}
            {@render field('eta', 'ETA', 'date')}
            <div class="field span3"><label for="ls-note">{m.ghi_chu()}</label><textarea id="ls-note" rows="2" bind:value={form.note} readonly={!editable} maxlength="500"></textarea></div>
          </div>
        </RecordSection>
      {:else if active === 'lines'}
        <section class="card">
          <div class="table-wrap">
            <table class="table">
              <thead><tr><th>{m.ls_don_mua()}</th><th>{m.ma_sp()}</th><th>{m.ten_san_pham()}</th><th class="num">{m.ls_so_luong_lo()}</th><th class="num">{m.ls_gia_tri_vnd()}</th><th class="num">CBM</th>{#if linesEditable}<th></th>{/if}</tr></thead>
              <tbody>
                {#each draftLines as line, index (keyOf(line))}
                  <tr>
                    <td><a class="link" href={`/procurement/${line.purchaseOrderId}`}>{line.purchaseOrderCode}</a></td>
                    <td class="code">{line.sku}</td>
                    <td>{line.productName}</td>
                    <td class="num">{#if linesEditable}<NumberInput class="input qty" decimals={3} bind:value={line.quantity} aria-label={`${m.so_luong()} ${line.sku}`} /><small>{m.ls_toi_da({ max: num(line.max), unit: line.baseUnit })}</small>{:else}{num(line.quantity)} {line.baseUnit}{/if}</td>
                    <td class="num">{vnd(previewByKey.get(keyOf(line))?.valueVnd ?? 0)}</td>
                    <td class="num">{(line.cbm * (line.max > 0 ? Number(line.quantity) / line.max : 1)).toFixed(3)}</td>
                    {#if linesEditable}<td class="row-actions"><button class="icon-btn danger" aria-label={m.crud_xoa()} onclick={() => draftLines.splice(index, 1)}><Trash2 size={15} /></button></td>{/if}
                  </tr>
                {:else}<tr class="empty-row"><td colspan="7">{m.ls_chua_co_dong()}</td></tr>{/each}
              </tbody>
            </table>
          </div>
        </section>
      {:else if active === 'costs'}
        <RecordSection id="shipment-costs" title={m.ls_chi_phi_nhap()} note={m.ls_tong_chi_phi({ amount: vnd(totalCost) })}>
          <div class="table-wrap">
            <table class="table edit">
              <thead><tr><th>{m.po_loai()}</th><th class="num">{m.crm_so_tien()} (VND)</th><th>{m.ls_so_hoa_don()}</th><th>{m.ghi_chu()}</th>{#if editable}<th></th>{/if}</tr></thead>
              <tbody>
                {#each costs as cost, index}
                  <tr>
                    <td><select class="input" bind:value={cost.type} disabled={!editable}>{#each IMPORT_COST_TYPES as type}<option value={type}>{costLabel(type)}</option>{/each}</select></td>
                    <td class="num"><NumberInput class="input right" bind:value={cost.amount} readonly={!editable} aria-label={m.crm_so_tien()} /></td>
                    <td><input class="input" bind:value={cost.invoiceNo} readonly={!editable} maxlength="60" aria-label={m.ls_so_hoa_don()} /></td>
                    <td><input class="input" bind:value={cost.note} readonly={!editable} maxlength="200" aria-label={m.ghi_chu()} /></td>
                    {#if editable}<td class="row-actions"><button class="icon-btn danger" aria-label={m.crud_xoa()} onclick={() => costs.splice(index, 1)}><Trash2 size={15} /></button></td>{/if}
                  </tr>
                {:else}<tr class="empty-row"><td colspan="5">{m.ls_chua_co_chi_phi()}</td></tr>{/each}
              </tbody>
            </table>
          </div>
          {#if editable}
            <div class="cost-tools">
              <button class="btn small" onclick={() => costs.push({ type: 'FREIGHT', amount: '', invoiceNo: '', note: '' })}><Plus size={14} />{m.ls_them_chi_phi()}</button>
              <div class="field inline"><label for="ls-method">{m.ls_phan_bo()}</label><select id="ls-method" bind:value={method}>{#each ALLOCATION_METHODS as value}<option {value}>{methodLabel(value)}</option>{/each}</select></div>
            </div>
          {/if}
        </RecordSection>
        <RecordSection id="shipment-landed" title={m.ls_gia_von_du_kien()} note={preview.methodUsed !== method ? m.ls_thieu_cbm() : methodLabel(preview.methodUsed)}>
          <div class="table-wrap">
            <table class="table">
              <thead><tr><th>{m.ma_sp()}</th><th class="num">{m.so_luong()}</th><th class="num">{m.ls_gia_tri_vnd()}</th><th class="num">{m.ls_phan_bo()}</th><th class="num">{m.ls_gia_von_nhap()}</th><th class="num">{m.ls_gia_von_don_vi()}</th></tr></thead>
              <tbody>
                {#each draftLines as line (keyOf(line))}
                  {@const row = previewByKey.get(keyOf(line))}
                  {#if row}<tr><td class="code">{line.sku}</td><td class="num">{num(line.quantity)} {line.baseUnit}</td><td class="num">{vnd(row.valueVnd)}</td><td class="num">{vnd(row.allocatedVnd)}</td><td class="num">{vnd(row.landedVnd)}</td><td class="num"><b>{vnd(row.unitCostVnd)}</b></td></tr>{/if}
                {/each}
              </tbody>
            </table>
          </div>
        </RecordSection>
      {:else if active === 'receive' && shipment}
        {#if shipment.status === 'RECEIVED'}
          <section class="card done-card">
            <p><PackageCheck size={18} /> {m.ls_da_nhan({ code: shipment.code, receipts: (shipment.receiptCodes ?? []).join(', ') })}</p>
            {#if shipment.costUpdates?.length}
              <table class="table"><thead><tr><th>{m.ma_sp()}</th><th class="num">{m.ls_gia_von_cu()}</th><th class="num">{m.ls_gia_von_moi()}</th></tr></thead>
                <tbody>{#each shipment.costUpdates as row}<tr><td class="code">{row.sku}</td><td class="num">{row.before ? vnd(row.before) : '—'}</td><td class="num"><b>{vnd(row.after)}</b></td></tr>{/each}</tbody></table>
            {/if}
          </section>
          <GoodsReceiptsPanel importShipmentId={shipment.id} reload={historyReload} canEdit={hasRole(roles, ['WAREHOUSE', 'WAREHOUSE_MANAGER'])}
            onchanged={(code) => { success = m.gr_da_sua({ code }); historyReload += 1; void load(); }} />
        {:else}
          <section class="card">
            <div class="table-wrap">
              <table class="table">
                <thead><tr><th>{m.ls_don_mua()}</th><th>{m.ma_sp()}</th><th class="num">{m.ls_so_luong_lo()}</th><th class="num">{m.thuc_nhan_lan_nay()}</th></tr></thead>
                <tbody>
                  {#each shipment.lines as line (keyOf(line))}
                    <tr><td>{line.purchaseOrderCode}</td><td class="code">{line.sku}</td><td class="num">{num(line.quantity)} {line.baseUnit}</td><td class="num">{#if canReceive}<NumberInput class="input qty" decimals={3} bind:value={received[keyOf(line)]} aria-label={`${m.thuc_nhan({ sku: line.sku })}`} />{:else}—{/if}</td></tr>
                  {/each}
                </tbody>
              </table>
            </div>
            {#if canReceive}
              <footer class="receive">
                <label class="check"><input type="checkbox" bind:checked={updateCost} />{m.ls_cap_nhat_gia_von()}</label>
                <div class="field"><label for="ls-ref">{m.so_phieu_giao_hang_cua_ncc()}</label><input id="ls-ref" bind:value={reference} placeholder={m.tuy_chon()} /></div>
                <button class="btn primary" disabled={working} onclick={receive}><PackageCheck size={16} />{working ? m.dang_ghi_so() : m.ls_nhap_kho_lo()}</button>
              </footer>
            {:else}<p class="hint pad">{m.ls_nhan_khi_cap_cang()}</p>{/if}
          </section>
        {/if}
      {:else if active === 'attachments' && shipment}
        <AttachmentsPanel type="import-shipments" id={shipment.id} onchange={(count) => (attachmentCount = count)} purposes={[{ purpose: 'PURCHASE_DOCUMENT', label: m.ls_chung_tu_lo(), pdf: true }]} />
      {:else if active === 'history' && shipment}
        <HistoryPanel type="import-shipments" id={shipment.id} reload={historyReload} actionLabels={{ IMPORT_SHIPMENT_CREATED: m.rw_tao_moi(), IMPORT_SHIPMENT_UPDATED: m.rw_cap_nhat(), IMPORT_SHIPMENT_RECEIVED: m.ls_nhap_kho_lo(), PURCHASE_FILE_UPLOADED: m.rw_tai_len_file(), PURCHASE_FILE_DELETED: m.rw_xoa_file() }} />
      {/if}
    {/snippet}
  </RecordWindow>
{:else if loading}
  <div class="card skeleton" style="height: 320px"></div>
{/if}

<style>
  .grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px 16px; }
  .span3 { grid-column: 1 / -1; }
  td :global(.qty) { width: 110px; text-align: right; }
  td small { display: block; color: var(--subtle); font-size: 11.5px; }
  .table.edit td { padding: 6px 8px; }
  .table.edit td :global(.input) { min-height: 36px; padding: 6px 9px; }
  td :global(.right) { text-align: right; }
  .cost-tools { display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: 12px; padding-top: 12px; }
  .inline { flex-direction: row; display: flex; align-items: center; gap: 8px; }
  .inline select { width: 200px; }
  .receive { display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: flex-end; gap: 14px; padding: 16px 20px; border-top: 1px solid var(--line-soft); }
  .receive .field { width: 260px; }
  .check { display: flex; align-items: center; gap: 8px; min-height: 42px; font-size: 13.5px; margin-right: auto; }
  .check input { width: 17px; height: 17px; accent-color: var(--navy); }
  .done-card { padding: 16px; }
  .done-card p { display: flex; align-items: center; gap: 8px; margin: 0 0 12px; color: var(--green); font-weight: 600; }
  .hint { color: var(--subtle); font-size: 12.5px; }
  .pad { margin: 0; padding: 14px 20px; }
  .banner .btn { margin-left: auto; }
  @media (max-width: 900px) { .grid { grid-template-columns: 1fr 1fr; } }
</style>
