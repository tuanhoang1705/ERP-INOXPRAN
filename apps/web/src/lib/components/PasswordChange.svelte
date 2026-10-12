<script lang="ts">
  /** Đổi mật khẩu (POST /auth/password): mật khẩu mới ≥ 12 ký tự, có chữ và số, khác mật khẩu cũ. */
  import { CircleAlert, CircleCheck, Eye, EyeOff } from 'lucide-svelte';
  import { m } from '$lib/paraglide/messages';
  import { api } from '$lib/api';
  import { passwordProblem } from '$shared/user-admin';

  let { temporary = false, ondone }: { temporary?: boolean; ondone?: () => void } = $props();
  let current = $state('');
  let next = $state('');
  let confirm = $state('');
  let show = $state(false);
  let saving = $state(false);
  let error = $state('');
  let done = $state(false);

  const problem = $derived(next ? passwordProblem(next) : null);
  const mismatch = $derived(Boolean(confirm) && confirm !== next);

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    error = '';
    if (problem || mismatch || !current) return;
    saving = true;
    try {
      await api('/auth/password', { method: 'POST', body: JSON.stringify({ currentPassword: current, newPassword: next }) });
      done = true;
      current = next = confirm = '';
      ondone?.();
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.acc_error();
    } finally {
      saving = false;
    }
  }
</script>

<form class="password" onsubmit={submit} novalidate>
  {#if error}<div class="banner error"><CircleAlert size={17} /><span>{error}</span></div>{/if}
  {#if done}<div class="banner success"><CircleCheck size={17} /><span>{m.acc_password_changed()}</span></div>{/if}
  <div class="field">
    <label for="pw-current">{temporary ? m.acc_temp_password() : m.acc_current_password()}</label>
    <input id="pw-current" type={show ? 'text' : 'password'} bind:value={current} autocomplete="current-password" />
  </div>
  <div class="field">
    <label for="pw-new">{m.acc_new_password()}</label>
    <div class="with-toggle">
      <input id="pw-new" type={show ? 'text' : 'password'} bind:value={next} autocomplete="new-password" aria-invalid={Boolean(problem)} />
      <button type="button" class="icon-btn" aria-label={show ? m.acc_hide() : m.acc_show()} onclick={() => (show = !show)}>{#if show}<EyeOff size={16} />{:else}<Eye size={16} />{/if}</button>
    </div>
    {#if problem}<span class="error">{problem === 'TOO_SHORT' ? m.acc_pw_too_short() : m.acc_pw_letter_digit()}</span>{:else}<span class="hint">{m.acc_pw_rule()}</span>{/if}
  </div>
  <div class="field">
    <label for="pw-confirm">{m.acc_confirm_password()}</label>
    <input id="pw-confirm" type={show ? 'text' : 'password'} bind:value={confirm} autocomplete="new-password" aria-invalid={mismatch} />
    {#if mismatch}<span class="error">{m.acc_pw_mismatch()}</span>{/if}
  </div>
  <button class="btn primary" type="submit" disabled={saving || !current || !next || Boolean(problem) || mismatch || !confirm}>{saving ? m.kh_dang_luu() : m.acc_change_password()}</button>
</form>

<style>
  .password { display: grid; gap: 14px; max-width: 440px; }
  .with-toggle { position: relative; }
  .with-toggle input { width: 100%; padding-right: 44px; }
  .with-toggle .icon-btn { position: absolute; top: 50%; right: 6px; transform: translateY(-50%); }
  .password .btn { justify-self: start; }
</style>
