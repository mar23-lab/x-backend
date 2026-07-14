// email-notifier.test.ts · R55 · Cloudflare Email Service (primary) → Resend → console chain
//
// Verifies the fallback ladder + that a failure never throws (the access request must not block).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  notifyAdminAccessRequest,
  type NotifierEnv,
  type AccessRequestNotification,
} from '../services/email-notifier';

const PAYLOAD: AccessRequestNotification = {
  request_id: 'req_1',
  email: 'e@acme.com',
  company_name: 'Acme',
  reason: null,
  source: 'web',
  ip_address: null,
  created_at: '2026-06-07T00:00:00Z',
  account_type: 'company',
  deep_level: 2,
};

function cfBinding(impl: () => Promise<{ messageId?: string }>) {
  return { send: vi.fn(impl) };
}

describe('notifyAdminAccessRequest · delivery chain', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('uses Cloudflare Email Service when binding + from + recipients are present', async () => {
    const EMAIL = cfBinding(async () => ({ messageId: 'cf_1' }));
    const env: NotifierEnv = {
      EMAIL,
      EMAIL_FROM_ADDRESS: 'alerts@notify.xlooop.com',
      ADMIN_NOTIFICATION_EMAIL: 'admin@xlooop.com',
    };
    const r = await notifyAdminAccessRequest(env, PAYLOAD);
    expect(r).toEqual({ delivered: true, channel: 'cloudflare' });
    expect(EMAIL.send).toHaveBeenCalledOnce();
    const msg = (EMAIL.send as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, any>;
    expect(msg.from).toEqual({ email: 'alerts@notify.xlooop.com', name: 'Xlooop' });
    expect(msg.to).toEqual(['admin@xlooop.com']);
    expect(msg.subject).toContain('e@acme.com');
    expect(msg.html).toBeTruthy();
    expect(msg.text).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled(); // never reaches Resend
  });

  it('falls back to console when CF send throws and Resend is not configured', async () => {
    const EMAIL = cfBinding(async () => {
      const e = new Error('not verified') as Error & { code: string };
      e.code = 'E_SENDER_NOT_VERIFIED';
      throw e;
    });
    const env: NotifierEnv = {
      EMAIL,
      EMAIL_FROM_ADDRESS: 'alerts@notify.xlooop.com',
      ADMIN_NOTIFICATION_EMAIL: 'admin@xlooop.com',
    };
    const r = await notifyAdminAccessRequest(env, PAYLOAD);
    expect(r.delivered).toBe(true);
    expect(r.channel).toBe('console');
    expect(r.error).toContain('E_SENDER_NOT_VERIFIED');
  });

  it('falls back to Resend when CF send throws and Resend IS configured', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('{}', { status: 200 }));
    const EMAIL = cfBinding(async () => {
      throw new Error('cf down');
    });
    const env: NotifierEnv = {
      EMAIL,
      EMAIL_FROM_ADDRESS: 'alerts@notify.xlooop.com',
      ADMIN_NOTIFICATION_EMAIL: 'admin@xlooop.com',
      RESEND_API_KEY: 're_x',
      RESEND_FROM_EMAIL: 'hello@xlooop.com',
    };
    const r = await notifyAdminAccessRequest(env, PAYLOAD);
    expect(r).toEqual({ delivered: true, channel: 'resend' });
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(fetchSpy.mock.calls[0][0]).toBe('https://api.resend.com/emails');
  });

  it('uses Resend directly when there is no CF binding but Resend is configured', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('{}', { status: 200 }));
    const env: NotifierEnv = {
      ADMIN_NOTIFICATION_EMAIL: 'admin@xlooop.com',
      RESEND_API_KEY: 're_x',
      RESEND_FROM_EMAIL: 'hello@xlooop.com',
    };
    const r = await notifyAdminAccessRequest(env, PAYLOAD);
    expect(r.channel).toBe('resend');
  });

  it('console-only when neither CF nor Resend is configured', async () => {
    const env: NotifierEnv = { ADMIN_NOTIFICATION_EMAIL: 'admin@xlooop.com' };
    const r = await notifyAdminAccessRequest(env, PAYLOAD);
    expect(r).toEqual({ delivered: true, channel: 'console' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('skips email entirely when no recipients are configured (console)', async () => {
    const EMAIL = cfBinding(async () => ({ messageId: 'cf_1' }));
    const env: NotifierEnv = { EMAIL, EMAIL_FROM_ADDRESS: 'alerts@notify.xlooop.com', ADMIN_NOTIFICATION_EMAIL: '' };
    const r = await notifyAdminAccessRequest(env, PAYLOAD);
    expect(r.channel).toBe('console');
    expect(EMAIL.send).not.toHaveBeenCalled();
  });

  // Regression (R55 · prod 500 "s2.replace is not a function"): a Date-typed `created_at`
  // (the Postgres driver returned a Date, not the declared string) must NOT throw. escapeHtml now
  // coerces via String(), and render+send are wrapped so any failure degrades to console, never 500.
  it('never throws when created_at is a Date object (escapeHtml coercion)', async () => {
    const EMAIL = cfBinding(async () => ({ messageId: 'cf_1' }));
    const env: NotifierEnv = {
      EMAIL,
      EMAIL_FROM_ADDRESS: 'alerts@notify.xlooop.com',
      ADMIN_NOTIFICATION_EMAIL: 'admin@xlooop.com',
    };
    const payload = { ...PAYLOAD, created_at: new Date('2026-06-07T00:00:00Z') as unknown as string };
    const r = await notifyAdminAccessRequest(env, payload);
    expect(r).toEqual({ delivered: true, channel: 'cloudflare' });
    expect(EMAIL.send).toHaveBeenCalledOnce();
  });
});
