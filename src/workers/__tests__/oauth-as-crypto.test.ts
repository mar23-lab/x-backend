// oauth-as-crypto.test.ts · Stage-2 second half (260806) · the stateless AS crypto core.
// Every security property carries its own negative control: a tampered artifact must read as
// null/invalid, never as a different-but-valid one.
import { describe, it, expect } from 'vitest';
import {
  mintClientId, verifyClientId, sealGrant, openGrant, s256Challenge,
  redirectUriRegistrable, redirectUriMatches, AUTH_CODE_TTL_SECONDS, type OAuthGrant,
} from '../lib/oauth-as-crypto';

const SECRET = 'test-oauth-signing-key-0123456789abcdef';
const NOW = 1_800_000_000_000;

const grant = (over: Partial<OAuthGrant> = {}): OAuthGrant => ({
  cid_sha: 'a'.repeat(64),
  redirect_uri: 'http://127.0.0.1:33418/callback',
  cc: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
  workspace_id: 'ws_a', user_id: 'u_1', role: 'viewer',
  exp: Math.floor(NOW / 1000) + AUTH_CODE_TTL_SECONDS, n: 'nonce-1',
  ...over,
});

describe('stateless client ids (DCR)', () => {
  it('round-trips and preserves the registered redirect set', async () => {
    const id = await mintClientId(['https://client.example/cb', 'http://127.0.0.1/callback'], SECRET, NOW);
    expect(id.startsWith('xlc_')).toBe(true);
    const rec = await verifyClientId(id, SECRET);
    expect(rec?.ru).toEqual(['https://client.example/cb', 'http://127.0.0.1/callback']);
  });
  it('a tampered payload or wrong key verifies as null — a forged client cannot smuggle a redirect', async () => {
    const id = await mintClientId(['https://client.example/cb'], SECRET, NOW);
    const [payload, tag] = id.slice(4).split('.');
    const evil = Buffer.from(JSON.stringify({ ru: ['https://evil.example/steal'], iat: 1 })).toString('base64url');
    expect(await verifyClientId(`xlc_${evil}.${tag}`, SECRET)).toBeNull();
    expect(await verifyClientId(`xlc_${payload}.${tag}`, 'a-different-signing-key-9876543210zyxw')).toBeNull();
    expect(await verifyClientId('xlc_garbage', SECRET)).toBeNull();
  });
});

describe('sealed grants (auth codes)', () => {
  it('round-trips the full grant', async () => {
    const g = grant();
    const code = await sealGrant(g, SECRET);
    expect(code.startsWith('xac_')).toBe(true);
    expect(await openGrant(code, SECRET, NOW)).toEqual(g);
  });
  it('every code is unique for an identical grant (random IV + nonce)', async () => {
    const g = grant();
    expect(await sealGrant(g, SECRET)).not.toEqual(await sealGrant(g, SECRET));
  });
  it('tamper, wrong key, and expiry all read as null — indistinguishable by design', async () => {
    const code = await sealGrant(grant(), SECRET);
    expect(await openGrant(code.slice(0, -4) + 'AAAA', SECRET, NOW)).toBeNull(); // bit-flip → GCM auth fails
    expect(await openGrant(code, 'a-different-signing-key-9876543210zyxw', NOW)).toBeNull();
    expect(await openGrant(code, SECRET, NOW + (AUTH_CODE_TTL_SECONDS + 1) * 1000)).toBeNull(); // expired
    expect(await openGrant('xac_not-a-code', SECRET, NOW)).toBeNull();
  });
});

describe('PKCE S256', () => {
  it('matches the RFC 7636 appendix-B vector', async () => {
    expect(await s256Challenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'))
      .toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });
});

describe('redirect URI policy', () => {
  it('registrable: https anywhere; plain http only on loopback; no credentials/fragments', () => {
    expect(redirectUriRegistrable('https://client.example/cb')).toBe(true);
    expect(redirectUriRegistrable('http://127.0.0.1:8080/cb')).toBe(true);
    expect(redirectUriRegistrable('http://localhost/cb')).toBe(true);
    expect(redirectUriRegistrable('http://client.example/cb')).toBe(false); // http off-loopback
    expect(redirectUriRegistrable('https://u:p@client.example/cb')).toBe(false);
    expect(redirectUriRegistrable('https://client.example/cb#frag')).toBe(false);
    expect(redirectUriRegistrable('custom-scheme://cb')).toBe(false);
    expect(redirectUriRegistrable('not a url')).toBe(false);
  });
  it('matching: exact for https; loopback ignores the PORT only (RFC 8252 §7.3)', () => {
    const reg = ['https://client.example/cb', 'http://127.0.0.1/callback'];
    expect(redirectUriMatches('https://client.example/cb', reg)).toBe(true);
    expect(redirectUriMatches('https://client.example/other', reg)).toBe(false);
    expect(redirectUriMatches('http://127.0.0.1:49152/callback', reg)).toBe(true); // ephemeral port OK
    expect(redirectUriMatches('http://127.0.0.1:49152/other', reg)).toBe(false); // path still strict
    expect(redirectUriMatches('http://localhost:49152/callback', reg)).toBe(false); // host still strict
    expect(redirectUriMatches('http://evil.example/callback', reg)).toBe(false);
  });
});
