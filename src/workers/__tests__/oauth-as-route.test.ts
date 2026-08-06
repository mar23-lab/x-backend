// oauth-as-route.test.ts · Stage-2 second half (260806) · the PKCE AS route matrix.
// The sql seam is mocked (same discipline as the other route tests); Clerk auth is exercised by
// mounting the real route with a pre-set auth context where needed.
import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { oauthAsRoute } from '../routes/oauth-as';
import { mintClientId, s256Challenge, sealGrant, AUTH_CODE_TTL_SECONDS } from '../lib/oauth-as-crypto';

vi.mock('../middleware/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../middleware/auth')>()),
  // consent tests inject auth directly; the real clerkAuth would need a Clerk network round-trip
  clerkAuth: () => async (_ctx: never, next: () => Promise<void>) => { await next(); },
}));
vi.mock('../lib/spine-authority', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/spine-authority')>()),
  authorizeGovernedWrite: vi.fn(async (ctx: { get: (k: string) => { role?: string } }) => {
    const role = ctx.get('auth')?.role;
    return role === 'owner' || role === 'operator'
      ? { allowed: true, reason: 'active_entitlement' }
      : { allowed: false, reason: 'mode_not_allowed' };
  }),
}));

const SECRET = 'test-oauth-signing-key-0123456789abcdef';
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

function appFor(opts: { auth?: Record<string, unknown>; sqlRows?: Array<Record<string, unknown>>; noKey?: boolean } = {}) {
  const inserted: string[] = [];
  const sql = Object.assign(
    async (strings: TemplateStringsArray, ...vals: unknown[]) => {
      const text = strings.join('?');
      if (text.includes('INSERT INTO idempotency_keys')) {
        const key = String(vals[1]);
        if (inserted.includes(key)) return []; // UNIQUE conflict → DO NOTHING → zero rows
        inserted.push(key);
        return [{ id: 1 }];
      }
      if (text.includes('INSERT INTO customer_api_tokens')) {
        return [{
          id: 'cat_test', workspace_id: vals[1], role: vals[3], label: vals[4], packet_prefix: vals[5],
          created_by: vals[6], created_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 90 * 86400000).toISOString(), revoked_at: null, revoked_by: null, last_used_at: null,
        }];
      }
      return opts.sqlRows ?? [];
    },
    {},
  );
  const app = new Hono();
  app.use('*', async (ctx, next) => {
    ctx.set('sql' as never, sql as never);
    if (opts.auth) ctx.set('auth' as never, opts.auth as never);
    await next();
  });
  app.route('/', oauthAsRoute);
  const env = opts.noKey ? {} : { OAUTH_SIGNING_KEY: SECRET, DATABASE_URL: 'postgres://unused' };
  const req = (path: string, init?: RequestInit) => app.request(path, init, env as never);
  return { req, inserted };
}

describe('AS metadata', () => {
  it('RFC 8414 document: S256-only, code grant only, public clients', async () => {
    const { req } = appFor();
    const res = await req('/.well-known/oauth-authorization-server');
    const j: any = await res.json();
    expect(j.issuer).toBe('https://api.xlooop.com');
    expect(j.code_challenge_methods_supported).toEqual(['S256']);
    expect(j.grant_types_supported).toEqual(['authorization_code']);
    expect(j.token_endpoint_auth_methods_supported).toEqual(['none']);
  });
  it('fails closed without the signing key', async () => {
    const { req } = appFor({ noKey: true });
    expect((await req('/oauth/register', { method: 'POST', body: '{}' })).status).toBe(503);
  });
});

describe('DCR', () => {
  it('registers loopback + https and refuses off-loopback http', async () => {
    const { req } = appFor();
    const ok = await req('/oauth/register', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['http://127.0.0.1/callback', 'https://client.example/cb'] }),
    });
    expect(ok.status).toBe(201);
    const j: any = await ok.json();
    expect(j.client_id.startsWith('xlc_')).toBe(true);
    expect(j.token_endpoint_auth_method).toBe('none');

    const bad = await req('/oauth/register', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['http://evil.example/cb'] }),
    });
    expect(bad.status).toBe(400);
  });
});

describe('authorize', () => {
  it('redirects a fully valid request to the consent page with params intact', async () => {
    const { req } = appFor();
    const cid = await mintClientId(['http://127.0.0.1/callback'], SECRET, Date.now());
    const res = await req(`/oauth/authorize?client_id=${encodeURIComponent(cid)}&redirect_uri=${encodeURIComponent('http://127.0.0.1:41234/callback')}&response_type=code&code_challenge=${CHALLENGE}&code_challenge_method=S256&state=st1`);
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('location')!);
    expect(loc.origin + loc.pathname).toBe('https://app.xlooop.com/oauth/consent');
    expect(loc.searchParams.get('state')).toBe('st1');
    expect(loc.searchParams.get('code_challenge')).toBe(CHALLENGE);
  });
  it('NEVER redirects on client/redirect validation failure (open-redirect guard)', async () => {
    const { req } = appFor();
    const cid = await mintClientId(['http://127.0.0.1/callback'], SECRET, Date.now());
    const badClient = await req(`/oauth/authorize?client_id=xlc_forged.tag&redirect_uri=${encodeURIComponent('http://127.0.0.1/callback')}&response_type=code&code_challenge=${CHALLENGE}&code_challenge_method=S256`);
    expect(badClient.status).toBe(400);
    const foreign = await req(`/oauth/authorize?client_id=${encodeURIComponent(cid)}&redirect_uri=${encodeURIComponent('https://evil.example/steal')}&response_type=code&code_challenge=${CHALLENGE}&code_challenge_method=S256`);
    expect(foreign.status).toBe(400);
    expect(foreign.headers.get('location')).toBeNull();
  });
  it('bounces protocol errors to the VALIDATED redirect per RFC (plain method refused)', async () => {
    const { req } = appFor();
    const cid = await mintClientId(['http://127.0.0.1/callback'], SECRET, Date.now());
    const res = await req(`/oauth/authorize?client_id=${encodeURIComponent(cid)}&redirect_uri=${encodeURIComponent('http://127.0.0.1/callback')}&response_type=code&code_challenge=${CHALLENGE}&code_challenge_method=plain`);
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('location')!);
    expect(loc.hostname).toBe('127.0.0.1');
    expect(loc.searchParams.get('error')).toBe('invalid_request');
  });
});

describe('consent', () => {
  const params = async () => {
    const cid = await mintClientId(['http://127.0.0.1/callback'], SECRET, Date.now());
    return { client_id: cid, redirect_uri: 'http://127.0.0.1:41234/callback', code_challenge: CHALLENGE, state: 'st2', scope: 'operator' };
  };
  it('an owner session gets a code bound to THEIR workspace; operator scope honoured only with the flag', async () => {
    const { req } = appFor({ auth: { auth_method: 'clerk_jwt', role: 'owner', user_id: 'u_o', workspace_id: 'ws_A' } });
    const res = await req('/oauth/consent', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(await params()),
    });
    expect(res.status).toBe(200);
    const j: any = await res.json();
    const to = new URL(j.redirect_to);
    expect(to.searchParams.get('state')).toBe('st2');
    expect(to.searchParams.get('code')!.startsWith('xac_')).toBe(true);
    expect(j.granted_role).toBe('viewer'); // CUSTOMER_OPERATIONAL_TOKENS_ENABLED unset in this env ⇒ capped
  });
  it('a non-privileged session is refused', async () => {
    const { req } = appFor({ auth: { auth_method: 'clerk_jwt', role: 'member', user_id: 'u_m', workspace_id: 'ws_A' } });
    const res = await req('/oauth/consent', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(await params()),
    });
    expect(res.status).toBe(403);
  });
  it('a service principal cannot consent', async () => {
    const { req } = appFor({ auth: { auth_method: 'service_principal', role: 'operator', user_id: 'svc_x', workspace_id: 'ws_A' } });
    const res = await req('/oauth/consent', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(await params()),
    });
    expect(res.status).toBe(403);
  });
});

describe('token exchange', () => {
  const mkCode = (over: Record<string, unknown> = {}) => sealGrant({
    cid_sha: '', redirect_uri: 'http://127.0.0.1:41234/callback', cc: CHALLENGE,
    workspace_id: 'ws_A', user_id: 'u_o', role: 'viewer',
    exp: Math.floor(Date.now() / 1000) + AUTH_CODE_TTL_SECONDS, n: crypto.randomUUID(), ...over,
  } as never, SECRET);
  const form = (o: Record<string, string>) => new URLSearchParams(o).toString();

  it('happy path mints an xlk token; a REPLAY of the same code is invalid_grant (single-use)', async () => {
    const { req } = appFor();
    const cid = await mintClientId(['http://127.0.0.1/callback'], SECRET, Date.now());
    const { sha256HexOf } = await import('../lib/oauth-as-crypto');
    const code = await mkCode({ cid_sha: await sha256HexOf(cid) });
    const body = form({ grant_type: 'authorization_code', code, client_id: cid, redirect_uri: 'http://127.0.0.1:41234/callback', code_verifier: VERIFIER });
    const res = await req('/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
    expect(res.status).toBe(200);
    const j: any = await res.json();
    expect(j.access_token.startsWith('xlk_ro_')).toBe(true);
    expect(j.token_type).toBe('bearer');
    expect(j.expires_in).toBeGreaterThan(80 * 86400);

    const replay = await req('/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
    expect(replay.status).toBe(400);
    expect(((await replay.json()) as any).error).toBe('invalid_grant');
  });
  it('an invalid_grant denial emits the structured oauth_as_denied telemetry line', async () => {
    const { req } = appFor();
    const warned: string[] = [];
    const original = console.warn;
    console.warn = (message: unknown) => { warned.push(String(message)); };
    try {
      const res = await req('/oauth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form({ grant_type: 'authorization_code', code: 'xac_garbage', client_id: 'xlc_x', redirect_uri: 'http://127.0.0.1/cb', code_verifier: 'v' }),
      });
      expect(res.status).toBe(400);
    } finally {
      console.warn = original;
    }
    const line = warned.map((entry) => { try { return JSON.parse(entry); } catch { return null; } })
      .find((entry) => entry && entry.event === 'oauth_as_denied');
    expect(line?.error).toBe('invalid_grant');
    expect(typeof line?.ip).toBe('string');
  });
  it('wrong verifier, wrong client, wrong redirect, expired code — all invalid_grant', async () => {
    const { req } = appFor();
    const cid = await mintClientId(['http://127.0.0.1/callback'], SECRET, Date.now());
    const { sha256HexOf } = await import('../lib/oauth-as-crypto');
    const base = { grant_type: 'authorization_code', client_id: cid, redirect_uri: 'http://127.0.0.1:41234/callback' };
    const post = (o: Record<string, string>) => req('/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form(o) });

    const good = await mkCode({ cid_sha: await sha256HexOf(cid) });
    expect((await post({ ...base, code: good, code_verifier: 'wrong-verifier-wrong-verifier-wrong-verifier' })).status).toBe(400);

    // a genuinely different client: different redirect set (a +1ms mint lands in the SAME iat
    // second with the same URIs and produces the IDENTICAL deterministic client_id — measured)
    const otherCid = await mintClientId(['http://127.0.0.1/other-cb'], SECRET, Date.now());
    const boundElsewhere = await mkCode({ cid_sha: await sha256HexOf(otherCid) });
    expect((await post({ ...base, code: boundElsewhere, code_verifier: VERIFIER })).status).toBe(400);

    const wrongRedirect = await mkCode({ cid_sha: await sha256HexOf(cid) });
    expect((await post({ ...base, code: wrongRedirect, redirect_uri: 'http://127.0.0.1:41234/other', code_verifier: VERIFIER })).status).toBe(400);

    const expired = await mkCode({ cid_sha: await sha256HexOf(cid), exp: Math.floor(Date.now() / 1000) - 5 });
    expect((await post({ ...base, code: expired, code_verifier: VERIFIER })).status).toBe(400);
  });
});
