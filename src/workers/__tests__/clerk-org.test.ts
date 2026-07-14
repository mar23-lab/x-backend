// clerk-org.test.ts - R55 Phase 4b - createTeamInvitation (Clerk org invitation wrapper)
//
// Tests the validation branches (no Clerk call), the success normalization, the undefined-field
// coercion (the @clerk/backend types make role/status optional), and Clerk-error wrapping.
// @clerk/backend is mocked via vi.hoisted so there is no network / SDK dependency.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockCreateInvitation } = vi.hoisted(() => ({ mockCreateInvitation: vi.fn() }));

vi.mock('@clerk/backend', () => ({
  createClerkClient: vi.fn(() => ({
    organizations: { createOrganizationInvitation: mockCreateInvitation },
  })),
}));

import { createTeamInvitation } from '../services/clerk-org';

const VALID = { organizationId: 'org_acme', inviterUserId: 'user_1', emailAddress: 'a@acme.com', role: 'org:member' };

beforeEach(() => {
  mockCreateInvitation.mockReset();
});

describe('createTeamInvitation - validation (throws before any Clerk call)', () => {
  it('throws CONFIG_ERROR when secretKey is missing', async () => {
    await expect(createTeamInvitation('', VALID)).rejects.toMatchObject({ code: 'CONFIG_ERROR' });
    expect(mockCreateInvitation).not.toHaveBeenCalled();
  });

  it('throws VALIDATION_ERROR when organizationId is missing', async () => {
    await expect(createTeamInvitation('sk_test', { ...VALID, organizationId: '' })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    expect(mockCreateInvitation).not.toHaveBeenCalled();
  });

  it('throws VALIDATION_ERROR when emailAddress is missing', async () => {
    await expect(createTeamInvitation('sk_test', { ...VALID, emailAddress: '' })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
  });
});

describe('createTeamInvitation - success + coercion', () => {
  it('forwards the org invitation args and returns the normalized shape', async () => {
    mockCreateInvitation.mockResolvedValueOnce({
      id: 'inv_1',
      emailAddress: 'a@acme.com',
      role: 'org:member',
      status: 'pending',
    });
    const r = await createTeamInvitation('sk_test', VALID);
    expect(r).toEqual({ invitation_id: 'inv_1', email: 'a@acme.com', role: 'org:member', status: 'pending' });
    expect(mockCreateInvitation).toHaveBeenCalledOnce();
    const arg = mockCreateInvitation.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.organizationId).toBe('org_acme');
    expect(arg.inviterUserId).toBe('user_1');
    expect(arg.emailAddress).toBe('a@acme.com');
    expect(arg.role).toBe('org:member');
  });

  it('coerces undefined Clerk fields using input fallbacks + pending status', async () => {
    // @clerk/backend types role/status as possibly-undefined; the wrapper must not surface undefined.
    mockCreateInvitation.mockResolvedValueOnce({ id: 'inv_2', emailAddress: undefined, role: undefined, status: undefined });
    const r = await createTeamInvitation('sk_test', VALID);
    expect(r.invitation_id).toBe('inv_2');
    expect(r.email).toBe('a@acme.com'); // fell back to input.emailAddress
    expect(r.role).toBe('org:member'); // fell back to input.role
    expect(r.status).toBe('pending'); // fell back to 'pending'
  });

  it('wraps a Clerk API error as CLERK_ORG_ERROR with the upstream message', async () => {
    mockCreateInvitation.mockRejectedValueOnce({ status: 422, errors: [{ message: 'already a member' }] });
    await expect(createTeamInvitation('sk_test', VALID)).rejects.toMatchObject({ code: 'CLERK_ORG_ERROR' });
  });
});
