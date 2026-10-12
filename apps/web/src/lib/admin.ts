/** Nhãn cho màn Quản trị hệ thống (lý do đăng nhập, trạng thái giám sát) theo ngôn ngữ giao diện. */
import type { SystemCheck } from '@inoxpran/contracts';
import { m } from '$lib/paraglide/messages';

export function loginReasonText(reason: string): string {
  switch (reason) {
    case 'SUCCESS': return m.adm_login_success();
    case 'SETUP_PASSWORD': return m.adm_login_setup_password();
    case 'SETUP_MFA': return m.adm_login_setup_mfa();
    case 'SETUP_PASSWORD_MFA': return m.adm_login_setup_both();
    case 'UNKNOWN_EMAIL': return m.adm_login_unknown();
    case 'DISABLED': return m.adm_login_disabled();
    case 'LOCKED': return m.adm_login_locked();
    case 'BAD_PASSWORD': return m.adm_login_bad_password();
    case 'BAD_PASSWORD_LOCKED': return m.adm_login_bad_password_locked();
    case 'MFA_INVALID': return m.adm_login_mfa_invalid();
    default: return reason;
  }
}

export function checkTitle(key: string): string {
  switch (key) {
    case 'database': return m.sys_database();
    case 'replica': return m.sys_replica();
    case 'redis': return m.sys_redis();
    case 'queue': return m.sys_queue();
    case 'worker': return m.sys_worker();
    case 'clamav': return m.sys_clamav();
    case 'storage': return m.sys_storage();
    case 'outbox': return m.sys_outbox();
    case 'backup': return m.sys_backup();
    case 'errors': return m.sys_errors();
    case 'logins': return m.sys_logins();
    default: return key;
  }
}

export function checkDetail(check: SystemCheck): string {
  const p = check.params ?? {};
  const n = (key: string) => Number(p[key] ?? 0);
  const t = (key: string) => String(p[key] ?? '');
  switch (check.detail) {
    case 'DB_OK': return m.sys_db_ok({ objects: n('objects').toLocaleString() });
    case 'DB_DOWN': return m.sys_db_down();
    case 'REPLICA_OK': return m.sys_replica_ok({ set: t('set') });
    case 'REPLICA_NO_PRIMARY': return m.sys_replica_no_primary();
    case 'REPLICA_UNKNOWN': return m.sys_replica_unknown();
    case 'REDIS_OK': return m.sys_redis_ok();
    case 'REDIS_DOWN': return m.sys_redis_down();
    case 'QUEUE_OK': return m.sys_queue_ok();
    case 'QUEUE_FAILED': return m.sys_queue_failed({ count: n('failed') });
    case 'QUEUE_BACKLOG': return m.sys_queue_backlog({ count: n('waiting') });
    case 'WORKER_OK': return m.sys_worker_ok({ minutes: n('minutes') });
    case 'WORKER_STALE': return m.sys_worker_stale({ minutes: n('minutes') });
    case 'WORKER_NEVER': return m.sys_worker_never();
    case 'CLAMAV_OK': return t('version');
    case 'CLAMAV_DOWN': return m.sys_clamav_down();
    case 'CLAMAV_OFF': return m.sys_clamav_off();
    case 'S3_CHECK': return check.state === 'ok' ? m.sys_s3_ok({ bucket: t('bucket') }) : m.sys_s3_down({ bucket: t('bucket') });
    case 'S3_NOT_CONFIGURED': return m.sys_s3_not_configured();
    case 'OUTBOX_OK': return m.sys_outbox_ok({ pending: n('pending') });
    case 'OUTBOX_DEAD_LETTER': return m.sys_outbox_dead({ count: n('deadLetter') });
    case 'OUTBOX_BACKLOG': return m.sys_outbox_backlog({ pending: n('pending') });
    case 'BACKUP_OK': return m.sys_backup_ok({ hours: t('hours') });
    case 'BACKUP_STALE': return m.sys_backup_stale({ hours: t('hours') });
    case 'BACKUP_FAILED': return m.sys_backup_failed();
    case 'BACKUP_NONE': return m.sys_backup_none();
    case 'ERRORS_TODAY': return m.sys_errors_today({ count: n('count') });
    case 'LOGINS': return m.sys_logins_detail({ failed: n('failed'), locked: n('locked') });
    default: return check.detail;
  }
}

export const stateTone: Record<string, string> = { ok: 'success', warning: 'warning', error: 'danger', unknown: 'neutral' };

export function bytes(value: number): string {
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = value / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toLocaleString(undefined, { maximumFractionDigits: 1 })} ${units[unit]}`;
}
