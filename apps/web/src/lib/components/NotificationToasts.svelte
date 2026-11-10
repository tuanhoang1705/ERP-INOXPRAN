<script lang="ts">
  /**
   * Thông báo hiện ngay (NOTI-RT-01, 09/11/2026 — người dùng: "thông báo hiển thị realtime như thông báo facebook"): thông báo mới
   * nổi lên góc dưới bên phải, bấm vào → đánh dấu đã đọc và mở đúng phiếu cần xử lý; tự ẩn sau ~15 giây (trừ thông báo khẩn,
   * hoặc đang rê chuột). Lần đầu kèm thẻ chỉ dẫn cách dùng (nhớ theo trình duyệt).
   */
  import type { AppNotification } from '@inoxpran/contracts';
  import { onDestroy } from 'svelte';
  import { Bell, BellRing, X } from 'lucide-svelte';
  import { m } from '$lib/paraglide/messages';
  import { notificationText } from '$lib/server-text';

  let { toasts, onopen, ondismiss }: {
    toasts: AppNotification[];
    onopen: (notification: AppNotification) => void;
    ondismiss: (id: string) => void;
  } = $props();

  const GUIDE_KEY = 'inoxpran.notify-guide.v1';
  let guideSeen = $state(readGuide());
  let hovered = $state<string | null>(null);
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  function readGuide(): boolean {
    try { return localStorage.getItem(GUIDE_KEY) === '1'; } catch { return false; }
  }
  function closeGuide() {
    guideSeen = true;
    try { localStorage.setItem(GUIDE_KEY, '1'); } catch { /* trình duyệt chặn lưu → lần sau hiện lại, không sao */ }
  }

  function schedule(id: string, level: string | undefined) {
    if (level === 'CRITICAL' || timers.has(id)) return;
    timers.set(id, setTimeout(() => {
      timers.delete(id);
      if (hovered === id) schedule(id, level);
      else ondismiss(id);
    }, 15_000));
  }
  $effect(() => {
    for (const toast of toasts) schedule(toast.id, toast.level);
    for (const id of [...timers.keys()]) if (!toasts.some((toast) => toast.id === id)) { clearTimeout(timers.get(id)); timers.delete(id); }
  });
  onDestroy(() => { for (const timer of timers.values()) clearTimeout(timer); });

  const time = (iso: string) => new Intl.DateTimeFormat('vi-VN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date(iso));
</script>

{#if toasts.length}
  <div class="toasts" role="region" aria-label={m.tb_rt_vung()} aria-live="polite">
    {#if !guideSeen}
      <aside class="guide" role="note">
        <BellRing size={18} />
        <div>
          <b>{m.tb_rt_huong_dan_tieu_de()}</b>
          <p>{m.tb_rt_huong_dan()}</p>
        </div>
        <button class="btn small" onclick={closeGuide}>{m.tb_rt_da_hieu()}</button>
      </aside>
    {/if}
    {#each toasts as toast (toast.id)}
      {@const text = notificationText(toast)}
      <article class="toast" class:critical={toast.level === 'CRITICAL'} class:warning={toast.level === 'WARNING'}
        onmouseenter={() => (hovered = toast.id)} onmouseleave={() => (hovered = null)}>
        <button class="body" onclick={() => onopen(toast)} title={m.tb_rt_bam_mo()}>
          <span class="icon" aria-hidden="true"><Bell size={16} /></span>
          <span class="text">
            <b>{text.title}</b>
            {#if text.message}<span class="message">{text.message}</span>{/if}
            <small>{time(toast.createdAt)} · {toast.href ? m.tb_rt_bam_mo() : m.tb_rt_bam_doc()}</small>
          </span>
        </button>
        <button class="close" onclick={() => ondismiss(toast.id)} aria-label={m.dong()} title={m.tb_rt_an()}><X size={15} /></button>
      </article>
    {/each}
  </div>
{/if}

<style>
  .toasts { position: fixed; right: 18px; bottom: 18px; z-index: 60; display: flex; flex-direction: column; align-items: stretch; gap: 10px; width: min(380px, calc(100vw - 32px)); pointer-events: none; }
  .toasts > * { pointer-events: auto; }
  .guide { display: grid; grid-template-columns: auto 1fr; gap: 6px 10px; align-items: start; padding: 12px 14px; border: 1px solid var(--orange); border-radius: var(--radius); background: var(--surface); box-shadow: 0 10px 28px #0f172a2e; color: var(--text); font-size: 13px; }
  .guide :global(svg) { color: var(--orange); margin-top: 2px; }
  .guide b { display: block; margin-bottom: 2px; }
  .guide p { margin: 0; color: var(--muted); line-height: 1.45; }
  .guide .btn { grid-column: 2; justify-self: end; }
  .toast { position: relative; display: flex; border: 1px solid var(--line); border-left: 4px solid var(--orange); border-radius: var(--radius); background: var(--surface); box-shadow: 0 10px 28px #0f172a2e; animation: rise .25s ease-out; }
  .toast.warning { border-left-color: var(--amber); }
  .toast.critical { border-left-color: var(--red); }
  .body { display: flex; flex: 1; gap: 10px; align-items: flex-start; min-width: 0; padding: 12px 34px 12px 12px; border: 0; background: none; color: var(--text); font: inherit; text-align: left; cursor: pointer; }
  .body:hover b { text-decoration: underline; }
  .icon { display: grid; place-items: center; flex: none; width: 30px; height: 30px; border-radius: 50%; background: var(--orange-soft); color: var(--orange); }
  .text { display: flex; flex-direction: column; gap: 2px; min-width: 0; font-size: 13px; }
  .text b { font-size: 13.5px; line-height: 1.35; overflow-wrap: anywhere; }
  .message { color: var(--muted); line-height: 1.4; display: -webkit-box; -webkit-line-clamp: 3; line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
  .text small { margin-top: 2px; color: var(--orange); font-weight: 600; }
  .close { position: absolute; top: 6px; right: 6px; display: grid; place-items: center; width: 26px; height: 26px; border: 0; border-radius: 50%; background: none; color: var(--muted); cursor: pointer; }
  .close:hover { background: var(--surface-2); color: var(--text); }
  @keyframes rise { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: none; } }
  @media (max-width: 600px) { .toasts { right: 16px; left: 16px; bottom: 12px; width: auto; } }
  @media print { .toasts { display: none; } }
</style>
