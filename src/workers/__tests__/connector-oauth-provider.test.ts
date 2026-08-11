import { describe, expect, it, vi } from 'vitest';
import {
  createCodeVerifier,
  exchangeGoogleAuthorizationCode,
  googleAuthorizationUrl,
  refreshGoogleAccessToken,
  revokeGoogleGrant,
} from '../services/connector-oauth-provider';

const ENV = {
  CONNECTOR_GOOGLE_CLIENT_ID: 'client-id',
  CONNECTOR_GOOGLE_CLIENT_SECRET: 'client-secret',
  CONNECTOR_GOOGLE_OAUTH_VERIFICATION_STATUS: 'pilot_test_users',
  CONNECTOR_OAUTH_REDIRECT_URI: 'https://app.xlooop.com/settings/integrations',
};
const TOKENS = {
  access_token: 'access-1', refresh_token: 'refresh-1', token_type: 'Bearer',
  expires_at: '2026-08-11T12:00:00.000Z', scopes: ['openid', 'email'],
};

describe('dedicated Google connector provider', () => {
  it('fails closed when the Google OAuth verification posture is undeclared', async () => {
    const unproven = { ...ENV, CONNECTOR_GOOGLE_OAUTH_VERIFICATION_STATUS: undefined };
    await expect(googleAuthorizationUrl(unproven, 'gmail', 'state', createCodeVerifier()))
      .rejects.toThrow('CONNECTOR_GOOGLE_OAUTH_VERIFICATION_UNPROVEN');
  });

  it('creates a PKCE offline incremental-consent authorization URL', async () => {
    const verifier = createCodeVerifier();
    const url = new URL(await googleAuthorizationUrl(ENV, 'gmail', 'sealed-state', verifier));
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(url.origin).toBe('https://accounts.google.com');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('include_granted_scopes')).toBe('true');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('scope')).toContain('gmail.readonly');
  });

  it('exchanges code plus verifier and refuses an exchange without a refresh token', async () => {
    const fetchOk = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: 'access', refresh_token: 'refresh', expires_in: 3600, token_type: 'Bearer',
        scope: 'openid email https://www.googleapis.com/auth/gmail.readonly',
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ sub: 'acct_1', email: 'person@example.com' }), { status: 200 }));
    const result = await exchangeGoogleAuthorizationCode(ENV, 'gmail', 'code', 'verifier', fetchOk);
    expect(result).toMatchObject({ authority_provider: 'google', provider_account_id: 'acct_1', provider_label: 'person@example.com' });
    expect(String(fetchOk.mock.calls[0][1]?.body)).toContain('code_verifier=verifier');

    const fetchMissingRefresh = vi.fn().mockResolvedValue(new Response(JSON.stringify({ access_token: 'access' }), { status: 200 }));
    await expect(exchangeGoogleAuthorizationCode(ENV, 'gmail', 'code', 'verifier', fetchMissingRefresh)).rejects.toThrow('CODE_EXCHANGE_FAILED');
  });

  it('refreshes and verifies revocation by requiring invalid_grant afterwards', async () => {
    const refreshFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ access_token: 'access-2', expires_in: 1800 }), { status: 200 }));
    const refreshed = await refreshGoogleAccessToken(ENV, TOKENS, refreshFetch);
    expect(refreshed.access_token).toBe('access-2');
    expect(refreshed.refresh_token).toBe('refresh-1');

    const revokeFetch = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }));
    await expect(revokeGoogleGrant(ENV, TOKENS, revokeFetch)).resolves.toMatchObject({ status: 'revoked' });
    expect(revokeFetch).toHaveBeenCalledTimes(2);

    const unverifiable = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'still-valid', expires_in: 3600 }), { status: 200 }));
    await expect(revokeGoogleGrant(ENV, TOKENS, unverifiable)).rejects.toThrow('REVOCATION_VERIFICATION_FAILED');
  });
});
