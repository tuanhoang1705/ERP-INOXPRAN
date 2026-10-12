<script lang="ts">
  /**
   * Bật xác thực 2 lớp (TOTP): tạo mã thiết lập (POST /auth/mfa/start), quét QR bằng Google Authenticator / Microsoft
   * Authenticator (hoặc nhập mã thiết lập), rồi nhập mã 6 số để xác nhận (POST /auth/mfa/confirm).
   */
  import QRCode from 'qrcode';
  import { CircleAlert, CircleCheck, ShieldCheck } from 'lucide-svelte';
  import { m } from '$lib/paraglide/messages';
  import { api } from '$lib/api';

  let { ondone }: { ondone?: () => void } = $props();
  let secret = $state('');
  let qr = $state('');
  let code = $state('');
  let busy = $state(false);
  let error = $state('');
  let done = $state(false);

  async function start() {
    busy = true;
    error = '';
    try {
      const result = await api<{ secret: string; uri: string }>('/auth/mfa/start', { method: 'POST' });
      secret = result.secret;
      qr = await QRCode.toString(result.uri, { type: 'svg', margin: 1, width: 196, errorCorrectionLevel: 'M' });
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.acc_error();
    } finally {
      busy = false;
    }
  }

  async function confirm(event: SubmitEvent) {
    event.preventDefault();
    busy = true;
    error = '';
    try {
      await api('/auth/mfa/confirm', { method: 'POST', body: JSON.stringify({ code }) });
      done = true;
      ondone?.();
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.acc_error();
    } finally {
      busy = false;
    }
  }
</script>

<div class="mfa">
  {#if error}<div class="banner error"><CircleAlert size={17} /><span>{error}</span></div>{/if}
  {#if done}
    <div class="banner success"><CircleCheck size={17} /><span>{m.acc_mfa_enabled()}</span></div>
  {:else if !secret}
    <p class="muted">{m.acc_mfa_intro()}</p>
    <button class="btn primary" type="button" disabled={busy} onclick={start}><ShieldCheck size={16} />{m.acc_mfa_start()}</button>
  {:else}
    <ol class="steps">
      <li>{m.acc_mfa_step_app()}</li>
      <li>{m.acc_mfa_step_scan()}
        <div class="qr" aria-label="QR">{@html qr}</div>
        <small>{m.acc_mfa_manual()} <code>{secret.match(/.{1,4}/g)?.join(' ')}</code></small>
      </li>
      <li>{m.acc_mfa_step_code()}</li>
    </ol>
    <form class="confirm" onsubmit={confirm}>
      <input class="otp" inputmode="numeric" maxlength="6" pattern={'[0-9]{6}'} placeholder="000000" bind:value={code} autocomplete="one-time-code" aria-label={m.ma_xac_thuc_2_lop()} />
      <button class="btn primary" type="submit" disabled={busy || !/^\d{6}$/.test(code)}>{m.acc_mfa_confirm()}</button>
    </form>
  {/if}
</div>

<style>
  .mfa { display: grid; gap: 14px; max-width: 520px; }
  .mfa > .btn { justify-self: start; }
  .steps { display: grid; gap: 12px; margin: 0; padding-left: 20px; font-size: 14px; }
  .qr { width: 196px; margin: 10px 0 6px; padding: 6px; border: 1px solid var(--line); border-radius: 10px; background: #fff; }
  .qr :global(svg) { display: block; width: 100%; height: auto; }
  small { color: var(--muted); font-size: 12.5px; }
  code { padding: 2px 6px; border-radius: 4px; background: var(--surface-2); font-size: 13px; letter-spacing: 0.04em; }
  .confirm { display: flex; flex-wrap: wrap; gap: 10px; }
  .otp { max-width: 180px; min-height: 44px; padding: 0 12px; border: 1px solid var(--line); border-radius: 8px; font-size: 20px; letter-spacing: 0.3em; text-align: center; }
</style>
