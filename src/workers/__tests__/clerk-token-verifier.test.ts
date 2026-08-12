import { describe, expect, it } from 'vitest';
import {
  clerkVerificationFailureCode,
  unwrapClerkVerificationResult,
} from '../services/clerk-token-verifier';

describe('Clerk token verification result contract', () => {
  it('unwraps the installed SDK success shape', () => {
    expect(unwrapClerkVerificationResult({
      data: { sub: 'user_test', org_id: 'org_test' },
    })).toEqual({ sub: 'user_test', org_id: 'org_test' });
  });

  it('fails closed on the installed SDK error shape', () => {
    expect(() => unwrapClerkVerificationResult({
      errors: [new Error('signature invalid')],
    })).toThrow('signature invalid');
  });

  it('keeps legacy test doubles explicit at the adapter boundary', () => {
    expect(unwrapClerkVerificationResult({ sub: 'user_legacy' })).toEqual({
      sub: 'user_legacy',
    });
  });

  it('rejects empty or ambiguous results', () => {
    expect(() => unwrapClerkVerificationResult({})).toThrow('no claims');
  });
});

describe('Clerk token verification diagnostics', () => {
  it.each([
    [{ reason: 'token-expired' }, 'token_expired'],
    [{ reason: 'jwk-kid-mismatch' }, 'signing_key_mismatch'],
    [new Error('Token is not active yet'), 'token_not_active'],
    [new Error('Authorized party mismatch'), 'authorized_party_mismatch'],
    [new Error('Unable to resolve verification key'), 'verification_key_unavailable'],
    [new Error('Invalid signature'), 'signature_invalid'],
    [new Error('JWT decode failed'), 'token_malformed'],
    [new Error('unexpected failure'), 'verification_failed'],
  ])('maps %p to %s without returning raw text', (error, expected) => {
    expect(clerkVerificationFailureCode(error)).toBe(expected);
  });
});
