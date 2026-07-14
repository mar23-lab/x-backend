// investor-store.ts · investor-portal entitlement + NDA group (Track B / Wave R-I.7 Stage C).
//
// Authority: migrations/0004_investor_portal_stage_c.sql (investor_entitlements, nda_acceptances) ·
// DATABASE_SCHEMA_V1.md · API_CONTRACT_V1.md. Lifted verbatim out of WorkersDalAdapter
// (Stage 3.1, F10) to decompose the DAL god-object; behaviour is byte-for-byte identical to the
// prior inline methods.
//
// These methods are CALLER-SCOPED (WHERE user_id = ...) or admin-route-gated, NOT
// workspace_id-scoped, so there is NO assertWorkspaceScope call — identical to the inline
// originals. makeError is imported from ./shared-helpers (same call shape). No audit-log writes
// here (the inline originals had none), so no appendAuditLogRow is replicated.
//
// NOTE: getSessionEntitlement is NOT in this group — despite the "Entitlement" name it is the
// R40 session/access gate (users + access_requests + workspace_members + projects), touches NO
// investor table, and stays on the DAL.

import { makeError } from './shared-helpers';
import type {
  NdaAcceptance,
  NdaAcceptanceInput,
  InvestorEntitlement,
  GrantInvestorTier1Input,
  EscalateInvestorTier2Input,
  RevokeInvestorTier2Input,
} from './types';
import type { Sql } from '../db/client';

// ------------------------------------------------------------
// Public store functions (delegation targets)
// ------------------------------------------------------------

export async function getInvestorEntitlementRow(sql: Sql, userId: string): Promise<InvestorEntitlement | null> {
  if (!userId) return null;
  const rows = (await sql/*sql*/`
    SELECT id, user_id, workspace_id, tier, scope_project_ref,
           granted_at, granted_by, revoked_at, revoked_by, revoked_reason,
           section_filter_json AS section_filter, metadata, created_at, updated_at
    FROM investor_entitlements
    WHERE user_id = ${userId} AND revoked_at IS NULL
    ORDER BY granted_at DESC NULLS LAST
    LIMIT 1
  `) as Record<string, unknown>[];
  const r = rows[0];
  if (!r) return null;
  return {
    ...r,
    section_filter: typeof r['section_filter'] === 'string' ? JSON.parse(r['section_filter'] as string) : (r['section_filter'] ?? null),
    metadata: typeof r['metadata'] === 'string' ? JSON.parse(r['metadata'] as string) : (r['metadata'] ?? {}),
  } as InvestorEntitlement;
}

export async function grantInvestorEntitlementRow(
  sql: Sql,
  input: { userId: string; tier: string; workspaceId?: string | null; sectionFilter?: unknown },
  grantedBy: string,
): Promise<{ id: string; user_id: string; tier: string; granted_at: string; granted_by: string } | null> {
  if (!input?.userId || !input?.tier || !grantedBy) return null;
  const id = `inv_ent_${(globalThis.crypto as { randomUUID(): string }).randomUUID()}`;
  const sectionFilterJson = (input.sectionFilter != null) ? JSON.stringify(input.sectionFilter) : null;
  const rows = (await sql`
    INSERT INTO investor_entitlements
      (id, user_id, workspace_id, tier, section_filter_json, granted_at, granted_by, created_at, updated_at)
    VALUES (
      ${id}, ${input.userId}, ${input.workspaceId ?? null}, ${input.tier},
      ${sectionFilterJson}, now()::text, ${grantedBy}, now()::text, now()::text
    )
    RETURNING id, user_id, tier, granted_at, granted_by
  `) as Record<string, unknown>[];
  const r = rows[0];
  if (!r) return null;
  return {
    id: String(r.id), user_id: String(r.user_id), tier: String(r.tier),
    granted_at: String(r.granted_at || ''), granted_by: String(r.granted_by || ''),
  };
}

export async function getLatestNdaAcceptanceRow(sql: Sql, userId: string): Promise<
  { nda_version: string; accepted_at: string | null; email: string | null; full_name_typed: string | null } | null
> {
  if (!userId) return null;
  const rows = (await sql`
    SELECT nda_version, accepted_at, email, full_name_typed
    FROM nda_acceptances
    WHERE user_id = ${userId}
    ORDER BY accepted_at DESC NULLS LAST
    LIMIT 1
  `) as Record<string, unknown>[];
  const r = rows[0];
  if (!r) return null;
  return {
    nda_version: String(r.nda_version || ''),
    accepted_at: r.accepted_at ? String(r.accepted_at) : null,
    email: r.email ? String(r.email) : null,
    full_name_typed: r.full_name_typed ? String(r.full_name_typed) : null,
  };
}

export async function recordNdaAcceptanceRow(sql: Sql, input: NdaAcceptanceInput): Promise<NdaAcceptance> {
  // Full impl: see feat/investor-portal-stage-c (stash@{0})
  // Minimal impl for merge: insert NDA acceptance record
  const id = 'nda_' + Date.now().toString(36);
  const acceptedAt = new Date().toISOString();
  const ndaVersion = input.nda_version || 'NDA_v1';
  const rows = (await sql/*sql*/`
    INSERT INTO nda_acceptances (id, user_id, access_request_id, email, full_name_typed, nda_version, accepted_at, ip_address, user_agent, metadata)
    VALUES (${id}, ${input.user_id ?? null}, ${input.access_request_id}, ${input.email}, ${input.full_name_typed?.trim()}, ${ndaVersion}, ${acceptedAt}, ${input.ip_address ?? null}, ${input.user_agent ?? null}, ${JSON.stringify(input.metadata ?? {})}::jsonb)
    ON CONFLICT (access_request_id, email) DO UPDATE SET full_name_typed = EXCLUDED.full_name_typed, nda_version = EXCLUDED.nda_version, accepted_at = ${acceptedAt}, ip_address = EXCLUDED.ip_address
    RETURNING id, user_id, access_request_id, email, full_name_typed, nda_version, accepted_at, ip_address, user_agent, metadata, created_at
  `) as NdaAcceptance[];
  return rows[0]!;
}

export async function grantInvestorTier1Row(sql: Sql, input: GrantInvestorTier1Input): Promise<InvestorEntitlement> {
  // GrantInvestorTier1Input uses clerk_user_id (optional) + email (optional) + granted_by
  // Full implementation is in feat/investor-portal-stage-c (stash@{0})
  // This stub satisfies the DalAdapter interface contract.
  const id = 'inv_ent_' + Date.now().toString(36);
  const grantedAt = new Date().toISOString();
  const userId = input.clerk_user_id ?? null;
  const scopeRef = 'x-biz-investor-readiness';
  const rows = (await sql/*sql*/`
    INSERT INTO investor_entitlements (id, user_id, workspace_id, tier, scope_project_ref, granted_at, granted_by, section_filter_json, metadata)
    VALUES (${id}, ${userId}, ${null}, 'tier-1', ${scopeRef}, ${grantedAt}, ${input.granted_by}, 'null'::jsonb, '{}'::jsonb)
    RETURNING id, user_id, workspace_id, tier, scope_project_ref, granted_at, granted_by, revoked_at, revoked_by, revoked_reason, section_filter_json AS section_filter, metadata, created_at, updated_at
  `) as Record<string, unknown>[];
  if (!rows[0]) throw makeError('INTERNAL_ERROR', 'failed to grant investor Tier-1', 500);
  const r = rows[0] as Record<string, unknown>;
  return { ...r, section_filter: null, metadata: {} } as unknown as InvestorEntitlement;
}

export async function escalateInvestorToTier2Row(sql: Sql, input: EscalateInvestorTier2Input): Promise<InvestorEntitlement> {
  const updatedAt = new Date().toISOString();
  const sectionFilter = input.section_filter ?? null;
  const rows = (await sql/*sql*/`
    UPDATE investor_entitlements
    SET tier = 'tier-2', section_filter_json = ${JSON.stringify(sectionFilter)}::jsonb, updated_at = ${updatedAt}
    WHERE user_id = ${input.user_id} AND scope_project_ref = 'x-biz-investor-readiness' AND revoked_at IS NULL
    RETURNING id, user_id, workspace_id, tier, scope_project_ref, granted_at, granted_by, revoked_at, revoked_by, revoked_reason, section_filter_json AS section_filter, metadata, created_at, updated_at
  `) as Record<string, unknown>[];
  if (!rows[0]) throw makeError('NOT_FOUND', 'no entitlement found for user ' + input.user_id, 404);
  const r = rows[0] as Record<string, unknown>;
  return { ...r, section_filter: r['section_filter'], metadata: r['metadata'] } as InvestorEntitlement;
}

export async function revokeInvestorTier2Row(sql: Sql, input: RevokeInvestorTier2Input): Promise<InvestorEntitlement> {
  const updatedAt = new Date().toISOString();
  const rows = (await sql/*sql*/`
    UPDATE investor_entitlements
    SET tier = 'tier-1', updated_at = ${updatedAt}, revoked_by = ${input.revoked_by}, revoked_reason = ${input.reason ?? null}
    WHERE user_id = ${input.user_id} AND scope_project_ref = 'x-biz-investor-readiness' AND tier = 'tier-2'
    RETURNING id, user_id, workspace_id, tier, scope_project_ref, granted_at, granted_by, revoked_at, revoked_by, revoked_reason, section_filter_json AS section_filter, metadata, created_at, updated_at
  `) as Record<string, unknown>[];
  if (!rows[0]) throw makeError('NOT_FOUND', 'no Tier-2 entitlement found for user ' + input.user_id, 404);
  const r = rows[0] as Record<string, unknown>;
  return { ...r, section_filter: r['section_filter'], metadata: r['metadata'] } as InvestorEntitlement;
}
