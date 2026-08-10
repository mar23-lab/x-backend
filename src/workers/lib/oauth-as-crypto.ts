// oauth-as-crypto.ts · Stage-2 second half (260806, operator-approved plan) · the STATELESS
// crypto core of the PKCE authorization server.
//
// DESIGN: zero DDL. Clients and auth codes carry their own state, integrity-protected under one
// worker secret (OAUTH_SIGNING_KEY):
//   - client_id  = `xlc_` b64url(JSON{ru,iat}) `.` HMAC-SHA256 tag  — self-validating DCR; the
//     redirect check is membership in the SIGNED payload, so a forged client cannot smuggle a
//     redirect target.
//   - auth code  = `xac_` b64url( IV ∥ AES-GCM-256(JSON grant) )     — the grant binds client,
//     redirect, PKCE challenge, workspace, user, role and a 10-minute expiry. Single-use is NOT
//     this module's job (the route claims a row in idempotency_keys at redemption).
// Every function here is PURE over (input, secret, now) — unit-tested without a worker.

const enc = new TextEncoder();
const dec = new TextDecoder();

export const AUTH_CODE_TTL_SECONDS = 600; // 10 minutes — RFC 6749 §4.1.2 "A maximum … of 10 minutes is RECOMMENDED"

export function b64urlEncode(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function b64urlDecode(s: string): Uint8Array | null {
  try {
    const pad = s.length % 4 === 2 ? '==' : s.length % 4 === 3 ? '=' : '';
    const raw = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

export async function sha256HexOf(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(value));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
async function aesKey(secret: string): Promise<CryptoKey> {
  const keyBytes = await crypto.subtle.digest('SHA-256', enc.encode(secret));
  return crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

// ── Stateless DCR client ids ─────────────────────────────────────────────────────────────────────

export interface OAuthClientRecord {
  /** Registered redirect URIs — the ONLY authority on where a code may be sent. */
  ru: string[];
  /** issued-at (seconds) — informational; client ids do not expire. */
  iat: number;
}

export async function mintClientId(redirectUris: string[], secret: string, nowMs: number): Promise<string> {
  const payload = b64urlEncode(enc.encode(JSON.stringify({ ru: redirectUris, iat: Math.floor(nowMs / 1000) } satisfies OAuthClientRecord)));
  const tag = b64urlEncode(new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(payload))));
  return `xlc_${payload}.${tag}`;
}

export async function verifyClientId(clientId: string, secret: string): Promise<OAuthClientRecord | null> {
  if (!clientId.startsWith('xlc_')) return null;
  const dot = clientId.indexOf('.');
  if (dot < 0) return null;
  const payload = clientId.slice(4, dot);
  const tag = b64urlDecode(clientId.slice(dot + 1));
  if (!tag) return null;
  const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), tag as unknown as ArrayBuffer, enc.encode(payload) as unknown as ArrayBuffer);
  if (!ok) return null;
  const raw = b64urlDecode(payload);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(dec.decode(raw)) as OAuthClientRecord;
    if (!Array.isArray(parsed.ru) || parsed.ru.some((u) => typeof u !== 'string')) return null;
    return parsed;
  } catch {
    return null;
  }
}

// ── Sealed authorization-code grants ─────────────────────────────────────────────────────────────

export interface OAuthGrant {
  /** SHA-256 hex of the client_id the code was issued to (full id would bloat the code). */
  cid_sha: string;
  redirect_uri: string;
  /** The S256 code_challenge the token exchange must satisfy. */
  cc: string;
  workspace_id: string;
  user_id: string;
  role: 'viewer' | 'operator';
  scopes: string[];
  /** expiry, epoch seconds. */
  exp: number;
  /** random nonce — makes every code unique even for identical grants. */
  n: string;
}

export async function sealGrant(grant: OAuthGrant, secret: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(secret), enc.encode(JSON.stringify(grant))));
  const packed = new Uint8Array(iv.length + ct.length);
  packed.set(iv, 0);
  packed.set(ct, iv.length);
  return `xac_${b64urlEncode(packed)}`;
}

export async function openGrant(code: string, secret: string, nowMs: number): Promise<OAuthGrant | null> {
  if (!code.startsWith('xac_')) return null;
  const packed = b64urlDecode(code.slice(4));
  if (!packed || packed.length < 13) return null;
  try {
    const iv = packed.slice(0, 12);
    const ct = packed.slice(12);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, await aesKey(secret), ct as unknown as ArrayBuffer);
    const grant = JSON.parse(dec.decode(new Uint8Array(pt))) as OAuthGrant;
    if (typeof grant.exp !== 'number' || grant.exp * 1000 <= nowMs) return null; // expired ⇒ invalid, same as tampered
    if (grant.role !== 'viewer' && grant.role !== 'operator') return null;
    if (!Array.isArray(grant.scopes) || grant.scopes.some((scope) => typeof scope !== 'string')) return null;
    return grant;
  } catch {
    return null; // tamper, wrong key, malformed — all indistinguishable by design
  }
}

// ── PKCE (S256 only) ─────────────────────────────────────────────────────────────────────────────

export async function s256Challenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(verifier));
  return b64urlEncode(new Uint8Array(digest));
}

// ── Redirect URI policy ──────────────────────────────────────────────────────────────────────────

/** Registration-time policy: https everywhere, plain http ONLY for loopback hosts (RFC 8252 §7.3). */
export function redirectUriRegistrable(uri: string): boolean {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.username || u.password || u.hash) return false;
  if (u.protocol === 'https:') return true;
  if (u.protocol === 'http:') return isLoopbackHost(u.hostname);
  return false;
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]' || hostname === 'localhost';
}

/**
 * Request-time match against the registered list: exact string match, EXCEPT loopback redirects,
 * which compare scheme+host+path and IGNORE the port — RFC 8252 §7.3: a native client's loopback
 * listener binds an ephemeral port, so the registered and requested ports legitimately differ.
 */
export function redirectUriMatches(requested: string, registered: string[]): boolean {
  if (registered.includes(requested)) return true;
  let req: URL;
  try {
    req = new URL(requested);
  } catch {
    return false;
  }
  if (req.protocol !== 'http:' || !isLoopbackHost(req.hostname)) return false;
  return registered.some((r) => {
    let reg: URL;
    try {
      reg = new URL(r);
    } catch {
      return false;
    }
    return reg.protocol === 'http:' && isLoopbackHost(reg.hostname)
      && reg.hostname === req.hostname && reg.pathname === req.pathname
      && reg.search === req.search;
  });
}
