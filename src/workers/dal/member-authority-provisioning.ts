// member-authority-provisioning.ts · P5(a) (260708) · the STANDING provisioning writer that keeps the
// entitlement + operating-mode axes in lockstep with membership changes — closing the §5e stop-condition.
//
// WHY: migrations 055 (entitlement role-mirror) + 056 (operator-mode seed) are ONE-SHOT backfills over the
// members that existed at apply time. Without a standing writer, a member added or promoted AFTER the
// ENTITLEMENT_ENFORCEMENT flip has NO customer_entitlements row and NO user_session_preferences mode →
// missing_entitlement / watch-default → 403 on every governed write (the §5e lockout, per member). And a
// member DEMOTED after the flip would keep an operator-grade entitlement — the demotion would be a lie
// (HR-AFFORDANCE-ENFORCEMENT-PARITY-1 class, on the data axis). This writer mirrors BOTH directions.
//
// SEMANTICS (the 055/056 role-mirror SSOT, kept in lockstep):
//   owner/operator → modes [watch,test,operator] · actions ['*'] · denied []   + seed mode 'operator'
//   viewer         → modes [watch]               · actions []    · denied []   + force mode 'watch'
//   client         → modes [watch]               · actions []    · denied ['*'] + force mode 'watch'
// Entitlement is UPSERTED (promote AND demote re-mirror it — deny-wins rows stay curatable later: this is
// the same interim role-mirror posture as 055, not least-privilege curation). Mode: promotion seeds
// 'operator' WITHOUT clobbering an explicit user choice (ON CONFLICT DO NOTHING, 056 semantics); demotion
// to viewer/client FORCES 'watch' (losing the role means losing operator mode — fail-closed).
//
// DEGRADE-SAFE: provisioning must never break the member write itself (pre-054 test DBs lack the tables).
// Failures are console.warn'ed (structured, greppable) — NOT silent-dropped invisibly: the §5c per-key
// anti-join check is the standing drift detector that catches any missed provisioning.

import type { Sql } from '../db/client';

const PRODUCT_APP_ID = 'xlooop-product';

export type MemberRole = 'owner' | 'operator' | 'viewer' | 'client' | (string & {});

/** Pure 055-mirror: the entitlement grants for a role. Exported for tests + future curation tooling. */
export function roleMirrorEntitlement(role: MemberRole): {
  allowed_modes: string[]; allowed_actions: string[]; denied_actions: string[];
} {
  const operatorGrade = role === 'owner' || role === 'operator';
  return {
    allowed_modes: operatorGrade ? ['watch', 'test', 'operator'] : ['watch'],
    allowed_actions: operatorGrade ? ['*'] : [],
    denied_actions: role === 'client' ? ['*'] : [],
  };
}

export interface ProvisionInput {
  userId: string;
  workspaceId: string;
  role: MemberRole;
  /** who caused this membership change (used as granted_by; falls back to the member). */
  actorUserId?: string | null;
}

/**
 * The provisioning statements, as an array the caller can spread into an EXISTING sql.transaction([...])
 * (customer-provisioning + role-change run their member writes transactionally — provisioning rides the
 * same transaction so a member row can never commit without its authority rows).
 */
export function memberAuthorityProvisioningStatements(sql: Sql, input: ProvisionInput): unknown[] {
  const { userId, workspaceId, role } = input;
  const grantedBy = input.actorUserId || userId;
  const m = roleMirrorEntitlement(role);
  const stmts: unknown[] = [
    sql/*sql*/`
      INSERT INTO customer_entitlements
        (id, user_id, workspace_id, app_id, account_type,
         allowed_modes, allowed_actions, denied_actions,
         authority_ref, granted_at, granted_by, created_at, updated_at)
      VALUES
        ('cent_' || replace(gen_random_uuid()::text, '-', ''), ${userId}, ${workspaceId}, ${PRODUCT_APP_ID}, 'company',
         ${m.allowed_modes}::text[], ${m.allowed_actions}::text[], ${m.denied_actions}::text[],
         'provisioning:role-mirror', now(), ${grantedBy}, now(), now())
      ON CONFLICT (user_id, workspace_id, app_id) DO UPDATE SET
        allowed_modes = EXCLUDED.allowed_modes,
        allowed_actions = EXCLUDED.allowed_actions,
        denied_actions = EXCLUDED.denied_actions,
        authority_ref = 'provisioning:role-mirror',
        updated_at = now()
    `,
  ];
  if (role === 'owner' || role === 'operator') {
    // Promotion/creation: seed operator mode, NEVER clobbering an explicit user choice (056 semantics).
    stmts.push(sql/*sql*/`
      INSERT INTO user_session_preferences (user_id, workspace_id, operating_mode, updated_at)
      VALUES (${userId}, ${workspaceId}, 'operator', now())
      ON CONFLICT (user_id, workspace_id) DO NOTHING
    `);
  } else {
    // Demotion: losing the role means losing operator mode — force 'watch' (fail-closed on the mode axis).
    stmts.push(sql/*sql*/`
      INSERT INTO user_session_preferences (user_id, workspace_id, operating_mode, updated_at)
      VALUES (${userId}, ${workspaceId}, 'watch', now())
      ON CONFLICT (user_id, workspace_id) DO UPDATE SET operating_mode = 'watch', updated_at = now()
    `);
  }
  return stmts;
}

/**
 * Standalone form for non-transactional call sites (session-bootstrap owner, create-workspace owner):
 * awaits the statements directly. Degrade-safe — a provisioning failure is WARNED, never thrown, so the
 * member write itself cannot be broken by a pre-054 schema (tests) or a transient read-path error.
 */
export async function ensureMemberAuthorityProvisioned(sql: Sql, input: ProvisionInput): Promise<void> {
  let results: PromiseSettledResult<unknown>[] = [];
  try {
    // allSettled (not a sequential await-loop): the statements are created eagerly, so a throw on the
    // first must not leave the second as an unhandled rejection — every promise is consumed.
    results = await Promise.allSettled(
      memberAuthorityProvisioningStatements(sql, input) as Promise<unknown>[],
    );
  } catch (err) {
    results = [{ status: 'rejected', reason: err }];
  }
  const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failed.length) {
    try {
      console.warn(JSON.stringify({
        evt: 'member_authority_provisioning.failed',
        user_id: input.userId,
        workspace_id: input.workspaceId,
        role: input.role,
        error: failed.map((f) => String(f.reason)).join(' | '),
      }));
    } catch { /* best-effort */ }
  }
}
