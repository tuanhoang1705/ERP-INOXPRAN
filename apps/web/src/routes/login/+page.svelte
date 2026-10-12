<script lang="ts">
  import { m } from '$lib/paraglide/messages';
  import LocaleSwitcher from '$lib/components/LocaleSwitcher.svelte';
  import { goto } from '$app/navigation';
  import { onMount } from 'svelte';
  import { Check, CircleAlert, Info } from 'lucide-svelte';
  import { api, ApiRequestError } from '$lib/api';
  import type { Workspace } from '@inoxpran/contracts';
  import { saveWorkspace, workspaceId } from '$lib/session.svelte';

  const REMEMBER_KEY = 'erp.rememberEmail';
  let email = $state('');
  let password = $state('');
  let totpCode = $state('');
  let remember = $state(true);
  let showPassword = $state(false);
  let submitting = $state(false);
  let requiresMfa = $state(false);
  let showForgot = $state(false);
  let error = $state('');
  let workspaces = $state<Workspace[]>([]);
  let workspace = $state('');

  onMount(async () => {
    try {
      const saved = localStorage.getItem(REMEMBER_KEY);
      if (saved) email = saved;
    } catch {
      // Bỏ qua khi trình duyệt chặn lưu trữ.
    }
    if (new URL(window.location.href).searchParams.get('revoked')) error = m.login_revoked();
    workspaces = await api<Workspace[]>('/auth/workspaces').catch(() => []);
    const previous = workspaceId();
    workspace = workspaces.find((item) => item.id === previous)?.id ?? workspaces[0]?.id ?? '';
  });

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    error = '';
    submitting = true;
    try {
      const result = await api<{ user: { pending?: string[] } }>('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password, ...(totpCode ? { totpCode } : {}) }),
      });
      try {
        if (remember) localStorage.setItem(REMEMBER_KEY, email.trim().toLowerCase());
        else localStorage.removeItem(REMEMBER_KEY);
      } catch {
        // Không lưu được cũng không ảnh hưởng đăng nhập.
      }
      const selected = workspaces.find((item) => item.id === workspace);
      if (selected) saveWorkspace(selected);
      // Mật khẩu tạm / chưa bật MFA (bắt buộc) → hoàn tất thiết lập trước khi vào hệ thống.
      await goto(result.user.pending?.length ? '/setup' : '/');
    } catch (caught) {
      if (caught instanceof ApiRequestError && caught.payload.code === 'MFA_REQUIRED') {
        requiresMfa = true;
        error = m.tai_khoan_da_bat_xac_thuc();
      } else if (caught instanceof ApiRequestError && caught.payload.code === 'INVALID_CREDENTIALS') {
        error = m.sai_ten_dang_nhap_hoac_mat();
      } else {
        error = caught instanceof Error ? caught.message : m.khong_the_dang_nhap();
      }
    } finally {
      submitting = false;
    }
  }
</script>

<svelte:head><title>{m.dang_nhap_inoxpran_erp()}</title></svelte:head>

<main class="login">
  <section class="brand-panel" aria-label={m.gioi_thieu_he_thong()}>
    <div class="logo">
      <img src="/brand/inoxpran-logo.png" alt="INOXPRAN" width="185" height="48" />
      <small>{m.phan_phoi_do_gia_dung()}</small>
    </div>
    <div class="headline">
      <h1>{m.he_thong_thong_tin()}<br />{m.quan_ly_ban_hang()}<br /><em>{m.phan_phoi_do_gia_dung_2()}</em></h1>
      <p>{m.cong_ty_tnhh_dau_tu_thang()}</p>
    </div>
    <ul class="features">
      <li><span><Check size={18} strokeWidth={3} /></span><div><b>{m.quan_ly_don_hang_b2b_b2c()}</b><small>{m.mot_luong_duyet_don_duy_nhat()}</small></div></li>
      <li><span><Check size={18} strokeWidth={3} /></span><div><b>{m.kiem_soat_ton_kho_theo_thoi()}</b><small>{m.giu_ton_khi_duyet_don_canh()}</small></div></li>
      <li><span><Check size={18} strokeWidth={3} /></span><div><b>{m.canh_bao_cong_no_chiet_khau()}</b><small>{m.tinh_chiet_khau_theo_bac_doanh()}</small></div></li>
    </ul>
  </section>

  <section class="form-panel">
    <div class="form-card">
      <div class="locale-row"><LocaleSwitcher tone="light" /></div>
      <h2>{m.dang_nhap_he_thong()}</h2>
      <p class="lead">{m.vui_long_dang_nhap_bang_tai()}</p>
      <form onsubmit={submit} novalidate={false}>
        <div class="field">
          <label for="email">{m.ten_dang_nhap_email()} <span class="req">*</span></label>
          <input id="email" type="email" bind:value={email} autocomplete="username" placeholder="ten@inoxpran.vn" required />
        </div>
        <div class="field">
          <div class="label-row"><label for="password">{m.mat_khau()} <span class="req">*</span></label><button type="button" class="toggle" onclick={() => (showPassword = !showPassword)}>{showPassword ? m.an() : m.hien()}</button></div>
          <input id="password" type={showPassword ? 'text' : 'password'} bind:value={password} autocomplete="current-password" minlength="10" required />
        </div>
        {#if requiresMfa}
          <div class="field">
            <label for="totp">{m.ma_xac_thuc_2_lop()} <span class="req">*</span></label>
            <input id="totp" class="otp" inputmode="numeric" pattern={'[0-9]{6}'} maxlength="6" bind:value={totpCode} autocomplete="one-time-code" placeholder="000000" required />
          </div>
        {/if}
        <div class="row">
          <label class="check"><input type="checkbox" bind:checked={remember} />{m.ghi_nho_dang_nhap_tren_thiet()}</label>
          <button type="button" class="forgot" onclick={() => (showForgot = !showForgot)}>{m.quen_mat_khau()}</button>
        </div>
        {#if showForgot}
          <div class="banner"><Info size={17} /><span>{m.lien_he_quan_tri_vien_he()}</span></div>
        {/if}
        <div class="field">
          <label for="workspace">{m.chi_nhanh_kho_lam_viec()}</label>
          <select id="workspace" bind:value={workspace}>
            {#if workspaces.some((item) => item.kind === 'OFFICE')}
              <optgroup label={m.van_phong()}>{#each workspaces.filter((item) => item.kind === 'OFFICE') as item}<option value={item.id}>{item.name}</option>{/each}</optgroup>
            {/if}
            {#if workspaces.some((item) => item.kind === 'WAREHOUSE')}
              <optgroup label={m.kho_hang()}>{#each workspaces.filter((item) => item.kind === 'WAREHOUSE') as item}<option value={item.id}>{item.name} — {item.code}</option>{/each}</optgroup>
            {/if}
            {#if !workspaces.length}<option value="">{m.dang_tai_danh_sach_noi_lam()}</option>{/if}
          </select>
        </div>
        <button class="submit" type="submit" disabled={submitting}>{submitting ? m.dang_xac_thuc_2() : m.dang_nhap()}</button>
        {#if error}<div class="banner error" role="alert"><CircleAlert size={17} /><span>{error}</span></div>{/if}
      </form>
    </div>
    <p class="foot">{m.chua_co_tai_khoan_lien_he()}<br />{m.t_2026_cong_ty_tnhh_dau_tu()}</p>
  </section>
</main>

<style>
  .login { display: grid; grid-template-columns: minmax(420px, 43fr) minmax(460px, 57fr); min-height: 100vh; background: var(--bg); }
  .brand-panel { position: relative; display: flex; flex-direction: column; overflow: hidden; padding: 78px 72px 64px; background: var(--navy); color: #fff; }
  .brand-panel::before { content: ''; position: absolute; left: -180px; top: 320px; width: 600px; height: 600px; border-radius: 50%; background: #1b5480; opacity: 0.85; }
  .brand-panel::after { content: ''; position: absolute; right: -130px; top: -30px; width: 420px; height: 420px; border-radius: 50%; background: rgba(255, 255, 255, 0.05); }
  .brand-panel > * { position: relative; z-index: 1; }
  .logo { display: grid; justify-items: start; gap: 10px; }
  .logo img { display: block; height: 48px; width: auto; border-radius: 5px; }
  .logo small { color: rgba(255, 255, 255, 0.72); font-size: 12px; }
  .headline { margin-top: auto; }
  h1 { margin: 0; font-size: clamp(30px, 3vw, 40px); font-weight: 700; line-height: 1.32; letter-spacing: -0.01em; }
  h1 em { color: var(--orange); font-style: normal; }
  .headline p { margin: 18px 0 0; color: rgba(255, 255, 255, 0.82); font-size: 15px; }
  .features { display: grid; gap: 26px; margin: 76px 0 0; padding: 0; list-style: none; }
  .features li { display: flex; gap: 16px; }
  .features span { display: grid; flex: none; width: 34px; height: 34px; place-items: center; border-radius: 9px; background: rgba(255, 255, 255, 0.12); color: var(--orange); }
  .features div { display: grid; gap: 3px; }
  .features b { font-size: 14.5px; }
  .features small { color: rgba(255, 255, 255, 0.68); font-size: 12.5px; }
  .form-panel { display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 40px 24px; }
  .form-card { width: min(560px, 100%); padding: 46px 40px 34px; border: 1px solid var(--line); border-radius: 16px; background: var(--surface); }
  h2 { margin: 0; font-size: 28px; font-weight: 600; }
  .lead { margin: 8px 0 26px; color: var(--muted); }
  form { display: grid; gap: 18px; }
  .locale-row { display: flex; justify-content: flex-end; margin-bottom: 8px; }
  .label-row { display: flex; justify-content: space-between; align-items: baseline; }
  .label-row label { font-size: 13px; font-weight: 500; }
  .toggle, .forgot { color: var(--navy); font-size: 13px; font-weight: 700; }
  .otp { max-width: 200px; font-size: 20px; letter-spacing: 0.3em; text-align: center; }
  .row { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: -2px 0; }
  .check { display: flex; align-items: center; gap: 9px; color: var(--muted); font-size: 13.5px; }
  .check input { width: 17px; height: 17px; accent-color: var(--navy); }
  .submit { min-height: 50px; border-radius: 8px; background: var(--navy); color: #fff; font-size: 15px; font-weight: 700; letter-spacing: 0.02em; }
  .submit:hover { background: #0e3150; }
  .submit:disabled { opacity: 0.7; cursor: wait; }
  .banner { margin: 0; }
  .foot { margin: 26px 0 0; color: var(--subtle); font-size: 12.5px; line-height: 1.9; text-align: center; }
  @media (max-width: 960px) {
    .login { grid-template-columns: 1fr; }
    .brand-panel { padding: 30px 24px 34px; }
    .headline { margin-top: 40px; }
    h1 { font-size: 28px; }
    .features { display: none; }
    .form-card { padding: 30px 22px; }
  }
</style>
