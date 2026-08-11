// Dedicated connector OAuth token encryption and callback-state sealing.
// Connector keys are distinct from model-runtime keys and Clerk identity keys.

const IV_BYTES = 12;
const KEY_BYTES = 32;
const TOKEN_PREFIX = 'xco1';
const STATE_PREFIX = 'xcs1';

export interface ConnectorOAuthEncryptionEnv {
  CONNECTOR_OAUTH_ENC_KEYS?: string;
  CONNECTOR_OAUTH_ACTIVE_KEY_ID?: string;
  CONNECTOR_OAUTH_STATE_KEY?: string;
}

export interface ConnectorOAuthKeyring {
  active_key_id: string;
  keys: Record<string, string>;
}

export interface ConnectorTokenPayload {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_at: string;
  scopes: string[];
}

export interface ConnectorOAuthStatePayload {
  user_id: string;
  workspace_id: string;
  provider: 'google_drive' | 'gmail';
  code_verifier: string;
  redirect_uri: string;
  nonce: string;
  expires_at_ms: number;
}

export interface ConnectorTokenContext {
  workspace_id: string;
  user_id: string;
  grant_id: string;
}

async function sha256B64url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return bytesToB64url(new Uint8Array(digest));
}

export async function connectorOAuthNonceHash(nonce: string): Promise<string> {
  if (!nonce) throw new Error('connector OAuth nonce is required');
  return sha256B64url(`xlooop:connector-oauth:nonce:v1:${nonce}`);
}

export async function connectorOAuthGrantId(context: {
  workspace_id: string;
  user_id: string;
  authority_provider: 'google';
  provider_account_id: string;
}): Promise<string> {
  if (!context.workspace_id || !context.user_id || !context.provider_account_id) {
    throw new Error('connector OAuth grant identity is incomplete');
  }
  const digest = await sha256B64url(
    `xlooop:connector-oauth:grant:v1:${context.workspace_id}:${context.user_id}:${context.authority_provider}:${context.provider_account_id}`,
  );
  return `cog_${digest.slice(0, 32)}`;
}

function bytesToB64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(length));
  crypto.getRandomValues(bytes);
  return bytes;
}

function encodedBytes(value: string): Uint8Array<ArrayBuffer> {
  const encoded = new TextEncoder().encode(value);
  const copy = new Uint8Array(new ArrayBuffer(encoded.byteLength));
  copy.set(encoded);
  return copy;
}

async function importKey(base64Key: string | undefined, label: string): Promise<CryptoKey> {
  if (!base64Key) throw new Error(`${label} is not configured`);
  let raw: Uint8Array<ArrayBuffer>;
  try {
    raw = b64urlToBytes(base64Key);
  } catch {
    throw new Error(`${label} is not valid base64`);
  }
  if (raw.byteLength !== KEY_BYTES) throw new Error(`${label} must decode to ${KEY_BYTES} bytes`);
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export function connectorOAuthKeyring(env: ConnectorOAuthEncryptionEnv): ConnectorOAuthKeyring {
  try {
    const parsed = JSON.parse(env.CONNECTOR_OAUTH_ENC_KEYS || '{}') as Record<string, unknown>;
    return {
      active_key_id: (env.CONNECTOR_OAUTH_ACTIVE_KEY_ID || '').trim(),
      keys: Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
    };
  } catch {
    return { active_key_id: '', keys: {} };
  }
}

export async function isConnectorOAuthEncryptionConfigured(env: ConnectorOAuthEncryptionEnv): Promise<boolean> {
  try {
    const keyring = connectorOAuthKeyring(env);
    await importKey(keyring.keys[keyring.active_key_id], 'CONNECTOR_OAUTH_ACTIVE_KEY');
    await importKey(env.CONNECTOR_OAUTH_STATE_KEY, 'CONNECTOR_OAUTH_STATE_KEY');
    return true;
  } catch {
    return false;
  }
}

function tokenAad(context: ConnectorTokenContext): Uint8Array<ArrayBuffer> {
  if (!context.workspace_id || !context.user_id || !context.grant_id) throw new Error('connector token context is incomplete');
  return encodedBytes(`xlooop:connector-oauth:v1:${context.workspace_id}:${context.user_id}:${context.grant_id}`);
}

export async function sealConnectorTokens(
  env: ConnectorOAuthEncryptionEnv,
  payload: ConnectorTokenPayload,
  context: ConnectorTokenContext,
): Promise<{ ciphertext: string; iv: string }> {
  const keyring = connectorOAuthKeyring(env);
  const keyId = keyring.active_key_id;
  if (!keyId || !keyring.keys[keyId]) throw new Error('CONNECTOR_OAUTH_ACTIVE_KEY_ID is not configured');
  const masterKey = await importKey(keyring.keys[keyId], 'CONNECTOR_OAUTH_ACTIVE_KEY');
  const aad = tokenAad(context);
  const dataKeyRaw = randomBytes(KEY_BYTES);
  const dataKey = await crypto.subtle.importKey('raw', dataKeyRaw, { name: 'AES-GCM' }, false, ['encrypt']);
  const wrapIv = randomBytes(IV_BYTES);
  const dataIv = randomBytes(IV_BYTES);
  const wrappedKey = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: wrapIv, additionalData: aad }, masterKey, dataKeyRaw);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: dataIv, additionalData: aad },
    dataKey,
    encodedBytes(JSON.stringify(payload)),
  );
  return {
    ciphertext: [TOKEN_PREFIX, encodeURIComponent(keyId), bytesToB64url(wrapIv), bytesToB64url(new Uint8Array(wrappedKey)), bytesToB64url(dataIv), bytesToB64url(new Uint8Array(ciphertext))].join('.'),
    iv: bytesToB64url(dataIv),
  };
}

export async function openConnectorTokens(
  env: ConnectorOAuthEncryptionEnv,
  sealed: { ciphertext: string; iv: string },
  context: ConnectorTokenContext,
): Promise<ConnectorTokenPayload> {
  const parts = sealed.ciphertext.split('.');
  if (parts.length !== 6 || parts[0] !== TOKEN_PREFIX) throw new Error('unsupported connector token envelope');
  if (sealed.iv !== parts[4]) throw new Error('connector token envelope IV mismatch');
  const keyring = connectorOAuthKeyring(env);
  const keyId = decodeURIComponent(parts[1]);
  const masterKey = await importKey(keyring.keys[keyId], `CONNECTOR_OAUTH_KEY:${keyId}`);
  const aad = tokenAad(context);
  const dataKeyRaw = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64urlToBytes(parts[2]), additionalData: aad },
    masterKey,
    b64urlToBytes(parts[3]),
  );
  const dataKey = await crypto.subtle.importKey('raw', dataKeyRaw, { name: 'AES-GCM' }, false, ['decrypt']);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64urlToBytes(parts[4]), additionalData: aad },
    dataKey,
    b64urlToBytes(parts[5]),
  );
  const payload = JSON.parse(new TextDecoder().decode(plaintext)) as ConnectorTokenPayload;
  if (!payload.access_token || !payload.refresh_token || !payload.expires_at || !Array.isArray(payload.scopes)) {
    throw new Error('connector token payload is incomplete');
  }
  return payload;
}

export async function sealConnectorOAuthState(
  stateKey: string | undefined,
  payload: ConnectorOAuthStatePayload,
): Promise<string> {
  const key = await importKey(stateKey, 'CONNECTOR_OAUTH_STATE_KEY');
  const iv = randomBytes(IV_BYTES);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encodedBytes('xlooop:connector-oauth:state:v1') },
    key,
    encodedBytes(JSON.stringify(payload)),
  );
  return [STATE_PREFIX, bytesToB64url(iv), bytesToB64url(new Uint8Array(ciphertext))].join('.');
}

export async function openConnectorOAuthState(
  stateKey: string | undefined,
  value: string,
  nowMs: number = Date.now(),
): Promise<ConnectorOAuthStatePayload | null> {
  try {
    const parts = value.split('.');
    if (parts.length !== 3 || parts[0] !== STATE_PREFIX) return null;
    const key = await importKey(stateKey, 'CONNECTOR_OAUTH_STATE_KEY');
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64urlToBytes(parts[1]), additionalData: encodedBytes('xlooop:connector-oauth:state:v1') },
      key,
      b64urlToBytes(parts[2]),
    );
    const payload = JSON.parse(new TextDecoder().decode(plaintext)) as ConnectorOAuthStatePayload;
    if (!payload.user_id || !payload.workspace_id || !payload.code_verifier || !payload.nonce) return null;
    if (!['google_drive', 'gmail'].includes(payload.provider)) return null;
    if (payload.expires_at_ms <= nowMs) return null;
    return payload;
  } catch {
    return null;
  }
}
