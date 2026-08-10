// model-runtime-crypto.ts · Wave C (260708) · encryption-at-rest for customer model-provider credentials.
//
// Cloudflare Workers have NO per-tenant secret vault (wrangler secrets are global), so a customer's
// provider credential (API key / cloud auth material) must be encrypted-at-rest in Postgres. This module
// is the ONLY place key material is turned into ciphertext (on write) or back into plaintext (on the
// provider-call path). New deployments use a versioned keyring; the legacy single
// MODEL_RUNTIME_ENC_KEY remains decrypt-compatible during rotation only.
//
// Boundary: this lib is KEY-INJECTED and called from the ROUTE layer (which has ctx.env). The DAL layer
// (constructed with sql only, no env) stores/returns only the opaque {ciphertext, iv, last4} triple and
// NEVER sees plaintext or the master key. Reads that reach a client are masked to `····last4` by the route
// serializer — plaintext and ciphertext never leave the worker.
//
// Crypto contract:
//  - AES-256-GCM via Web Crypto (crypto.subtle), available in the Workers runtime.
//  - a FRESH random 96-bit IV per encryption (GCM is catastrophically broken by IV reuse).
//  - Web Crypto APPENDS the 16-byte auth tag to the ciphertext; the whole blob is stored (base64).
//  - decrypt throws if the ciphertext/iv/tag was tampered (GCM integrity) — fail-closed.
//  - fail-closed on WRITE: a missing/malformed master key throws; plaintext is NEVER stored as a fallback.

const IV_BYTES = 12; // 96-bit — the GCM-recommended random IV size
const KEY_BYTES = 32; // AES-256
const ENVELOPE_PREFIX = 'xcp1';
const TENANT_ENVELOPE_PREFIX = 'xcp2';

export interface ModelRuntimeEncryptionKeyring {
  active_key_id: string;
  keys: Record<string, string>;
}
export type ModelRuntimeEncryptionConfig = string | ModelRuntimeEncryptionKeyring | undefined | null;
export interface ModelRuntimeEncryptionEnv {
  MODEL_RUNTIME_ENC_KEY?: string;
  MODEL_RUNTIME_ENC_KEYS?: string;
  MODEL_RUNTIME_ACTIVE_KEY_ID?: string;
}

export function modelRuntimeEncryptionConfig(env: ModelRuntimeEncryptionEnv): ModelRuntimeEncryptionConfig {
  if (env.MODEL_RUNTIME_ENC_KEYS !== undefined) {
    try {
      const parsed = JSON.parse(env.MODEL_RUNTIME_ENC_KEYS) as Record<string, unknown>;
      const keys = Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
      return { active_key_id: String(env.MODEL_RUNTIME_ACTIVE_KEY_ID ?? ''), keys };
    } catch {
      return { active_key_id: '', keys: {} };
    }
  }
  return env.MODEL_RUNTIME_ENC_KEY;
}

/** base64 (standard alphabet) of raw bytes — btoa/atob are available in the Workers runtime. */
function bytesToB64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

// Returns Uint8Array<ArrayBuffer> (not the widened ArrayBufferLike): crypto.subtle wants a BufferSource
// whose backing buffer is a plain ArrayBuffer. `new Uint8Array(number)` is ArrayBuffer-backed — sound, no cast.
function b64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Import the master key, validating it is exactly 32 bytes. Throws (fail-closed) when absent/malformed. */
async function importMasterKey(base64Key: string | undefined | null): Promise<CryptoKey> {
  if (!base64Key) throw new Error('MODEL_RUNTIME_ENC_KEY is not configured');
  let raw: Uint8Array<ArrayBuffer>;
  try {
    raw = b64ToBytes(base64Key);
  } catch {
    throw new Error('MODEL_RUNTIME_ENC_KEY is not valid base64');
  }
  if (raw.byteLength !== KEY_BYTES) {
    throw new Error(`MODEL_RUNTIME_ENC_KEY must decode to ${KEY_BYTES} bytes (got ${raw.byteLength})`);
  }
  // extractable = false: the raw key bytes cannot be read back out of the CryptoKey.
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/** The stored, at-rest form of a credential. Both fields base64. NEVER returned to a client. */
export interface SealedCredential {
  ciphertext: string; // base64 of (AES-GCM ciphertext || 16-byte tag)
  iv: string; // base64 of the 12-byte IV
}

export interface CredentialEnvelopeContext {
  tenant_id: string;
  purpose: string;
}

/** Key id carried by a versioned envelope, or null for legacy unversioned ciphertext. */
export function credentialEnvelopeKeyId(sealed: Pick<SealedCredential, 'ciphertext'>): string | null {
  const match = sealed.ciphertext.match(/^xcp[12]\.([^.]+)\./);
  return match ? decodeURIComponent(match[1]) : null;
}

export function credentialEnvelopeVersion(sealed: Pick<SealedCredential, 'ciphertext'>): 0 | 1 | 2 {
  if (sealed.ciphertext.startsWith(`${TENANT_ENVELOPE_PREFIX}.`)) return 2;
  if (sealed.ciphertext.startsWith(`${ENVELOPE_PREFIX}.`)) return 1;
  return 0;
}

/** Active key id for rotation workflows. Legacy single-key deployments return null. */
export function modelRuntimeActiveKeyId(config: ModelRuntimeEncryptionConfig): string | null {
  if (!config || typeof config === 'string') return null;
  const keyId = config.active_key_id.trim();
  return keyId && config.keys[keyId] ? keyId : null;
}

/** Encrypt a plaintext credential (typically a JSON string) with a fresh IV. Fail-closed on a bad key. */
export async function encryptCredential(
  config: ModelRuntimeEncryptionConfig,
  plaintext: string,
  context?: CredentialEnvelopeContext,
): Promise<SealedCredential> {
  const keyId = typeof config === 'object' && config ? config.active_key_id.trim() : '';
  const base64Key = typeof config === 'string' ? config : keyId ? config?.keys[keyId] : undefined;
  if (typeof config === 'object' && config && !keyId) throw new Error('MODEL_RUNTIME_ACTIVE_KEY_ID is not configured');
  if (typeof config === 'object' && config && keyId && !base64Key) throw new Error(`active model-runtime encryption key is missing: ${keyId}`);
  const key = await importMasterKey(base64Key);
  if (context) {
    const tenantId = context.tenant_id.trim();
    const purpose = context.purpose.trim();
    if (!tenantId || !purpose) throw new Error('credential envelope tenant_id and purpose are required');
    const aad = new TextEncoder().encode(`xlooop:model-runtime:v2:${tenantId}:${purpose}`);
    const dataKeyRaw = crypto.getRandomValues(new Uint8Array(KEY_BYTES));
    const dataKey = await crypto.subtle.importKey('raw', dataKeyRaw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
    const wrapIv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const dataIv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const wrappedDataKey = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: wrapIv, additionalData: aad },
      key,
      dataKeyRaw,
    );
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: dataIv, additionalData: aad },
      dataKey,
      new TextEncoder().encode(plaintext),
    );
    return {
      ciphertext: [
        TENANT_ENVELOPE_PREFIX,
        encodeURIComponent(keyId || 'legacy'),
        bytesToB64(wrapIv),
        bytesToB64(new Uint8Array(wrappedDataKey)),
        bytesToB64(dataIv),
        bytesToB64(new Uint8Array(ciphertext)),
      ].join('.'),
      iv: bytesToB64(dataIv),
    };
  }
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext));
  const ciphertext = bytesToB64(new Uint8Array(ct));
  return {
    ciphertext: keyId ? `${ENVELOPE_PREFIX}.${encodeURIComponent(keyId)}.${ciphertext}` : ciphertext,
    iv: bytesToB64(iv),
  };
}

/** Decrypt a sealed credential. Throws on a bad key or on tamper (GCM auth-tag failure). Internal-only. */
export async function decryptCredential(
  config: ModelRuntimeEncryptionConfig,
  sealed: SealedCredential,
  context?: CredentialEnvelopeContext,
): Promise<string> {
  const tenantEnvelope = sealed.ciphertext.match(/^xcp2\.([^.]+)\.([^.]+)\.([^.]+)\.([^.]+)\.(.+)$/);
  if (tenantEnvelope) {
    if (!context?.tenant_id.trim() || !context.purpose.trim()) {
      throw new Error('tenant envelope context is required');
    }
    const storedKeyId = decodeURIComponent(tenantEnvelope[1]);
    const base64Key = typeof config === 'string'
      ? (storedKeyId === 'legacy' ? config : undefined)
      : config?.keys?.[storedKeyId];
    if (!base64Key) throw new Error(`model-runtime encryption key is unavailable: ${storedKeyId}`);
    const aad = new TextEncoder().encode(
      `xlooop:model-runtime:v2:${context.tenant_id.trim()}:${context.purpose.trim()}`,
    );
    const masterKey = await importMasterKey(base64Key);
    const rawDataKey = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64ToBytes(tenantEnvelope[2]), additionalData: aad },
      masterKey,
      b64ToBytes(tenantEnvelope[3]),
    );
    const dataKey = await crypto.subtle.importKey('raw', rawDataKey, { name: 'AES-GCM' }, false, ['decrypt']);
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64ToBytes(tenantEnvelope[4]), additionalData: aad },
      dataKey,
      b64ToBytes(tenantEnvelope[5]),
    );
    return new TextDecoder().decode(plaintext);
  }
  const match = sealed.ciphertext.match(/^xcp1\.([^.]+)\.(.+)$/);
  const ciphertext = match ? match[2] : sealed.ciphertext;
  const storedKeyId = match ? decodeURIComponent(match[1]) : null;
  const iv = b64ToBytes(sealed.iv);
  const candidates = typeof config === 'string'
    ? [[null, config] as const]
    : Object.entries(config?.keys ?? {}).filter(([keyId]) => !storedKeyId || keyId === storedKeyId);
  if (storedKeyId && candidates.length === 0) throw new Error(`model-runtime encryption key is unavailable: ${storedKeyId}`);
  let lastError: unknown = new Error('MODEL_RUNTIME_ENC_KEY is not configured');
  for (const [, base64Key] of candidates) {
    try {
      const key = await importMasterKey(base64Key);
      const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, b64ToBytes(ciphertext));
      return new TextDecoder().decode(pt);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

/** The last 4 chars of a secret — the only part safe to persist as plaintext metadata for masked display. */
export function lastFour(secret: string): string {
  return secret.length <= 4 ? secret : secret.slice(-4);
}

/** Render the masked display form: four U+00B7 middle-dots + last4 (fixed-length; a proportional mask
 *  would leak the real key length). null when there is no stored credential (keyless-local provider). */
export function renderMaskedCredential(last4Value: string | null | undefined): string | null {
  return last4Value ? '····' + last4Value : null;
}

/** True iff the master key is present AND well-formed (32 bytes). Used to fail POST/PUT writes early with a
 *  clear 503 rather than a raw crypto error, without ever attempting to store plaintext. */
export async function isEncryptionConfigured(config: ModelRuntimeEncryptionConfig): Promise<boolean> {
  try {
    const keyId = typeof config === 'object' && config ? config.active_key_id.trim() : '';
    const base64Key = typeof config === 'string' ? config : keyId ? config?.keys[keyId] : undefined;
    if (typeof config === 'object' && config && (!keyId || !base64Key)) return false;
    await importMasterKey(base64Key);
    return true;
  } catch {
    return false;
  }
}

export async function isTenantEnvelopeEncryptionConfigured(config: ModelRuntimeEncryptionConfig): Promise<boolean> {
  if (!config || typeof config === 'string' || !modelRuntimeActiveKeyId(config)) return false;
  return isEncryptionConfigured(config);
}
