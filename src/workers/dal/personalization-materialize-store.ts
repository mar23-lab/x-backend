// src/workers/dal/personalization-materialize-store.ts · Y-wave MATERIALIZE (ADR-XB-012) · owner-connected
// store surface for the personalization-materialize cron. The cron is a SYSTEM-WIDE job (folds every
// user's signals across all workspaces), so it runs OWNER-CONNECTED (like provisioning + the census
// cron), NEVER withWorkspaceRlsContext. Each row carries its explicit workspace_id/user_id, so no RLS
// context is needed; RLS on these tables governs the app-role READ path (the resolver), not this job.
//
// It NEVER writes tenant_learning_profiles (those are promotion+consent only). The aggregation itself is
// the PURE foldSignalsIntoProfile (lib/personalization-fold.ts) — this file only reads + upserts.

import type { Sql } from '../db/client';

export interface LearningSignalForMaterialization {
  id: string;
  workspace_id: string;
  user_id: string;
  signal_kind: string;
  signal_json: Record<string, unknown>;
  created_at: string;
}

export interface UserPersonalizationProfileUpsert {
  workspace_id: string;
  user_id: string;
  role_key: string;
  preference_json: Record<string, unknown>;
  personal_rules_json: Record<string, unknown>;
  personal_skills_json: Record<string, unknown>;
  learned_defaults_json: Record<string, unknown>;
  source_signal_ids: string[];
}

/**
 * Bounded, owner-connected read of ACTIVE learning signals across all workspaces, ordered so the caller
 * can group by (workspace_id, user_id) and fold in created_at order. Rejected/archived signals are
 * excluded (they must not influence a profile). Reads `limit + 1` so the caller can detect truncation
 * (the AI-EXEC-1 pattern — surface, never silently under-materialize).
 */
export async function listActiveLearningSignalsForMaterializationRow(
  sql: Sql,
  limit: number,
): Promise<LearningSignalForMaterialization[]> {
  const cap = Math.max(1, Math.min(limit, 100000)) + 1;
  const rows = (await sql/*sql*/`
    SELECT id, workspace_id, user_id, signal_kind, signal_json, created_at
    FROM user_learning_signals
    WHERE promotion_state NOT IN ('rejected', 'archived')
    ORDER BY workspace_id, user_id, created_at, id
    LIMIT ${cap}
  `) as unknown as Array<{
    id: string; workspace_id: string; user_id: string; signal_kind: string;
    signal_json: Record<string, unknown> | null; created_at: string;
  }>;
  return rows.map((r) => ({
    id: r.id,
    workspace_id: r.workspace_id,
    user_id: r.user_id,
    signal_kind: r.signal_kind,
    signal_json: (r.signal_json && typeof r.signal_json === 'object' && !Array.isArray(r.signal_json)) ? r.signal_json : {},
    created_at: typeof r.created_at === 'string' ? r.created_at : new Date(r.created_at).toISOString(),
  }));
}

/**
 * Owner-connected UPSERT of one user's personalization profile (FULL-REBUILD-FROM-SIGNALS semantics: the
 * caller passes the complete folded buckets, so a re-run overwrites deterministically). Keyed on the
 * schema's UNIQUE(workspace_id, user_id, role_key). Never touches tenant_learning_profiles.
 */
export async function upsertUserPersonalizationProfileRow(
  sql: Sql,
  row: UserPersonalizationProfileUpsert,
): Promise<void> {
  const id = `upp_${row.workspace_id}:${row.user_id}:${row.role_key}`.slice(0, 200);
  await sql/*sql*/`
    INSERT INTO user_personalization_profiles
      (id, workspace_id, user_id, role_key, preference_json, personal_rules_json,
       personal_skills_json, learned_defaults_json, source_signal_ids, lifecycle_state, updated_at)
    VALUES (
      ${id}, ${row.workspace_id}, ${row.user_id}, ${row.role_key},
      ${JSON.stringify(row.preference_json)}::jsonb, ${JSON.stringify(row.personal_rules_json)}::jsonb,
      ${JSON.stringify(row.personal_skills_json)}::jsonb, ${JSON.stringify(row.learned_defaults_json)}::jsonb,
      ${row.source_signal_ids}, 'active', now()
    )
    ON CONFLICT (workspace_id, user_id, role_key) DO UPDATE SET
      preference_json = EXCLUDED.preference_json,
      personal_rules_json = EXCLUDED.personal_rules_json,
      personal_skills_json = EXCLUDED.personal_skills_json,
      learned_defaults_json = EXCLUDED.learned_defaults_json,
      source_signal_ids = EXCLUDED.source_signal_ids,
      updated_at = now()
  `;
}
