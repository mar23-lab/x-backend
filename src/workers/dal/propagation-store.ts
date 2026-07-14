// propagation-store.ts · R49' goals + propagation rules + recommendations + tick engine.
//
// Authority: DATABASE_SCHEMA_V1.md (synthetic_domain_goals, synthetic_domain_goal_progress,
// synthetic_domain_propagation_rules, synthetic_domain_recommendations, propagation_tick_state) ·
// LEM-v3 PR-5+6. Lifted verbatim out of WorkersDalAdapter (Stage 3.1, F10) to decompose the DAL
// god-object; behaviour is byte-for-byte identical to the prior inline methods.
//
// The DAL methods are now thin delegations (return <name>Row(this.sql, ...)). Audit-log writes,
// the domain lookup/counter maintainers, and the roadmap-item insert are replicated here with the
// SAME shapes WorkersDalAdapter uses (mirrors synthetic-domain-store, which also writes audit_logs
// directly), so the public appendAuditLog / addRoadmapItem methods stay on the class and behaviour
// is unchanged.

import { makeError } from './shared-helpers';
import type {
  WorkspaceId,
  UserId,
  SyntheticDomainId,
  SyntheticDomainGoal,
  SyntheticDomainGoalId,
  SyntheticDomainGoalCreateInput,
  SyntheticDomainGoalProgress,
  GoalStatus,
  GoalDerivation,
  SyntheticDomainPropagationRule,
  PropagationRuleId,
  PropagationRuleCreateInput,
  PropagationTrigger,
  PropagationAction,
  PropagationRuleStatus,
  SyntheticDomainRecommendation,
  RecommendationId,
  RecommendationListOpts,
  PropagationTickResult,
  SyntheticDomainRoadmapId,
  SyntheticDomainRoadmapItem,
  SyntheticDomainRoadmapItemInput,
  AuditLogInput,
} from './types';
import type { Sql } from '../db/client';

// R55-3c · tenant write scope for recommendation accept/reject. A caller may act
// only on rows in their workspace scope (operator: owned workspaces + cross-workspace
// NULL rows; customer: their own workspace only). Mirrors recommendationTenantScope
// in routes/synthetic-domains.ts (the read side).
export interface RecommendationWriteScope {
  workspaceIds: string[];
  includeCrossWorkspace: boolean;
}

// ------------------------------------------------------------
// Internal helpers (lifted verbatim from WorkersDalAdapter)
// ------------------------------------------------------------

/** Mirrors WorkersDalAdapter.appendAuditLog INSERT exactly so audit rows are identical. */
async function appendAuditLogRow(sql: Sql, entry: AuditLogInput): Promise<void> {
  await sql/*sql*/`
    INSERT INTO audit_logs (actor_user_id, action, target_type, target_id, workspace_id, reason, metadata)
    VALUES (
      ${entry.actor_user_id},
      ${entry.action}::text,
      ${entry.target_type}::text,
      ${entry.target_id},
      ${entry.workspace_id ?? null},
      ${entry.reason ?? null},
      ${JSON.stringify(entry.metadata ?? {})}::jsonb
    )
  `;
}

/** Mirrors WorkersDalAdapter._getDomainOrThrow (shared with roadmap methods on the DAL). */
async function getDomainOrThrowRow(
  sql: Sql,
  domainId: SyntheticDomainId,
): Promise<{ id: string; workspace_id: string | null }> {
  const rows = await sql/*sql*/`
    SELECT id, workspace_id FROM synthetic_domains WHERE id = ${domainId} LIMIT 1
  ` as Array<{ id: string; workspace_id: string | null }>;
  if (rows.length === 0) throw makeError('NOT_FOUND', `synthetic_domain ${domainId} not found`, 404);
  return rows[0]!;
}

/**
 * Mirrors WorkersDalAdapter._updateDomainCounters (shared with roadmap methods on the DAL).
 * Maintains synthetic_domains.has_roadmap + goal_count counters. Idempotent.
 */
async function updateDomainCountersRow(sql: Sql, domainId: SyntheticDomainId): Promise<void> {
  await sql/*sql*/`
    UPDATE synthetic_domains
    SET has_roadmap = (SELECT EXISTS (
          SELECT 1 FROM synthetic_domain_roadmaps
          WHERE domain_id = ${domainId} AND status NOT IN ('archived')
        )),
        goal_count = (SELECT COUNT(*)::int FROM synthetic_domain_goals
          WHERE domain_id = ${domainId} AND status IN ('proposed','active')),
        updated_at = now()
    WHERE id = ${domainId}
  `;
}

/**
 * Mirrors WorkersDalAdapter.addRoadmapItem (which stays on the DAL for roadmap routes).
 * Replicated so _applyRecommendationPayloadRow's add_roadmap_item case does not couple to
 * the class; INSERT + audit shapes are byte-identical to the public method.
 */
async function addRoadmapItemRow(
  sql: Sql,
  roadmapId: SyntheticDomainRoadmapId,
  input: SyntheticDomainRoadmapItemInput,
  actorUserId: UserId,
): Promise<SyntheticDomainRoadmapItem> {
  if (!actorUserId) throw makeError('VALIDATION_ERROR', 'actor required', 400);
  if (!input.title || input.title.length > 200) throw makeError('VALIDATION_ERROR', 'title 1-200 chars required', 400);
  const rRows = await sql/*sql*/`
    SELECT id, domain_id, workspace_id FROM synthetic_domain_roadmaps WHERE id = ${roadmapId} LIMIT 1
  ` as Array<{ id: string; domain_id: string; workspace_id: string | null }>;
  if (rRows.length === 0) throw makeError('NOT_FOUND', `roadmap ${roadmapId} not found`, 404);
  const r = rRows[0]!;
  const posRows = await sql/*sql*/`
    SELECT COALESCE(MAX(position) + 1, 0) AS next_pos
    FROM synthetic_domain_roadmap_items WHERE roadmap_id = ${roadmapId} AND deleted_at IS NULL
  ` as Array<{ next_pos: number }>;
  const position = posRows[0]?.next_pos ?? 0;
  const newId = input.id && input.id.length > 0
    ? input.id
    : `sdri_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const rows = await sql/*sql*/`
    INSERT INTO synthetic_domain_roadmap_items (
      id, roadmap_id, domain_id, position, title, description, status, target_date,
      derived_from_project_id, derived_from_event_id, metadata
    ) VALUES (
      ${newId}, ${roadmapId}, ${r.domain_id}, ${position},
      ${input.title}, ${input.description ?? null}, ${input.status ?? 'planned'},
      ${input.target_date ?? null},
      ${input.derived_from_project_id ?? null},
      ${input.derived_from_event_id ?? null},
      ${JSON.stringify(input.metadata ?? {})}::jsonb
    )
    RETURNING id, roadmap_id, domain_id, position, title, description, status, target_date,
              derived_from_project_id, derived_from_event_id, metadata, created_at, updated_at
  ` as SyntheticDomainRoadmapItem[];
  const item = normalizeRoadmapItemRow(rows[0]!);
  await appendAuditLogRow(sql, {
    actor_user_id: actorUserId,
    action: 'sd_roadmap_item_add',
    target_type: 'synthetic_domain_roadmap_item',
    target_id: item.id,
    workspace_id: r.workspace_id,
    metadata: { roadmap_id: roadmapId, position, title: item.title },
  });
  return item;
}

function normalizeRoadmapItemRow(i: SyntheticDomainRoadmapItem): SyntheticDomainRoadmapItem {
  return {
    ...i,
    description: i.description ?? null,
    target_date: i.target_date ?? null,
    derived_from_project_id: i.derived_from_project_id ?? null,
    derived_from_event_id: i.derived_from_event_id ?? null,
    metadata: i.metadata ?? {},
  };
}

function normalizeGoalRow(g: SyntheticDomainGoal): SyntheticDomainGoal {
  return {
    ...g,
    description: g.description ?? null,
    metric_unit: g.metric_unit ?? null,
    current_value: g.current_value === null || g.current_value === undefined
      ? null
      : typeof g.current_value === 'string' ? Number(g.current_value) : g.current_value,
    target_value: typeof g.target_value === 'string' ? Number(g.target_value) : g.target_value,
    current_value_updated_at: g.current_value_updated_at ?? null,
    target_date: g.target_date ?? null,
    roadmap_id: g.roadmap_id ?? null,
    derivation: g.derivation ?? { kind: 'member_project_count' },
    metadata: g.metadata ?? {},
    updated_by: g.updated_by ?? null,
  };
}

const GOAL_DERIVATION_KINDS = new Set([
  'member_project_count', 'project_status_count', 'event_count', 'sign_off_approved_count',
]);

// R49 PR-5+6 · propagation rule + recommendation normalizers
function normalizePropagationRuleRow(r: SyntheticDomainPropagationRule): SyntheticDomainPropagationRule {
  return {
    ...r,
    description: r.description ?? null,
    last_fired_at: r.last_fired_at ?? null,
    fire_count: typeof r.fire_count === 'string' ? Number(r.fire_count) : (r.fire_count ?? 0),
    updated_by: r.updated_by ?? null,
    trigger: r.trigger ?? {},
    action: r.action ?? { kind: 'flag_blocker' },
  };
}

function recommendationInWriteScope(
  rec: { workspace_id?: string | null },
  scope: RecommendationWriteScope,
): boolean {
  if (rec.workspace_id == null) return scope.includeCrossWorkspace === true;
  return Array.isArray(scope.workspaceIds) && scope.workspaceIds.includes(rec.workspace_id);
}

function normalizeRecommendationRow(r: SyntheticDomainRecommendation): SyntheticDomainRecommendation {
  return {
    ...r,
    rule_id: r.rule_id ?? null,
    source_event_ids: Array.isArray(r.source_event_ids) ? r.source_event_ids : [],
    source_project_ids: Array.isArray(r.source_project_ids) ? r.source_project_ids : [],
    payload: r.payload ?? {},
    confidence: typeof r.confidence === 'string' ? Number(r.confidence) : (r.confidence ?? 0.7),
    acted_by: r.acted_by ?? null,
    acted_at: r.acted_at ?? null,
    resolution_note: r.resolution_note ?? null,
  };
}

const RECOMMENDATION_KINDS = new Set([
  'extend_timeline', 'add_goal', 'add_roadmap_item',
  'mark_goal_complete', 'mark_roadmap_item_complete',
  'flag_blocker', 'reorder_roadmap', 'update_member_set', 'archive_domain',
]);

function validatePropagationTriggerThrowing(t: unknown): void {
  if (!t || typeof t !== 'object') {
    throw makeError('VALIDATION_ERROR', 'trigger must be an object', 400);
  }
  const obj = t as Record<string, unknown>;
  if (!obj.event_pattern && !obj.goal_pattern) {
    throw makeError('VALIDATION_ERROR', 'trigger must define event_pattern OR goal_pattern', 400);
  }
}

function validatePropagationActionThrowing(a: unknown): void {
  if (!a || typeof a !== 'object') {
    throw makeError('VALIDATION_ERROR', 'action must be an object', 400);
  }
  const obj = a as Record<string, unknown>;
  if (typeof obj.kind !== 'string' || !RECOMMENDATION_KINDS.has(obj.kind as string)) {
    throw makeError('VALIDATION_ERROR', `action.kind must be one of: ${[...RECOMMENDATION_KINDS].join(', ')}`, 400);
  }
  if (obj.expiry_hours !== undefined && (typeof obj.expiry_hours !== 'number' || obj.expiry_hours < 1 || obj.expiry_hours > 720)) {
    throw makeError('VALIDATION_ERROR', 'action.expiry_hours must be a number between 1 and 720', 400);
  }
  if (obj.confidence !== undefined && (typeof obj.confidence !== 'number' || obj.confidence < 0 || obj.confidence > 1)) {
    throw makeError('VALIDATION_ERROR', 'action.confidence must be between 0 and 1', 400);
  }
}

function matchEventPattern(
  ev: { status: string; source_tool: string; occurred_at: string },
  trigger: PropagationTrigger,
): boolean {
  const p = trigger.event_pattern;
  if (!p) return false;
  if (p.status_in && !p.status_in.includes(ev.status as any)) return false;
  if (p.source_tool_in && !p.source_tool_in.includes(ev.source_tool as any)) return false;
  if (p.min_age_seconds) {
    const ageMs = Date.now() - new Date(ev.occurred_at).getTime();
    if (ageMs < p.min_age_seconds * 1000) return false;
  }
  return true;
}

function interpolateRationale(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, function (_, k) { return vars[k] ?? ''; });
}

function validateDerivationThrowing(d: unknown): void {
  if (!d || typeof d !== 'object') {
    throw makeError('VALIDATION_ERROR', 'derivation must be an object', 400);
  }
  const obj = d as Record<string, unknown>;
  if (typeof obj.kind !== 'string' || !GOAL_DERIVATION_KINDS.has(obj.kind as string)) {
    throw makeError('VALIDATION_ERROR', `derivation.kind must be one of: ${[...GOAL_DERIVATION_KINDS].join(', ')}`, 400);
  }
  if (obj.filter !== undefined && (typeof obj.filter !== 'object' || obj.filter === null)) {
    throw makeError('VALIDATION_ERROR', 'derivation.filter must be an object if present', 400);
  }
}

/**
 * Evaluates a goal's derivation rule against current data. Returns the numeric value.
 * Supported kinds: member_project_count, project_status_count, event_count, sign_off_approved_count
 */
async function evaluateDerivationRow(sql: Sql, domainId: SyntheticDomainId, derivation: GoalDerivation): Promise<number> {
  switch (derivation.kind) {
    case 'member_project_count': {
      const rows = await sql/*sql*/`
        SELECT COUNT(*)::int AS n FROM synthetic_domain_membership WHERE domain_id = ${domainId}
      ` as Array<{ n: number }>;
      return rows[0]?.n ?? 0;
    }
    case 'project_status_count': {
      const targetStatus = String(derivation.filter?.status ?? 'active');
      const rows = await sql/*sql*/`
        SELECT COUNT(*)::int AS n
        FROM synthetic_domain_membership m
        JOIN projects p ON p.id = m.project_id
        WHERE m.domain_id = ${domainId} AND p.status = ${targetStatus}
      ` as Array<{ n: number }>;
      return rows[0]?.n ?? 0;
    }
    case 'event_count': {
      const targetStatus = derivation.filter?.status ? String(derivation.filter.status) : null;
      if (targetStatus) {
        const rows = await sql/*sql*/`
          SELECT COUNT(*)::int AS n
          FROM synthetic_domain_membership m
          JOIN operation_events e ON e.project_id = m.project_id
          WHERE m.domain_id = ${domainId} AND e.status = ${targetStatus}
        ` as Array<{ n: number }>;
        return rows[0]?.n ?? 0;
      }
      const rows = await sql/*sql*/`
        SELECT COUNT(*)::int AS n
        FROM synthetic_domain_membership m
        JOIN operation_events e ON e.project_id = m.project_id
        WHERE m.domain_id = ${domainId}
      ` as Array<{ n: number }>;
      return rows[0]?.n ?? 0;
    }
    case 'sign_off_approved_count': {
      const rows = await sql/*sql*/`
        SELECT COUNT(*)::int AS n
        FROM synthetic_domain_membership m
        JOIN operation_events e ON e.project_id = m.project_id
        JOIN sign_offs s ON s.event_id = e.id
        WHERE m.domain_id = ${domainId} AND s.verdict = 'approved'
      ` as Array<{ n: number }>;
      return rows[0]?.n ?? 0;
    }
    default:
      return 0;
  }
}

async function loadActiveRulesGroupedByDomainRow(sql: Sql): Promise<Map<string, SyntheticDomainPropagationRule[]>> {
  const rows = await sql/*sql*/`
    SELECT id, domain_id, workspace_id, name, description, trigger, action, status,
           last_fired_at, fire_count, created_by, updated_by, created_at, updated_at
    FROM synthetic_domain_propagation_rules
    WHERE status = 'active' AND trigger ? 'event_pattern'
  ` as SyntheticDomainPropagationRule[];
  const map = new Map<string, SyntheticDomainPropagationRule[]>();
  for (const r of rows.map(normalizePropagationRuleRow)) {
    const arr = map.get(r.domain_id) ?? [];
    arr.push(r);
    map.set(r.domain_id, arr);
  }
  return map;
}

async function isRuleDebouncedRow(sql: Sql, ruleId: PropagationRuleId, eventId: string, windowSec: number): Promise<boolean> {
  const rows = await sql/*sql*/`
    SELECT 1 FROM synthetic_domain_recommendations
    WHERE rule_id = ${ruleId} AND ${eventId} = ANY(source_event_ids)
      AND generated_at > now() - (${windowSec} * INTERVAL '1 second')
    LIMIT 1
  ` as Array<{ '?column?': number }>;
  return rows.length > 0;
}

async function applyRecommendationPayloadRow(sql: Sql, rec: SyntheticDomainRecommendation, actorUserId: UserId): Promise<void> {
  switch (rec.kind) {
    case 'mark_goal_complete': {
      const goalId = String(rec.payload?.goal_id ?? '');
      if (!goalId) return;
      await sql/*sql*/`
        UPDATE synthetic_domain_goals
        SET status = 'achieved', updated_by = ${actorUserId}, updated_at = now()
        WHERE id = ${goalId} AND status != 'achieved'
      `;
      return;
    }
    case 'add_roadmap_item': {
      const roadmapId = String(rec.payload?.roadmap_id ?? '');
      const title = String(rec.payload?.title ?? '');
      if (!roadmapId || !title) return;
      await addRoadmapItemRow(sql, roadmapId, { title, status: 'planned' }, actorUserId);
      return;
    }
    case 'mark_roadmap_item_complete': {
      const itemId = String(rec.payload?.item_id ?? '');
      if (!itemId) return;
      await sql/*sql*/`
        UPDATE synthetic_domain_roadmap_items
        SET status = 'done', updated_at = now()
        WHERE id = ${itemId} AND status != 'done'
      `;
      return;
    }
    case 'flag_blocker':
    case 'extend_timeline':
    case 'reorder_roadmap':
    case 'add_goal':
    case 'update_member_set':
    case 'archive_domain':
      // Advisory only at this stage; future PRs implement the actual mutation
      return;
    default:
      return;
  }
}

async function updateDomainRecommendationCounterRow(sql: Sql, domainId: SyntheticDomainId): Promise<void> {
  await sql/*sql*/`
    UPDATE synthetic_domains
    SET open_recommendation_count = (
      SELECT COUNT(*)::int FROM synthetic_domain_recommendations
      WHERE domain_id = ${domainId} AND status = 'pending'
    ),
    updated_at = now()
    WHERE id = ${domainId}
  `;
}

// ------------------------------------------------------------
// Public store functions (delegation targets)
// ------------------------------------------------------------

// ---- Goals ----

export async function createGoalRow(sql: Sql, input: SyntheticDomainGoalCreateInput, actorUserId: UserId): Promise<SyntheticDomainGoal> {
  if (!actorUserId) throw makeError('VALIDATION_ERROR', 'actor required', 400);
  if (!input.title || input.title.length > 200) throw makeError('VALIDATION_ERROR', 'title 1-200 chars required', 400);
  if (!input.metric_name) throw makeError('VALIDATION_ERROR', 'metric_name required', 400);
  if (typeof input.target_value !== 'number' || Number.isNaN(input.target_value)) {
    throw makeError('VALIDATION_ERROR', 'target_value must be a number', 400);
  }
  validateDerivationThrowing(input.derivation);
  const domain = await getDomainOrThrowRow(sql, input.domain_id);
  const newId = input.id && input.id.length > 0
    ? input.id
    : `sdg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const rows = await sql/*sql*/`
    INSERT INTO synthetic_domain_goals (
      id, domain_id, roadmap_id, workspace_id, title, description,
      metric_name, metric_unit, target_value, target_date, status,
      derivation, metadata, created_by,
      tier, ikigai_axes, future_state, review_cadence, review_due, source_goal_id, goal_metric_contract
    ) VALUES (
      ${newId}, ${input.domain_id}, ${input.roadmap_id ?? null}, ${domain.workspace_id},
      ${input.title}, ${input.description ?? null},
      ${input.metric_name}, ${input.metric_unit ?? null}, ${input.target_value},
      ${input.target_date ?? null}, ${input.status ?? 'proposed'},
      ${JSON.stringify(input.derivation)}::jsonb,
      ${JSON.stringify(input.metadata ?? {})}::jsonb,
      ${actorUserId},
      ${input.tier ?? null}, ${input.ikigai_axes ?? []}, ${input.future_state ?? null},
      ${input.review_cadence ?? null}, ${input.review_due ?? null}, ${input.source_goal_id ?? null},
      ${input.goal_metric_contract ? JSON.stringify(input.goal_metric_contract) : null}::jsonb
    )
    RETURNING id, domain_id, roadmap_id, workspace_id, title, description,
              metric_name, metric_unit, target_value, current_value, current_value_updated_at,
              target_date, status, derivation, metadata, created_by, updated_by, created_at, updated_at
  ` as SyntheticDomainGoal[];
  const goal = normalizeGoalRow(rows[0]!);
  // Compute initial current_value
  try { await recomputeGoalValueRow(sql, goal.id, actorUserId, null); } catch (_) { /* best-effort */ }
  await updateDomainCountersRow(sql, input.domain_id);
  await appendAuditLogRow(sql, {
    actor_user_id: actorUserId,
    action: 'sd_goal_create',
    target_type: 'synthetic_domain_goal',
    target_id: goal.id,
    workspace_id: goal.workspace_id ?? null,
    metadata: { domain_id: goal.domain_id, metric_name: goal.metric_name, target_value: goal.target_value },
  });
  return goal;
}

export async function listGoalsForDomainRow(sql: Sql, domainId: SyntheticDomainId, status?: GoalStatus): Promise<SyntheticDomainGoal[]> {
  if (status) {
    const rows = await sql/*sql*/`
      SELECT id, domain_id, roadmap_id, workspace_id, title, description,
             metric_name, metric_unit, target_value, current_value, current_value_updated_at,
             target_date, status, derivation, metadata, created_by, updated_by, created_at, updated_at
      FROM synthetic_domain_goals
      WHERE domain_id = ${domainId} AND status = ${status}
      ORDER BY created_at DESC LIMIT 200
    ` as SyntheticDomainGoal[];
    return rows.map(normalizeGoalRow);
  }
  const rows = await sql/*sql*/`
    SELECT id, domain_id, roadmap_id, workspace_id, title, description,
           metric_name, metric_unit, target_value, current_value, current_value_updated_at,
           target_date, status, derivation, metadata, created_by, updated_by, created_at, updated_at
    FROM synthetic_domain_goals
    WHERE domain_id = ${domainId} AND status != 'abandoned'
    ORDER BY created_at DESC LIMIT 200
  ` as SyntheticDomainGoal[];
  return rows.map(normalizeGoalRow);
}

export async function getGoalRow(sql: Sql, goalId: SyntheticDomainGoalId): Promise<SyntheticDomainGoal | null> {
  const rows = await sql/*sql*/`
    SELECT id, domain_id, roadmap_id, workspace_id, title, description,
           metric_name, metric_unit, target_value, current_value, current_value_updated_at,
           target_date, status, derivation, metadata, created_by, updated_by, created_at, updated_at
    FROM synthetic_domain_goals WHERE id = ${goalId} LIMIT 1
  ` as SyntheticDomainGoal[];
  if (rows.length === 0) return null;
  return normalizeGoalRow(rows[0]!);
}

/** A10 review-scheduler (mig 069 review_cadence/review_due). No existing goal SELECT carries these two
 *  columns, so the cron gets its own minimal projection. review_due is cast to text ⇒ 'YYYY-MM-DD'. */
export interface GoalReviewDueRow {
  id: string;
  domain_id: string;
  workspace_id: string;
  review_cadence: string | null;
  review_due: string | null;
}

/** Cross-workspace (system-loop) read of ACTIVE goals whose review_due has passed (<= nowDateIso),
 *  most-overdue first, hard-bounded (≤500) so the query never runs long. The A10 cadence kernel
 *  (services/review-scheduler.ts selectDueReviews) re-confirms + orders + computes overdue_days. */
export async function listGoalsWithReviewDueRow(sql: Sql, nowDateIso: string, limit: number): Promise<GoalReviewDueRow[]> {
  const capped = Math.min(Math.max(1, limit), 500);
  const rows = await sql/*sql*/`
    SELECT id, domain_id, workspace_id, review_cadence, review_due::text AS review_due
    FROM synthetic_domain_goals
    WHERE review_due IS NOT NULL AND review_due <= ${nowDateIso}::date AND status = 'active'
    ORDER BY review_due ASC
    LIMIT ${capped}
  ` as GoalReviewDueRow[];
  return rows;
}

/** Advance a goal's review_due to the next cadence slot (computed by rescheduleReviewDue). Scoped by id;
 *  a re-run writing the same next date is a harmless idempotent UPDATE. No audit row (system cadence bump). */
export async function updateGoalReviewDueRow(sql: Sql, goalId: SyntheticDomainGoalId, nextReviewDue: string): Promise<void> {
  await sql/*sql*/`
    UPDATE synthetic_domain_goals
    SET review_due = ${nextReviewDue}::date, updated_at = now()
    WHERE id = ${goalId}
  `;
}

export async function updateGoalRow(
  sql: Sql,
  goalId: SyntheticDomainGoalId,
  patch: { title?: string; description?: string | null; target_value?: number; target_date?: string | null; status?: GoalStatus; metadata?: Record<string, any> },
  actorUserId: UserId,
): Promise<SyntheticDomainGoal> {
  if (!actorUserId) throw makeError('VALIDATION_ERROR', 'actor required', 400);
  const rows = await sql/*sql*/`
    UPDATE synthetic_domain_goals
    SET title = COALESCE(${patch.title ?? null}, title),
        description = COALESCE(${patch.description ?? null}, description),
        target_value = COALESCE(${patch.target_value ?? null}::numeric, target_value),
        target_date = COALESCE(${patch.target_date ?? null}, target_date),
        status = COALESCE(${patch.status ?? null}, status),
        metadata = COALESCE(${patch.metadata ? JSON.stringify(patch.metadata) : null}::jsonb, metadata),
        updated_by = ${actorUserId},
        updated_at = now()
    WHERE id = ${goalId}
    RETURNING id, domain_id, roadmap_id, workspace_id, title, description,
              metric_name, metric_unit, target_value, current_value, current_value_updated_at,
              target_date, status, derivation, metadata, created_by, updated_by, created_at, updated_at
  ` as SyntheticDomainGoal[];
  if (rows.length === 0) throw makeError('NOT_FOUND', `goal ${goalId} not found`, 404);
  const goal = normalizeGoalRow(rows[0]!);
  await appendAuditLogRow(sql, {
    actor_user_id: actorUserId,
    action: patch.status === 'abandoned' ? 'sd_goal_archive' : 'sd_goal_update',
    target_type: 'synthetic_domain_goal',
    target_id: goal.id,
    workspace_id: goal.workspace_id ?? null,
    metadata: { changed_fields: Object.keys(patch) },
  });
  return goal;
}

export async function recomputeGoalValueRow(
  sql: Sql,
  goalId: SyntheticDomainGoalId,
  actorUserId: UserId,
  sourceSignalId?: string | null,
): Promise<{ goal: SyntheticDomainGoal; value: number }> {
  if (!actorUserId) throw makeError('VALIDATION_ERROR', 'actor required', 400);
  const goal = await getGoalRow(sql, goalId);
  if (!goal) throw makeError('NOT_FOUND', `goal ${goalId} not found`, 404);

  const value = await evaluateDerivationRow(sql, goal.domain_id, goal.derivation);
  // Auto-flip status when target reached
  let nextStatus: GoalStatus = goal.status;
  if (goal.status === 'active' && value >= goal.target_value) nextStatus = 'achieved';

  const updRows = await sql/*sql*/`
    UPDATE synthetic_domain_goals
    SET current_value = ${value},
        current_value_updated_at = now(),
        status = ${nextStatus},
        updated_at = now()
    WHERE id = ${goalId}
    RETURNING id, domain_id, roadmap_id, workspace_id, title, description,
              metric_name, metric_unit, target_value, current_value, current_value_updated_at,
              target_date, status, derivation, metadata, created_by, updated_by, created_at, updated_at
  ` as SyntheticDomainGoal[];

  await sql/*sql*/`
    INSERT INTO synthetic_domain_goal_progress (goal_id, observed_at, value, source_signal_id)
    VALUES (${goalId}, now(), ${value}, ${sourceSignalId ?? null})
    ON CONFLICT (goal_id, observed_at) DO NOTHING
  `;

  await appendAuditLogRow(sql, {
    actor_user_id: actorUserId,
    action: 'sd_goal_recompute_value',
    target_type: 'synthetic_domain_goal',
    target_id: goalId,
    workspace_id: goal.workspace_id ?? null,
    metadata: { value, target_value: goal.target_value, status: nextStatus },
  });

  return { goal: normalizeGoalRow(updRows[0]!), value };
}

export async function listGoalProgressRow(sql: Sql, goalId: SyntheticDomainGoalId, limit: number = 100): Promise<SyntheticDomainGoalProgress[]> {
  const lim = Math.min(Math.max(1, limit), 500);
  const rows = await sql/*sql*/`
    SELECT goal_id, observed_at, value, source_signal_id
    FROM synthetic_domain_goal_progress
    WHERE goal_id = ${goalId}
    ORDER BY observed_at DESC
    LIMIT ${lim}
  ` as SyntheticDomainGoalProgress[];
  return rows.map((r) => ({ ...r, source_signal_id: r.source_signal_id ?? null }));
}

// ---- Propagation rules ----

export async function createPropagationRuleRow(sql: Sql, input: PropagationRuleCreateInput, actorUserId: UserId): Promise<SyntheticDomainPropagationRule> {
  if (!actorUserId) throw makeError('VALIDATION_ERROR', 'actor required', 400);
  if (!input.name || input.name.length > 200) throw makeError('VALIDATION_ERROR', 'name 1-200 chars required', 400);
  validatePropagationTriggerThrowing(input.trigger);
  validatePropagationActionThrowing(input.action);
  const domain = await getDomainOrThrowRow(sql, input.domain_id);
  const newId = input.id && input.id.length > 0
    ? input.id
    : `sdpr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const rows = await sql/*sql*/`
    INSERT INTO synthetic_domain_propagation_rules (
      id, domain_id, workspace_id, name, description, trigger, action, status,
      fire_count, created_by
    ) VALUES (
      ${newId}, ${input.domain_id}, ${domain.workspace_id},
      ${input.name}, ${input.description ?? null},
      ${JSON.stringify(input.trigger)}::jsonb,
      ${JSON.stringify(input.action)}::jsonb,
      ${input.status ?? 'active'},
      0,
      ${actorUserId}
    )
    RETURNING id, domain_id, workspace_id, name, description, trigger, action, status,
              last_fired_at, fire_count, created_by, updated_by, created_at, updated_at
  ` as SyntheticDomainPropagationRule[];
  const rule = normalizePropagationRuleRow(rows[0]!);
  await appendAuditLogRow(sql, {
    actor_user_id: actorUserId,
    action: 'sd_propagation_rule_create',
    target_type: 'synthetic_domain_propagation_rule',
    target_id: rule.id,
    workspace_id: rule.workspace_id ?? null,
    metadata: { domain_id: rule.domain_id, name: rule.name, action_kind: input.action.kind },
  });
  return rule;
}

export async function listPropagationRulesForDomainRow(sql: Sql, domainId: SyntheticDomainId, status?: PropagationRuleStatus): Promise<SyntheticDomainPropagationRule[]> {
  if (status) {
    const rows = await sql/*sql*/`
      SELECT id, domain_id, workspace_id, name, description, trigger, action, status,
             last_fired_at, fire_count, created_by, updated_by, created_at, updated_at
      FROM synthetic_domain_propagation_rules
      WHERE domain_id = ${domainId} AND status = ${status}
      ORDER BY created_at DESC LIMIT 200
    ` as SyntheticDomainPropagationRule[];
    return rows.map(normalizePropagationRuleRow);
  }
  const rows = await sql/*sql*/`
    SELECT id, domain_id, workspace_id, name, description, trigger, action, status,
           last_fired_at, fire_count, created_by, updated_by, created_at, updated_at
    FROM synthetic_domain_propagation_rules
    WHERE domain_id = ${domainId} AND status != 'archived'
    ORDER BY created_at DESC LIMIT 200
  ` as SyntheticDomainPropagationRule[];
  return rows.map(normalizePropagationRuleRow);
}

export async function updatePropagationRuleRow(
  sql: Sql,
  ruleId: PropagationRuleId,
  patch: { name?: string; description?: string | null; trigger?: PropagationTrigger; action?: PropagationAction; status?: PropagationRuleStatus },
  actorUserId: UserId,
): Promise<SyntheticDomainPropagationRule> {
  if (!actorUserId) throw makeError('VALIDATION_ERROR', 'actor required', 400);
  if (patch.trigger) validatePropagationTriggerThrowing(patch.trigger);
  if (patch.action) validatePropagationActionThrowing(patch.action);
  const rows = await sql/*sql*/`
    UPDATE synthetic_domain_propagation_rules
    SET name = COALESCE(${patch.name ?? null}, name),
        description = COALESCE(${patch.description ?? null}, description),
        trigger = COALESCE(${patch.trigger ? JSON.stringify(patch.trigger) : null}::jsonb, trigger),
        action = COALESCE(${patch.action ? JSON.stringify(patch.action) : null}::jsonb, action),
        status = COALESCE(${patch.status ?? null}, status),
        updated_by = ${actorUserId},
        updated_at = now()
    WHERE id = ${ruleId}
    RETURNING id, domain_id, workspace_id, name, description, trigger, action, status,
              last_fired_at, fire_count, created_by, updated_by, created_at, updated_at
  ` as SyntheticDomainPropagationRule[];
  if (rows.length === 0) throw makeError('NOT_FOUND', `propagation rule ${ruleId} not found`, 404);
  const rule = normalizePropagationRuleRow(rows[0]!);
  await appendAuditLogRow(sql, {
    actor_user_id: actorUserId,
    action: patch.status === 'archived' ? 'sd_propagation_rule_archive' : 'sd_propagation_rule_update',
    target_type: 'synthetic_domain_propagation_rule',
    target_id: rule.id,
    workspace_id: rule.workspace_id ?? null,
    metadata: { changed_fields: Object.keys(patch) },
  });
  return rule;
}

export async function archivePropagationRuleRow(sql: Sql, ruleId: PropagationRuleId, actorUserId: UserId): Promise<SyntheticDomainPropagationRule> {
  return updatePropagationRuleRow(sql, ruleId, { status: 'archived' }, actorUserId);
}

// ---- Recommendations ----

export async function listRecommendationsRow(sql: Sql, opts: RecommendationListOpts): Promise<SyntheticDomainRecommendation[]> {
  const status = opts.status ?? 'pending';
  const limit = Math.min(opts.limit ?? 100, 500);
  if (opts.domain_id) {
    const rows = await sql/*sql*/`
      SELECT id, domain_id, workspace_id, rule_id, source_event_ids, source_project_ids,
             kind, payload, rationale, confidence, status,
             generated_at, expires_at, acted_by, acted_at, resolution_note
      FROM synthetic_domain_recommendations
      WHERE domain_id = ${opts.domain_id} AND status = ${status}
      ORDER BY generated_at DESC
      LIMIT ${limit}
    ` as SyntheticDomainRecommendation[];
    return rows.map(normalizeRecommendationRow);
  }
  // TENANT SCOPING (audit 260531): no domain_id → require a workspace scope; FAIL-CLOSED.
  // Closes the prior unscoped read where `WHERE status = ${status}` returned ALL
  // recommendations across every tenant. workspaceIds = the caller's accessible
  // workspaces; includeCrossWorkspace additionally returns operator-only cross-workspace
  // (workspace_id IS NULL) rows. (ANY(${array}) is the same param pattern as
  // listWorkspacesForOperator.)
  const workspaceIds = Array.isArray(opts.workspaceIds) ? opts.workspaceIds.filter(Boolean) : [];
  const includeCross = opts.includeCrossWorkspace === true;
  if (workspaceIds.length === 0 && !includeCross) {
    return []; // no tenant scope → no rows (never an unscoped all-tenant read)
  }
  let rows: SyntheticDomainRecommendation[];
  if (workspaceIds.length > 0 && includeCross) {
    rows = await sql/*sql*/`
      SELECT id, domain_id, workspace_id, rule_id, source_event_ids, source_project_ids,
             kind, payload, rationale, confidence, status,
             generated_at, expires_at, acted_by, acted_at, resolution_note
      FROM synthetic_domain_recommendations
      WHERE status = ${status} AND (workspace_id = ANY(${workspaceIds}) OR workspace_id IS NULL)
      ORDER BY generated_at DESC
      LIMIT ${limit}
    ` as SyntheticDomainRecommendation[];
  } else if (workspaceIds.length > 0) {
    rows = await sql/*sql*/`
      SELECT id, domain_id, workspace_id, rule_id, source_event_ids, source_project_ids,
             kind, payload, rationale, confidence, status,
             generated_at, expires_at, acted_by, acted_at, resolution_note
      FROM synthetic_domain_recommendations
      WHERE status = ${status} AND workspace_id = ANY(${workspaceIds})
      ORDER BY generated_at DESC
      LIMIT ${limit}
    ` as SyntheticDomainRecommendation[];
  } else {
    rows = await sql/*sql*/`
      SELECT id, domain_id, workspace_id, rule_id, source_event_ids, source_project_ids,
             kind, payload, rationale, confidence, status,
             generated_at, expires_at, acted_by, acted_at, resolution_note
      FROM synthetic_domain_recommendations
      WHERE status = ${status} AND workspace_id IS NULL
      ORDER BY generated_at DESC
      LIMIT ${limit}
    ` as SyntheticDomainRecommendation[];
  }
  return rows.map(normalizeRecommendationRow);
}

export async function getRecommendationRow(sql: Sql, id: RecommendationId): Promise<SyntheticDomainRecommendation | null> {
  const rows = await sql/*sql*/`
    SELECT id, domain_id, workspace_id, rule_id, source_event_ids, source_project_ids,
           kind, payload, rationale, confidence, status,
           generated_at, expires_at, acted_by, acted_at, resolution_note
    FROM synthetic_domain_recommendations WHERE id = ${id} LIMIT 1
  ` as SyntheticDomainRecommendation[];
  if (rows.length === 0) return null;
  return normalizeRecommendationRow(rows[0]!);
}

export async function acceptRecommendationRow(sql: Sql, id: RecommendationId, actorUserId: UserId, note?: string, scope?: RecommendationWriteScope): Promise<SyntheticDomainRecommendation> {
  if (!actorUserId) throw makeError('VALIDATION_ERROR', 'actor required', 400);
  const rec = await getRecommendationRow(sql, id);
  if (!rec) throw makeError('NOT_FOUND', `recommendation ${id} not found`, 404);
  // R55-3c · TENANT WRITE GUARD. accept() runs applyRecommendationPayloadRow (a
  // mutation). Without scoping, any 'owner'/'operator'-role customer could act
  // on another tenant's recommendation by id — the write mirror of the
  // GET /recommendations read leak. Enforce BEFORE any mutation/status flip.
  if (scope && !recommendationInWriteScope(rec, scope)) {
    throw makeError('FORBIDDEN', `recommendation ${id} not in caller scope`, 403);
  }
  if (rec.status !== 'pending') {
    throw makeError('CONFLICT', `recommendation already ${rec.status}`, 409);
  }
  // Apply the payload per kind (advisory => mutation transition point)
  try {
    await applyRecommendationPayloadRow(sql, rec, actorUserId);
  } catch (e: any) {
    throw makeError('UNPROCESSABLE', `apply failed: ${e?.message ?? String(e)}`, 422);
  }
  const updRows = await sql/*sql*/`
    UPDATE synthetic_domain_recommendations
    SET status = 'accepted',
        acted_by = ${actorUserId},
        acted_at = now(),
        resolution_note = ${note ?? null}
    WHERE id = ${id}
    RETURNING id, domain_id, workspace_id, rule_id, source_event_ids, source_project_ids,
              kind, payload, rationale, confidence, status,
              generated_at, expires_at, acted_by, acted_at, resolution_note
  ` as SyntheticDomainRecommendation[];
  const result = normalizeRecommendationRow(updRows[0]!);
  await updateDomainRecommendationCounterRow(sql, rec.domain_id);
  await appendAuditLogRow(sql, {
    actor_user_id: actorUserId,
    action: 'sd_recommendation_accept',
    target_type: 'synthetic_domain_recommendation',
    target_id: id,
    workspace_id: rec.workspace_id ?? null,
    metadata: { kind: rec.kind, note: note ?? null },
  });
  return result;
}

export async function rejectRecommendationRow(sql: Sql, id: RecommendationId, actorUserId: UserId, note: string, scope?: RecommendationWriteScope): Promise<SyntheticDomainRecommendation> {
  if (!actorUserId) throw makeError('VALIDATION_ERROR', 'actor required', 400);
  if (!note || note.trim().length === 0) {
    throw makeError('VALIDATION_ERROR', 'reject requires a resolution_note', 400);
  }
  const rec = await getRecommendationRow(sql, id);
  if (!rec) throw makeError('NOT_FOUND', `recommendation ${id} not found`, 404);
  // R55-3c · TENANT WRITE GUARD (mirror of acceptRecommendation). Prevents a
  // customer 'owner'/'operator' role from rejecting another tenant's row by id.
  if (scope && !recommendationInWriteScope(rec, scope)) {
    throw makeError('FORBIDDEN', `recommendation ${id} not in caller scope`, 403);
  }
  if (rec.status !== 'pending') {
    throw makeError('CONFLICT', `recommendation already ${rec.status}`, 409);
  }
  const updRows = await sql/*sql*/`
    UPDATE synthetic_domain_recommendations
    SET status = 'rejected',
        acted_by = ${actorUserId},
        acted_at = now(),
        resolution_note = ${note}
    WHERE id = ${id}
    RETURNING id, domain_id, workspace_id, rule_id, source_event_ids, source_project_ids,
              kind, payload, rationale, confidence, status,
              generated_at, expires_at, acted_by, acted_at, resolution_note
  ` as SyntheticDomainRecommendation[];
  const result = normalizeRecommendationRow(updRows[0]!);
  await updateDomainRecommendationCounterRow(sql, rec.domain_id);
  await appendAuditLogRow(sql, {
    actor_user_id: actorUserId,
    action: 'sd_recommendation_reject',
    target_type: 'synthetic_domain_recommendation',
    target_id: id,
    workspace_id: rec.workspace_id ?? null,
    metadata: { kind: rec.kind, note: note },
  });
  return result;
}

export async function runPropagationTickRow(sql: Sql, actorUserId: UserId): Promise<PropagationTickResult> {
  const startedAt = Date.now();
  const result: PropagationTickResult = {
    ticks_run: 0,
    events_seen: 0,
    recommendations_generated: 0,
    expired_count: 0,
    last_event_ts: null,
    duration_ms: 0,
  };
  try {
    // 1. Expire past-due pending recommendations
    const expiredRows = await sql/*sql*/`
      UPDATE synthetic_domain_recommendations
      SET status = 'expired'
      WHERE status = 'pending' AND expires_at < now()
      RETURNING id, domain_id
    ` as Array<{ id: string; domain_id: string }>;
    result.expired_count = expiredRows.length;

    // 2. Read tick state
    const tickRows = await sql/*sql*/`
      SELECT last_tick_at, last_event_ts FROM propagation_tick_state WHERE id = 1
    ` as Array<{ last_tick_at: string; last_event_ts: string | null }>;
    const lastTickAt = tickRows[0]?.last_tick_at ?? new Date(Date.now() - 3600_000).toISOString();

    // 3. Read new events since last_tick_at, scoped to projects that are members of any active domain
    const newEvents = await sql/*sql*/`
      SELECT DISTINCT e.id, e.workspace_id, e.project_id, e.source_tool, e.agent_id,
                      e.status, e.summary, e.occurred_at
      FROM operation_events e
      JOIN synthetic_domain_membership m ON m.project_id = e.project_id
      JOIN synthetic_domains d ON d.id = m.domain_id AND d.status = 'active'
      WHERE e.occurred_at > ${lastTickAt}
      ORDER BY e.occurred_at ASC
      LIMIT 500
    ` as Array<{ id: string; workspace_id: string; project_id: string; source_tool: string; agent_id: string | null; status: string; summary: string; occurred_at: string }>;
    result.events_seen = newEvents.length;
    result.last_event_ts = newEvents.length > 0 ? newEvents[newEvents.length - 1]!.occurred_at : (tickRows[0]?.last_event_ts ?? null);

    // 4. For each new event, find active rules whose event_pattern matches; write recommendations
    if (newEvents.length > 0) {
      const rulesByDomain = await loadActiveRulesGroupedByDomainRow(sql);
      for (const ev of newEvents) {
        const membershipRows = await sql/*sql*/`
          SELECT domain_id FROM synthetic_domain_membership WHERE project_id = ${ev.project_id}
        ` as Array<{ domain_id: string }>;
        for (const { domain_id } of membershipRows) {
          const rules = rulesByDomain.get(domain_id) ?? [];
          for (const rule of rules) {
            if (!matchEventPattern(ev, rule.trigger)) continue;
            if (rule.trigger.debounce_window_seconds) {
              const isDebounced = await isRuleDebouncedRow(sql, rule.id, ev.id, rule.trigger.debounce_window_seconds);
              if (isDebounced) continue;
            }
            const recId = `sdrec_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
            const payload = Object.assign({ event_id: ev.id, project_id: ev.project_id }, rule.action.payload_extra ?? {});
            const rationale = interpolateRationale(
              rule.action.rationale_template ?? `Rule "${rule.name}" matched event ${ev.id}`,
              { event_id: ev.id, project_id: ev.project_id, domain_id: domain_id, value: '', target: '' },
            );
            const expiryHours = rule.action.expiry_hours ?? 168;
            const confidence = typeof rule.action.confidence === 'number' ? rule.action.confidence : 0.7;
            await sql/*sql*/`
              INSERT INTO synthetic_domain_recommendations (
                id, domain_id, workspace_id, rule_id, source_event_ids, source_project_ids,
                kind, payload, rationale, confidence, status, expires_at
              ) VALUES (
                ${recId}, ${domain_id}, ${rule.workspace_id}, ${rule.id},
                ARRAY[${ev.id}]::text[], ARRAY[${ev.project_id}]::text[],
                ${rule.action.kind},
                ${JSON.stringify(payload)}::jsonb,
                ${rationale},
                ${confidence},
                'pending',
                now() + (${expiryHours} * INTERVAL '1 hour')
              )
              ON CONFLICT DO NOTHING
            `;
            await sql/*sql*/`
              UPDATE synthetic_domain_propagation_rules
              SET last_fired_at = now(), fire_count = fire_count + 1
              WHERE id = ${rule.id}
            `;
            result.recommendations_generated++;
          }
        }
      }
    }

    // 5. Goal-pattern rules: scan active goals + auto-generate mark_goal_complete when pct >= 1.0
    const goalRules = await sql/*sql*/`
      SELECT id, domain_id, workspace_id, trigger, action, name
      FROM synthetic_domain_propagation_rules
      WHERE status = 'active' AND trigger ? 'goal_pattern'
    ` as Array<{ id: string; domain_id: string; workspace_id: string | null; trigger: PropagationTrigger; action: PropagationAction; name: string }>;
    for (const rule of goalRules) {
      const ratio = rule.trigger.goal_pattern?.completion_ratio_gte ?? 1.0;
      const statusFilter = rule.trigger.goal_pattern?.status_in ?? ['active'];
      const goalRows = await sql/*sql*/`
        SELECT id, target_value, current_value, title
        FROM synthetic_domain_goals
        WHERE domain_id = ${rule.domain_id} AND status = ANY(${statusFilter}::text[])
      ` as Array<{ id: string; target_value: number | string; current_value: number | string | null; title: string }>;
      for (const g of goalRows) {
        const cur = g.current_value == null ? 0 : Number(g.current_value);
        const tgt = Number(g.target_value);
        if (tgt <= 0) continue;
        if (cur / tgt < ratio) continue;
        // Suppress duplicate within last 24h
        const dupRows = await sql/*sql*/`
          SELECT id FROM synthetic_domain_recommendations
          WHERE rule_id = ${rule.id} AND kind = ${rule.action.kind}
            AND payload->>'goal_id' = ${g.id}
            AND generated_at > now() - INTERVAL '24 hours'
            AND status IN ('pending','accepted')
          LIMIT 1
        ` as Array<{ id: string }>;
        if (dupRows.length > 0) continue;
        const recId = `sdrec_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
        const payload = Object.assign({ goal_id: g.id, value: cur, target: tgt }, rule.action.payload_extra ?? {});
        const rationale = interpolateRationale(
          rule.action.rationale_template ?? `Goal "${g.title}" reached ${cur}/${tgt}`,
          { event_id: '', project_id: '', domain_id: rule.domain_id, value: String(cur), target: String(tgt) },
        );
        const expiryHours = rule.action.expiry_hours ?? 168;
        await sql/*sql*/`
          INSERT INTO synthetic_domain_recommendations (
            id, domain_id, workspace_id, rule_id, source_event_ids, source_project_ids,
            kind, payload, rationale, confidence, status, expires_at
          ) VALUES (
            ${recId}, ${rule.domain_id}, ${rule.workspace_id}, ${rule.id},
            ARRAY[]::text[], ARRAY[]::text[],
            ${rule.action.kind},
            ${JSON.stringify(payload)}::jsonb,
            ${rationale},
            ${typeof rule.action.confidence === 'number' ? rule.action.confidence : 0.85},
            'pending',
            now() + (${expiryHours} * INTERVAL '1 hour')
          )
          ON CONFLICT DO NOTHING
        `;
        await sql/*sql*/`
          UPDATE synthetic_domain_propagation_rules
          SET last_fired_at = now(), fire_count = fire_count + 1
          WHERE id = ${rule.id}
        `;
        result.recommendations_generated++;
      }
    }

    // 6. Maintain per-domain open_recommendation_count
    await sql/*sql*/`
      UPDATE synthetic_domains sd
      SET open_recommendation_count = (
        SELECT COUNT(*)::int FROM synthetic_domain_recommendations
        WHERE domain_id = sd.id AND status = 'pending'
      ),
      updated_at = now()
      WHERE sd.id IN (
        SELECT DISTINCT domain_id FROM synthetic_domain_recommendations
        WHERE status IN ('pending','expired')
      )
    `;

    // 7. Update tick state
    await sql/*sql*/`
      UPDATE propagation_tick_state
      SET last_tick_at = now(),
          last_event_ts = COALESCE(${result.last_event_ts}::timestamptz, last_event_ts),
          ticks_run = ticks_run + 1,
          recommendations_generated = recommendations_generated + ${result.recommendations_generated},
          last_error = NULL,
          last_error_at = NULL
      WHERE id = 1
    `;
    result.ticks_run = 1;
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    await sql/*sql*/`
      UPDATE propagation_tick_state
      SET last_error = ${msg}, last_error_at = now()
      WHERE id = 1
    `;
    result.error = msg;
  } finally {
    result.duration_ms = Date.now() - startedAt;
  }
  if (actorUserId) {
    try {
      await appendAuditLogRow(sql, {
        actor_user_id: actorUserId,
        action: 'sd_propagation_tick',
        target_type: 'workspace',
        target_id: 'global',
        workspace_id: null,
        metadata: result as unknown as Record<string, any>,
      });
    } catch (_) { /* tick audit is best-effort */ }
  }
  return result;
}
