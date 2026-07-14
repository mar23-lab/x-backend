// intent-store.ts · first-class intents — the artefact + lineage read/write model (Wave 5b).
//
// Authority: 023_first_class_intents. operation_events.intent_id used to point at nothing; intents is
// now a real table. These functions read/write it scoped to the OPERATOR's own workspaces (resolved by
// owner_user_id, the same overlay the cockpit chat + project-events surfaces use) so a non-owned intent
// is invisible. Lineage = an intent + its child events (operation_events.intent_id = id) + its derived
// intents (intents.derived_from = id). Writes also best-effort mirror into operations_unified
// (plane 'synthetic') so the durable read-model (Wave 5a) carries intents too — never fails the write.

import type { Sql } from '../db/client';

export interface IntentRow {
  id: string;
  workspace_id: string | null;
  project_id: string | null;
  domain_id: string | null;
  title: string;
  summary: string | null;
  status: string;
  owner_user_id: string | null;
  derived_from: string | null;
  origin: string | null;
  created_at: string;
  updated_at: string;
}

/** A child event of an intent, lean (enough for a lineage view) — newest first. */
export interface IntentLineageEvent {
  id: string;
  workspace_id: string | null;
  project_id: string | null;
  source_tool: string | null;
  status: string | null;
  summary: string | null;
  evidence_link: string | null;
  occurred_at: string | null;
}

export interface IntentLineage {
  intent: IntentRow;
  child_events: IntentLineageEvent[];
  derived_intents: IntentRow[];
}

export interface CreateIntentInput {
  id?: string;
  workspace_id: string | null;
  project_id?: string | null;
  domain_id?: string | null;
  title: string;
  summary?: string | null;
  status?: string;
  owner_user_id?: string | null;
  derived_from?: string | null;
  origin?: string | null;
}

const ALLOWED_STATUS = new Set(['open', 'active', 'blocked', 'done', 'abandoned']);
const str = (v: unknown): string => (v == null ? '' : String(v));
const iso = (v: unknown): string => (v ? new Date(v as string).toISOString() : '');

function mapIntentRow(r: Record<string, unknown>): IntentRow {
  return {
    id: str(r.id),
    workspace_id: r.workspace_id == null ? null : str(r.workspace_id),
    project_id: r.project_id == null ? null : str(r.project_id),
    domain_id: r.domain_id == null ? null : str(r.domain_id),
    title: str(r.title),
    summary: r.summary == null ? null : str(r.summary),
    status: str(r.status),
    owner_user_id: r.owner_user_id == null ? null : str(r.owner_user_id),
    derived_from: r.derived_from == null ? null : str(r.derived_from),
    origin: r.origin == null ? null : str(r.origin),
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

/** List intents in the operator's workspaces, optionally narrowed to a project/domain. Newest first. */
export async function listIntentsForOperatorRow(
  sql: Sql,
  ownerUserIds: string[],
  scope: { workspace_id?: string | null; project_id?: string | null; domain_id?: string | null },
  limit = 200,
): Promise<IntentRow[]> {
  const wsIds = await operatorWorkspaceIds(sql, ownerUserIds);
  if (wsIds.length === 0) return [];
  const cap = Math.max(1, Math.min(500, Number(limit) || 200));
  const wsFilter = scope.workspace_id ? String(scope.workspace_id) : null;
  const projectFilter = scope.project_id ? String(scope.project_id) : null;
  const domainFilter = scope.domain_id ? String(scope.domain_id) : null;
  const rows = (await sql/*sql*/`
    SELECT id, workspace_id, project_id, domain_id, title, summary, status,
           owner_user_id, derived_from, origin, created_at, updated_at
    FROM intents
    WHERE workspace_id = ANY(${wsIds})
      AND (${wsFilter}::text IS NULL OR workspace_id = ${wsFilter}::text)
      AND (${projectFilter}::text IS NULL OR project_id = ${projectFilter}::text)
      AND (${domainFilter}::text IS NULL OR domain_id = ${domainFilter}::text)
    ORDER BY created_at DESC, id DESC
    LIMIT ${cap}
  `) as Array<Record<string, unknown>>;
  return rows.map(mapIntentRow);
}

/** One intent + its lineage (child events + derived intents), scoped to the operator. null if not theirs. */
export async function getIntentLineageForOperatorRow(
  sql: Sql,
  ownerUserIds: string[],
  intentId: string,
): Promise<IntentLineage | null> {
  const id = str(intentId).trim();
  if (!id) return null;
  const wsIds = await operatorWorkspaceIds(sql, ownerUserIds);
  if (wsIds.length === 0) return null;

  const intentRows = (await sql/*sql*/`
    SELECT id, workspace_id, project_id, domain_id, title, summary, status,
           owner_user_id, derived_from, origin, created_at, updated_at
    FROM intents
    WHERE id = ${id} AND workspace_id = ANY(${wsIds})
    LIMIT 1
  `) as Array<Record<string, unknown>>;
  if (intentRows.length === 0) return null;
  const intent = mapIntentRow(intentRows[0]!);

  // Child events — operation_events that point at this intent (bounded, newest first).
  const eventRows = (await sql/*sql*/`
    SELECT id, workspace_id, project_id, source_tool, status, summary, evidence_link, occurred_at
    FROM operation_events
    WHERE intent_id = ${id} AND workspace_id = ANY(${wsIds}) AND archived_at IS NULL
    ORDER BY occurred_at DESC, id DESC
    LIMIT 200
  `) as Array<Record<string, unknown>>;
  const child_events: IntentLineageEvent[] = eventRows.map((r) => ({
    id: str(r.id),
    workspace_id: r.workspace_id == null ? null : str(r.workspace_id),
    project_id: r.project_id == null ? null : str(r.project_id),
    source_tool: r.source_tool == null ? null : str(r.source_tool),
    status: r.status == null ? null : str(r.status),
    summary: r.summary == null ? null : str(r.summary),
    evidence_link: r.evidence_link == null ? null : str(r.evidence_link),
    occurred_at: r.occurred_at ? iso(r.occurred_at) : null,
  }));

  // Derived intents — children in the lineage chain.
  const derivedRows = (await sql/*sql*/`
    SELECT id, workspace_id, project_id, domain_id, title, summary, status,
           owner_user_id, derived_from, origin, created_at, updated_at
    FROM intents
    WHERE derived_from = ${id} AND workspace_id = ANY(${wsIds})
    ORDER BY created_at DESC, id DESC
    LIMIT 200
  `) as Array<Record<string, unknown>>;

  return { intent, child_events, derived_intents: derivedRows.map(mapIntentRow) };
}

/** Create a first-class intent. id auto-generated when absent. Returns the stored row. */
export async function createIntentRow(sql: Sql, input: CreateIntentInput): Promise<IntentRow> {
  const title = str(input.title).trim();
  if (!title) throw Object.assign(new Error('intent.title is required'), { code: 'VALIDATION_ERROR', status: 400 });
  const status = input.status && ALLOWED_STATUS.has(input.status) ? input.status : 'open';
  const id = str(input.id).trim() || `intent-${crypto.randomUUID()}`;
  const rows = (await sql/*sql*/`
    INSERT INTO intents (id, workspace_id, project_id, domain_id, title, summary, status, owner_user_id, derived_from, origin)
    VALUES (
      ${id}, ${input.workspace_id ?? null}, ${input.project_id ?? null}, ${input.domain_id ?? null},
      ${title}, ${input.summary ?? null}, ${status}, ${input.owner_user_id ?? null},
      ${input.derived_from ?? null}, ${input.origin ?? 'operator'}
    )
    ON CONFLICT (id) DO NOTHING
    RETURNING id, workspace_id, project_id, domain_id, title, summary, status,
              owner_user_id, derived_from, origin, created_at, updated_at
  `) as Array<Record<string, unknown>>;
  // ON CONFLICT DO NOTHING returns no row on collision — read it back so the caller always gets the row.
  if (rows.length > 0) return mapIntentRow(rows[0]!);
  const existing = (await sql/*sql*/`
    SELECT id, workspace_id, project_id, domain_id, title, summary, status,
           owner_user_id, derived_from, origin, created_at, updated_at
    FROM intents WHERE id = ${id} LIMIT 1
  `) as Array<Record<string, unknown>>;
  return mapIntentRow(existing[0]!);
}

/** Update an intent's status, scoped to the operator. Returns the row, or null if not theirs / bad status. */
export async function updateIntentStatusForOperatorRow(
  sql: Sql,
  ownerUserIds: string[],
  intentId: string,
  status: string,
): Promise<IntentRow | null> {
  const id = str(intentId).trim();
  if (!id || !ALLOWED_STATUS.has(status)) return null;
  const wsIds = await operatorWorkspaceIds(sql, ownerUserIds);
  if (wsIds.length === 0) return null;
  const rows = (await sql/*sql*/`
    UPDATE intents SET status = ${status}, updated_at = now()
    WHERE id = ${id} AND workspace_id = ANY(${wsIds})
    RETURNING id, workspace_id, project_id, domain_id, title, summary, status,
              owner_user_id, derived_from, origin, created_at, updated_at
  `) as Array<Record<string, unknown>>;
  return rows.length > 0 ? mapIntentRow(rows[0]!) : null;
}

/**
 * Best-effort mirror of an intent into operations_unified (plane 'synthetic'), so the durable read-model
 * carries intents alongside the event + governance planes. Idempotent (upsert by 'intent:<id>'). The
 * caller wraps this in try/catch — a missing operations_unified table (022 not yet applied) is a no-op.
 */
export async function materializeIntentToUnified(sql: Sql, intent: IntentRow): Promise<void> {
  if (!intent?.id) return;
  await sql/*sql*/`
    INSERT INTO operations_unified
      (id, plane, source_plane_id, workspace_id, project_id, domain_id, kind, status, title, summary, occurred_at)
    VALUES (
      ${'intent:' + intent.id}, 'synthetic', ${intent.id},
      ${intent.workspace_id}, ${intent.project_id}, ${intent.domain_id},
      'intent', ${intent.status}, ${intent.title}, ${intent.summary},
      ${intent.created_at || null}
    )
    ON CONFLICT (id) DO UPDATE SET
      workspace_id = EXCLUDED.workspace_id, project_id = EXCLUDED.project_id, domain_id = EXCLUDED.domain_id,
      status = EXCLUDED.status, title = EXCLUDED.title, summary = EXCLUDED.summary, ingested_at = now()
  `;
}

// ── OS-4 P3 · attach-event-to-intent (the L1 re-point + audit receipt) ───────────────────────────
//
// The lineage was ONE-directional: an intent lists its child events, but a stray event could not be
// attached to an intent after the fact. This re-points operation_events.intent_id — an L1
// ORGANIZATION pointer per ADR-XLOOP-IA-001 ("re-pointing = change the pointer + APPEND an audit
// event, never edit a fact body") — and appends the required receipt in the same flow. The receipt
// is itself an event THREADED under the re-pointed event (parent_event_id, migration 032) and
// linked to the intent (intent_id), so it shows up in both the event's thread and the intent's
// lineage. Operator-scoped, fail-closed; returns null when the intent or event isn't theirs.

export interface RepointEventResult {
  event_id: string;
  intent_id: string;
  prior_intent_id: string | null;
  receipt_event_id: string;
}

export async function repointEventIntentForOperatorRow(
  sql: Sql,
  ownerUserIds: string[],
  intentId: string,
  eventId: string,
): Promise<RepointEventResult | null> {
  const iid = str(intentId).trim();
  const eid = str(eventId).trim();
  if (!iid || !eid) return null;
  const wsIds = await operatorWorkspaceIds(sql, ownerUserIds);
  if (wsIds.length === 0) return null;

  // The intent must be the operator's (also gives us the title for the receipt copy).
  const intentRows = (await sql/*sql*/`
    SELECT id, title FROM intents WHERE id = ${iid} AND workspace_id = ANY(${wsIds}) LIMIT 1
  `) as Array<{ id: string; title: string }>;
  if (intentRows.length === 0) return null;

  // Capture the prior pointer (for the receipt's honest provenance), then re-point.
  const prior = (await sql/*sql*/`
    SELECT intent_id, workspace_id FROM operation_events
    WHERE id = ${eid} AND workspace_id = ANY(${wsIds}) LIMIT 1
  `) as Array<{ intent_id: string | null; workspace_id: string }>;
  if (prior.length === 0) return null;

  const updated = (await sql/*sql*/`
    UPDATE operation_events SET intent_id = ${iid}
    WHERE id = ${eid} AND workspace_id = ANY(${wsIds})
    RETURNING id
  `) as Array<{ id: string }>;
  if (updated.length === 0) return null;

  // APPEND the audit receipt (ia-001: pointer change + audit event, same flow). Unique id per
  // re-point (each re-point is a distinct fact); threaded under the event + linked to the intent.
  const receiptId = `evt_repoint_${eid}_${crypto.randomUUID().slice(0, 8)}`;
  const title = intentRows[0]!.title;
  const priorNote = prior[0]!.intent_id ? ` (was: ${prior[0]!.intent_id})` : '';
  await sql/*sql*/`
    INSERT INTO operation_events (
      id, workspace_id, project_id, source_tool, agent_id, intent_id,
      status, summary, body, visibility, occurred_at, parent_event_id
    ) VALUES (
      ${receiptId}, ${prior[0]!.workspace_id}, NULL, 'operator', 'xlooop:repoint', ${iid},
      'completed', ${`Attached to intent: ${title}`},
      ${`Re-pointed event ${eid} -> intent ${iid}${priorNote}. L1 pointer change; original content untouched.`},
      'internal_workspace', now(), ${eid}
    )
  `;
  return { event_id: eid, intent_id: iid, prior_intent_id: prior[0]!.intent_id, receipt_event_id: receiptId };
}

// ── OS-5 W4 · intent field edit (title/summary) + appended audit receipt ─────────────────────────
//
// J3's dead-end: intents were IMMUTABLE — a typo'd title could never be fixed. The intents TABLE is
// mutable (ia-001 binds operation_events only); the honest-audit move is the repoint pattern above:
// UPDATE the intent row + APPEND a receipt event naming the prior value, linked to the intent so the
// edit shows in its lineage. Operator-scoped, fail-closed; returns null when not theirs / no change.

export interface IntentFieldsPatch {
  title?: string;
  summary?: string | null;
}

export async function updateIntentFieldsForOperatorRow(
  sql: Sql,
  ownerUserIds: string[],
  intentId: string,
  patch: IntentFieldsPatch,
): Promise<IntentRow | null> {
  const id = str(intentId).trim();
  const title = typeof patch?.title === 'string' ? patch.title.trim().slice(0, 280) : undefined;
  const summary = typeof patch?.summary === 'string' ? patch.summary.trim().slice(0, 2000) : undefined;
  if (!id || (title === undefined && summary === undefined) || title === '') return null;
  const wsIds = await operatorWorkspaceIds(sql, ownerUserIds);
  if (wsIds.length === 0) return null;

  // Capture the prior values for the receipt's honest provenance.
  const prior = (await sql/*sql*/`
    SELECT id, title, summary, workspace_id FROM intents
    WHERE id = ${id} AND workspace_id = ANY(${wsIds}) LIMIT 1
  `) as Array<{ id: string; title: string; summary: string | null; workspace_id: string }>;
  if (prior.length === 0) return null;

  const rows = (await sql/*sql*/`
    UPDATE intents SET
      title = COALESCE(${title ?? null}::text, title),
      summary = COALESCE(${summary ?? null}::text, summary),
      updated_at = now()
    WHERE id = ${id} AND workspace_id = ANY(${wsIds})
    RETURNING id, workspace_id, project_id, domain_id, title, summary, status,
              owner_user_id, derived_from, origin, created_at, updated_at
  `) as Array<Record<string, unknown>>;
  if (rows.length === 0) return null;
  const intent = mapIntentRow(rows[0]!);

  // APPEND the audit receipt — unique per edit (each edit is a distinct fact), linked to the
  // intent (lineage) ; names the prior title when it changed.
  const receiptId = `evt_intent_edited_${id}_${crypto.randomUUID().slice(0, 8)}`;
  const titleNote = title !== undefined && title !== prior[0]!.title ? ` (title was: ${prior[0]!.title})` : '';
  await sql/*sql*/`
    INSERT INTO operation_events (
      id, workspace_id, project_id, source_tool, agent_id, intent_id,
      status, summary, body, visibility, occurred_at
    ) VALUES (
      ${receiptId}, ${prior[0]!.workspace_id}, NULL, 'operator', 'xlooop:intent-edit', ${id},
      'completed', ${`Intent edited: ${intent.title}`.slice(0, 512)},
      ${`Operator edited intent ${id}${titleNote}. The intents table is the mutable artefact; this receipt is the appended audit fact.`},
      'internal_workspace', now()
    )
  `;
  return intent;
}
