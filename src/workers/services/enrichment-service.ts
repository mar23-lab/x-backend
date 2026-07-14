// enrichment-service.ts · Wave B (260628) · REAL public-signal enrichment.
//
// Replaces the placebo sweep (Part Q, the worst trust violation — an animated
// setTimeout that fetched nothing yet showed green ✓). This fetches the FEASIBLE
// public signals for a domain, FOR REAL:
//   - FREE, no key: DNS-over-HTTPS (SPF / DMARC email-auth posture), HTTPS/TLS
//     reachability (valid cert + host up).
//   - PAID, operator key: HaveIBeenPwned breach exposure (HIBP_API_KEY), BuiltWith
//     tech stack (BUILTWITH_API_KEY). When the key is absent the source reports
//     'not_configured' HONESTLY — never a fake ✓.
//
// Every source is best-effort and NEVER throws: a failed/blocked source degrades to
// a status, so enrichment can never strand onboarding. The result is cached in the
// assessment's `enrichment` JSONB and consumed by buildCustomerContextProfile
// (provenance:'public_signal') — so the AI sees REAL signals, not an animation.

export type EnrichmentStatus = 'found' | 'not_found' | 'not_configured' | 'blocked' | 'error';

export interface EnrichmentSource {
  key: string;
  label: string;
  status: EnrichmentStatus;
  /** human-safe one-line finding (never raw PII; counts + posture only). */
  detail: string | null;
}

export interface EnrichmentResult {
  schema_id: 'xlooop.enrichment_sweep.v1';
  domain: string | null;
  swept_at: string;
  sources: EnrichmentSource[];
  provenance: 'public_signal';
}

export interface EnrichmentEnv {
  HIBP_API_KEY?: string;
  BUILTWITH_API_KEY?: string;
}

const DOH = 'https://cloudflare-dns.com/dns-query';
const TIMEOUT_MS = 6000;

/** Normalise a free-form domain/url into a bare hostname (lowercase, no scheme/path). */
export function normalizeDomain(raw: string | null | undefined): string | null {
  const d = (raw || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/[^a-z0-9.-]/g, '');
  // a real domain has a dot and at least a 2-char TLD; reject junk so we don't sweep nonsense.
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d) ? d : null;
}

async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try { return await fetch(url, { ...init, signal: ctrl.signal }); }
  finally { clearTimeout(t); }
}

async function dohTxt(name: string): Promise<string[]> {
  const res = await fetchWithTimeout(`${DOH}?name=${encodeURIComponent(name)}&type=TXT`, { headers: { accept: 'application/dns-json' } });
  if (!res.ok) return [];
  const data = (await res.json()) as { Answer?: Array<{ data?: string }> };
  return (data.Answer || []).map((a) => String(a.data || '').replace(/^"|"$/g, '').trim()).filter(Boolean);
}

async function checkSpf(domain: string): Promise<EnrichmentSource> {
  const base: EnrichmentSource = { key: 'spf', label: 'Email SPF record', status: 'error', detail: null };
  try {
    const txt = await dohTxt(domain);
    const spf = txt.find((t) => /^v=spf1/i.test(t));
    return { ...base, status: spf ? 'found' : 'not_found', detail: spf ? 'SPF published (sender authentication configured)' : 'no SPF record — email spoofing risk' };
  } catch { return base; }
}

async function checkDmarc(domain: string): Promise<EnrichmentSource> {
  const base: EnrichmentSource = { key: 'dmarc', label: 'Email DMARC policy', status: 'error', detail: null };
  try {
    const txt = await dohTxt(`_dmarc.${domain}`);
    const dmarc = txt.find((t) => /^v=DMARC1/i.test(t));
    const policy = dmarc ? (/p=([a-z]+)/i.exec(dmarc)?.[1] || 'none') : null;
    return { ...base, status: dmarc ? 'found' : 'not_found', detail: dmarc ? `DMARC published (policy: ${policy})` : 'no DMARC policy — email spoofing risk' };
  } catch { return base; }
}

async function checkTls(domain: string): Promise<EnrichmentSource> {
  const base: EnrichmentSource = { key: 'tls', label: 'HTTPS / valid certificate', status: 'error', detail: null };
  try {
    const res = await fetchWithTimeout(`https://${domain}`, { method: 'HEAD', redirect: 'manual' });
    // any HTTP response means the TLS handshake (cert) succeeded; a network/cert error throws.
    return { ...base, status: 'found', detail: `HTTPS reachable with a valid certificate (HTTP ${res.status})` };
  } catch {
    return { ...base, status: 'not_found', detail: 'HTTPS not reachable — no valid certificate or host is down' };
  }
}

async function checkHibp(domain: string, env: EnrichmentEnv): Promise<EnrichmentSource> {
  const base: EnrichmentSource = { key: 'hibp', label: 'Breach exposure (HaveIBeenPwned)', status: 'error', detail: null };
  if (!env.HIBP_API_KEY) return { ...base, status: 'not_configured', detail: 'add HIBP_API_KEY (operator secret) to check breach exposure' };
  try {
    const res = await fetchWithTimeout(`https://haveibeenpwned.com/api/v3/breaches?domain=${encodeURIComponent(domain)}`,
      { headers: { 'hibp-api-key': env.HIBP_API_KEY, 'user-agent': 'xlooop-enrichment' } });
    if (res.status === 404) return { ...base, status: 'not_found', detail: 'no known breaches reference this domain' };
    if (!res.ok) return { ...base, status: res.status === 401 ? 'not_configured' : 'blocked', detail: `HIBP returned HTTP ${res.status}` };
    const breaches = (await res.json()) as unknown[];
    const n = Array.isArray(breaches) ? breaches.length : 0;
    return { ...base, status: n > 0 ? 'found' : 'not_found', detail: n > 0 ? `${n} known breach(es) reference this domain` : 'no known breaches reference this domain' };
  } catch { return base; }
}

async function checkBuiltwith(domain: string, env: EnrichmentEnv): Promise<EnrichmentSource> {
  const base: EnrichmentSource = { key: 'builtwith', label: 'Technology stack (BuiltWith)', status: 'error', detail: null };
  if (!env.BUILTWITH_API_KEY) return { ...base, status: 'not_configured', detail: 'add BUILTWITH_API_KEY (operator secret) to detect the tech stack' };
  try {
    const res = await fetchWithTimeout(`https://api.builtwith.com/v21/api.json?KEY=${encodeURIComponent(env.BUILTWITH_API_KEY)}&LOOKUP=${encodeURIComponent(domain)}`);
    if (!res.ok) return { ...base, status: 'blocked', detail: `BuiltWith returned HTTP ${res.status}` };
    const data = (await res.json()) as { Results?: Array<{ Result?: { Paths?: Array<{ Technologies?: Array<{ Name?: string }> }> } }> };
    const techs = (data.Results?.[0]?.Result?.Paths || []).flatMap((p) => (p.Technologies || []).map((t) => t.Name).filter(Boolean)) as string[];
    const top = Array.from(new Set(techs)).slice(0, 8);
    return { ...base, status: top.length ? 'found' : 'not_found', detail: top.length ? `detected: ${top.join(', ')}` : 'no technologies detected' };
  } catch { return base; }
}

/** Run the public-signal sweep for a domain. Best-effort, never throws. */
export async function runEnrichmentSweep(domain: string | null | undefined, env: EnrichmentEnv): Promise<EnrichmentResult> {
  const swept_at = new Date().toISOString();
  const d = normalizeDomain(domain);
  if (!d) {
    return { schema_id: 'xlooop.enrichment_sweep.v1', domain: null, swept_at, sources: [], provenance: 'public_signal' };
  }
  const sources = await Promise.all([
    checkSpf(d), checkDmarc(d), checkTls(d), checkHibp(d, env), checkBuiltwith(d, env),
  ]);
  return { schema_id: 'xlooop.enrichment_sweep.v1', domain: d, swept_at, sources, provenance: 'public_signal' };
}
