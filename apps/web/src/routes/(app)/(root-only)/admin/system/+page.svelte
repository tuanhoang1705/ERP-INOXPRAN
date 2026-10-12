<script lang="ts">
  import { m } from '$lib/paraglide/messages';
  import type { SystemStatus } from '@inoxpran/contracts';
  import { onDestroy, onMount } from 'svelte';
  import { CircleAlert, RefreshCw } from 'lucide-svelte';
  import { api } from '$lib/api';
  import { dateTime, num } from '$lib/format';
  import { bytes, checkDetail, checkTitle, stateTone } from '$lib/admin';

  let status = $state<SystemStatus | null>(null);
  let error = $state('');
  let loading = $state(false);
  let timer: ReturnType<typeof setInterval> | undefined;

  const overall = $derived(status ? (status.checks.some((check) => check.state === 'error') ? 'error' : status.checks.some((check) => check.state === 'warning') ? 'warning' : 'ok') : 'unknown');
  const maxErrors = $derived(Math.max(1, ...(status?.errors5xx.map((row) => row.count) ?? [1])));
  const uptime = (seconds: number) => {
    const days = Math.floor(seconds / 86_400);
    const hours = Math.floor((seconds % 86_400) / 3_600);
    const minutes = Math.floor((seconds % 3_600) / 60);
    return days ? m.sys_uptime_days({ days, hours }) : m.sys_uptime_hours({ hours, minutes });
  };

  async function load() {
    loading = true;
    try {
      status = await api<SystemStatus>('/admin/system');
      error = '';
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.acc_error();
    } finally {
      loading = false;
    }
  }
  onMount(() => {
    void load();
    timer = setInterval(() => void load(), 30_000);
  });
  onDestroy(() => clearInterval(timer));
</script>

<svelte:head><title>{m.sys_title()} · INOXPRAN ERP</title></svelte:head>

<section class="page-head">
  <div>
    <nav class="crumbs" aria-label={m.duong_dan()}><a href="/admin/system">{m.adm_section()}</a><span>{m.sys_title()}</span></nav>
    <h1 class="page-title">{m.sys_title()}</h1>
    <p class="page-sub">{status ? m.sys_sub({ environment: status.environment, version: status.version, time: dateTime(status.generatedAt) }) : m.dang_tai()}</p>
  </div>
  <div class="actions"><button class="btn" onclick={load} disabled={loading}><RefreshCw size={15} />{m.sys_refresh()}</button></div>
</section>

{#if error}<div class="banner error"><CircleAlert size={17} />{error}</div>{/if}

{#if status}
  <section class={`card overall ${overall}`}>
    <b>{overall === 'ok' ? m.sys_overall_ok() : overall === 'warning' ? m.sys_overall_warning() : m.sys_overall_error()}</b>
    <span>{m.sys_uptime()}: {uptime(status.uptimeSeconds)}</span>
  </section>

  <section class="checks">
    {#each status.checks as check (check.key)}
      <article class={`card check ${check.state}`}>
        <header><span class={`dot ${check.state}`} aria-hidden="true"></span><h2>{checkTitle(check.key)}</h2><span class={`pill ${stateTone[check.state]}`}>{check.state === 'ok' ? m.sys_state_ok() : check.state === 'warning' ? m.sys_state_warning() : check.state === 'error' ? m.sys_state_error() : m.sys_state_unknown()}</span></header>
        <p>{checkDetail(check)}</p>
      </article>
    {/each}
  </section>

  <section class="split">
    <article class="card">
      <header class="card-head"><h2>{m.sys_database()}</h2></header>
      <dl class="facts">
        <div><dt>{m.sys_db_data()}</dt><dd>{bytes(status.database.dataSizeBytes)}</dd></div>
        <div><dt>{m.sys_db_storage()}</dt><dd>{bytes(status.database.storageSizeBytes)}</dd></div>
        <div><dt>{m.sys_db_collections()}</dt><dd>{num(status.database.collections)}</dd></div>
        <div><dt>{m.sys_db_objects()}</dt><dd>{num(status.database.objects)}</dd></div>
        <div><dt>{m.sys_backup()}</dt><dd>{status.lastBackup ? `${dateTime(status.lastBackup.at)} · ${status.lastBackup.status}${status.lastBackup.sizeBytes ? ` · ${bytes(status.lastBackup.sizeBytes)}` : ''}` : m.sys_backup_none()}</dd></div>
      </dl>
    </article>
    <article class="card">
      <header class="card-head"><h2>{m.sys_logins()}</h2></header>
      <dl class="facts">
        <div><dt>{m.sys_online_now()}</dt><dd>{status.logins.onlineNow}</dd></div>
        <div><dt>{m.sys_active_24h()}</dt><dd>{status.logins.activeUsers24h}</dd></div>
        <div><dt>{m.sys_failed_24h()}</dt><dd class:warn={status.logins.failed24h > 0}>{status.logins.failed24h}</dd></div>
        <div><dt>{m.sys_locked()}</dt><dd class:warn={status.logins.lockedAccounts > 0}>{status.logins.lockedAccounts}</dd></div>
        <div><dt>{m.sys_disabled()}</dt><dd>{status.logins.disabledAccounts}</dd></div>
      </dl>
      <p class="link-row"><a class="link" href="/admin/users">{m.nguoi_dung_phan_quyen()}</a> · <a class="link" href="/admin/audit">{m.aud_title()}</a></p>
    </article>
  </section>

  <section class="split">
    <article class="card">
      <header class="card-head"><h2>{m.sys_queue()}</h2></header>
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>{m.sys_queue_name()}</th><th class="num">{m.sys_waiting()}</th><th class="num">{m.sys_active()}</th><th class="num">{m.sys_delayed()}</th><th class="num">{m.sys_failed()}</th></tr></thead>
          <tbody>
            {#each status.queues as row}<tr><td class="code">{row.name}</td><td class="num">{row.waiting}</td><td class="num">{row.active}</td><td class="num">{row.delayed}</td><td class="num" class:warn={row.failed > 0}>{row.failed}</td></tr>{/each}
            <tr><td class="code">outbox</td><td class="num">{status.outbox.pending}</td><td class="num">—</td><td class="num">—</td><td class="num" class:warn={status.outbox.deadLetter > 0}>{status.outbox.deadLetter}</td></tr>
          </tbody>
        </table>
      </div>
    </article>
    <article class="card">
      <header class="card-head"><h2>{m.sys_errors_7d()}</h2></header>
      <ol class="bars" aria-label={m.sys_errors_7d()}>
        {#each status.errors5xx as row}
          <li title={`${row.day}: ${row.count}`}><span class="bar"><i class:bad={row.count > 0} style={`height:${Math.max(3, (row.count / maxErrors) * 100)}%`}></i></span><b>{row.count}</b><small>{row.day.slice(8, 10)}/{row.day.slice(5, 7)}</small></li>
        {/each}
      </ol>
      <p class="note">{m.sys_errors_note()}</p>
    </article>
  </section>
{/if}

<style>
  .overall { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 16px; padding: 14px 20px; border-left: 5px solid var(--green); }
  .overall.warning { border-left-color: var(--amber); background: #fffbf0; }
  .overall.error { border-left-color: var(--red); background: #fff5f4; }
  .overall span { color: var(--muted); font-size: 13px; }
  .checks { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 14px; margin-bottom: 16px; }
  .check { display: grid; gap: 6px; padding: 14px 16px; }
  .check header { display: flex; align-items: center; gap: 8px; }
  .check h2 { flex: 1; margin: 0; font-size: 14px; }
  .check p { margin: 0; color: var(--muted); font-size: 12.5px; word-break: break-word; }
  .dot { width: 10px; height: 10px; border-radius: 50%; background: var(--subtle); }
  .dot.ok { background: var(--green); }
  .dot.warning { background: var(--amber); }
  .dot.error { background: var(--red); }
  .check.error { border-color: #f2c6c0; }
  .split { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; margin-bottom: 16px; }
  .facts { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin: 0; padding: 8px 20px 16px; }
  .facts dt { color: var(--subtle); font-size: 11.5px; }
  .facts dd { margin: 2px 0 0; font-size: 15px; font-weight: 600; }
  .warn { color: var(--amber) !important; font-weight: 700; }
  .link-row { margin: 0; padding: 0 20px 16px; font-size: 13px; }
  .bars { display: grid; grid-template-columns: repeat(7, 1fr); gap: 10px; margin: 0; padding: 8px 20px 4px; list-style: none; }
  .bars li { display: grid; justify-items: center; gap: 4px; }
  .bar { display: flex; align-items: flex-end; width: 100%; max-width: 36px; height: 90px; border-radius: 4px; background: var(--surface-2); }
  .bar i { display: block; width: 100%; border-radius: 4px 4px 0 0; background: var(--line); }
  .bar i.bad { background: var(--red); }
  .bars b { font-size: 13px; }
  .bars small { color: var(--subtle); font-size: 11px; }
  .note { margin: 0; padding: 4px 20px 16px; color: var(--subtle); font-size: 12px; }
  @media (max-width: 1000px) { .split { grid-template-columns: 1fr; } }
</style>
