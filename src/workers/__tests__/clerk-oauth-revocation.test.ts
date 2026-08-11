import { beforeEach, describe, expect, it, vi } from 'vitest';

const clerkState = vi.hoisted(() => ({
  accounts: [] as Array<{ id: string; provider: string }>,
  passwordEnabled: false,
  emailAddresses: [] as Array<{ id: string }>,
  preserveAfterDelete: false,
  deleteCalls: [] as Array<{ userId: string; externalAccountId: string }>,
}));

vi.mock('@clerk/backend', () => ({
  createClerkClient: () => ({
    users: {
      getUser: async () => ({
        externalAccounts: clerkState.accounts,
        passwordEnabled: clerkState.passwordEnabled,
        emailAddresses: clerkState.emailAddresses,
        phoneNumbers: [],
        samlAccounts: [],
      }),
      deleteUserExternalAccount: async (input: { userId: string; externalAccountId: string }) => {
        clerkState.deleteCalls.push(input);
        if (!clerkState.preserveAfterDelete) {
          clerkState.accounts = clerkState.accounts.filter((account) => account.id !== input.externalAccountId);
        }
        return { id: input.externalAccountId, object: 'external_account', deleted: true };
      },
    },
  }),
}));

import { makeClerkOAuthAdapter } from '../dal/clerk-oauth-adapter';

beforeEach(() => {
  clerkState.accounts = [{ id: 'eacc_google', provider: 'google' }];
  clerkState.passwordEnabled = false;
  clerkState.emailAddresses = [{ id: 'idn_email' }];
  clerkState.preserveAfterDelete = false;
  clerkState.deleteCalls = [];
});

describe('Clerk connector revocation authority', () => {
  it('deletes the exact link-only external account and verifies absence', async () => {
    const receipt = await makeClerkOAuthAdapter('sk_test_x')
      .revokeLinkOnlyGrant('user_1', 'gmail', 'eacc_google');

    expect(receipt).toMatchObject({
      authority: 'clerk_external_account',
      authority_mode: 'clerk_link_only',
      provider: 'gmail',
      status: 'revoked',
      identity_preserved: true,
    });
    expect(clerkState.deleteCalls).toEqual([{ userId: 'user_1', externalAccountId: 'eacc_google' }]);
  });

  it('is idempotent when the upstream account is already absent', async () => {
    clerkState.accounts = [];
    const receipt = await makeClerkOAuthAdapter('sk_test_x')
      .revokeLinkOnlyGrant('user_1', 'gmail', 'eacc_google');

    expect(receipt.status).toBe('already_absent');
    expect(clerkState.deleteCalls).toHaveLength(0);
  });

  it('refuses to remove the last viable sign-in factor', async () => {
    clerkState.emailAddresses = [];
    await expect(makeClerkOAuthAdapter('sk_test_x')
      .revokeLinkOnlyGrant('user_1', 'gmail', 'eacc_google'))
      .rejects.toMatchObject({ code: 'OAUTH_IDENTITY_FALLBACK_REQUIRED' });
    expect(clerkState.deleteCalls).toHaveLength(0);
  });

  it('fails closed when Clerk still returns the account after deletion', async () => {
    clerkState.preserveAfterDelete = true;
    await expect(makeClerkOAuthAdapter('sk_test_x')
      .revokeLinkOnlyGrant('user_1', 'gmail', 'eacc_google'))
      .rejects.toMatchObject({ code: 'OAUTH_REVOCATION_VERIFICATION_FAILED' });
  });
});
