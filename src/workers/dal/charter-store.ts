// charter-store.ts · Wave 1 PR-1b (260721) · the workspace charter DAL.
//
// workspace_charter (migration 088) is the ONE charter per workspace — mission / background /
// industry / team_size / objectives_summary / constraints[] — the context-precedence layer-3 home
// the CANONICAL_DOMAIN_MODEL specifies and that provisioning seeds INTO and chat grounds FROM (the
// info->plan join). ONE row per workspace (workspace_id PRIMARY KEY).
//
// TENANCY (matches the estate's connection split): READS go through the RLS-subject client
// (WorkersDalAdapter.rlsSql — RLS-enforced on the app connection; migration 089 GRANTs SELECT so the
// app role can read, safe because 088 already enabled RLS + policy). WRITES go through the owner
// connection (WorkersDalAdapter.sql — bypasses RLS) + an audit_logs row in the SAME txn, mirroring
// setOperatingModeRow. Every query is `WHERE workspace_id = $w`, so a caller only ever touches its
// own workspace's charter; RLS is the defense-in-depth backstop on the read path.

import type { Sql } from '../db/client';
import type { WorkspaceId, UserId } from './types';

export interface CharterRow {
  workspace_id: string;
  mission: string | null;
  background: string | null;
  industry: string | null;
  team_size: string | null;
  objectives_summary: string | null;
  constraints: unknown[];
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  updated_by: string | null;
}

export interface CharterInput {
  mission?: string | null;
  background?: string | null;
  industry?: string | null;
  team_size?: string | null;
  objectives_summary?: string | null;
  constraints?: unknown[];
  metadata?: Record<string, unknown>;
}

/** The workspace's charter, or null when unset (or pre-088 / transient) — degrade-safe, never throws. */
export async function getCharterRow(sql: Sql, workspaceId: WorkspaceId): Promise<CharterRow | null> {
  if (!workspaceId) return null;
  try {
    const rows = (await sql/*sql*/`
      SELECT workspace_id, mission, background, industry, team_size, objectives_summary,
             constraints, metadata, created_at, updated_at, updated_by
      FROM workspace_charter
      WHERE workspace_id = ${workspaceId}
      LIMIT 1
    `) as Array<CharterRow>;
    return rows[0] ?? null;
  } catch {
    // pre-088 (table absent), no SELECT grant yet (pre-089), or transient -> no charter, never a throw.
    return null;
  }
}

/** UPSERT the workspace's charter (one row per workspace) + an audit_logs row in the SAME txn.
 *  Owner-connection write (RLS-bypassing, workspace-scoped by the PK). Governed: the route gates
 *  this to owner/operator (canWrite) before calling. Only provided fields change; omitted stay. */
export async function upsertCharterRow(
  sql: Sql,
  workspaceId: WorkspaceId,
  input: CharterInput,
  actorUserId: UserId,
): Promise<CharterRow> {
  const rows = (await sql/*sql*/`
    WITH charter_written AS (
      INSERT INTO workspace_charter (
        workspace_id, mission, background, industry, team_size, objectives_summary,
        constraints, metadata, updated_by, updated_at
      ) VALUES (
        ${workspaceId},
        ${input.mission ?? null}, ${input.background ?? null}, ${input.industry ?? null},
        ${input.team_size ?? null}, ${input.objectives_summary ?? null},
        ${JSON.stringify(input.constraints ?? [])}::jsonb,
        ${JSON.stringify(input.metadata ?? {})}::jsonb,
        ${actorUserId ?? null}, now()
      )
      ON CONFLICT (workspace_id) DO UPDATE SET
        mission            = COALESCE(EXCLUDED.mission, workspace_charter.mission),
        background         = COALESCE(EXCLUDED.background, workspace_charter.background),
        industry           = COALESCE(EXCLUDED.industry, workspace_charter.industry),
        team_size          = COALESCE(EXCLUDED.team_size, workspace_charter.team_size),
        objectives_summary = COALESCE(EXCLUDED.objectives_summary, workspace_charter.objectives_summary),
        constraints        = EXCLUDED.constraints,
        metadata           = EXCLUDED.metadata,
        updated_by         = EXCLUDED.updated_by,
        updated_at         = now()
      RETURNING workspace_id, mission, background, industry, team_size, objectives_summary,
                constraints, metadata, created_at, updated_at, updated_by
    ), audit_written AS (
      INSERT INTO audit_logs (actor_user_id, action, target_type, target_id, workspace_id, reason)
      SELECT ${actorUserId ?? null}, 'charter_upsert'::text, 'workspace', workspace_id, workspace_id, 'charter updated'
      FROM charter_written
      RETURNING id
    )
    SELECT charter_written.* FROM charter_written JOIN audit_written ON TRUE
  `) as Array<CharterRow>;
  const row = rows[0];
  if (!row) throw new Error('charter upsert did not return a row');
  return row;
}
