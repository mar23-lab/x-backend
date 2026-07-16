// governance-store.ts · project-governance read-models + sign-off (R52-A1 provenance +
// R53-W4 operator-overlay provenance + board-cards + sign-off transaction).
//
// Authority: DATABASE_SCHEMA_V1.md (operation_events, projects, board_cards, sign_offs) ·
// API_CONTRACT_V1.md · AUTH_TENANCY_MODEL.md. Lifted verbatim out of WorkersDalAdapter
// (Stage 3.1, F10) to decompose the DAL god-object; behaviour is byte-for-byte identical to the
// prior inline methods.
//
// The DAL methods are now thin delegations (return <name>Row(this.sql, ...)). assertWorkspaceScope
// is imported from ./DalAdapter and makeError from ./shared-helpers (same call shapes).
// getProjectProvenanceRow calls getProjectRow from ./project-store — the inline original called
// this.getProject(...) which is itself a thin delegation to getProjectRow(this.sql, ...), so this is
// a 1:1 behaviour-preserving swap. The OAUTH_SOURCE_TOOLS sets + the binding matcher + the
// normalizeBoardCardRow row-normalizer move here with the methods (no other DAL method references
// them). createSignOff preserves the single sql.transaction([...]) (insert sign-off + update event
// approval_state atomically).
//
// VERIFY NOTE: the inline SQL surfaces (GROUP BY source_tool provenance read; the owner-scoped
// operation_events read in the operator overlay; board_cards SELECT; sign_offs INSERT +
// operation_events UPDATE transaction) MOVED here from WorkersDalAdapter.ts. The standalone source
// gates that grep the DAL for these were retargeted to read this store:
//   - scripts/verify-project-provenance.mjs (R52-A1 grouped-query + OAUTH_SOURCE_TOOLS)
//   - scripts/verify-operator-provenance-no-customer-events.mjs (R53-W4 tenant-guard slice)

import { assertWorkspaceScope } from './DalAdapter';
import { makeError } from './shared-helpers';
import { getProjectRow } from './project-store';
// 047 · board_cards LIST runs inside the workspace-GUC transaction so the RLS-subject client
// (rlsSql) is DB-filtered. INERT until XLOOOP_RLS_APP_DATABASE_URL is set (rlsSql defaults to owner).
import { withWorkspaceRlsContext } from './operational-spine-store';
import type {
  WorkspaceId,
  ProjectId,
  BoardCard,
  BoardCardListOpts,
  SignOffInput,
  SignOff,
} from './types';
import type { Sql } from '../db/client';

// ------------------------------------------------------------
// Internal helpers (lifted verbatim from WorkersDalAdapter)
// ------------------------------------------------------------

function normalizeBoardCardRow(row: BoardCard): BoardCard {
  return {
    ...row,
    body: row.body ?? null,
    lane: row.lane ?? null,
    assignee_id: row.assignee_id ?? null,
    event_id: row.event_id ?? null,
    evidence_link: row.evidence_link ?? null,
    metadata: row.metadata ?? {},
  };
}

// ------------------------------------------------------------
// R52-A1 · /api/v1/projects/:id/provenance
// ------------------------------------------------------------
//
// Source→Project provenance: which sources fed this project, how many
// events each contributed, and when each last produced one. Powers the
// provenance chips on project cards (pillar 2 · "projects connected from
// any source"). OAuth-source tools (github/google_drive/dropbox/gitlab/
// microsoft_onedrive) are flagged so the UI can foreground them vs the
// internal tools (codex/claude/harness/mbp/xlooop/operator).
export async function getProjectProvenanceRow(
  sql: Sql,
  workspaceId: WorkspaceId,
  projectId: ProjectId,
): Promise<{
  project_id: string;
  total_events: number;
  sources: Array<{ source_tool: string; event_count: number; last_event_at: string | null; is_oauth_source: boolean }>;
}> {
  assertWorkspaceScope(workspaceId);
  if (!projectId) throw makeError('VALIDATION_ERROR', 'project_id is required', 400);

  const proj = await getProjectRow(sql, workspaceId, projectId);
  if (!proj) throw makeError('NOT_FOUND', `project ${projectId} not found in workspace ${workspaceId}`, 404);

  const rows = (await sql/*sql*/`
    SELECT source_tool,
           COUNT(*)::int     AS event_count,
           MAX(occurred_at)  AS last_event_at
    FROM operation_events
    WHERE workspace_id = ${workspaceId}
      AND project_id = ${projectId}
    GROUP BY source_tool
    ORDER BY event_count DESC, source_tool ASC
  `) as Array<Record<string, unknown>>;

  const OAUTH_SOURCE_TOOLS = new Set(['github', 'google_drive', 'dropbox', 'gitlab', 'microsoft_onedrive']);
  let total = 0;
  const sources = rows.map((r) => {
    const count = Number(r.event_count) || 0;
    total += count;
    return {
      source_tool: String(r.source_tool),
      event_count: count,
      last_event_at: r.last_event_at ? String(r.last_event_at) : null,
      is_oauth_source: OAUTH_SOURCE_TOOLS.has(String(r.source_tool)),
    };
  });
  return { project_id: projectId, total_events: total, sources };
}

// R53-W4 · operator-overlay provenance via scope_binding.
// The governance projects the operator cockpit shows (xlooop-product, mbp-ops…)
// claim events by a scope_binding FILTER, not by project_id. This computes
// provenance over events matching that filter, scoped to the operator's OWN
// workspaces only (tenant guard). Bounded candidate set (operator's own
// events) → filtered in JS to avoid dynamic-SQL composition.
export async function getProjectProvenanceForOperatorRow(
  sql: Sql,
  ownerUserIds: string[],
  projectId: ProjectId,
): Promise<{
  project_id: string;
  total_events: number;
  matched_by: 'scope_binding' | 'project_id';
  sources: Array<{ source_tool: string; event_count: number; last_event_at: string | null; is_oauth_source: boolean }>;
}> {
  // R53-W4.1 · ownerUserIds is the operator's IDENTITY SET (the human may sign
  // in under more than one Clerk id — e.g. a governance identity + an org
  // identity that are both them). All ids must belong to the SAME operator.
  const ids = (Array.isArray(ownerUserIds) ? ownerUserIds : [ownerUserIds]).filter(Boolean);
  if (ids.length === 0) throw makeError('UNAUTHORIZED', 'ownerUserIds is required', 401);
  if (!projectId) throw makeError('VALIDATION_ERROR', 'project_id is required', 400);

  // TENANT GUARD — workspaces owned by ANY of the operator's identities ONLY.
  // Customer workspaces are owned by other user_ids (never in this set) and can
  // never contribute to operator provenance.
  const wsRows = (await sql/*sql*/`
    SELECT id FROM workspaces WHERE owner_user_id = ANY(${ids})
  `) as Array<Record<string, unknown>>;
  const ownerWorkspaceIds = wsRows.map((r) => String(r.id));
  if (ownerWorkspaceIds.length === 0) {
    return { project_id: projectId, total_events: 0, matched_by: 'project_id', sources: [] };
  }

  // Project metadata (scope_binding) — read by id (overlay; project may live in
  // a governance workspace owned by the seed user). Read-only, no events.
  const projRows = (await sql/*sql*/`
    SELECT scope_binding FROM projects WHERE id = ${projectId} LIMIT 1
  `) as Array<Record<string, unknown>>;
  const binding = (projRows[0]?.scope_binding && typeof projRows[0].scope_binding === 'object')
    ? (projRows[0].scope_binding as any)
    : null;

  // Candidate events — scoped to the operator's own workspaces ONLY.
  const events = (await sql/*sql*/`
    SELECT source_tool, agent_id, project_id, occurred_at
    FROM operation_events
    WHERE workspace_id = ANY(${ownerWorkspaceIds})
  `) as Array<Record<string, unknown>>;

  const matchesBinding = (ev: Record<string, unknown>): boolean => {
    if (!binding || !Array.isArray(binding.filters)) return false;
    const combine = binding.combine === 'all' ? 'all' : 'any';
    const results: boolean[] = binding.filters.map((f: any) => {
      if (f && f.type === 'source_tool_in' && Array.isArray(f.values)) {
        return f.values.includes(String(ev.source_tool));
      }
      if (f && f.type === 'actor_in' && Array.isArray(f.values)) {
        const actor = String(ev.agent_id || '');
        return f.values.some((v: string) =>
          typeof v === 'string' && (v.endsWith('*') ? actor.startsWith(v.slice(0, -1)) : actor === v));
      }
      return false; // unknown filter type → conservative no-match
    });
    return combine === 'all' ? results.every(Boolean) : results.some(Boolean);
  };

  const matchedBy: 'scope_binding' | 'project_id' = binding ? 'scope_binding' : 'project_id';
  const matched = binding
    ? events.filter(matchesBinding)
    : events.filter((ev) => String(ev.project_id) === projectId);

  const OAUTH_SOURCE_TOOLS = new Set(['github', 'google_drive', 'dropbox', 'gitlab', 'microsoft_onedrive']);
  const bySource = new Map<string, { count: number; last: string | null }>();
  for (const ev of matched) {
    const st = String(ev.source_tool || 'unknown');
    const cur = bySource.get(st) || { count: 0, last: null };
    cur.count += 1;
    const ts = ev.occurred_at ? String(ev.occurred_at) : null;
    if (ts && (!cur.last || ts > cur.last)) cur.last = ts;
    bySource.set(st, cur);
  }
  const sources = Array.from(bySource.entries())
    .map(([source_tool, v]) => ({
      source_tool,
      event_count: v.count,
      last_event_at: v.last,
      is_oauth_source: OAUTH_SOURCE_TOOLS.has(source_tool),
    }))
    .sort((a, b) => b.event_count - a.event_count || a.source_tool.localeCompare(b.source_tool));
  const total = sources.reduce((s, x) => s + x.event_count, 0);
  return { project_id: projectId, total_events: total, matched_by: matchedBy, sources };
}

// ------------------------------------------------------------
// /api/v1/board-cards
// ------------------------------------------------------------

export async function listBoardCardsRow(
  sql: Sql,
  workspaceId: WorkspaceId,
  projectId: ProjectId,
  opts: BoardCardListOpts,
): Promise<BoardCard[]> {
  assertWorkspaceScope(workspaceId);
  if (!projectId) throw makeError('VALIDATION_ERROR', 'project_id is required', 400);

  const laneFilter = opts.lane ?? null;
  const statusFilter = opts.status ?? null;

  const [rows] = await withWorkspaceRlsContext<[BoardCard[]]>(sql, workspaceId, (tx) => [
    tx/*sql*/`
    SELECT id, workspace_id, project_id, title, body, status, lane,
           assignee_id, event_id, evidence_link, position, metadata,
           created_at, updated_at
    FROM board_cards
    WHERE workspace_id = ${workspaceId}
      AND project_id = ${projectId}
      AND (${laneFilter}::text IS NULL OR lane = ${laneFilter}::text)
      AND (${statusFilter}::text IS NULL OR status = ${statusFilter}::text)
    ORDER BY lane ASC, position ASC, created_at ASC
    LIMIT 500
  `,
  ], { readOnly: true });

  return rows.map(normalizeBoardCardRow);
}

// ------------------------------------------------------------
// POST /api/v1/sign-offs
// ------------------------------------------------------------

export async function createSignOffRow(
  sql: Sql,
  workspaceId: WorkspaceId,
  userId: import('./types').UserId,
  signOff: SignOffInput,
  requestId?: string | null,
): Promise<SignOff> {
  assertWorkspaceScope(workspaceId);
  if (!userId) throw makeError('UNAUTHORIZED', 'user_id required', 401);
  if (!signOff?.event_id) throw makeError('VALIDATION_ERROR', 'event_id is required', 400);
  if (!signOff?.verdict) throw makeError('VALIDATION_ERROR', 'verdict is required', 400);

  // Cross-tenant guard: event_id must belong to the workspace.
  const eventCheck = (await sql/*sql*/`
    SELECT id FROM operation_events
    WHERE id = ${signOff.event_id} AND workspace_id = ${workspaceId}
    LIMIT 1
  `) as Array<{ id: string }>;
  if (eventCheck.length === 0) {
    throw makeError('NOT_FOUND', `event ${signOff.event_id} not found in workspace`, 404);
  }

  const decisionKind = signOff.decision_kind
    ?? (signOff.verdict === 'approved' ? 'approval' : signOff.verdict === 'rejected' ? 'rejection' : 'noted');
  const mirrorStatus = signOff.verdict === 'rejected' || decisionKind === 'request_changes'
    ? 'needs_review'
    : 'completed';
  const approvalState = signOff.verdict === 'approved'
    ? 'approved'
    : signOff.verdict === 'rejected' ? 'rejected' : null;
  const action = `sign_off_${decisionKind}`;
  const summary = `[sign-off ${decisionKind}] ${signOff.event_id}`.slice(0, 512);
  const body = signOff.comment?.slice(0, 400) ?? null;

  // One statement is the authority boundary: the sign-off, target state, operation event and audit log
  // either all commit or all roll back. Email, analytics and graph projection remain post-commit effects.
  const rows = (await sql/*sql*/`
    WITH target_updated AS (
      UPDATE operation_events
      SET approval_state = ${approvalState}
      WHERE id = ${signOff.event_id} AND workspace_id = ${workspaceId}
      RETURNING id
    ), inserted AS (
      INSERT INTO sign_offs (workspace_id, event_id, user_id, verdict, comment)
      SELECT ${workspaceId}, ${signOff.event_id}, ${userId}, ${signOff.verdict}, ${signOff.comment ?? null}
      FROM target_updated
      RETURNING id, workspace_id, event_id, user_id, verdict, comment, signed_at
    ), event_written AS (
      INSERT INTO operation_events (
        id, workspace_id, source_tool, agent_id, status, summary, body, visibility,
        occurred_at, parent_event_id, authorized_by_user_id, instrument_kind,
        authority_source, request_id
      )
      SELECT
        LEFT('evt_signoff_' || inserted.id::text, 128), workspace_id, 'xlooop',
        'xlooop:operator-action', ${mirrorStatus}, ${summary}, ${body},
        'internal_workspace', signed_at, event_id, user_id, 'human',
        'explicit_approval', ${requestId ?? null}
      FROM inserted
      JOIN target_updated ON target_updated.id = inserted.event_id
      RETURNING id
    ), audit_written AS (
      INSERT INTO audit_logs (
        actor_user_id, action, target_type, target_id, workspace_id, reason, causation_id,
        metadata
      )
      SELECT user_id, ${action}, 'event', event_id, workspace_id, comment, event_id,
        jsonb_build_object('sign_off_id', id, 'audit_event_id', (SELECT id FROM event_written))
      FROM inserted
      RETURNING id
    )
    SELECT inserted.*, event_written.id AS audit_event_id
    FROM inserted
    JOIN target_updated ON target_updated.id = inserted.event_id
    CROSS JOIN event_written
    CROSS JOIN audit_written
  `) as SignOff[];

  const row = rows[0];
  if (!row) throw makeError('CONFLICT', 'sign-off target was not updated; receipt not issued', 409);

  return {
    id: row.id,
    audit_event_id: row.audit_event_id,
    workspace_id: row.workspace_id,
    event_id: row.event_id,
    user_id: row.user_id,
    verdict: row.verdict,
    comment: row.comment ?? null,
    signed_at: row.signed_at,
  };
}

// Wave 4 · the governance audit trail. Reads the audit_logs entries for governance targets (sign-offs
// + the events/packets/decisions they act on), operator-scoped, newest first. This is what makes
// "who approved what, when" actually READABLE — the missing half of the lineage the operator wanted.
export interface GovernanceAuditEntry {
  actor_user_id: string;
  action: string;
  target_type: string;
  target_id: string;
  workspace_id: string | null;
  reason: string | null;
  causation_id: string | null;
  occurred_at: string;
}

export async function listGovernanceAuditLogForOperatorRow(
  sql: Sql,
  ownerUserIds: string[],
  limit = 100,
): Promise<GovernanceAuditEntry[]> {
  const ids = (Array.isArray(ownerUserIds) ? ownerUserIds : []).filter(Boolean);
  if (ids.length === 0) return [];
  const cap = Math.max(1, Math.min(500, Number(limit) || 100));
  // Operator overlay: the governance audit across every workspace the operator owns (joins to
  // workspaces.owner_user_id, the same spine the engagement rollup + operator event read use).
  const rows = (await sql/*sql*/`
    SELECT a.actor_user_id, a.action, a.target_type, a.target_id, a.workspace_id, a.reason, a.causation_id, a.occurred_at
    FROM audit_logs a
    JOIN workspaces w ON w.id = a.workspace_id
    WHERE a.target_type IN ('event', 'packet', 'decision', 'sign_off')
      AND w.owner_user_id = ANY(${ids})
    ORDER BY a.occurred_at DESC
    LIMIT ${cap}
  `) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    actor_user_id: String(r.actor_user_id || ''),
    action: String(r.action || ''),
    target_type: String(r.target_type || ''),
    target_id: String(r.target_id || ''),
    workspace_id: r.workspace_id ? String(r.workspace_id) : null,
    reason: r.reason ? String(r.reason) : null,
    causation_id: r.causation_id ? String(r.causation_id) : null,
    occurred_at: r.occurred_at ? new Date(r.occurred_at as string).toISOString() : '',
  }));
}
