<script lang="ts">
  /**
   * Tỉnh / thành + NVKD phụ trách theo phân vùng (PV-01, 30/10/2026). Chọn tỉnh mới (34) → ô tỉnh cũ chỉ còn các tỉnh thuộc nó (chỉ
   * một thì tự chọn); chọn tỉnh cũ (63) → tự điền tỉnh mới. Tỉnh tách kênh (VD Hà Nội) hỏi thêm kênh. Vùng đã giao NVKD thì ô NVKD
   * tự điền và khóa; Admin / quản trị gốc bấm "Giao NVKD khác" và ghi lý do (máy chủ kiểm tra lại).
   */
  import { NEW_PROVINCES, OLD_PROVINCES, newProvinceOf, oldProvincesOf, provinceLabel } from '$shared/provinces';
  import { onMount } from 'svelte';
  import { m } from '$lib/paraglide/messages';
  import { can } from '$lib/permissions';
  import { loadTerritories, splitProvince, territories, territoryOwner } from '$lib/territories.svelte';

  type Employee = { id: string; code: string; name: string; status?: string };
  let {
    provinceNewCode = $bindable(''),
    provinceOldCode = $bindable(''),
    territoryChannel = $bindable(''),
    salesRepId = $bindable(''),
    exceptionReason = $bindable(''),
    employees,
    disabled = false,
    idPrefix = 'pv',
    /** Ngoại lệ đang lưu trên hồ sơ (sửa khách). */
    currentException = null,
  }: {
    provinceNewCode?: string;
    provinceOldCode?: string;
    territoryChannel?: string;
    salesRepId?: string;
    exceptionReason?: string;
    employees: Employee[];
    disabled?: boolean;
    idPrefix?: string;
    currentException?: { reason: string; byName: string } | null;
  } = $props();

  let exceptionOn = $state(false);
  onMount(() => void loadTerritories());
  // Hồ sơ đang có ngoại lệ: bật sẵn và điền lý do (chạy lại khi tải lại hồ sơ).
  $effect(() => {
    exceptionOn = Boolean(currentException);
    if (currentException) exceptionReason = currentException.reason;
  });

  const oldChoices = $derived(provinceNewCode ? oldProvincesOf(provinceNewCode) : OLD_PROVINCES);
  const split = $derived(splitProvince(provinceOldCode));
  const owner = $derived(territoryOwner(provinceOldCode, split ? territoryChannel : null));
  const locked = $derived(Boolean(owner) && !exceptionOn);

  function chooseNew(code: string) {
    provinceNewCode = code;
    const members = code ? oldProvincesOf(code) : [];
    if (members.length === 1) provinceOldCode = members[0]!.code;
    else if (provinceOldCode && !members.some((item) => item.code === provinceOldCode)) provinceOldCode = '';
  }
  function chooseOld(code: string) {
    provinceOldCode = code;
    if (code) provinceNewCode = newProvinceOf(code)?.code ?? provinceNewCode;
  }
  // Vùng đã giao NVKD: tự điền người phụ trách (trừ khi đang đặt ngoại lệ).
  $effect(() => {
    if (owner && !exceptionOn && territories.loaded) salesRepId = owner.employeeId;
  });
  $effect(() => {
    if (!split && territoryChannel) territoryChannel = '';
  });
  $effect(() => {
    if (!exceptionOn) exceptionReason = '';
  });
</script>

<div class="field">
  <label for="{idPrefix}-new">{m.pv_tinh_moi()}</label>
  <select id="{idPrefix}-new" value={provinceNewCode} onchange={(event) => chooseNew(event.currentTarget.value)} {disabled}>
    <option value="">{m.pv_chon_tinh()}</option>
    {#each NEW_PROVINCES as item}<option value={item.code}>{item.name}</option>{/each}
  </select>
</div>
<div class="field">
  <label for="{idPrefix}-old">{m.pv_tinh_cu()}</label>
  <select id="{idPrefix}-old" value={provinceOldCode} onchange={(event) => chooseOld(event.currentTarget.value)} {disabled}>
    <option value="">{m.pv_chon_tinh()}</option>
    {#each oldChoices as item}<option value={item.code}>{provinceNewCode ? item.name : provinceLabel(item.code)}</option>{/each}
  </select>
</div>
{#if split}
  <div class="field">
    <label for="{idPrefix}-channel">{m.pv_kenh()} <span class="req">*</span></label>
    <select id="{idPrefix}-channel" bind:value={territoryChannel} {disabled}>
      <option value="">—</option>
      <option value="DISTRIBUTOR">{m.pv_kenh_npp()}</option>
      <option value="RETAIL">{m.pv_kenh_ban_le()}</option>
    </select>
  </div>
{/if}
<div class="field">
  <label for="{idPrefix}-rep">{m.nv_phu_trach()}</label>
  <select id="{idPrefix}-rep" bind:value={salesRepId} disabled={disabled || locked}>
    <option value="">{m.chon_nhan_vien()}</option>
    {#each employees.filter((row) => row.status !== 'INACTIVE' || row.id === salesRepId) as row (row.id)}<option value={row.id}>{row.name} ({row.code})</option>{/each}
  </select>
  {#if owner && !exceptionOn}
    <span class="hint">{m.pv_theo_vung({ region: provinceLabel(provinceOldCode), name: owner.employeeName })}</span>
  {:else if provinceOldCode && !owner && (!split || territoryChannel)}
    <span class="hint">{m.pv_vung_chua_giao()}</span>
  {/if}
  {#if owner && can.overrideTerritory() && !disabled}
    <label class="check"><input type="checkbox" bind:checked={exceptionOn} />{m.pv_dat_ngoai_le()}</label>
  {/if}
</div>
{#if exceptionOn && owner}
  <div class="field span">
    <label for="{idPrefix}-reason">{m.pv_ly_do_ngoai_le()} <span class="req">*</span></label>
    <input id="{idPrefix}-reason" bind:value={exceptionReason} minlength="5" maxlength="300" {disabled} />
    {#if currentException}<span class="hint">{m.pv_ngoai_le_dang_co({ by: currentException.byName })}</span>{/if}
  </div>
{/if}

<style>
  .span { grid-column: 1 / -1; }
  .req { color: var(--red); }
  .check { display: inline-flex; align-items: center; gap: 6px; margin-top: 6px; font-size: 12.5px; font-weight: 500; color: var(--muted); }
</style>
