import { describe, expect, it } from 'vitest';
import { unwrapClerkVerificationResult } from '../services/clerk-token-verifier';

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
