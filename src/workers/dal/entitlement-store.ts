// entitlement-store.ts · Wave OA-SAFE (260708) · the REAL per-principal entitlement reader (P0-0).
//
// Reads the per-(user, workspace) entitlement from `customer_entitlements` (migration 018) and maps it to the
// canonical AppEntitlement. This is the source that REPLACES the role-derived fabrication in buildPrincipal
// (modesForRole + hardcoded allowed_actions/denied_actions/status) — at the CUTOVER. It is NOT wired into any
// production path yet: `customer_entitlements` is EMPTY in prod (0 rows), so hydrating from it today would
// fail-closed every user. Production keeps the legacy role-derived path until the operator-gated cutover
// (054 UNIQUE(user_id, workspace_id, app_id) → 055 role-mirror backfill → wire behind a flag). See
// docs/governance/OPERATOR_AXIS_AUTHORITY.md. Mirrors the read style of dal/investor-store.ts.
//
// GRAIN: per-(user, workspace) (operator decision 260708). The prod table is multi-workspace (11 memberships /
// 4 users), so authority must be scoped by workspace_id — a per-user row would leak operator authority across
// tenants. The reader therefore requires BOTH user_id and workspace_id.
//
// SCHEMA note: customer_entitlements has real allowed_modes/allowed_actions/denied_actions + revoked_at. status
// is DERIVED from revoked_at (no status column). expires_at/review_due are now REAL nullable columns (migration
// 060, additive) — surfaced when present, null when the grant is open-ended. This reader does NOT deny on
// expiry (status stays active/revoked); expiry-based denial would be a separate, named enforcement decision.

import type { Sql } from '../db/client';
import type { AppEntitlement, OperatingMode } from './types/xcp-identity-contracts';

// The table stores app_id='xlooop-product' (its DEFAULT); the canonical XcpAppId is 'xlooop'.
const PRODUCT_APP_ID = 'xlooop-product';
const CANONICAL_APP_ID = 'xlooop' as const;

/** Fetch the caller's live xlooop entitlement for THIS workspace, or null (⇒ evaluateAppAccess fails closed).
 *  Degrade-safe: any error (e.g. table absent in a bare test DB) → null, never a throw. */
export async function getAppEntitlementRow(sql: Sql, userId: string, workspaceId: string): Promise<AppEntitlement | null> {
  if (!userId || !workspaceId) return null;
  try {
    const rows = (await sql/*sql*/`
      SELECT ce.id, ce.user_id, ce.workspace_id, ce.app_id,
             ce.allowed_modes, ce.allowed_actions, ce.denied_actions,
             ce.authority_ref, ce.revoked_at, ce.expires_at, ce.review_due,
             ce.metadata, ce.created_at, ce.updated_at
      FROM customer_entitlements ce
      -- 260730 · DISCHARGES THE TRANCHE-C OBLIGATION.
      --
      -- workspace-member-store.ts:267-275 deliberately does NOT revoke entitlements when a member is
      -- soft-removed, and says why: "enforcement is flag-off today (inert), and the
      -- ENTITLEMENT_ENFORCEMENT flip (Tranche C) re-derives authority from LIVE membership; that
      -- derivation must exclude soft-removed members (removed_at IS NOT NULL) — tracked as the
      -- flip's responsibility, not this membership write's."
      --
      -- That was the correct seam. ENTITLEMENT_ENFORCEMENT flipped to "on" on 260720
      -- (wrangler.toml) and this derivation was never updated, so the obligation the comment
      -- assigned has been outstanding since. Until now the grant outlived the membership: a
      -- soft-removed member kept allowed_actions ['*'] and operating_mode 'operator', and removal —
      -- the first thing an owner reaches for — closed nothing.
      --
      -- Joining here rather than revoking at the removal write is deliberate and stronger: it binds
      -- authority to LIVE membership for every caller and every future removal path, including ones
      -- that do not exist yet. A revoke-on-write fix would have to be repeated at each new site.
      JOIN workspace_members wm
        ON wm.user_id = ce.user_id
       AND wm.workspace_id = ce.workspace_id
       AND wm.removed_at IS NULL
       AND wm.status = 'active'
      WHERE ce.user_id = ${userId} AND ce.workspace_id = ${workspaceId} AND ce.app_id = ${PRODUCT_APP_ID}
      ORDER BY ce.granted_at DESC NULLS LAST
      LIMIT 1
    `) as Record<string, unknown>[];
    const r = rows[0];
    if (!r) return null; // ← FAIL CLOSED (no entitlement)
    return toAppEntitlement(r);
  } catch (err) {
    // 260806 (9.6 tranche 2): the fail-CLOSED posture here is CORRECT and deliberately kept — an
    // entitlement must never be granted on an unreadable read. The defect was the SILENCE: an
    // entitled, paying customer served the locked product on a DB blip was indistinguishable from
    // a customer who never bought it. The log is what separates "not entitled" from "could not
    // check" so support and telemetry can see the outage instead of a churn signal.
    console.log(JSON.stringify({ kind: 'entitlement_read_failed_fail_closed', error: String((err as Error)?.message || err).slice(0, 200) }));
    return null; // degrade-safe: never let a read error read as authorized
  }
}

/** Pure mapper (unit-testable without a DB): customer_entitlements row → canonical AppEntitlement. */
export function toAppEntitlement(r: Record<string, unknown>): AppEntitlement {
  const revoked = r['revoked_at'] != null;
  return {
    app_id: CANONICAL_APP_ID,
    status: revoked ? 'revoked' : 'active', // no status column yet; revoked_at is the signal
    enabled_by: 'customer_entitlements',
    authority_ref: String(r['authority_ref'] ?? ''),
    risk_lane: 'customer-internal',
    expires_at: toIsoOrNull(r['expires_at']), // migration 060 (nullable; null = open-ended grant)
    review_due: toIsoOrNull(r['review_due']), // migration 060 (nullable; null = no review scheduled)
    allowed_modes: asStringArray(r['allowed_modes']) as OperatingMode[],
    allowed_actions: asStringArray(r['allowed_actions']),
    denied_actions: asStringArray(r['denied_actions']),
  };
}

/** Normalize a TIMESTAMPTZ (Date | ISO string | null) to an ISO string, or null. Never throws. */
function toIsoOrNull(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  const s = String(v).trim();
  return s ? s : null;
}

/** neon returns TEXT[] as a JS array; fall back to parsing a pg array literal defensively. */
function asStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === 'string' && v.startsWith('{') && v.endsWith('}')) {
    return v.slice(1, -1).split(',').map((s) => s.trim().replace(/^"|"$/g, '')).filter(Boolean);
  }
  return [];
}
