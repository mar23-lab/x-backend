// turnstile.test.ts · R56 Stage 1 · server-side Turnstile verification (gated + fail-open)

import { describe, it, expect, vi, afterEach } from 'vitest';
import { verifyTurnstile } from '../services/turnstile';

afterEach(() => vi.unstubAllGlobals());

describe('verifyTurnstile', () => {
  it('skips (ok) when TURNSTILE_SECRET is unset — wire-now phase', async () => {
    const r = await verifyTurnstile({}, null, '1.2.3.4');
    expect(r).toEqual({ ok: true, skipped: true });
  });

  it('rejects a missing token once the secret is configured', async () => {
    const r = await verifyTurnstile({ TURNSTILE_SECRET: 's' }, null, '1.2.3.4');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('missing_token');
  });

  it('passes when siteverify returns success', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 })));
    const r = await verifyTurnstile({ TURNSTILE_SECRET: 's' }, 'tok', '1.2.3.4');
    expect(r).toEqual({ ok: true, skipped: false });
  });

  it('rejects when siteverify returns failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: false }), { status: 200 })));
    const r = await verifyTurnstile({ TURNSTILE_SECRET: 's' }, 'tok', '1.2.3.4');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('verification_failed');
  });

  it('fails OPEN on a siteverify network error (rate-limit backstops)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('network');
    }));
    const r = await verifyTurnstile({ TURNSTILE_SECRET: 's' }, 'tok', '1.2.3.4');
    expect(r.ok).toBe(true);
    expect(r.skipped).toBe(true);
    expect(r.reason).toBe('siteverify_unreachable');
  });
});
