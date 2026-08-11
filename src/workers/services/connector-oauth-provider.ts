// Native connector authorization provider adapters. Identity OAuth is intentionally absent.

import type { OAuthProvider } from '../dal/types';
import type { ConnectorTokenPayload } from '../lib/connector-oauth-crypto';

export interface ConnectorOAuthProviderEnv {
  CONNECTOR_GOOGLE_CLIENT_ID?: string;
  CONNECTOR_GOOGLE_CLIENT_SECRET?: string;
  CONNECTOR_GOOGLE_OAUTH_VERIFICATION_STATUS?: string;
  CONNECTOR_OAUTH_REDIRECT_URI?: string;
}

export type GoogleOAuthVerificationStatus = 'pilot_test_users' | 'verified';

export interface ConnectorProviderExchange {
  authority_provider: 'google';
  provider_account_id: string;
  provider_label: string | null;
  tokens: ConnectorTokenPayload;
}

const GOOGLE_AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GOOGLE_REVOCATION_ENDPOINT = 'https://oauth2.googleapis.com/revoke';
const GOOGLE_USERINFO_ENDPOINT = 'https://openidconnect.googleapis.com/v1/userinfo';
const ALLOWED_REDIRECT_ORIGINS = new Set(['https://app.xlooop.com', 'https://test.xlooop.com']);

const GOOGLE_SCOPES: Record<'google_drive' | 'gmail', string[]> = {
  google_drive: [
    'openid',
    'email',
    'profile',
    'https://www.googleapis.com/auth/drive.metadata.readonly',
  ],
  gmail: [
    'openid',
    'email',
    'profile',
    'https://www.googleapis.com/auth/gmail.readonly',
  ],
};

function requireGoogleConfig(env: ConnectorOAuthProviderEnv) {
  const clientId = (env.CONNECTOR_GOOGLE_CLIENT_ID || '').trim();
  const clientSecret = (env.CONNECTOR_GOOGLE_CLIENT_SECRET || '').trim();
  const redirectUri = (env.CONNECTOR_OAUTH_REDIRECT_URI || '').trim();
  const verificationStatus = (env.CONNECTOR_GOOGLE_OAUTH_VERIFICATION_STATUS || '').trim();
  if (!clientId || !clientSecret || !redirectUri) throw new Error('CONNECTOR_GOOGLE_OAUTH_NOT_CONFIGURED');
  if (verificationStatus !== 'pilot_test_users' && verificationStatus !== 'verified') {
    throw new Error('CONNECTOR_GOOGLE_OAUTH_VERIFICATION_UNPROVEN');
  }
  const redirect = new URL(redirectUri);
  if (redirect.protocol !== 'https:' || !ALLOWED_REDIRECT_ORIGINS.has(redirect.origin)) {
    throw new Error('CONNECTOR_OAUTH_REDIRECT_URI must use an approved Xlooop HTTPS app origin');
  }
  return {
    clientId,
    clientSecret,
    redirectUri,
    verificationStatus: verificationStatus as GoogleOAuthVerificationStatus,
  };
}

export function isGoogleConnectorOAuthConfigured(env: ConnectorOAuthProviderEnv): boolean {
  try {
    requireGoogleConfig(env);
    return true;
  } catch {
    return false;
  }
}

export function googleConnectorOAuthVerificationStatus(
  env: ConnectorOAuthProviderEnv,
): GoogleOAuthVerificationStatus | 'unproven' {
  const status = (env.CONNECTOR_GOOGLE_OAUTH_VERIFICATION_STATUS || '').trim();
  return status === 'pilot_test_users' || status === 'verified' ? status : 'unproven';
}

export function googleConnectorScopes(provider: 'google_drive' | 'gmail'): readonly string[] {
  return GOOGLE_SCOPES[provider];
}

function requireGoogleConnector(provider: OAuthProvider): asserts provider is 'google_drive' | 'gmail' {
  if (provider !== 'google_drive' && provider !== 'gmail') throw new Error(`CONNECTOR_OAUTH_PROVIDER_UNAVAILABLE:${provider}`);
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  let binary = '';
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function createCodeVerifier(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(48));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function googleAuthorizationUrl(
  env: ConnectorOAuthProviderEnv,
  provider: OAuthProvider,
  state: string,
  codeVerifier: string,
): Promise<string> {
  requireGoogleConnector(provider);
  const { clientId, redirectUri } = requireGoogleConfig(env);
  const url = new URL(GOOGLE_AUTHORIZATION_ENDPOINT);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('include_granted_scopes', 'true');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('scope', GOOGLE_SCOPES[provider].join(' '));
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('code_challenge', await sha256Base64Url(codeVerifier));
  return url.toString();
}

async function parseJson(response: Response): Promise<Record<string, unknown>> {
  return response.json().catch(() => ({})) as Promise<Record<string, unknown>>;
}

export async function exchangeGoogleAuthorizationCode(
  env: ConnectorOAuthProviderEnv,
  provider: OAuthProvider,
  code: string,
  codeVerifier: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ConnectorProviderExchange> {
  requireGoogleConnector(provider);
  const { clientId, clientSecret, redirectUri } = requireGoogleConfig(env);
  const tokenResponse = await fetchImpl(GOOGLE_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      code_verifier: codeVerifier,
    }),
  });
  const tokenBody = await parseJson(tokenResponse);
  if (!tokenResponse.ok || typeof tokenBody.access_token !== 'string' || typeof tokenBody.refresh_token !== 'string') {
    throw new Error(`CONNECTOR_OAUTH_CODE_EXCHANGE_FAILED:${String(tokenBody.error || tokenResponse.status)}`);
  }
  const userInfoResponse = await fetchImpl(GOOGLE_USERINFO_ENDPOINT, {
    headers: { authorization: `Bearer ${tokenBody.access_token}` },
  });
  const userInfo = await parseJson(userInfoResponse);
  if (!userInfoResponse.ok || typeof userInfo.sub !== 'string') {
    throw new Error(`CONNECTOR_OAUTH_ACCOUNT_LOOKUP_FAILED:${userInfoResponse.status}`);
  }
  const expiresAt = new Date(Date.now() + Number(tokenBody.expires_in || 3600) * 1000).toISOString();
  const scopes = String(tokenBody.scope || GOOGLE_SCOPES[provider].join(' ')).split(/\s+/).filter(Boolean);
  return {
    authority_provider: 'google',
    provider_account_id: userInfo.sub,
    provider_label: typeof userInfo.email === 'string' ? userInfo.email : null,
    tokens: {
      access_token: tokenBody.access_token,
      refresh_token: tokenBody.refresh_token,
      token_type: typeof tokenBody.token_type === 'string' ? tokenBody.token_type : 'Bearer',
      expires_at: expiresAt,
      scopes,
    },
  };
}

export async function refreshGoogleAccessToken(
  env: ConnectorOAuthProviderEnv,
  tokens: ConnectorTokenPayload,
  fetchImpl: typeof fetch = fetch,
): Promise<ConnectorTokenPayload> {
  const { clientId, clientSecret } = requireGoogleConfig(env);
  const response = await fetchImpl(GOOGLE_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: tokens.refresh_token,
      grant_type: 'refresh_token',
    }),
  });
  const body = await parseJson(response);
  if (!response.ok || typeof body.access_token !== 'string') {
    throw new Error(`CONNECTOR_OAUTH_REFRESH_FAILED:${String(body.error || response.status)}`);
  }
  return {
    ...tokens,
    access_token: body.access_token,
    token_type: typeof body.token_type === 'string' ? body.token_type : tokens.token_type,
    expires_at: new Date(Date.now() + Number(body.expires_in || 3600) * 1000).toISOString(),
    scopes: typeof body.scope === 'string' ? body.scope.split(/\s+/).filter(Boolean) : tokens.scopes,
  };
}

export async function revokeGoogleGrant(
  env: ConnectorOAuthProviderEnv,
  tokens: ConnectorTokenPayload,
  fetchImpl: typeof fetch = fetch,
): Promise<{ status: 'revoked' | 'already_absent'; verified_at: string }> {
  const response = await fetchImpl(GOOGLE_REVOCATION_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: tokens.refresh_token }),
  });
  const body = await parseJson(response);
  const alreadyAbsent = !response.ok && body.error === 'invalid_token';
  if (!response.ok && !alreadyAbsent) {
    throw new Error(`CONNECTOR_OAUTH_REVOCATION_FAILED:${String(body.error || response.status)}`);
  }
  if (!alreadyAbsent) {
    try {
      await refreshGoogleAccessToken(env, tokens, fetchImpl);
      throw new Error('CONNECTOR_OAUTH_REVOCATION_VERIFICATION_FAILED');
    } catch (error) {
      if ((error as Error).message === 'CONNECTOR_OAUTH_REVOCATION_VERIFICATION_FAILED') throw error;
      if (!/CONNECTOR_OAUTH_REFRESH_FAILED:invalid_grant/.test((error as Error).message)) throw error;
    }
  }
  return { status: alreadyAbsent ? 'already_absent' : 'revoked', verified_at: new Date().toISOString() };
}
