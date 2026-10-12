<script lang="ts">
  /**
   * Thiết lập bắt buộc trước khi dùng hệ thống: đổi mật khẩu tạm (tài khoản mới / vừa được đặt lại) và bật xác thực 2 lớp
   * (tài khoản đặc quyền ở production, tài khoản quản trị gốc). Máy chủ chặn mọi chức năng khác cho tới khi xong (SETUP_REQUIRED).
   */
  import { m } from '$lib/paraglide/messages';
  import { goto } from '$app/navigation';
  import { onMount } from 'svelte';
  import { KeyRound, LogOut, ShieldCheck } from 'lucide-svelte';
  import { api } from '$lib/api';
  import LocaleSwitcher from '$lib/components/LocaleSwitcher.svelte';
  import MfaEnroll from '$lib/components/MfaEnroll.svelte';
  import PasswordChange from '$lib/components/PasswordChange.svelte';

  type Me = { email: string; displayName: string; pending?: Array<'PASSWORD' | 'MFA'> };
  let me = $state<Me | null>(null);
  const step = $derived(me?.pending?.[0]);

  async function refresh() {
    try {
      me = await api<Me>('/auth/me');
      if (!me.pending?.length) await goto('/');
    } catch {
      await goto('/login');
    }
  }
  onMount(refresh);

  async function logout() {
    await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
    await goto('/login');
  }
</script>

<svelte:head><title>{m.setup_title()} · INOXPRAN ERP</title></svelte:head>

<main class="setup">
  <section class="card">
    <header>
      <img src="/brand/inoxpran-logo.png" alt="INOXPRAN" />
      <LocaleSwitcher tone="light" />
    </header>
    <h1>{m.setup_title()}</h1>
    {#if me}
      <p class="muted">{m.setup_lead({ name: me.displayName, email: me.email })}</p>
      <ol class="progress">
        {#each me.pending ?? [] as item, index}
          <li class:current={index === 0}>{#if item === 'PASSWORD'}<KeyRound size={15} />{m.setup_step_password()}{:else}<ShieldCheck size={15} />{m.setup_step_mfa()}{/if}</li>
        {/each}
      </ol>
      {#if step === 'PASSWORD'}
        <h2>{m.setup_step_password()}</h2>
        <p class="muted">{m.setup_password_hint()}</p>
        <PasswordChange temporary ondone={refresh} />
      {:else if step === 'MFA'}
        <h2>{m.setup_step_mfa()}</h2>
        <p class="muted">{m.setup_mfa_hint()}</p>
        <MfaEnroll ondone={refresh} />
      {/if}
    {/if}
    <footer><button class="link-btn" onclick={logout}><LogOut size={15} />{m.dang_xuat()}</button></footer>
  </section>
</main>

<style>
  .setup { display: grid; min-height: 100vh; place-items: center; padding: 32px 16px; background: var(--bg); }
  .card { display: grid; gap: 14px; width: min(640px, 100%); padding: 32px 36px; border: 1px solid var(--line); border-radius: 16px; background: var(--surface); }
  header { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  header img { height: 36px; width: auto; border-radius: 4px; }
  h1 { margin: 6px 0 0; font-size: 22px; }
  h2 { margin: 8px 0 0; font-size: 16px; }
  p { margin: 0; }
  .progress { display: flex; flex-wrap: wrap; gap: 8px; margin: 0; padding: 0; list-style: none; }
  .progress li { display: inline-flex; align-items: center; gap: 6px; padding: 5px 12px; border: 1px solid var(--line); border-radius: 999px; color: var(--muted); font-size: 13px; }
  .progress li.current { border-color: var(--navy); background: var(--navy); color: #fff; }
  footer { display: flex; justify-content: flex-end; padding-top: 8px; border-top: 1px solid var(--line-soft); }
  .link-btn { display: inline-flex; align-items: center; gap: 6px; color: var(--muted); font-size: 13px; }
  @media (max-width: 520px) { .card { padding: 24px 18px; } }
</style>
