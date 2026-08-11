import { verifyToken } from '@clerk/backend';

export interface ClerkTokenVerificationEnv {
  CLERK_SECRET_KEY?: string;
  CLERK_JWT_KEY?: string;
}

export type ClerkTokenClaims = Record<string, unknown>;

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
