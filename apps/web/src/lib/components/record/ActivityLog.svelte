<script lang="ts">
  /**
   * Nhật ký chăm sóc khách (跟进记录): ghi lần gọi / gặp / nhắn Zalo / email, hẹn chăm sóc lại (worker nhắc sáng ngày hẹn),
   * đánh dấu đã chăm sóc xong. Người ghi (hoặc quản lý kinh doanh) mới sửa / xóa được.
   */
  import type { PartnerActivity, PartnerContact } from '@inoxpran/contracts';
  import { Check, CircleAlert, Plus, RotateCcw, Trash2 } from 'lucide-svelte';
  import { m } from '$lib/paraglide/messages';
  import { api } from '$lib/api';
  import { date, dateTime, todayIso } from '$lib/format';
  import type { Paged } from '$lib/paging';
  import { can } from '$lib/permissions';
  import { session } from '$lib/session.svelte';
  import Pagination from '$lib/components/Pagination.svelte';

  let { partnerId, contacts = [], onchange }: { partnerId: string; contacts?: PartnerContact[]; onchange?: (() => void) | undefined } = $props();

  const CHANNELS = ['CALL', 'MEET', 'ZALO', 'EMAIL', 'OTHER'] as const;
  const channelLabel = (value: string) => ({ CALL: m.crm_kenh_goi(), MEET: m.crm_kenh_gap(), ZALO: 'Zalo', EMAIL: 'Email', OTHER: m.crm_kenh_khac() })[value] ?? value;
  const nowLocal = () => {
    const shifted = new Date(Date.now() + 7 * 3_600_000);
    return shifted.toISOString().slice(0, 16);
  };
  const blank = () => ({ occurredAt: nowLocal(), channel: 'CALL', contactName: contacts.find((row) => row.primary)?.name ?? '', content: '', followUpOn: '', followUpNote: '' });

  let rows = $state<PartnerActivity[]>([]);
  let total = $state(0);
  let page = $state(1);
  let pageSize = $state(20);
  let loading = $state(true);
  let error = $state('');
  let adding = $state(false);
  let saving = $state(false);
  let form = $state(blank());
  const canLog = $derived(can.logActivities());
  const supervisor = $derived((session.user?.roles ?? []).some((role) => ['ADMIN', 'SALES_MANAGER'].includes(role)));
  const today = todayIso();

  async function load() {
    loading = true;
    try {
      const result = await api<Paged<PartnerActivity>>(`/partners/${partnerId}/activities?page=${page}&pageSize=${pageSize}`);
      rows = result.rows;
      total = result.total;
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.rw_loi_tai();
    } finally {
      loading = false;
    }
  }
  $effect(() => {
    void partnerId;
    void load();
  });

  async function add(event: SubmitEvent) {
    event.preventDefault();
    if (form.content.trim().length < 2) {
      error = m.crm_noi_dung_bat_buoc();
      return;
    }
    saving = true;
    error = '';
    try {
      await api(`/partners/${partnerId}/activities`, {
        method: 'POST',
        body: JSON.stringify({
          occurredAt: `${form.occurredAt}:00+07:00`,
          channel: form.channel,
          content: form.content.trim(),
          ...(form.contactName.trim() ? { contactName: form.contactName.trim() } : {}),
          ...(form.followUpOn ? { followUpOn: form.followUpOn } : {}),
          ...(form.followUpOn && form.followUpNote.trim() ? { followUpNote: form.followUpNote.trim() } : {}),
        }),
      });
      form = blank();
      adding = false;
      page = 1;
      await load();
      onchange?.();
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.crud_loi_luu();
    } finally {
      saving = false;
    }
  }

  async function toggleDone(row: PartnerActivity) {
    error = '';
    try {
      await api(`/partners/${partnerId}/activities/${row.id}`, { method: 'PATCH', body: JSON.stringify({ done: !row.done }) });
      await load();
      onchange?.();
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.crud_loi_luu();
    }
  }
  async function remove(row: PartnerActivity) {
    if (!confirm(m.crm_xoa_hoi())) return;
    error = '';
    try {
      await api(`/partners/${partnerId}/activities/${row.id}`, { method: 'DELETE' });
      await load();
      onchange?.();
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.crud_loi_luu();
    }
  }
  const mine = (row: PartnerActivity) => supervisor || row.ownerId === session.user?.sub;
  const followTone = (row: PartnerActivity) => (row.done ? 'success' : !row.followUpOn ? 'neutral' : row.followUpOn < today ? 'danger' : row.followUpOn === today ? 'warning' : '');
</script>

{#if error}<div class="banner error"><CircleAlert size={17} /><span>{error}</span></div>{/if}

{#if canLog}
  {#if adding}
    <form class="card add" onsubmit={add}>
      <div class="grid">
        <div class="field"><label for="a-time">{m.crm_thoi_gian()}</label><input id="a-time" type="datetime-local" bind:value={form.occurredAt} required /></div>
        <div class="field"><label for="a-channel">{m.crm_kenh()}</label><select id="a-channel" bind:value={form.channel}>{#each CHANNELS as value}<option {value}>{channelLabel(value)}</option>{/each}</select></div>
        <div class="field"><label for="a-contact">{m.crm_nguoi_lien_he()}</label><input id="a-contact" bind:value={form.contactName} list="a-contacts" maxlength="120" /><datalist id="a-contacts">{#each contacts as contact}<option value={contact.name}></option>{/each}</datalist></div>
        <div class="field span"><label for="a-content">{m.crm_noi_dung()} <span class="req">*</span></label><textarea id="a-content" rows="3" bind:value={form.content} maxlength="2000" placeholder={m.crm_noi_dung_goi_y()}></textarea></div>
        <div class="field"><label for="a-follow">{m.crm_hen_cham_soc()}</label><input id="a-follow" type="date" bind:value={form.followUpOn} min={today} /></div>
        <div class="field span2"><label for="a-note">{m.crm_viec_can_lam()}</label><input id="a-note" bind:value={form.followUpNote} maxlength="300" disabled={!form.followUpOn} /></div>
      </div>
      <div class="buttons"><button type="button" class="btn" onclick={() => (adding = false)}>{m.huy()}</button><button class="btn primary" disabled={saving}>{saving ? m.kh_dang_luu() : m.crud_luu()}</button></div>
    </form>
  {:else}
    <div class="toolbar"><button class="btn primary small" onclick={() => { form = blank(); adding = true; }}><Plus size={15} />{m.crm_ghi_nhat_ky()}</button></div>
  {/if}
{/if}

<section class="card">
  <ul class="timeline">
    {#each rows as row (row.id)}
      <li class:done={row.done}>
        <div class="when"><b>{dateTime(row.occurredAt)}</b><span class="pill neutral">{channelLabel(row.channel)}</span></div>
        <div class="what">
          <p>{row.content}</p>
          <small>{row.ownerName}{#if row.contactName} · {m.crm_voi()} {row.contactName}{/if}</small>
          {#if row.followUpOn}
            <div class="follow"><span class={`pill ${followTone(row)}`}>{row.done ? m.crm_da_xong() : m.crm_hen_ngay({ date: date(row.followUpOn) })}</span>{#if row.followUpNote}<span class="muted">{row.followUpNote}</span>{/if}</div>
          {/if}
        </div>
        <div class="row-actions">
          {#if row.followUpOn && mine(row) && canLog}
            <button class="icon-btn" title={row.done ? m.crm_mo_lai() : m.crm_danh_dau_xong()} aria-label={row.done ? m.crm_mo_lai() : m.crm_danh_dau_xong()} onclick={() => toggleDone(row)}>{#if row.done}<RotateCcw size={15} />{:else}<Check size={15} />{/if}</button>
          {/if}
          {#if mine(row) && canLog}<button class="icon-btn danger" title={m.crud_xoa()} aria-label={m.crud_xoa()} onclick={() => remove(row)}><Trash2 size={15} /></button>{/if}
        </div>
      </li>
    {:else}
      <li class="empty">{loading ? m.dang_tai() : m.crm_chua_co_nhat_ky()}</li>
    {/each}
  </ul>
  <Pagination {page} {pageSize} {total} {loading} onchange={(next, size) => { page = next; pageSize = size; void load(); }} />
</section>

<style>
  .toolbar { display: flex; justify-content: flex-end; margin-bottom: 12px; }
  .add { margin-bottom: 14px; padding: 16px; }
  .grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px 14px; }
  .span { grid-column: 1 / -1; }
  .span2 { grid-column: span 2; }
  .buttons { display: flex; justify-content: flex-end; gap: 10px; margin-top: 14px; }
  .timeline { margin: 0; padding: 0; list-style: none; }
  .timeline li { display: grid; grid-template-columns: 170px 1fr auto; gap: 14px; padding: 14px 16px; border-bottom: 1px solid var(--line-soft); }
  .timeline li.done .what p { color: var(--muted); }
  .when { display: grid; gap: 6px; align-content: start; font-size: 13px; }
  .when .pill { justify-self: start; }
  .what p { margin: 0 0 4px; white-space: pre-line; }
  .what small { color: var(--subtle); font-size: 12px; }
  .follow { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 8px; font-size: 12.5px; }
  .empty { display: block !important; padding: 36px 16px !important; color: var(--muted); text-align: center; }
  @media (max-width: 720px) {
    .grid { grid-template-columns: 1fr; }
    .span2 { grid-column: auto; }
    .timeline li { grid-template-columns: 1fr; }
  }
</style>
