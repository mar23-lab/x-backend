// event-store.ts · operation_events read + idempotent-upsert group.
//
// Authority: DATABASE_SCHEMA_V1.md (operation_events, workspaces) · API_CONTRACT_V1.md ·
// AUTH_TENANCY_MODEL.md. Lifted verbatim out of WorkersDalAdapter (Stage 3.1, F10) to
// decompose the DAL god-object; behaviour is byte-for-byte identical to the prior inline
// methods. These are consumed by many routes incl. the digest agent — the delegation is
// byte-identical.
//
// The DAL methods are now thin delegations (return <name>Row(this.sql, ...)). assertWorkspaceScope
// is imported from ./DalAdapter and visibilityForRole from ./visibility (same call shapes). The
// pagination constants + normalizeEventRow row-normalizer move here with the methods (no other
// DAL method references them). operatorOwnsWorkspace / listEventsForProjectScope stay on the class.

import { assertWorkspaceScope } from './DalAdapter';
import { makeError } from './shared-helpers';
import { visibilityForRole } from './visibility';
import { getProjectRow } from './project-store';
// Plane 1 RLS cutover (043): tenant-scoped operation_events reads run inside the workspace GUC
// transaction so the RLS-subject client (`rlsSql`) is filtered at the DB. INERT until the secret is
// set — with rlsSql defaulting to the owner `sql`, the owner bypasses RLS and the existing
// `WHERE workspace_id` clause yields byte-identical results (just inside a read-only transaction).
import { withWorkspaceRlsContext } from './operational-spine-store';
import type {
  WorkspaceId,
  ProjectId,
  EventPage,
  EventListOpts,
  EventStatus,
  EventStatusPatch,
  HarnessFlowEvent,
  HarnessFlowEventInput,
  UpsertResult,
  ProjectScopeBinding,
  ProjectScopeFilterType,
} from './types';
import type { Sql } from '../db/client';

const MAX_PAGE_LIMIT = 200;
const DEFAULT_PAGE_LIMIT = 50;

// ------------------------------------------------------------
// Internal helpers (lifted verbatim from WorkersDalAdapter)
// ------------------------------------------------------------

function normalizeEventRow(row: HarnessFlowEvent): HarnessFlowEvent {
  return {
    ...row,
    body: row.body ?? null,
    evidence_link: row.evidence_link ?? null,
    project_id: row.project_id ?? null,
    agent_id: row.agent_id ?? null,
    intent_id: row.intent_id ?? null,
    permission_scope: row.permission_scope ?? null,
    risk: row.risk ?? null,
    approval_state: row.approval_state ?? null,
    next_action: row.next_action ?? null,
    parent_event_id: row.parent_event_id ?? null,
    authorized_by_user_id: row.authorized_by_user_id ?? null,
    instrument_kind: row.instrument_kind ?? null,
    authority_source: row.authority_source ?? null,
    request_id: row.request_id ?? null,
  };
}

// A-W4.1 · customer-safe redaction of the raw human principal id. Policy (PRINCIPAL_INSTRUMENT_LINEAGE.md
// §Customer-safe redaction): no raw internal user ids to the low-trust roles (`client`/`viewer`) or any
// public_safe surface — they still get the SAFE lineage (instrument_kind/authority_source/request_id), just
// not WHO. FAIL-CLOSED: the principal is exposed ONLY to the explicit accountable roles; every other role —
// including an unknown/absent one — is redacted, so a new/mis-plumbed role can never silently leak an id.
// F-retro: the set is {owner, operator} — the ACTUAL runtime auth roles are owner|operator|viewer|client
// (dal/types/access.ts); a phantom 'member' entry was dropped (it never occurs, and leaving an unreachable
// allow entry is a latent hazard if a future RBAC rework maps a real role to that literal). 'owner' is kept
// forward-compat (Clerk currently maps org:admin→'operator', so today the effective accountable set is
// {operator}, which is correct — only the workspace's operators/owner see WHO authorized a write).
const PRINCIPAL_ACCOUNTABLE_ROLES: ReadonlySet<string> = new Set(['owner', 'operator']);
export function redactPrincipalForRole<T extends { authorized_by_user_id?: string | null }>(row: T, role?: string): T {
  return role && PRINCIPAL_ACCOUNTABLE_ROLES.has(role)
    ? row
    : { ...row, authorized_by_user_id: null };
}

// ------------------------------------------------------------
// Public store functions (delegation targets)
// ------------------------------------------------------------

export async function listEventsRow(sql: Sql, workspaceId: WorkspaceId, opts: EventListOpts): Promise<EventPage> {
  assertWorkspaceScope(workspaceId);

  const limit = Math.min(opts.limit ?? DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT);
  const fetchLimit = limit + 1; // fetch one extra to know if there are more pages
  const visList = visibilityForRole(opts.role);
  // Build dynamic query — using tagged-template all the way through.
  // Branching is needed because @neondatabase/serverless tagged templates
  // bind parameters; we choose the variant by query shape.
  const beforeFilter = opts.before ?? null;
  const projectFilter = opts.project_id ?? null;
  const statusFilter = opts.status ?? null;
  const sourceFilter = opts.source_tool ?? null;
  // OS-4 P1 · thread filters (opt-in; defaults unchanged). parent_event_id=X => only X's replies;
  // top_level=true => only non-replies (roll-up). parent wins if both are set.
  const parentFilter = opts.parent_event_id ?? null;
  const topLevelOnly = !parentFilter && opts.top_level === true;

  // Use a single query with NULL-tolerant filters via COALESCE pattern.
  // Wrapped in the workspace-RLS GUC transaction (043) so a restricted rlsSql client is DB-filtered;
  // byte-identical for the owner client (bypasses RLS; WHERE workspace_id still scopes).
  const [rows] = await withWorkspaceRlsContext<[HarnessFlowEvent[]]>(sql, workspaceId, (tx) => [
    tx/*sql*/`
    SELECT id, workspace_id, project_id, source_tool, agent_id, intent_id,
           status, summary, body, evidence_link, visibility, permission_scope,
           risk, approval_state, next_action,
           occurred_at, ingested_at, archived_at, domain_id, parent_event_id,
           authorized_by_user_id, instrument_kind, authority_source, request_id
    FROM operation_events
    WHERE workspace_id = ${workspaceId}
      AND archived_at IS NULL
      AND visibility = ANY(${visList as unknown as string[]})
      AND (${beforeFilter}::text IS NULL OR id < ${beforeFilter}::text)
      AND (${projectFilter}::text IS NULL OR project_id = ${projectFilter}::text)
      AND (${statusFilter}::text IS NULL OR status = ${statusFilter}::text)
      AND (${sourceFilter}::text IS NULL OR source_tool = ${sourceFilter}::text)
      AND (${parentFilter}::text IS NULL OR parent_event_id = ${parentFilter}::text)
      AND (${topLevelOnly}::boolean IS NOT TRUE OR parent_event_id IS NULL)
    ORDER BY occurred_at DESC, id DESC
    LIMIT ${fetchLimit}
  `,
  ], { readOnly: true });

  const has_more = rows.length > limit;
  const events = has_more ? rows.slice(0, limit) : rows;
  const next_before = has_more ? events[events.length - 1]!.id : null;

  return {
    events: events.map((r) => redactPrincipalForRole(normalizeEventRow(r), opts.role)),
    pagination: { has_more, next_before },
  };
}

export async function listEventsForOperatorRow(sql: Sql, ownerUserIds: string[], opts: EventListOpts): Promise<EventPage> {
  const ids = (Array.isArray(ownerUserIds) ? ownerUserIds : [ownerUserIds]).filter(Boolean);
  const empty: EventPage = { events: [], pagination: { has_more: false, next_before: null } };
  if (ids.length === 0) return empty;

  const wsRows = (await sql/*sql*/`
    SELECT id FROM workspaces WHERE owner_user_id = ANY(${ids})
  `) as Array<Record<string, unknown>>;
  const wsIds = wsRows.map((r) => String(r.id));
  if (wsIds.length === 0) return empty;

  const limit = Math.min(opts.limit ?? DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT);
  const fetchLimit = limit + 1;
  const visList = visibilityForRole(opts.role);
  const beforeFilter = opts.before ?? null;
  const projectFilter = opts.project_id ?? null;
  const statusFilter = opts.status ?? null;
  const sourceFilter = opts.source_tool ?? null;
  // OS-4 P1 · thread filters (opt-in; defaults unchanged) — mirrors listEventsRow.
  const parentFilter = opts.parent_event_id ?? null;
  const topLevelOnly = !parentFilter && opts.top_level === true;

  const rows = (await sql/*sql*/`
    SELECT id, workspace_id, project_id, source_tool, agent_id, intent_id,
           status, summary, body, evidence_link, visibility, permission_scope,
           risk, approval_state, next_action,
           occurred_at, ingested_at, archived_at, parent_event_id,
           authorized_by_user_id, instrument_kind, authority_source, request_id
    FROM operation_events
    WHERE workspace_id = ANY(${wsIds})
      AND archived_at IS NULL
      AND visibility = ANY(${visList as unknown as string[]})
      AND (${beforeFilter}::text IS NULL OR id < ${beforeFilter}::text)
      AND (${projectFilter}::text IS NULL OR project_id = ${projectFilter}::text)
      AND (${statusFilter}::text IS NULL OR status = ${statusFilter}::text)
      AND (${sourceFilter}::text IS NULL OR source_tool = ${sourceFilter}::text)
      AND (${parentFilter}::text IS NULL OR parent_event_id = ${parentFilter}::text)
      AND (${topLevelOnly}::boolean IS NOT TRUE OR parent_event_id IS NULL)
    ORDER BY occurred_at DESC, id DESC
    LIMIT ${fetchLimit}
  `) as HarnessFlowEvent[];

  const has_more = rows.length > limit;
  const out = has_more ? rows.slice(0, limit) : rows;
  const next_before = has_more ? out[out.length - 1]!.id : null;
  return { events: out.map((r) => redactPrincipalForRole(normalizeEventRow(r), opts.role)), pagination: { has_more, next_before } };
}

export async function upsertEventRow(sql: Sql, workspaceId: WorkspaceId, event: HarnessFlowEventInput): Promise<UpsertResult> {
  assertWorkspaceScope(workspaceId);
  if (!event?.id) throw makeError('VALIDATION_ERROR', 'event.id is required', 400);

  // Idempotency: if id exists in this workspace, return without modifying.
  const existing = (await sql/*sql*/`
    SELECT id FROM operation_events WHERE workspace_id = ${workspaceId} AND id = ${event.id} LIMIT 1
  `) as Array<{ id: string }>;
  if (existing.length > 0) {
    return { id: event.id, created: false };
  }

  // A-W4/P6 (050) · principal-instrument lineage columns. DEGRADE-SAFE: this function serves EVERY
  // event write, so if migration 050 is not applied yet ("column does not exist"), fall back to the
  // legacy column set — event ingestion must never break on a migrate/deploy ordering slip.
  try {
    await sql/*sql*/`
      INSERT INTO operation_events (
        id, workspace_id, project_id, source_tool, agent_id, intent_id,
        status, summary, body, evidence_link, visibility, permission_scope,
        risk, approval_state, next_action, occurred_at, domain_id, parent_event_id,
        authorized_by_user_id, instrument_kind, authority_source, request_id
      ) VALUES (
        ${event.id},
        ${workspaceId},
        ${event.project_id ?? null},
        ${event.source_tool},
        ${event.agent_id ?? null},
        ${event.intent_id ?? null},
        ${event.status},
        ${event.summary},
        ${event.body ?? null},
        ${event.evidence_link ?? null},
        ${event.visibility ?? 'internal_workspace'},
        ${event.permission_scope ?? null},
        ${event.risk ?? null},
        ${event.approval_state ?? null},
        ${event.next_action ?? null},
        ${event.occurred_at}::timestamptz,
        ${event.domain_id ?? null},
        ${event.parent_event_id ?? null},
        ${event.authorized_by_user_id ?? null},
        ${event.instrument_kind ?? null},
        ${event.authority_source ?? null},
        ${event.request_id ?? null}
      )
    `;
    return { id: event.id, created: true };
  } catch (err) {
    const msg = String((err as { message?: unknown })?.message ?? err ?? '');
    // Pre-050 only: `column "authorized_by_user_id" of relation "operation_events" does not exist`.
    const missingLineageColumn =
      /column\s+"?(authorized_by_user_id|instrument_kind|authority_source|request_id)"?.*does not exist/i.test(msg);
    if (!missingLineageColumn) throw err;
  }

  await sql/*sql*/`
    INSERT INTO operation_events (
      id, workspace_id, project_id, source_tool, agent_id, intent_id,
      status, summary, body, evidence_link, visibility, permission_scope,
      risk, approval_state, next_action, occurred_at, domain_id, parent_event_id
    ) VALUES (
      ${event.id},
      ${workspaceId},
      ${event.project_id ?? null},
      ${event.source_tool},
      ${event.agent_id ?? null},
      ${event.intent_id ?? null},
      ${event.status},
      ${event.summary},
      ${event.body ?? null},
      ${event.evidence_link ?? null},
      ${event.visibility ?? 'internal_workspace'},
      ${event.permission_scope ?? null},
      ${event.risk ?? null},
      ${event.approval_state ?? null},
      ${event.next_action ?? null},
      ${event.occurred_at}::timestamptz,
      ${event.domain_id ?? null},
      ${event.parent_event_id ?? null}
    )
  `;

  return { id: event.id, created: true };
}

// OS-3 UX Wave-2.1 · execution-pipeline STATUS-TRANSITION primitive (status-class fields ONLY).
//
// upsertEventRow is INSERT-IF-ABSENT, so the queue consumer cannot use it to move a queued op
// through queued -> running -> completed on the SAME row. This UPDATEs the row, scoped to the
// operator's own workspaces (owner_user_id = ANY — same fail-closed scoping as listEventsForOperator).
// When `expectedStatus` is supplied, the `AND status = expectedStatus` guard makes the transition an
// ATOMIC CLAIM (run-exactly-once): a second consumer or a re-run UPDATEs 0 rows.
//
// CRITICAL — ADR-XLOOP-IA-001 invariant (2): operation_events CONTENT columns (summary/body/...) are
// APPEND-ONLY and must NEVER be UPDATEd. This primitive therefore only re-points STATUS-CLASS columns
// (status / approval_state / next_action). An executor that produces NEW content (e.g. a digest body)
// INSERTs a fresh result event via upsertEvent — it does not mutate the request row's content here.
// COALESCE leaves approval_state/next_action unchanged when the patch omits them, so a bare claim
// ({status:'running'}) does not clobber them. Returns the rows changed (1 = claimed/updated, 0 = not
// found / not in expectedStatus / not the operator's). Never widens scope. EventStatusPatch lives in
// ./types (barrel) so the DalAdapter interface can reference it without an import cycle.
export async function updateEventStatusForOperatorRow(
  sql: Sql,
  ownerUserIds: string[],
  eventId: string,
  patch: EventStatusPatch,
  expectedStatus?: EventStatus | null,
): Promise<{ updated: number }> {
  const ids = (Array.isArray(ownerUserIds) ? ownerUserIds : [ownerUserIds]).filter(Boolean);
  if (ids.length === 0 || !eventId || !patch?.status) return { updated: 0 };

  const wsRows = (await sql/*sql*/`
    SELECT id FROM workspaces WHERE owner_user_id = ANY(${ids})
  `) as Array<Record<string, unknown>>;
  const wsIds = wsRows.map((r) => String(r.id));
  if (wsIds.length === 0) return { updated: 0 };

  const expect = expectedStatus ?? null;
  const changed = (await sql/*sql*/`
    UPDATE operation_events
       SET status = ${patch.status},
           approval_state = COALESCE(${patch.approval_state ?? null}::text, approval_state),
           next_action = COALESCE(${patch.next_action ?? null}::text, next_action)
     WHERE id = ${eventId}
       AND workspace_id = ANY(${wsIds})
       AND (${expect}::text IS NULL OR status = ${expect}::text)
    RETURNING id
  `) as Array<{ id: string }>;
  return { updated: changed.length };
}

// OS-5 W2 · single-event read, tenant-scoped by workspace_id (the missing primitive — every list
// variant exists but no by-id fetch did). Status-class + identity columns only: enough for a
// consumer (e.g. the digest poster) to decide, without widening into a generic row dump.
export async function getEventRow(
  sql: Sql,
  workspaceId: string,
  eventId: string,
): Promise<{ id: string; status: string | null; approval_state: string | null; next_action: string | null; summary: string | null; body: string | null; agent_id: string | null } | null> {
  if (!workspaceId || !eventId) return null;
  // Wrapped in the workspace-RLS GUC transaction (043); byte-identical for the owner client.
  const [rows] = await withWorkspaceRlsContext<[Array<{ id: string; status: string | null; approval_state: string | null; next_action: string | null; summary: string | null; body: string | null; agent_id: string | null }>]>(sql, workspaceId, (tx) => [
    tx/*sql*/`
    SELECT id, status, approval_state, next_action, summary, body, agent_id
    FROM operation_events
    WHERE id = ${eventId} AND workspace_id = ${workspaceId}
    LIMIT 1
  `,
  ], { readOnly: true });
  return rows[0] ?? null;
}

// OS-5 W2 · workspace-scoped sibling of updateEventStatusForOperatorRow (above): same ia-001
// status-class-only re-point + the same expectedStatus atomic-claim guard, scoped by the caller's
// ALREADY-VERIFIED workspace_id instead of the owner-workspace subquery (the sign-offs route's
// tenant guard has proven event_id ∈ workspace_id before this runs). Content columns untouched.
export async function updateEventStatusRow(
  sql: Sql,
  workspaceId: string,
  eventId: string,
  patch: EventStatusPatch,
  expectedStatus?: EventStatus | null,
): Promise<{ updated: number }> {
  if (!workspaceId || !eventId || !patch?.status) return { updated: 0 };
  const expect = expectedStatus ?? null;
  const changed = (await sql/*sql*/`
    UPDATE operation_events
       SET status = ${patch.status},
           approval_state = COALESCE(${patch.approval_state ?? null}::text, approval_state),
           next_action = COALESCE(${patch.next_action ?? null}::text, next_action)
     WHERE id = ${eventId}
       AND workspace_id = ${workspaceId}
       AND (${expect}::text IS NULL OR status = ${expect}::text)
    RETURNING id
  `) as Array<{ id: string }>;
  return { updated: changed.length };
}

// F2 (260628) · customer self-service soft-delete. Sets archived_at (the column already exists
// and is honored by every list query's `archived_at IS NULL` filter — see listEventsRow:86),
// so a "delete" is a fully REVERSIBLE soft-delete. Tenant-scoped: `WHERE workspace_id` means a
// foreign/guessed event id returns updated:0 (→ 404 at the route), never a cross-tenant write.
// Content columns (summary/body) are untouched — IA-001 append-only invariant preserved.
export async function archiveEventRow(sql: Sql, workspaceId: string, eventId: string): Promise<{ updated: number }> {
  if (!workspaceId || !eventId) return { updated: 0 };
  const changed = (await sql/*sql*/`
    UPDATE operation_events
       SET archived_at = now()
     WHERE id = ${eventId}
       AND workspace_id = ${workspaceId}
       AND archived_at IS NULL
    RETURNING id
  `) as Array<{ id: string }>;
  return { updated: changed.length };
}

// F2 · restore a soft-deleted event (clear archived_at). Tenant-scoped; only restores rows that
// ARE currently archived (a non-archived/foreign id → updated:0). Reverses archiveEventRow and
// writes the operation-event restore receipt from the same statement. The receipt SELECT is joined
// to target_updated, so a missing/ineligible target cannot produce a successful receipt.
export async function restoreEventRow(
  sql: Sql,
  workspaceId: string,
  eventId: string,
  actorUserId?: string | null,
  requestId?: string | null,
): Promise<{ updated: number; target_event_id: string | null; restore_receipt_id: string | null; audit_event_id: string | null }> {
  if (!workspaceId || !eventId) {
    return { updated: 0, target_event_id: null, restore_receipt_id: null, audit_event_id: null };
  }
  const changed = (await sql/*sql*/`
    WITH target_updated AS (
      UPDATE operation_events
         SET archived_at = NULL
       WHERE id = ${eventId}
         AND workspace_id = ${workspaceId}
         AND archived_at IS NOT NULL
      RETURNING id, workspace_id, project_id
    ), event_written AS (
      INSERT INTO operation_events (
        id, workspace_id, project_id, source_tool, agent_id, status, summary, body,
        visibility, occurred_at, parent_event_id, authorized_by_user_id,
        instrument_kind, authority_source, request_id
      )
      SELECT
        LEFT(
          'evt_restore_' ||
          regexp_replace(target_updated.id, '[^a-zA-Z0-9_:-]', '_', 'g') ||
          '_' ||
          substr(md5(coalesce(${requestId ?? null}::text, '') || clock_timestamp()::text || random()::text), 1, 12),
          128
        ),
        target_updated.workspace_id,
        target_updated.project_id,
        'xlooop',
        'xlooop:event-restore',
        'completed',
        'Event restored: ' || target_updated.id,
        'Restored soft-deleted operation event "' || target_updated.id || '" after explicit user request.',
        'internal_workspace',
        now(),
        target_updated.id,
        ${actorUserId ?? null},
        CASE WHEN ${actorUserId ?? null}::text IS NULL THEN 'system' ELSE 'human' END,
        'explicit_approval',
        ${requestId ?? null}
      FROM target_updated
      RETURNING id
    )
    SELECT
      target_updated.id AS target_event_id,
      event_written.id AS restore_receipt_id,
      event_written.id AS audit_event_id
    FROM target_updated
    JOIN event_written ON TRUE
  `) as Array<{ target_event_id: string; restore_receipt_id: string; audit_event_id: string }>;
  const row = changed[0];
  return {
    updated: changed.length,
    target_event_id: row?.target_event_id ?? null,
    restore_receipt_id: row?.restore_receipt_id ?? null,
    audit_event_id: row?.audit_event_id ?? null,
  };
}

// E3 (260628) · "recently deleted" — a workspace's soft-deleted events still inside the restore
// window (archived_at within `sinceDays`), newest first. Powers the Profile rollback panel; the
// countdown is derived (archived_at + window) in the UI. Tenant-scoped (assertWorkspaceScope).
export async function listArchivedEventsRow(
  sql: Sql,
  workspaceId: string,
  sinceDays: number,
  limit = 50,
): Promise<Array<{ id: string; summary: string | null; body: string | null; source_tool: string | null; project_id: string | null; archived_at: string }>> {
  assertWorkspaceScope(workspaceId);
  const days = Math.max(1, Math.min(sinceDays || 30, 365));
  const cap = Math.max(1, Math.min(limit, 200));
  return (await sql/*sql*/`
    SELECT id, summary, body, source_tool, project_id, archived_at
    FROM operation_events
    WHERE workspace_id = ${workspaceId}
      AND archived_at IS NOT NULL
      AND archived_at > now() - (interval '1 day' * ${days})
    ORDER BY archived_at DESC, id DESC
    LIMIT ${cap}
  `) as Array<{ id: string; summary: string | null; body: string | null; source_tool: string | null; project_id: string | null; archived_at: string }>;
}

// F3 (260628) · purge cron support: HARD-delete customer roadmap/xlooop events soft-deleted
// (archived_at) longer than the restore window. SCOPED to source_tool='xlooop' so a customer-
// archived GOVERNANCE event (codex/claude/operator/...) is NEVER hard-purged — it stays
// recoverable indefinitely. This is the over-broad-purge footgun guard (P.8 #3): the events
// table also holds governance-archived rows, which must survive the purge. Returns the count.
export async function purgeArchivedXlooopEventsRow(sql: Sql, olderThanDays: number): Promise<{ deleted: number }> {
  const days = Math.max(1, Math.min(olderThanDays || 30, 3650));
  const removed = (await sql/*sql*/`
    DELETE FROM operation_events
    WHERE archived_at IS NOT NULL
      AND archived_at < now() - (interval '1 day' * ${days})
      AND source_tool = 'xlooop'
    RETURNING id
  `) as Array<{ id: string }>;
  return { deleted: removed.length };
}

// ------------------------------------------------------------
// R45 · scoped-events read (project_id link OR scope_binding filters)
// ------------------------------------------------------------
//
// Lifted verbatim from WorkersDalAdapter (Stage 3.1, F10 batch5) alongside the rest of the
// operation_events family. The inline original called this.getProject(...) — a thin delegation to
// getProjectRow(this.sql, ...) — so getProjectRow is called directly here (1:1 behaviour-preserving
// swap). collectScopeFilterValues (the scope_binding filter-flattener) moves here too: it was a
// module-level helper used ONLY by this method.

export async function listEventsForProjectScopeRow(
  sql: Sql,
  workspaceId: WorkspaceId,
  projectId: ProjectId,
  opts: EventListOpts,
): Promise<EventPage> {
  assertWorkspaceScope(workspaceId);
  if (!projectId) throw makeError('VALIDATION_ERROR', 'project_id is required', 400);

  const proj = await getProjectRow(sql, workspaceId, projectId);
  if (!proj) throw makeError('NOT_FOUND', `project ${projectId} not found in workspace ${workspaceId}`, 404);

  const limit = Math.max(1, Math.min(opts.limit ?? 100, 200));
  const binding = proj.scope_binding;
  // F17 fix · the role-based visibility TIER floor (which visibility tiers this role may see AT ALL) +
  // the soft-delete filter. Every OTHER event list (listEventsRow, listEventsForOperatorRow) applies both;
  // this per-project path historically did not, so a viewer could receive internal_owner_only + archived
  // rows the flat GET /events correctly withholds. `visList` is the tier floor; the scope-binding
  // `visibility_in` below is an ORTHOGONAL narrowing — both must hold.
  const visList = visibilityForRole(opts.role);

  // Build the dynamic WHERE clause. Direct project_id link is ALWAYS included
  // (existing R40 behavior). Scope-binding filters are added if present.
  // We construct one SQL statement with parameterized inputs for safety.
  //
  // Strategy: collect each filter into a SQL fragment combined with combine.
  // Final WHERE = (events.project_id = projectId) OR (combined scope clause)

  // No binding → just direct link
  if (!binding || binding.filters.length === 0) {
    // R45.5 · schema uses `agent_id` (not `actor`) and `ingested_at` (not `created_at`)
    const rows = (await sql/*sql*/`
      SELECT id, workspace_id, project_id, source_tool, agent_id, status, summary, body,
             visibility, occurred_at, ingested_at, parent_event_id
      FROM operation_events
      WHERE workspace_id = ${workspaceId}
        AND archived_at IS NULL
        AND visibility = ANY(${visList as unknown as string[]})
        AND project_id = ${projectId}
      ORDER BY occurred_at DESC, id DESC
      LIMIT ${limit}
    `) as Array<Record<string, unknown>>;
    return { events: rows as unknown as EventPage['events'], pagination: { has_more: rows.length === limit, next_before: null } };
  }

  // With binding: materialize filter arrays then run ONE of two queries
  // depending on combine mode. We keep the queries explicit (no SQL
  // composition across template literals — neon's tagged template doesn't
  // safely compose Promises mid-SQL). The two branches share the same
  // CTE shape so analyze + index usage stays predictable.
  const actorPatterns = collectScopeFilterValues(binding, 'actor_in')
    .map((p) => p.replace(/\*/g, '%')); // glob → SIMILAR TO pattern
  const sourceTools = collectScopeFilterValues(binding, 'source_tool_in');
  const statuses = collectScopeFilterValues(binding, 'status_in');
  const visibilities = collectScopeFilterValues(binding, 'visibility_in');
  const combineAny = binding.combine === 'any';

  // Inline the boolean expression as a constant set so SQL only branches
  // on the binding shape, not on the row values.
  let rows: Array<Record<string, unknown>>;
  // R45.5 · the API surface keeps `actor_in` for clarity in MCP tool descriptions,
  // but the DB column is `agent_id`. We treat them as synonyms at the SQL boundary.
  if (combineAny) {
    rows = (await sql/*sql*/`
      SELECT id, workspace_id, project_id, source_tool, agent_id, status, summary, body,
             visibility, occurred_at, ingested_at, parent_event_id
      FROM operation_events
      WHERE workspace_id = ${workspaceId}
        AND archived_at IS NULL
        AND visibility = ANY(${visList as unknown as string[]})
        AND (
          project_id = ${projectId}
          OR (${actorPatterns.length} > 0 AND EXISTS (
            SELECT 1 FROM unnest(${actorPatterns}::text[]) AS p WHERE agent_id SIMILAR TO p
          ))
          OR (${sourceTools.length} > 0 AND source_tool = ANY(${sourceTools}::text[]))
          OR (${statuses.length} > 0 AND status = ANY(${statuses}::text[]))
          OR (${visibilities.length} > 0 AND visibility = ANY(${visibilities}::text[]))
        )
      ORDER BY occurred_at DESC, id DESC
      LIMIT ${limit}
    `) as Array<Record<string, unknown>>;
  } else {
    // combine === 'all' · every populated filter must match, but unpopulated
    // filter dimensions are ignored (NULL → TRUE in the predicate).
    rows = (await sql/*sql*/`
      SELECT id, workspace_id, project_id, source_tool, agent_id, status, summary, body,
             visibility, occurred_at, ingested_at, parent_event_id
      FROM operation_events
      WHERE workspace_id = ${workspaceId}
        AND archived_at IS NULL
        AND visibility = ANY(${visList as unknown as string[]})
        AND (
          project_id = ${projectId}
          OR (
            (${actorPatterns.length} = 0 OR EXISTS (
              SELECT 1 FROM unnest(${actorPatterns}::text[]) AS p WHERE agent_id SIMILAR TO p
            ))
            AND (${sourceTools.length} = 0 OR source_tool = ANY(${sourceTools}::text[]))
            AND (${statuses.length} = 0 OR status = ANY(${statuses}::text[]))
            AND (${visibilities.length} = 0 OR visibility = ANY(${visibilities}::text[]))
            AND (
              ${actorPatterns.length} > 0
              OR ${sourceTools.length} > 0
              OR ${statuses.length} > 0
              OR ${visibilities.length} > 0
            )
          )
        )
      ORDER BY occurred_at DESC, id DESC
      LIMIT ${limit}
    `) as Array<Record<string, unknown>>;
  }

  return { events: rows as unknown as EventPage['events'], pagination: { has_more: rows.length === limit, next_before: null } };
}

// R45 · collect values for a specific filter type from a scope_binding,
// flattening across multiple filters of the same type. Empty array if none.
function collectScopeFilterValues(
  binding: ProjectScopeBinding,
  type: ProjectScopeFilterType,
): string[] {
  const out: string[] = [];
  for (const f of binding.filters) {
    if (f.type === type && Array.isArray(f.values)) {
      for (const v of f.values) {
        if (typeof v === 'string' && v.length > 0) out.push(v);
      }
    }
  }
  return out;
}
