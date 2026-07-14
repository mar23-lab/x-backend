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
      SELECT id, user_id, workspace_id, app_id, allowed_modes, allowed_actions, denied_actions,
             authority_ref, revoked_at, expires_at, review_due, metadata, created_at, updated_at
      FROM customer_entitlements
      WHERE user_id = ${userId} AND workspace_id = ${workspaceId} AND app_id = ${PRODUCT_APP_ID}
      ORDER BY granted_at DESC NULLS LAST
      LIMIT 1
    `) as Record<string, unknown>[];
    const r = rows[0];
    if (!r) return null; // ← FAIL CLOSED (no entitlement)
    return toAppEntitlement(r);
  } catch {
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
