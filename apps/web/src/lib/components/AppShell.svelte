<script lang="ts">
  import type { AppNotification } from '@inoxpran/contracts';
  import { m } from '$lib/paraglide/messages';
  import LocaleSwitcher from './LocaleSwitcher.svelte';
  import WorkspaceTabs from './record/WorkspaceTabs.svelte';
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { onMount, type Snippet } from 'svelte';
  import { Bell, ChevronDown, LogOut, Menu, UserCog, WifiOff, X } from 'lucide-svelte';
  import { api } from '$lib/api';
  import { initials, vnToday } from '$lib/format';
  import { roleLabel } from '$lib/labels';
  import { notificationText } from '$lib/server-text';
  import { activeSection, allowed, sections, type NavItem } from '$lib/nav';
  import CommandPalette from '$lib/components/CommandPalette.svelte';
  import { can, session, savedWorkspace, type SessionUser } from '$lib/session.svelte';


  let { children }: { children: Snippet } = $props();
  let drawerOpen = $state(false);
  let online = $state(true);
  let pendingApprovals = $state(0);
  let pendingChanges = $state(0);
  let notificationsOpen = $state(false);
  let userMenuOpen = $state(false);
  let notifications = $state<AppNotification[]>([]);
  let clearAsk = $state(false);
  let clearing = $state(false);
  let warehouseName = $state('');

  const user = $derived(session.user);
  const current = $derived(activeSection(page.url.pathname));
  const visibleSections = $derived(sections.filter((section) => allowed(user?.roles, section.roles)));
  const today = vnToday();

  onMount(() => {
    online = navigator.onLine;
    const handleOnline = () => (online = true);
    const handleOffline = () => (online = false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    api<SessionUser>('/auth/me')
      .then(async (value) => {
        if (value.pending?.length) {
          await goto('/setup');
          return;
        }
        session.user = value;
        const [approvals, unread, warehouses, changes] = await Promise.all([
          allowed(value.roles, ['SALES_MANAGER', 'PROCUREMENT_MANAGER', 'DIRECTOR'])
            ? api<unknown[]>('/approval-requests?status=PENDING').catch(() => [])
            : Promise.resolve([]),
          api<AppNotification[]>('/notifications?unreadOnly=true').catch(() => []),
          api<Array<{ id: string; name: string }>>('/warehouses').catch(() => []),
          can('sales.change_approve') || can('sales.change_request')
            ? api<{ pending: number }>('/sales-change-requests/count').catch(() => ({ pending: 0 }))
            : Promise.resolve({ pending: 0 }),
        ]);
        pendingApprovals = approvals.length;
        pendingChanges = changes.pending;
        notifications = unread;
        warehouseName = savedWorkspace()?.name ?? warehouses[0]?.name ?? '';
      })
      .catch(() => goto('/login'));
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  });

  /** Mục con khớp nhất với URL hiện tại (đường dẫn + tham số truy vấn). */
  function activeHref(items: NavItem[]): string | null {
    let best: string | null = null;
    let bestScore = 0;
    for (const item of items) {
      const target = new URL(item.href, 'http://local');
      const params = [...target.searchParams.entries()];
      let score = -1;
      if (target.pathname === page.url.pathname) {
        score = params.every(([key, value]) => page.url.searchParams.get(key) === value) ? 1 + params.length : -1;
      } else if (target.pathname !== '/' && page.url.pathname.startsWith(`${target.pathname}/`) && params.length === 0) {
        score = 0.5;
      }
      if (score > bestScore) {
        bestScore = score;
        best = item.href;
      }
    }
    return best;
  }
  const sideItems = $derived(current.groups.flatMap((group) => group.items));
  const selectedHref = $derived(activeHref(sideItems));

  async function logout() {
    await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
    session.user = null;
    await goto('/login');
  }

  /** Mở chuông: tải lại thông báo chưa đọc (trước đây chỉ tải một lần khi vào trang). */
  function toggleNotifications() {
    notificationsOpen = !notificationsOpen;
    clearAsk = false;
    if (notificationsOpen) void api<AppNotification[]>('/notifications?unreadOnly=true').then((rows) => (notifications = rows)).catch(() => undefined);
  }

  /** Xóa tất cả thông báo của mình (NOTI-02): bấm "Xóa tất cả" rồi xác nhận ngay trong khung. */
  async function clearNotifications() {
    clearing = true;
    try {
      await api('/notifications', { method: 'DELETE' });
      notifications = [];
      clearAsk = false;
    } catch {
      // Giữ nguyên danh sách khi lỗi mạng; người dùng bấm lại được.
    } finally {
      clearing = false;
    }
  }

  async function openNotification(notification: AppNotification) {
    await api(`/notifications/${notification.id}/read`, { method: 'POST' }).catch(() => undefined);
    notifications = notifications.filter((item) => item.id !== notification.id);
    notificationsOpen = false;
    if (notification.href) await goto(notification.href);
  }

  function closeMenus(event: MouseEvent) {
    // Xét đường đi lúc bấm (composedPath): nút vừa bấm có thể đã bị thay (VD "Xóa tất cả" → nút xác nhận) nên không còn trong DOM.
    const path = event.composedPath();
    const inside = (selector: string) => path.some((node) => node instanceof Element && node.matches(selector));
    if (!inside('.notify-wrap')) notificationsOpen = false;
    if (!inside('.user-wrap')) userMenuOpen = false;
  }
</script>

<svelte:window onclick={closeMenus} />

<div class="shell">
  <header class="topbar no-print">
    <button class="hamburger" onclick={() => (drawerOpen = true)} aria-label={m.mo_menu()}><Menu size={22} /></button>
    <a class="brand" href="/" aria-label={m.inoxpran_erp_tong_quan()}>
      <img class="logo" src="/brand/inoxpran-logo.png" alt="INOXPRAN" width="139" height="36" />
    </a>
    <nav class="tabs" aria-label={m.phan_he()}>
      {#each visibleSections as section}
        <a href={section.href} class:active={section.key === current.key} aria-current={section.key === current.key ? 'page' : undefined}>{section.label}</a>
      {/each}
    </nav>
    <div class="right">
      <CommandPalette />
      <LocaleSwitcher />
      {#if !online}<span class="offline"><WifiOff size={15} />{m.mat_ket_noi()}</span>{/if}
      <div class="notify-wrap">
        <button class="bell" onclick={toggleNotifications} aria-expanded={notificationsOpen} aria-label={m.thong_bao({ p0: notifications.length ? m.chua_doc({ length: notifications.length }) : '' })}>
          <Bell size={18} />{#if notifications.length}<em>{notifications.length > 9 ? '9+' : notifications.length}</em>{/if}
        </button>
        {#if notificationsOpen}
          <section class="tray card" aria-label={m.thong_bao_chua_doc()}>
            <header><b>{m.thong_bao_2()}</b><small>{notifications.length} {m.chua_doc_2()}</small></header>
            {#if notifications.length}
              <div class="tray-list">
                {#each notifications as notification}
                  {@const text = notificationText(notification)}
                  <button class:critical={notification.level === 'CRITICAL'} onclick={() => openNotification(notification)}>
                    <i></i><span><b>{text.title}</b><small>{text.message}</small></span>
                  </button>
                {/each}
              </div>
            {:else}<p>{m.khong_co_thong_bao_moi()}</p>{/if}
            <footer>
              {#if clearAsk}
                <span>{m.tb_xoa_hoi({ count: notifications.length })}</span>
                <button class="link" onclick={() => (clearAsk = false)}>{m.huy()}</button>
                <button class="danger" disabled={clearing} onclick={clearNotifications}>{m.tb_xoa()}</button>
              {:else}
                <button class="danger" disabled={!notifications.length} onclick={() => (clearAsk = true)}>{m.tb_xoa_tat_ca()}</button>
              {/if}
            </footer>
          </section>
        {/if}
      </div>
      <div class="user-wrap">
        <button class="user" onclick={() => (userMenuOpen = !userMenuOpen)} aria-expanded={userMenuOpen}>
          <span class="avatar">{initials(user?.displayName)}</span>
          <span class="who"><b>{user?.displayName ?? m.dang_xac_thuc()}</b><small>{user ? (user.root ? m.adm_root() : roleLabel[user.roles[0] ?? ''] ?? user.roles[0]) : ''}</small></span>
          <ChevronDown size={15} />
        </button>
        {#if userMenuOpen}
          <div class="user-menu card">
            <p><b>{user?.displayName}</b><small>{user?.email}</small></p>
            <a class="account" href="/account" onclick={() => (userMenuOpen = false)}><UserCog size={16} />{m.acc_title()}</a>
            <button onclick={logout}><LogOut size={16} />{m.dang_xuat()}</button>
          </div>
        {/if}
      </div>
    </div>
  </header>

  <div class="body">
    {#if drawerOpen}<button class="scrim" aria-label={m.dong_menu()} onclick={() => (drawerOpen = false)}></button>{/if}
    <aside class="sidebar no-print" class:open={drawerOpen} aria-label={m.chuc_nang()}>
      <div class="drawer-head">
        <b>{m.menu()}</b>
        <button onclick={() => (drawerOpen = false)} aria-label={m.dong_menu()}><X size={20} /></button>
      </div>
      <nav class="mobile-sections" aria-label={m.phan_he()}>
        {#each visibleSections as section}
          <a href={section.href} class:active={section.key === current.key} onclick={() => (drawerOpen = false)}>{section.label}</a>
        {/each}
      </nav>
      {#each current.groups as group}
        {@const items = group.items.filter((item) => (!item.rootOnly || user?.root) && allowed(user?.roles, item.roles) && (!item.permissions || item.permissions.some((key) => can(key))))}
        {#if items.length}
          <p class="group-title">{group.title}</p>
          <nav class="side-nav">
            {#each items as item}
              <a href={item.href} class:active={item.href === selectedHref} aria-current={item.href === selectedHref ? 'page' : undefined} onclick={() => (drawerOpen = false)}>
                <i aria-hidden="true"></i><span>{item.label}</span>
                {#if item.badge === 'approvals' && pendingApprovals > 0}<em>{pendingApprovals}</em>{/if}
                {#if item.badge === 'changes' && pendingChanges > 0}<em>{pendingChanges}</em>{/if}
              </a>
            {/each}
          </nav>
        {/if}
      {/each}
      <div class="period">
        <span>{m.ky_bao_cao_hien_tai()}</span>
        <b>{m.thang()} {String(today.month).padStart(2, '0')}/{today.year}</b>
        {#if warehouseName}<small>{m.noi_lam_viec()} {warehouseName}</small>{/if}
      </div>
    </aside>

    <main id="main">
      {#if user}<WorkspaceTabs />{@render children()}{:else}<div class="auth-loading">{m.dang_xac_thuc_phien_lam_viec()}</div>{/if}
    </main>
  </div>
</div>

<style>
  .shell { min-height: 100vh; }
  .topbar { position: sticky; top: 0; z-index: 40; display: flex; align-items: center; gap: 22px; height: var(--topbar); padding: 0 20px; background: var(--navy); color: #fff; }
  .brand { display: flex; align-items: center; gap: 11px; flex: none; }
  .logo { display: block; height: 36px; width: auto; border-radius: 4px; }
  .tabs { display: flex; align-items: center; gap: 4px; min-width: 0; overflow-x: auto; scrollbar-width: none; }
  .tabs a { position: relative; padding: 8px 16px; border-radius: 8px; color: rgba(255, 255, 255, 0.86); font-size: 15px; white-space: nowrap; }
  .tabs a:hover { background: rgba(255, 255, 255, 0.08); color: #fff; }
  .tabs a.active { background: rgba(255, 255, 255, 0.13); color: #fff; font-weight: 700; }
  .tabs a.active::after { content: ''; position: absolute; left: 16px; right: 16px; bottom: 2px; height: 3px; border-radius: 2px; background: var(--orange); }
  .right { display: flex; align-items: center; gap: 14px; margin-left: auto; }
  /* Giám đốc / quản trị thấy đủ 8 phân hệ: thu gọn tab để không bị cắt ở màn hình 1366–1600 px. */
  @media (max-width: 1600px) {
    .topbar { gap: 14px; }
    .tabs a { padding: 8px 8px; font-size: 14px; }
    .tabs a.active::after { left: 8px; right: 8px; }
    .right { gap: 8px; }
  }
  .offline { display: inline-flex; align-items: center; gap: 6px; color: #ffb4a8; font-size: 12.5px; font-weight: 600; }
  .notify-wrap, .user-wrap { position: relative; }
  .bell { position: relative; display: grid; width: 36px; height: 36px; place-items: center; border-radius: 9px; background: rgba(255, 255, 255, 0.12); color: #fff; }
  .bell em { position: absolute; top: -5px; right: -5px; min-width: 18px; height: 18px; padding: 0 4px; border: 2px solid var(--navy); border-radius: 999px; background: var(--orange); color: #fff; font-size: 10px; font-style: normal; font-weight: 700; line-height: 14px; text-align: center; }
  .tray { position: absolute; top: 46px; right: 0; width: min(380px, calc(100vw - 24px)); overflow: hidden; color: var(--text); }
  .tray header { display: flex; align-items: baseline; justify-content: space-between; padding: 13px 16px; border-bottom: 1px solid var(--line); }
  .tray header small { color: var(--muted); font-size: 12px; }
  .tray-list { max-height: 360px; overflow: auto; }
  .tray-list button { display: grid; grid-template-columns: 8px 1fr; gap: 10px; width: 100%; padding: 12px 16px; border-bottom: 1px solid var(--line-soft); text-align: left; }
  .tray-list button:hover { background: var(--surface-2); }
  .tray-list i { width: 8px; height: 8px; margin-top: 5px; border-radius: 50%; background: var(--amber); }
  .tray-list .critical i { background: var(--red); }
  .tray-list span { display: grid; gap: 3px; }
  .tray-list b { font-size: 13px; }
  .tray-list small { color: var(--muted); font-size: 12px; line-height: 1.4; }
  .tray p { margin: 0; padding: 26px 16px; color: var(--muted); text-align: center; }
  .tray footer { display: flex; align-items: center; justify-content: flex-end; gap: 10px; padding: 10px 16px; border-top: 1px solid var(--line); background: var(--surface-2); font-size: 12.5px; }
  .tray footer span { margin-right: auto; color: var(--text); }
  .tray footer button { padding: 5px 10px; border-radius: 6px; font-weight: 600; }
  .tray footer .danger { color: var(--red); }
  .tray footer .danger:hover:not(:disabled) { background: #fdecec; }
  .tray footer .link { color: var(--muted); }
  .tray footer button:disabled { opacity: 0.45; cursor: default; }
  .user { display: flex; align-items: center; gap: 10px; color: #fff; text-align: left; }
  .avatar { display: grid; width: 34px; height: 34px; place-items: center; border-radius: 50%; background: var(--orange); font-size: 12.5px; font-weight: 700; }
  .who { display: grid; }
  .who b { max-width: 170px; overflow: hidden; font-size: 13.5px; text-overflow: ellipsis; white-space: nowrap; }
  .who small { color: rgba(255, 255, 255, 0.72); font-size: 11.5px; }
  .user-menu { position: absolute; top: 46px; right: 0; width: 240px; padding: 6px; color: var(--text); }
  .user-menu p { display: grid; gap: 2px; margin: 0; padding: 10px 10px 12px; border-bottom: 1px solid var(--line-soft); }
  .user-menu small { color: var(--muted); font-size: 12px; }
  .user-menu button { display: flex; align-items: center; gap: 8px; width: 100%; margin-top: 6px; padding: 9px 10px; border-radius: 6px; color: var(--red); font-weight: 600; }
  .user-menu button:hover { background: var(--red-soft); }
  .user-menu .account { display: flex; align-items: center; gap: 8px; margin-top: 6px; padding: 9px 10px; border-radius: 6px; color: var(--text); font-weight: 600; }
  .user-menu .account:hover { background: var(--surface-2); }
  .hamburger { display: none; color: #fff; }

  .body { display: grid; grid-template-columns: var(--sidebar) minmax(0, 1fr); min-height: calc(100vh - var(--topbar)); background: linear-gradient(to right, var(--surface) calc(var(--sidebar) - 1px), var(--line) calc(var(--sidebar) - 1px), var(--line) var(--sidebar), transparent var(--sidebar)); }
  .sidebar { position: sticky; top: var(--topbar); display: flex; flex-direction: column; height: calc(100vh - var(--topbar)); overflow-y: auto; padding: 14px 10px 16px; border-right: 1px solid var(--line); background: var(--surface); }
  .drawer-head, .mobile-sections { display: none; }
  .group-title { margin: 14px 12px 8px; color: var(--subtle); font-size: 11.5px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; }
  .group-title:first-of-type { margin-top: 6px; }
  .side-nav { display: grid; gap: 2px; padding-bottom: 10px; border-bottom: 1px solid var(--line-soft); }
  .side-nav a { position: relative; display: flex; align-items: center; gap: 12px; min-height: 40px; padding: 0 12px; border-radius: 8px; color: var(--muted); font-size: 13.5px; line-height: 1.3; }
  .side-nav a i { flex: none; width: 15px; height: 15px; border-radius: 4px; background: #e3e8ee; }
  .side-nav a:hover { background: var(--surface-2); color: var(--text); }
  .side-nav a.active { background: var(--blue-soft); color: var(--text); font-weight: 600; }
  .side-nav a.active i { background: var(--navy); }
  .side-nav a.active::before { content: ''; position: absolute; left: -10px; top: 8px; bottom: 8px; width: 4px; border-radius: 0 3px 3px 0; background: var(--navy); }
  .side-nav em { margin-left: auto; min-width: 22px; padding: 1px 7px; border-radius: 999px; background: var(--orange); color: #fff; font-size: 11px; font-style: normal; font-weight: 700; text-align: center; }
  .period { display: grid; gap: 2px; margin: auto 4px 0; padding: 13px 14px; border-radius: 10px; background: var(--orange-soft); }
  .period span { color: var(--orange); font-size: 12px; font-weight: 500; }
  .period b { font-size: 15.5px; }
  .period small { color: var(--muted); font-size: 11.5px; }
  main { min-width: 0; padding: 26px 28px 48px; }
  .auth-loading { padding: 60px; color: var(--muted); text-align: center; }
  .scrim { display: none; }

  @media (max-width: 1180px) {
    .tabs a { padding: 8px 11px; font-size: 14px; }
    .who { display: none; }
  }
  @media (max-width: 1000px) {
    .tabs { display: none; }
    .hamburger { display: grid; }
    .body { grid-template-columns: minmax(0, 1fr); background: none; }
    .sidebar { position: fixed; top: 0; left: 0; z-index: 60; width: min(300px, 86vw); height: 100vh; transform: translateX(-102%); transition: transform 0.2s ease; }
    .sidebar.open { transform: none; box-shadow: 20px 0 50px rgba(18, 59, 94, 0.2); }
    .drawer-head { display: flex; align-items: center; justify-content: space-between; padding: 6px 12px 12px; }
    .mobile-sections { display: grid; gap: 2px; padding-bottom: 10px; border-bottom: 1px solid var(--line); }
    .mobile-sections a { padding: 9px 12px; border-radius: 8px; color: var(--text); font-weight: 500; }
    .mobile-sections a.active { background: var(--navy); color: #fff; }
    .scrim { position: fixed; inset: 0; z-index: 55; display: block; background: rgba(18, 39, 59, 0.45); }
    main { padding: 20px 16px 40px; }
  }
  /* Điện thoại: thu gọn thanh trên để không tràn ngang (logo, tìm chức năng, ngôn ngữ, chuông, ảnh đại diện vừa 360–390px). */
  @media (max-width: 560px) {
    .brand { flex: 0 1 auto; min-width: 0; }
    .logo { max-width: 100%; height: auto; max-height: 24px; object-fit: contain; }
    .topbar { gap: 6px; padding: 0 10px; }
    .right { gap: 6px; }
    .user :global(svg) { display: none; }
  }
  @media print { .body { display: block; } main { padding: 0; } }
</style>
