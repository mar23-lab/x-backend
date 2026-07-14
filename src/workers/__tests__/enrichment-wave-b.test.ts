// enrichment-wave-b.test.ts · Wave B (260628) · REAL public-signal enrichment.
// Proves the OUTCOME: the sweep fetches real signals (DNS-over-HTTPS SPF/DMARC, HTTPS/TLS),
// reports paid sources honestly as 'not_configured' without a key, NEVER throws, and the
// real 'found' signals (and ONLY those) reach the AI via the company-context profile.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { runEnrichmentSweep, normalizeDomain } from '../services/enrichment-service';
import { publicSignalsFromEnrichment, buildCustomerContextProfile, companyContextPreamble } from '../dal/customer-context-store';

afterEach(() => { vi.restoreAllMocks(); });

// Minimal Response-shaped stub (avoids depending on a global Response in the test env).
function res(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}
function mockFetch(handler: (url: string) => Promise<Response>) {
  globalThis.fetch = vi.fn((url: string | URL) => handler(String(url))) as never;
}

describe('Wave B · enrichment service (REAL public signals, never throws)', () => {
  it('normalizeDomain strips scheme/path + rejects junk', () => {
    expect(normalizeDomain('https://Honest-Young.com.au/path?x=1')).toBe('honest-young.com.au');
    expect(normalizeDomain('not a domain')).toBeNull();
    expect(normalizeDomain('')).toBeNull();
  });

  it('finds SPF/DMARC/TLS for real + reports HIBP/BuiltWith not_configured without keys', async () => {
    mockFetch(async (u) => {
      if (u.includes('type=TXT') && u.includes('_dmarc')) return res({ Answer: [{ data: '"v=DMARC1; p=reject"' }] });
      if (u.includes('type=TXT')) return res({ Answer: [{ data: '"v=spf1 include:_spf.example -all"' }] });
      if (u.startsWith('https://honest-young')) return res(null, 200); // TLS HEAD — handshake ok
      return res('nope', 500);
    });
    const r = await runEnrichmentSweep('honest-young.com.au', {});
    const by = Object.fromEntries(r.sources.map((s) => [s.key, s]));
    expect(by.spf.status).toBe('found');
    expect(by.dmarc.status).toBe('found');
    expect(by.dmarc.detail).toContain('reject');
    expect(by.tls.status).toBe('found');
    expect(by.hibp.status).toBe('not_configured');       // no key → honest, never a fake ✓
    expect(by.builtwith.status).toBe('not_configured');
    expect(r.provenance).toBe('public_signal');
    expect(r.domain).toBe('honest-young.com.au');
  });

  it('activates HIBP when the key is present (found ↔ breach count)', async () => {
    mockFetch(async (u) => {
      if (u.includes('haveibeenpwned')) return res([{ Name: 'AcmeLeak' }, { Name: 'Other' }], 200);
      return res({ Answer: [] });
    });
    const r = await runEnrichmentSweep('breached.example', { HIBP_API_KEY: 'k' });
    const hibp = r.sources.find((s) => s.key === 'hibp')!;
    expect(hibp.status).toBe('found');
    expect(hibp.detail).toContain('2 known breach');
  });

  it('NEVER throws — a rejecting fetch degrades to a status, not an exception', async () => {
    mockFetch(async () => { throw new Error('network down'); });
    const r = await runEnrichmentSweep('example.com', {});
    expect(r.sources.length).toBe(5);
    expect(r.sources.every((s) => ['error', 'not_found', 'not_configured'].includes(s.status))).toBe(true);
  });

  it('empty/invalid domain → empty sweep, no fetch', async () => {
    mockFetch(async () => { throw new Error('should not be called'); });
    const r = await runEnrichmentSweep('', {});
    expect(r.domain).toBeNull();
    expect(r.sources).toEqual([]);
  });
});

describe('Wave B · enrichment → AI profile (real signals reach the AI)', () => {
  const enrichment = {
    schema_id: 'xlooop.enrichment_sweep.v1', domain: 'honest-young.com.au', swept_at: '2026-06-28T00:00:00Z',
    provenance: 'public_signal',
    sources: [
      { key: 'spf', label: 'Email SPF record', status: 'found', detail: 'SPF published (sender authentication configured)' },
      { key: 'hibp', label: 'Breach exposure (HaveIBeenPwned)', status: 'not_configured', detail: 'add HIBP_API_KEY' },
      { key: 'tls', label: 'HTTPS / valid certificate', status: 'not_found', detail: 'HTTPS not reachable' },
    ],
  };

  it('only FOUND signals become facts (not_configured / not_found are NEVER claimed)', () => {
    expect(publicSignalsFromEnrichment(enrichment)).toEqual([
      'Email SPF record: SPF published (sender authentication configured)',
    ]);
    expect(publicSignalsFromEnrichment(null)).toEqual([]);
    expect(publicSignalsFromEnrichment({})).toEqual([]);
  });

  it('the profile + preamble surface the real signal', () => {
    const a = { company_name: 'Honest & Young', domain: 'honest-young.com.au', country: 'AU', deep_level: null, readiness_answers: {}, enrichment } as never;
    const p = buildCustomerContextProfile(a);
    expect(p.public_signals).toEqual(['Email SPF record: SPF published (sender authentication configured)']);
    expect(p.provenance).toBe('stated'); // real public signals count as known context
    const text = companyContextPreamble(p);
    expect(text).toContain('Public signals we verified');
    expect(text).toContain('SPF published');
    expect(text).not.toContain('HTTPS not reachable'); // a not_found signal must never appear as a fact
  });
});
