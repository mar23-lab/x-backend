// customer-approved-email.test.ts · R56 Stage 3.2 · notifyCustomerApproved delivery + safety

import { describe, it, expect, vi, afterEach } from 'vitest';
import { notifyCustomerApproved, type NotifierEnv } from '../services/email-notifier';

function cfBinding(impl: () => Promise<{ messageId?: string }>) {
  return { send: vi.fn(impl) };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('notifyCustomerApproved', () => {
  it('sends via Cloudflare to the customer when binding + from are present', async () => {
    const EMAIL = cfBinding(async () => ({ messageId: 'cf_1' }));
    const env: NotifierEnv = { EMAIL, EMAIL_FROM_ADDRESS: 'alerts@notify.xlooop.com' };
    const r = await notifyCustomerApproved(env, { email: 'customer@acme.com', company_name: 'Acme' });
    expect(r).toEqual({ delivered: true, channel: 'cloudflare' });
    expect(EMAIL.send).toHaveBeenCalledOnce();
    const msg = (EMAIL.send as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>;
    expect(msg.to).toEqual(['customer@acme.com']);
    expect(msg.from).toEqual({ email: 'alerts@notify.xlooop.com', name: 'Xlooop' });
    expect(String(msg.subject).toLowerCase()).toContain('approv');
    expect(String(msg.html)).toContain('Acme');
  });

  it('falls back to console when no binding is configured', async () => {
    const r = await notifyCustomerApproved({}, { email: 'customer@acme.com' });
    expect(r.channel).toBe('console');
  });

  it('never throws on a Cloudflare send failure (returns console)', async () => {
    const EMAIL = cfBinding(async () => {
      throw new Error('cf down');
    });
    const env: NotifierEnv = { EMAIL, EMAIL_FROM_ADDRESS: 'alerts@notify.xlooop.com' };
    const r = await notifyCustomerApproved(env, { email: 'customer@acme.com' });
    expect(r.channel).toBe('console');
  });

  it('does not send (console) when the customer email is empty', async () => {
    const EMAIL = cfBinding(async () => ({ messageId: 'cf_1' }));
    const env: NotifierEnv = { EMAIL, EMAIL_FROM_ADDRESS: 'alerts@notify.xlooop.com' };
    const r = await notifyCustomerApproved(env, { email: '' });
    expect(r.channel).toBe('console');
    expect(EMAIL.send).not.toHaveBeenCalled();
  });
});
