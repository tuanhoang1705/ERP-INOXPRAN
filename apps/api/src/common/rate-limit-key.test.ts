import { describe, expect, it } from 'vitest';
import { RATE_LIMIT_PER_IP, RATE_LIMIT_PER_USER, rateLimitKey, rateLimitMax, sessionCookie } from './rate-limit-key';

const verify = (token: string) => (token.startsWith('valid-') ? { sub: token.slice(6) } : (() => { throw new Error('bad signature'); })());

describe('rate limit key (20/10/2026: cả văn phòng chung một IP)', () => {
  it('đọc cookie erp_session trong header thô', () => {
    expect(sessionCookie('erp_csrf=abc; erp_session=valid-u1; other=1')).toBe('valid-u1');
    expect(sessionCookie(['a=1', 'erp_session=valid-u2'])).toBe('valid-u2');
    expect(sessionCookie('erp_session_x=1')).toBeNull();
    expect(sessionCookie(undefined)).toBeNull();
  });

  it('hai người cùng IP công ty có hạn mức riêng theo tài khoản', () => {
    const a = rateLimitKey({ ip: '203.0.113.7', headers: { cookie: 'erp_session=valid-u1' } }, verify);
    const b = rateLimitKey({ ip: '203.0.113.7', headers: { cookie: 'erp_session=valid-u2' } }, verify);
    expect(a).toBe('u:u1');
    expect(b).toBe('u:u2');
    expect(rateLimitMax(a)).toBe(RATE_LIMIT_PER_USER);
  });

  it('chưa đăng nhập hoặc cookie giả → tính theo IP như cũ', () => {
    expect(rateLimitKey({ ip: '203.0.113.7', headers: {} }, verify)).toBe('ip:203.0.113.7');
    const forged = rateLimitKey({ ip: '203.0.113.7', headers: { cookie: 'erp_session=forged' } }, verify);
    expect(forged).toBe('ip:203.0.113.7');
    expect(rateLimitMax(forged)).toBe(RATE_LIMIT_PER_IP);
  });
});
