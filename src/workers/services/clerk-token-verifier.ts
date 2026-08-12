import { verifyToken } from '@clerk/backend';

export interface ClerkTokenVerificationEnv {
  CLERK_SECRET_KEY?: string;
  CLERK_JWT_KEY?: string;
}

export type ClerkTokenClaims = Record<string, unknown>;

export type ClerkVerificationFailureCode =
  | 'token_expired'
  | 'token_not_active'
  | 'authorized_party_mismatch'
  | 'signing_key_mismatch'
  | 'signature_invalid'
  | 'verification_key_unavailable'
  | 'token_malformed'
  | 'verification_failed';

/**
 * Normalize Clerk SDK verification results at one boundary. Clerk backend v1.34
 * returns `{ data, errors }`; older tests and adapters returned claims directly.
 */
export function unwrapClerkVerificationResult(result: unknown): ClerkTokenClaims {
  if (!isRecord(result)) {
    throw new Error('Clerk token verification returned an invalid result');
  }

  if (Array.isArray(result.errors) && result.errors.length > 0) {
    const first = result.errors[0];
    throw first instanceof Error
      ? first
      : new Error(`Clerk token verification failed: ${String(first)}`);
  }

  if (isRecord(result.data)) {
    return result.data;
  }

  // Compatibility for legacy adapters and isolated test doubles. Production
  // SDK results take the wrapped path above.
  if (typeof result.sub === 'string') {
    return result;
  }

  throw new Error('Clerk token verification returned no claims');
}

export async function verifyClerkSessionToken(
  token: string,
  env: ClerkTokenVerificationEnv,
  authorizedParties?: string[],
): Promise<ClerkTokenClaims> {
  const secretKey = env.CLERK_SECRET_KEY?.trim() || undefined;
  const jwtKey = env.CLERK_JWT_KEY?.trim() || undefined;
  if (!secretKey && !jwtKey) {
    throw new Error('Clerk JWT verification key is not configured');
  }

  const result = await verifyToken(token, {
    secretKey,
    jwtKey,
    authorizedParties,
  });
  return unwrapClerkVerificationResult(result);
}

/**
 * Reduce Clerk SDK failures to a non-sensitive operational code. Never return
 * the raw error text: it may contain token metadata or deployment details.
 */
export function clerkVerificationFailureCode(error: unknown): ClerkVerificationFailureCode {
  const value = isRecord(error) ? error : {};
  const reason = String(value.reason ?? '').toLowerCase();
  const code = String(value.code ?? '').toLowerCase();
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  const signal = `${reason} ${code} ${message}`;

  if (/expired/.test(signal)) return 'token_expired';
  if (/not.?active|not.?before|nbf|iat.*future/.test(signal)) return 'token_not_active';
  if (/authorized.?part|azp/.test(signal)) return 'authorized_party_mismatch';
  if (/kid.*mismatch|signing key|unable to find.*jwk/.test(signal)) return 'signing_key_mismatch';
  if (/signature/.test(signal)) return 'signature_invalid';
  if (/jwk|verification key|secret key/.test(signal)) return 'verification_key_unavailable';
  if (/malformed|decode|jwt.*invalid|invalid.*token/.test(signal)) return 'token_malformed';
  return 'verification_failed';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
