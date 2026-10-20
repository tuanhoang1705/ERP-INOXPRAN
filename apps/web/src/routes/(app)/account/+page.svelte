<script lang="ts">
  import { m } from '$lib/paraglide/messages';
  import type { LoginEvent } from '@inoxpran/contracts';
  import { onMount } from 'svelte';
  import { CircleAlert, ShieldCheck, ShieldOff } from 'lucide-svelte';
  import { api } from '$lib/api';
  import { dateTime } from '$lib/format';
  import { roleLabel } from '$lib/labels';
  import { loginReasonText } from '$lib/admin';
  import { session } from '$lib/session.svelte';
  import MfaEnroll from '$lib/components/MfaEnroll.svelte';
  import PasswordChange from '$lib/components/PasswordChange.svelte';

  let logins = $state<LoginEvent[]>([]);
  const user = $derived(session.user);

  async function loadLogins() {
    logins = await api<LoginEvent[]>('/auth/logins').catch(() => []);
  }
  async function mfaDone() {
    const me = await api<typeof session.user>('/auth/me').catch(() => null);
    if (me) session.user = me;
  }
  /** Tự tắt 2 lớp khi không bị bắt buộc (MFA-02) — phải nhập mã 6 số hiện tại. */
  let disabling = $state(false);
  let offCode = $state('');
  let offError = $state('');
  let offSaving = $state(false);
  async function disableMfa(event: SubmitEvent) {
    event.preventDefault();
    offSaving = true;
    offError = '';
    try {
      await api('/auth/mfa/disable', { method: 'POST', body: JSON.stringify({ totpCode: offCode.trim() }) });
      disabling = false;
      offCode = '';
      await mfaDone();
    } catch (caught) {
      offError = caught instanceof Error ? caught.message : m.acc_mfa_off_failed();
    } finally {
      offSaving = false;
    }
  }
  onMount(loadLogins);
</script>

<svelte:head><title>{m.acc_title()} · INOXPRAN ERP</title></svelte:head>

<section class="page-head">
  <div>
    <nav class="crumbs" aria-label={m.duong_dan()}><a href="/">{m.tong_quan()}</a><span>{m.acc_title()}</span></nav>
    <h1 class="page-title">{m.acc_title()}</h1>
    <p class="page-sub">{m.acc_sub()}</p>
  </div>
</section>

<section class="grid">
  <article class="card">
    <header class="card-head"><h2>{m.acc_profile()}</h2></header>
    <dl class="facts">
      <div><dt>{m.ho_ten()}</dt><dd>{user?.displayName}{#if user?.root} <span class="pill orange">{m.adm_root()}</span>{/if}</dd></div>
      <div><dt>Email</dt><dd>{user?.email}</dd></div>
      <div><dt>{m.adm_roles()}</dt><dd>{user?.roles.map((role) => roleLabel[role] ?? role).join(', ')}</dd></div>
    </dl>
    <p class="note">{m.acc_profile_note()}</p>
  </article>

  <article class="card">
    <header class="card-head"><h2>{m.acc_change_password()}</h2></header>
    <div class="body"><PasswordChange /></div>
  </article>

  <article class="card">
    <header class="card-head"><h2>{m.acc_mfa_title()}</h2></header>
    <div class="body">
      {#if user?.mfa}
        <p class="ok"><ShieldCheck size={18} />{m.acc_mfa_on()}</p>
        <p class="note">{m.acc_mfa_on_note()}</p>
        {#if user.mfaRequired}
          <p class="note">{m.acc_mfa_required_note()}</p>
        {:else if disabling}
          <form class="off" onsubmit={disableMfa}>
            <label for="mfa-off-code">{m.acc_mfa_off_code()}</label>
            <input id="mfa-off-code" bind:value={offCode} inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="\d{6}" required />
            {#if offError}<p class="err"><CircleAlert size={15} />{offError}</p>{/if}
            <div class="row">
              <button class="btn small danger" disabled={offSaving || !/^\d{6}$/.test(offCode.trim())}>{offSaving ? m.kh_dang_luu() : m.acc_mfa_off_confirm()}</button>
              <button type="button" class="btn small" onclick={() => { disabling = false; offError = ''; offCode = ''; }}>{m.huy()}</button>
            </div>
          </form>
        {:else}
          <button class="btn small" onclick={() => (disabling = true)}><ShieldOff size={15} />{m.acc_mfa_off()}</button>
        {/if}
      {:else}
        <MfaEnroll ondone={mfaDone} />
      {/if}
    </div>
  </article>

  <article class="card wide">
    <header class="card-head"><h2>{m.acc_my_logins()}</h2></header>
    <div class="table-wrap">
      <table class="table">
        <thead><tr><th>{m.adm_time()}</th><th>{m.adm_result()}</th><th>IP</th><th>{m.adm_device()}</th></tr></thead>
        <tbody>
          {#each logins as row (row.id)}
            <tr>
              <td class="nowrap">{dateTime(row.at)}</td>
              <td><span class={`pill ${row.success ? 'success' : 'danger'}`}>{loginReasonText(row.reason)}</span></td>
              <td class="muted">{row.ip ?? '—'}</td>
              <td class="muted ua">{row.userAgent ?? '—'}</td>
            </tr>
          {:else}<tr class="empty-row"><td colspan="4">{m.adm_no_logins()}</td></tr>{/each}
        </tbody>
      </table>
    </div>
  </article>
</section>

<style>
  .grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; align-items: start; }
  .wide { grid-column: 1 / -1; }
  .facts { display: grid; gap: 10px; margin: 0; padding: 8px 20px 12px; }
  .facts dt { color: var(--subtle); font-size: 11.5px; }
  .facts dd { margin: 2px 0 0; font-size: 14px; }
  .body { padding: 6px 20px 20px; }
  .note { margin: 0; padding: 0 20px 16px; color: var(--subtle); font-size: 12.5px; }
  .body .note { padding: 6px 0 0; }
  .ok { display: flex; align-items: center; gap: 8px; margin: 0; color: var(--green); font-weight: 600; }
  .body > .btn { margin-top: 12px; }
  .off { display: grid; gap: 8px; margin-top: 12px; }
  .off label { color: var(--muted); font-size: 12.5px; }
  .off input { max-width: 160px; letter-spacing: 3px; }
  .off .row { display: flex; gap: 8px; }
  .err { display: flex; align-items: center; gap: 6px; margin: 0; color: var(--red); font-size: 12.5px; }
  .ua { max-width: 420px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  @media (max-width: 1100px) { .grid { grid-template-columns: 1fr; } }
</style>
