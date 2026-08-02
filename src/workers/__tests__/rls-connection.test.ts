import { describe, expect, it } from 'vitest';
import type { Sql } from '../db/client';
import { resolveRlsSql, rlsBindingMode } from '../db/rls-connection';

// A sentinel that is identity-comparable, so a test can prove WHICH connection came back rather
// than merely that something did. The previous fail-open returned the owner connection silently;
// the only way to catch that is to assert on identity.
const ownerSql = (() => {}) as unknown as Sql;

describe('resolveRlsSql · tenant reads must never silently fall back to the BYPASSRLS owner role', () => {
  it('FAILS CLOSED under production authority when the RLS DSN is unbound', () => {
    expect(() => resolveRlsSql({ XLOOOP_AUTHORITY_MODE: 'production' }, ownerSql))
      .toThrowError(/RLS-subject database connection is unavailable/);
  });

  it('the production refusal is a 503 SERVICE_UNAVAILABLE, not a 500', () => {
    // 503 is deliberate: an unbound secret is a recoverable configuration state, not a code fault.
    // A 500 would also be captured to Sentry as a server bug and buried among real faults.
    try {
      resolveRlsSql({ XLOOOP_AUTHORITY_MODE: 'production' }, ownerSql);
      throw new Error('resolveRlsSql did not throw under production authority');
    } catch (err) {
      expect(err).toMatchObject({ code: 'SERVICE_UNAVAILABLE', status: 503 });
    }
  });

  it('does NOT return the owner connection under production authority', () => {
    // The regression this whole module exists to prevent. If the fail-open ever comes back, this
    // assertion is the one that catches it — the throw tests above would still pass if someone
    // "helpfully" restored a fallback AFTER the throw.
    let returned: Sql | undefined;
    try {
      returned = resolveRlsSql({ XLOOOP_AUTHORITY_MODE: 'production' }, ownerSql);
    } catch {
      returned = undefined;
    }
    expect(returned).toBeUndefined();
  });

  it('falls back to the owner connection OUTSIDE production, so local work is unaffected', () => {
    expect(resolveRlsSql({}, ownerSql)).toBe(ownerSql);
    expect(resolveRlsSql({ XLOOOP_AUTHORITY_MODE: 'shadow' }, ownerSql)).toBe(ownerSql);
    expect(resolveRlsSql({ XLOOOP_AUTHORITY_MODE: 'development' }, ownerSql)).toBe(ownerSql);
  });

  it('returns a NON-owner connection when the RLS DSN is bound, in every authority mode', () => {
    const dsn = 'postgres://app:pw@example.invalid/neondb';
    for (const mode of ['production', 'shadow', undefined]) {
      const resolved = resolveRlsSql(
        { XLOOOP_RLS_APP_DATABASE_URL: dsn, DATABASE_URL: 'postgres://owner:pw@example.invalid/neondb', XLOOOP_AUTHORITY_MODE: mode },
        ownerSql,
      );
      expect(resolved).not.toBe(ownerSql);
    }
  });
});

describe('rlsBindingMode · keeps the posture externally observable on /health', () => {
  it('reports app when the subject DSN is bound and owner when it is not', () => {
    expect(rlsBindingMode({ XLOOOP_RLS_APP_DATABASE_URL: 'postgres://app@x/db' })).toBe('app');
    expect(rlsBindingMode({})).toBe('owner');
  });
});
