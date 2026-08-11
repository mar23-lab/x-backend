// Source token adapter backed by Xlooop-owned connector grants. It deliberately
// has no Clerk dependency: sign-in identity and source authorization are separate.

import type { DalAdapter } from './DalAdapter';
import type {
  OAuthAccessTokenSnapshot,
  OAuthProvider,
  SourceOAuthTokenAdapter,
  UserId,
} from './types';
import type { ConnectorOAuthEncryptionEnv } from '../lib/connector-oauth-crypto';
import {
  openConnectorTokens,
  sealConnectorTokens,
} from '../lib/connector-oauth-crypto';
import type { ConnectorOAuthProviderEnv } from '../services/connector-oauth-provider';
import { refreshGoogleAccessToken } from '../services/connector-oauth-provider';

export type ConnectorOAuthRuntimeEnv = ConnectorOAuthEncryptionEnv & ConnectorOAuthProviderEnv;

function connectorError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

export function makeConnectorOAuthGrantAdapter(input: {
  dal: Pick<
    DalAdapter,
    'getConnectorOAuthGrantSecret' | 'updateConnectorOAuthGrantTokens' | 'markConnectorOAuthGrantRefreshError'
  >;
  env: ConnectorOAuthRuntimeEnv;
  workspace_id: string;
  user_id: UserId;
  grant_id: string;
  fetch_impl?: typeof fetch;
}): SourceOAuthTokenAdapter {
  const { dal, env, workspace_id: workspaceId, user_id: ownerUserId, grant_id: grantId } = input;
  const fetchImpl = input.fetch_impl ?? fetch;
  return {
    async getAccessToken(
      userId: UserId,
      provider: OAuthProvider,
      opts: { force_refresh?: boolean } = {},
    ): Promise<OAuthAccessTokenSnapshot> {
      if (userId !== ownerUserId) {
        throw connectorError('OAUTH_GRANT_OWNER_MISMATCH', 'connector grant owner does not match the request identity');
      }
      if (provider !== 'google_drive' && provider !== 'gmail') {
        throw connectorError('OAUTH_INVALID_PROVIDER', `dedicated Google connector grant cannot serve ${provider}`);
      }
      const grant = await dal.getConnectorOAuthGrantSecret(workspaceId, ownerUserId, grantId);
      if (!grant || grant.status === 'revoked') {
        throw connectorError('OAUTH_REVOKED', 'connector grant is absent or revoked');
      }
      let tokens;
      try {
        tokens = await openConnectorTokens(
          env,
          { ciphertext: grant.token_ciphertext, iv: grant.token_iv },
          { workspace_id: workspaceId, user_id: ownerUserId, grant_id: grantId },
        );
      } catch {
        throw connectorError('OAUTH_TOKEN_DECRYPTION_FAILED', 'connector credential could not be opened');
      }
      const expiresAtMs = Date.parse(tokens.expires_at);
      const needsRefresh = opts.force_refresh === true
        || !Number.isFinite(expiresAtMs)
        || expiresAtMs <= Date.now() + 60_000;
      if (needsRefresh) {
        try {
          tokens = await refreshGoogleAccessToken(env, tokens, fetchImpl);
          const sealed = await sealConnectorTokens(
            env,
            tokens,
            { workspace_id: workspaceId, user_id: ownerUserId, grant_id: grantId },
          );
          const persisted = await dal.updateConnectorOAuthGrantTokens({
            id: grantId,
            workspace_id: workspaceId,
            user_id: ownerUserId,
            token_ciphertext: sealed.ciphertext,
            token_iv: sealed.iv,
            scopes: tokens.scopes,
            access_expires_at: tokens.expires_at,
          });
          if (!persisted) throw new Error('grant changed during refresh');
        } catch (error) {
          await dal.markConnectorOAuthGrantRefreshError({
            id: grantId,
            workspace_id: workspaceId,
            user_id: ownerUserId,
            error: (error as Error).message || 'connector OAuth refresh failed',
          });
          throw connectorError('OAUTH_REFRESH_FAILED', 'connector access could not be refreshed');
        }
      }
      return {
        provider,
        token: tokens.access_token,
        external_account_id: grant.id,
        scopes: tokens.scopes,
        label: grant.provider_label,
        fetched_at: new Date().toISOString(),
      };
    },
  };
}
