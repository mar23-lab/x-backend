import { describe, expect, it } from 'vitest';
import {
  connectorOAuthGrantId,
  connectorOAuthNonceHash,
  isConnectorOAuthEncryptionConfigured,
  openConnectorOAuthState,
  openConnectorTokens,
  sealConnectorOAuthState,
  sealConnectorTokens,
} from '../lib/connector-oauth-crypto';

const key = (fill: number) => Buffer.alloc(32, fill).toString('base64url');
const ENV = {
  CONNECTOR_OAUTH_ENC_KEYS: JSON.stringify({ k1: key(7), old: key(8) }),
  CONNECTOR_OAUTH_ACTIVE_KEY_ID: 'k1',
  CONNECTOR_OAUTH_STATE_KEY: key(9),
};
const CONTEXT = { workspace_id: 'org_acme', user_id: 'user_1', grant_id: 'cog_1' };
const TOKENS = {
  access_token: 'access-secret',
  refresh_token: 'refresh-secret',
  token_type: 'Bearer',
  expires_at: '2026-08-11T12:00:00.000Z',
  scopes: ['openid', 'email'],
};

describe('connector OAuth cryptography', () => {
  it('detects complete and incomplete keyrings', async () => {
    await expect(isConnectorOAuthEncryptionConfigured(ENV)).resolves.toBe(true);
    await expect(isConnectorOAuthEncryptionConfigured({})).resolves.toBe(false);
  });

  it('round-trips tokens without embedding plaintext and binds the tenant/user/grant AAD', async () => {
    const sealed = await sealConnectorTokens(ENV, TOKENS, CONTEXT);
    expect(sealed.ciphertext).not.toContain('access-secret');
    expect(sealed.ciphertext).not.toContain('refresh-secret');
    await expect(openConnectorTokens(ENV, sealed, CONTEXT)).resolves.toEqual(TOKENS);
    await expect(openConnectorTokens(ENV, sealed, { ...CONTEXT, workspace_id: 'org_other' })).rejects.toThrow();
    await expect(openConnectorTokens(ENV, { ...sealed, iv: 'changed' }, CONTEXT)).rejects.toThrow('IV mismatch');
  });

  it('seals callback state, rejects tampering and expiry, and yields stable non-raw identifiers', async () => {
    const payload = {
      user_id: 'user_1', workspace_id: 'org_acme', provider: 'gmail' as const,
      code_verifier: 'verifier', redirect_uri: 'https://app.xlooop.com/settings/integrations',
      nonce: 'private-nonce', expires_at_ms: 10_000,
    };
    const sealed = await sealConnectorOAuthState(ENV.CONNECTOR_OAUTH_STATE_KEY, payload);
    await expect(openConnectorOAuthState(ENV.CONNECTOR_OAUTH_STATE_KEY, sealed, 9_000)).resolves.toEqual(payload);
    await expect(openConnectorOAuthState(ENV.CONNECTOR_OAUTH_STATE_KEY, sealed, 10_001)).resolves.toBeNull();
    await expect(openConnectorOAuthState(ENV.CONNECTOR_OAUTH_STATE_KEY, `${sealed}x`, 9_000)).resolves.toBeNull();
    const nonceHash = await connectorOAuthNonceHash(payload.nonce);
    expect(nonceHash).not.toContain(payload.nonce);
    const grantA = await connectorOAuthGrantId({
      workspace_id: 'org_acme', user_id: 'user_1', authority_provider: 'google', provider_account_id: 'acct_1',
    });
    const grantB = await connectorOAuthGrantId({
      workspace_id: 'org_acme', user_id: 'user_1', authority_provider: 'google', provider_account_id: 'acct_1',
    });
    expect(grantA).toBe(grantB);
    expect(grantA).toMatch(/^cog_[A-Za-z0-9_-]{32}$/);
    expect(grantA).not.toContain('acct_1');
  });
});
