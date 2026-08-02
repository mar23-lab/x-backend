// rls-connection.ts · ONE place that decides which connection a tenant-scoped read runs on.
//
// WHY THIS EXISTS — measured 2026-08-03 against the production database.
//
// Six call sites independently wrote the same fail-OPEN expression:
//
//     env.XLOOOP_RLS_APP_DATABASE_URL ? neonClient(env.XLOOOP_RLS_APP_DATABASE_URL) : sql
//     neonClient(env.XLOOOP_RLS_APP_DATABASE_URL || env.DATABASE_URL)
//
// index.ts:172 (request), :384 (cron), :465 (queue), documents.ts:114, :173,
// mcp-customer-reads.ts:141. If that one secret is ever unbound, mistyped, or rotated away,
// every "tenant-scoped" read silently continues on the OWNER connection. There is no error and
// no log; the only external signal is `bindings.rls_binding` on GET /api/v1/health, which exists
// precisely because the state was otherwise unobservable — and nothing alerts on it.
//
// That fallback is a TOTAL bypass, not a partial one. Measured on the production branch:
//
//     public tables 96 · RLS enabled 73 · with policies 50 · granted to xlooop_app 30
//     tables granted to a non-owner role WITHOUT (RLS AND >=1 policy):  0   <- invariant holds
//     relforcerowsecurity:  0 of 96                                        <- nothing is FORCEd
//     roles with BYPASSRLS: cloud_admin, neon_service, neondb_owner, neon_superuser
//
// `neondb_owner` is the role behind DATABASE_URL and it carries BYPASSRLS, and because no table
// sets FORCE, every policy on all 73 RLS-enabled tables is inert on that connection. So the
// difference between "the secret is bound" and "the secret is missing" is the difference between
// full tenant isolation and none, decided silently at runtime.
//
// The grant-parity invariant itself is clean today, and the 23 policy-less tables from migration
// 092 are deliberate fail-closed future-grant insurance. This module protects the OTHER half:
// that the subject connection is actually the subject connection.
//
// POSTURE: fail CLOSED under production authority, fall back only outside it. A loud 503 is the
// correct trade against a silent cross-tenant read. Development and test keep the old behaviour
// so local work without the secret is unaffected.

import { neonClient, type Sql } from './client';
import { makeError } from '../dal/shared-helpers';

export interface RlsConnectionEnv {
  XLOOOP_RLS_APP_DATABASE_URL?: string;
  DATABASE_URL?: string;
  XLOOOP_AUTHORITY_MODE?: string;
}

/**
 * Resolve the RLS-subject (NOBYPASSRLS) connection for tenant-scoped reads.
 *
 * @param env        Worker env carrying the DSNs and the authority mode.
 * @param ownerSql   The already-constructed owner connection, used as the non-production fallback.
 * @returns          A connection bound to the RLS-subject role.
 * @throws           SERVICE_UNAVAILABLE (503) when authority is `production` and the DSN is absent.
 */
export function resolveRlsSql(env: RlsConnectionEnv, ownerSql: Sql): Sql {
  const dsn = env.XLOOOP_RLS_APP_DATABASE_URL;
  if (dsn) return neonClient(dsn);

  if (env.XLOOOP_AUTHORITY_MODE === 'production') {
    // Deliberately NOT a 500: this is a configuration/dependency state, not a code fault, and it
    // is recoverable by binding the secret. It must be loud — the whole point is that the previous
    // behaviour was silent.
    throw makeError(
      'SERVICE_UNAVAILABLE',
      'RLS-subject database connection is unavailable; refusing to serve tenant reads on the owner connection',
      503,
    );
  }

  return ownerSql;
}

/**
 * True when tenant reads are running on the RLS-subject role. Feeds `bindings.rls_binding` on
 * /health so the posture stays externally observable, which is how the fail-open was found.
 */
export function rlsBindingMode(env: RlsConnectionEnv): 'app' | 'owner' {
  return env.XLOOOP_RLS_APP_DATABASE_URL ? 'app' : 'owner';
}
