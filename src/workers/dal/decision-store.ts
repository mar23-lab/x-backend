// decision-store.ts · first-class DECISIONS — the rich governance-decision artefact (ARCH-006 W6).
//
// Authority: 030_decisions. A "decision" used to be implicit: operation_events.status flips + sign_offs
// rows + audit_logs(target_type='decision'). 'decision' is ALREADY an audit target_type (021) and a graph
// PACKET_KIND (data-graph.ts) but nothing materialized behind it. This adds the RICH record a sign-off
// does NOT carry (context / criteria / rollback / causation) while REUSING sign_offs as the approval act
// and audit_logs as the append-only trail — no duplication. Scoped to the OPERATOR's own workspaces
// (owner_user_id overlay, like intents) so a non-owned decision is invisible. createDecisionRow ALSO
// best-effort stamps audit_logs.causation_id (so the data-graph caused_by edge fills); the adapter
// best-effort mirrors into operations_unified (plane 'governance', kind 'decision') so the graph projects
// a `packet` node id `packet:<decisionId>` — both convention-aligned with graph-store.ts.

import type { Sql } from '../db/client';

export interface DecisionRow {
  id: string;
  workspace_id: string | null;
  project_id: string | null;
  event_id: string | null;
  actor_user_id: string | null;
  kind: string;
  verdict: string;
  context: string;
  criteria: unknown;
  rollback: string | null;
  causation_id: string | null;
  decided_at: string;
  created_at: string;
  updated_at: string;
}

/** A lean sign-off row for the decision detail (the approval act, reused — never re-stored). */
export interface DecisionSignOff {
  id: string;
  event_id: string | null;
  user_id: string | null;
  verdict: string | null;
  comment: string | null;
  signed_at: string | null;
}

/** A lean audit row for the decision trail (who/what/when, reused — never re-stored). */
export interface DecisionAuditEntry {
  action: string | null;
  target_type: string | null;
  target_id: string | null;
  causation_id: string | null;
  occurred_at: string | null;
}

export interface DecisionDetail {
  decision: DecisionRow;
  sign_offs: DecisionSignOff[];
  audit_trail: DecisionAuditEntry[];
}

export interface CreateDecisionInput {
  id?: string;
  workspace_id: string | null;
  project_id?: string | null;
  event_id?: string | null;
  actor_user_id: string | null;
  kind?: string;
  verdict: string;
  context: string;
  criteria?: unknown;
  rollback?: string | null;
  causation_id?: string | null;
}

const ALLOWED_KIND = new Set(['governance', 'technical', 'product', 'commercial', 'operational']);
const ALLOWED_VERDICT = new Set(['approved', 'rejected', 'deferred', 'noted']);
const str = (v: unknown): string => (v == null ? '' : String(v));
const iso = (v: unknown): string => (v ? new Date(v as string).toISOString() : '');

function mapDecisionRow(r: Record<string, unknown>): DecisionRow {
  return {
    id: str(r.id),
    workspace_id: r.workspace_id == null ? null : str(r.workspace_id),
    project_id: r.project_id == null ? null : str(r.project_id),
    event_id: r.event_id == null ? null : str(r.event_id),
    actor_user_id: r.actor_user_id == null ? null : str(r.actor_user_id),
    kind: str(r.kind),
    verdict: str(r.verdict),
    context: str(r.context),
    criteria: r.criteria == null ? [] : r.criteria,
    rollback: r.rollback == null ? null : str(r.rollback),
    causation_id: r.causation_id == null ? null : str(r.causation_id),
    decided_at: iso(r.decided_at),
    created_at: iso(r.created_at),
    updated_at: iso(r.updated_at),
  };
}

/** Resolve the operator's own workspace ids (the visibility boundary for every read/write below). */
async function operatorWorkspaceIds(sql: Sql, ownerUserIds: string[]): Promise<string[]> {
  const ids = (Array.isArray(ownerUserIds) ? ownerUserIds : [ownerUserIds]).filter(Boolean);
  if (ids.length === 0) return [];
  const rows = (await sql/*sql*/`
    SELECT id FROM workspaces WHERE owner_user_id = ANY(${ids})
  `) as Array<Record<string, unknown>>;
  return rows.map((r) => String(r.id));
}

/** List decisions in the operator's workspaces, optionally narrowed to a project/event. Newest first. */
export async function listDecisionsForOperatorRow(
  sql: Sql,
  ownerUserIds: string[],
  scope: { workspace_id?: string | null; project_id?: string | null; event_id?: string | null },
  limit = 200,
): Promise<DecisionRow[]> {
  const wsIds = await operatorWorkspaceIds(sql, ownerUserIds);
  if (wsIds.length === 0) return [];
  const cap = Math.max(1, Math.min(500, Number(limit) || 200));
  const wsFilter = scope.workspace_id ? String(scope.workspace_id) : null;
  const projectFilter = scope.project_id ? String(scope.project_id) : null;
  const eventFilter = scope.event_id ? String(scope.event_id) : null;
  const rows = (await sql/*sql*/`
    SELECT id, workspace_id, project_id, event_id, actor_user_id, kind, verdict,
           context, criteria, rollback, causation_id, decided_at, created_at, updated_at
    FROM decisions
    WHERE workspace_id = ANY(${wsIds})
      AND (${wsFilter}::text IS NULL OR workspace_id = ${wsFilter}::text)
      AND (${projectFilter}::text IS NULL OR project_id = ${projectFilter}::text)
      AND (${eventFilter}::text IS NULL OR event_id = ${eventFilter}::text)
    ORDER BY decided_at DESC, id DESC
    LIMIT ${cap}
  `) as Array<Record<string, unknown>>;
  return rows.map(mapDecisionRow);
}

/** One decision + its sign-offs (on the same event) + its audit trail. null if not the operator's. */
export async function getDecisionForOperatorRow(
  sql: Sql,
  ownerUserIds: string[],
  decisionId: string,
): Promise<DecisionDetail | null> {
  const id = str(decisionId).trim();
  if (!id) return null;
  const wsIds = await operatorWorkspaceIds(sql, ownerUserIds);
  if (wsIds.length === 0) return null;

  const rows = (await sql/*sql*/`
    SELECT id, workspace_id, project_id, event_id, actor_user_id, kind, verdict,
           context, criteria, rollback, causation_id, decided_at, created_at, updated_at
    FROM decisions WHERE id = ${id} AND workspace_id = ANY(${wsIds}) LIMIT 1
  `) as Array<Record<string, unknown>>;
  if (rows.length === 0) return null;
  const decision = mapDecisionRow(rows[0]!);

  // REUSE the sign-offs on this decision's event (the approval act) — never re-stored on the decision.
  let sign_offs: DecisionSignOff[] = [];
  if (decision.event_id) {
    try {
      const soRows = (await sql/*sql*/`
        SELECT id, event_id, user_id, verdict, comment, signed_at
        FROM sign_offs WHERE event_id = ${decision.event_id} AND workspace_id = ${decision.workspace_id}
        ORDER BY signed_at DESC LIMIT 50
      `) as Array<Record<string, unknown>>;
      sign_offs = soRows.map((r) => ({
        id: str(r.id), event_id: r.event_id == null ? null : str(r.event_id),
        user_id: r.user_id == null ? null : str(r.user_id), verdict: r.verdict == null ? null : str(r.verdict),
        comment: r.comment == null ? null : str(r.comment), signed_at: r.signed_at ? iso(r.signed_at) : null,
      }));
    } catch (_) { sign_offs = []; }
  }

  // REUSE the audit trail (best-effort; 021/causation may be absent) — never re-stored.
  let audit_trail: DecisionAuditEntry[] = [];
  try {
    const auditRows = (await sql/*sql*/`
      SELECT action, target_type, target_id, causation_id, occurred_at
      FROM audit_logs
      WHERE workspace_id = ${decision.workspace_id} AND (target_id = ${id} OR causation_id = ${id})
      ORDER BY occurred_at DESC LIMIT 50
    `) as Array<Record<string, unknown>>;
    audit_trail = auditRows.map((r) => ({
      action: r.action == null ? null : str(r.action), target_type: r.target_type == null ? null : str(r.target_type),
      target_id: r.target_id == null ? null : str(r.target_id), causation_id: r.causation_id == null ? null : str(r.causation_id),
      occurred_at: r.occurred_at ? iso(r.occurred_at) : null,
    }));
  } catch (_) { audit_trail = []; }

  return { decision, sign_offs, audit_trail };
}

/**
 * Create a first-class decision. id auto-generated when absent. Also BEST-EFFORT stamps audit_logs with
 * (target_type='decision', target_id=<bare id>, causation_id=<event_id or self>) so the data-graph emits
 * the caused_by edge (graph-store.ts builds effect 'packet:<target_id>' / cause 'event:<causation_id>',
 * which line up with the operations_unified mirror's node id 'packet:<id>'). The audit stamp is the one
 * line that wires causation — wrapped in try/catch so a missing 021 never blocks the decision create.
 */
export async function createDecisionRow(sql: Sql, input: CreateDecisionInput): Promise<DecisionRow> {
  const context = str(input.context).trim();
  if (!context) throw Object.assign(new Error('decision.context is required'), { code: 'VALIDATION_ERROR', status: 400 });
  const verdict = ALLOWED_VERDICT.has(str(input.verdict)) ? str(input.verdict) : '';
  if (!verdict) throw Object.assign(new Error('decision.verdict must be one of: approved, rejected, deferred, noted'), { code: 'VALIDATION_ERROR', status: 400 });
  const kind = input.kind && ALLOWED_KIND.has(input.kind) ? input.kind : 'governance';
  const id = str(input.id).trim() || `decision-${crypto.randomUUID()}`;
  const criteriaJson = JSON.stringify(input.criteria ?? []);
  const causationId = input.causation_id ? str(input.causation_id) : (input.event_id ? str(input.event_id) : null);

  const rows = (await sql/*sql*/`
    INSERT INTO decisions
      (id, workspace_id, project_id, event_id, actor_user_id, kind, verdict, context, criteria, rollback, causation_id)
    VALUES (
      ${id}, ${input.workspace_id ?? null}, ${input.project_id ?? null}, ${input.event_id ?? null},
      ${input.actor_user_id ?? null}, ${kind}, ${verdict}, ${context}, ${criteriaJson}::jsonb,
      ${input.rollback ?? null}, ${causationId}
    )
    ON CONFLICT (id) DO NOTHING
    RETURNING id, workspace_id, project_id, event_id, actor_user_id, kind, verdict,
              context, criteria, rollback, causation_id, decided_at, created_at, updated_at
  `) as Array<Record<string, unknown>>;
  const decision = rows.length > 0
    ? mapDecisionRow(rows[0]!)
    : mapDecisionRow(((await sql/*sql*/`
        SELECT id, workspace_id, project_id, event_id, actor_user_id, kind, verdict,
               context, criteria, rollback, causation_id, decided_at, created_at, updated_at
        FROM decisions WHERE id = ${id} LIMIT 1`) as Array<Record<string, unknown>>)[0]!);

  // Best-effort causation stamp (the caused_by wiring). action matches audit_logs' ^[a-z_]+$ CHECK.
  try {
    await sql/*sql*/`
      INSERT INTO audit_logs (actor_user_id, action, target_type, target_id, workspace_id, reason, causation_id)
      VALUES (${decision.actor_user_id}, ${`decision_${verdict}`}, 'decision', ${decision.id},
              ${decision.workspace_id}, ${context.slice(0, 2000)}, ${decision.causation_id ?? decision.id})
    `;
  } catch (_) { /* audit is best-effort; the decision already stands */ }

  return decision;
}

/**
 * Best-effort mirror of a decision into operations_unified (plane 'governance', kind 'decision'), so the
 * durable read-model + the data-graph carry it (it projects a `packet` node id 'packet:<id>'). Idempotent
 * (upsert by 'decision:<id>'). The caller wraps this in try/catch — a missing operations_unified is a no-op.
 */
export async function materializeDecisionToUnified(sql: Sql, decision: DecisionRow): Promise<void> {
  if (!decision?.id) return;
  await sql/*sql*/`
    INSERT INTO operations_unified
      (id, plane, source_plane_id, workspace_id, project_id, domain_id, kind, status, title, summary, occurred_at)
    VALUES (
      ${'decision:' + decision.id}, 'governance', ${decision.id},
      ${decision.workspace_id}, ${decision.project_id}, ${null},
      'decision', ${decision.verdict}, ${`[decision ${decision.verdict}] ${decision.context}`.slice(0, 200)},
      ${decision.context.slice(0, 400)}, ${decision.decided_at || null}
    )
    ON CONFLICT (id) DO UPDATE SET
      workspace_id = EXCLUDED.workspace_id, project_id = EXCLUDED.project_id,
      status = EXCLUDED.status, title = EXCLUDED.title, summary = EXCLUDED.summary, ingested_at = now()
  `;
}
