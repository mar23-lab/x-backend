// entitlement-live-membership.test.ts · 260730
//
// Discharges the obligation workspace-member-store.ts:267-275 assigned and never collected:
//
//   "enforcement is flag-off today (inert), and the ENTITLEMENT_ENFORCEMENT flip (Tranche C)
//    re-derives authority from LIVE membership; that derivation must exclude soft-removed members
//    (removed_at IS NOT NULL) — tracked as the flip's responsibility, not this membership write's."
//
// ENTITLEMENT_ENFORCEMENT flipped to "on" on 260720. The derivation was never updated. Until the
// accompanying change, a soft-removed member kept allowed_actions ['*'] and operating_mode
// 'operator': removal, the first control an owner reaches for, revoked nothing.
//
// WHY THIS TEST IS SHAPED THIS WAY, AND WHAT IT DOES NOT PROVE.
//
// The existing seeded test (spine-authority-seeded.test.ts:14-17) mocks the Sql driver as
//   (_strings, ...vals) => rowsByUser[vals[0]] ?? []
// It never inspects the query, so it returns identical rows whether or not the statement joins
// workspace_members. That mock CANNOT observe this defect — which is precisely why the defect
// survived the flag flip. A behavioural assertion written at that layer would be vacuous, and this
// estate has enough vacuous assertions.
//
// So this asserts the CONTRACT OF THE EMITTED STATEMENT, and says so plainly. It is structural, not
// end-to-end: it proves the derivation asks the database to exclude non-live members. It does NOT
// prove Postgres honours it — only a live two-member fixture does that, and the live-RLS proofs
// correctly exit 2 without a disposable database, so they cannot run here. That gap is named rather
// than papered over.
//
// Blast radius was measured against production before landing, not assumed. Of 11 entitlement rows,
// exactly one fails the new join: user_3EG6hekj2J4VdVjH7RQrinrmTwi — the duplicate orphan
// marat@xlooop.com, which holds allowed_actions with NO workspace_members row at all. The real
// account (user_3EINskyClTUBH6Obs9G46gvnBE4) retains access on all nine of its workspaces. So this
// also closes the orphan-identity hazard without a dedupe migration.
import { describe, it, expect } from 'vitest';
import { getAppEntitlementRow } from '../dal/entitlement-store';

/** Sql stub that records the statement text instead of pretending to execute it. */
function capturingSql(rows: Record<string, unknown>[] = []) {
  const seen: string[] = [];
  const sql = ((strings: TemplateStringsArray, ..._vals: unknown[]) => {
    seen.push(strings.join(' ? '));
    return Promise.resolve(rows);
  }) as never;
  return { sql, statement: () => seen.join('\n').toLowerCase().replace(/\s+/g, ' ') };
}

const ROW: Record<string, unknown> = {
  id: 'e1', user_id: 'u1', workspace_id: 'w1', app_id: 'xlooop-product',
  allowed_modes: ['watch', 'test', 'operator'], allowed_actions: ['*'], denied_actions: [],
  authority_ref: 'role-mirror', revoked_at: null, metadata: null,
  granted_at: '2026-07-08T00:00:00Z', created_at: null, updated_at: null,
};

describe('entitlement derivation is bound to LIVE membership', () => {
  it('joins workspace_members — an entitlement alone must not confer authority', async () => {
    const c = capturingSql([ROW]);
    await getAppEntitlementRow(c.sql, 'u1', 'w1');
    expect(c.statement()).toContain('join workspace_members');
  });

  it('excludes soft-removed members (removed_at IS NULL)', async () => {
    const c = capturingSql([ROW]);
    await getAppEntitlementRow(c.sql, 'u1', 'w1');
    // The literal removal marker: workspace-member-store.ts:313 writes `SET removed_at = now()`.
    expect(c.statement()).toContain('removed_at is null');
  });

  it('requires an ACTIVE membership, not merely a present row', async () => {
    const c = capturingSql([ROW]);
    await getAppEntitlementRow(c.sql, 'u1', 'w1');
    expect(c.statement()).toMatch(/status\s*=\s*'active'/);
  });

  it('correlates the join on BOTH user and workspace, never user alone', async () => {
    // A join on user_id only would let a live membership in workspace A resurrect a revoked
    // entitlement in workspace B — a cross-tenant authority leak wearing a fix's clothing.
    const c = capturingSql([ROW]);
    await getAppEntitlementRow(c.sql, 'u1', 'w1');
    expect(c.statement()).toContain('wm.user_id = ce.user_id');
    expect(c.statement()).toContain('wm.workspace_id = ce.workspace_id');
  });

  it('still fails closed when the read returns nothing', async () => {
    const c = capturingSql([]);
    await expect(getAppEntitlementRow(c.sql, 'u1', 'w1')).resolves.toBeNull();
  });

  it('still fails closed on a driver error rather than propagating it', async () => {
    const throwing = (() => Promise.reject(new Error('relation does not exist'))) as never;
    await expect(getAppEntitlementRow(throwing, 'u1', 'w1')).resolves.toBeNull();
  });

  it('refuses empty identifiers without touching the database', async () => {
    const c = capturingSql([ROW]);
    await expect(getAppEntitlementRow(c.sql, '', 'w1')).resolves.toBeNull();
    await expect(getAppEntitlementRow(c.sql, 'u1', '')).resolves.toBeNull();
    expect(c.statement()).toBe('');
  });
});
