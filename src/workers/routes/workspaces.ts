// workspaces.ts · R54-Stage3-C · operator creates/lists top-level workspaces
//
// Pillar 1 of the operator's 4-pillar model — "ecosystem workspace; projects
// connected by the user from any source." Until now workspaces were seeded; this
// lets the operator create them from the UI.
//
// Auth: OPERATOR-ONLY (user_id === MBP_OWNER_USER_ID). Mounted org-OPTIONAL so a
// personal (orgless) operator session works — same reason the events overlay is
// org-optional. Non-operators are 403'd (customer workspace == Clerk org, a
// separate concern). createWorkspace always mints a fresh id, so this can never
// overwrite another tenant's workspace.

import { Hono } from 'hono';
import { operatorIds } from '../lib/permissions';
import { errorEnvelope } from '../middleware/error';
import { withDataClass } from '../lib/response-envelope';
import { withAuthority } from '../lib/allowed-actions';
import { auditToCsv, auditToJsonl, parseAuditExportFormat } from '../lib/audit-export';
import { isAdmissibleForContext } from '../lib/admissibility';
import type { AuthEnv, AuthVariables } from '../middleware/auth';
import type { DalAdapter } from '../dal/DalAdapter';
import type { WorkspaceCreateInput, ProjectStatus } from '../dal/types';
import { buildWorkspaceDigestLLM, type AiRunner } from '../services/agent-digest';
import { refinePromptText } from '../services/prompt-refine';
import { syncFolderSnapshot, folderChangeToPacketRow, type FolderBinding, type FolderChangeKind } from '../sources/translators/folder';
import { generateIntentEnrichment } from '../services/packet-enrichment';
import { inferSourceContext } from '../lib/infer-source-context';
import { normalizeFolderSnapshot } from '../sources/folder-snapshot-core';
import {
  answerCockpitChat,
  COCKPIT_CHAT_MAX_EVENTS,
  mapGovernanceRowsToEvents,
  mapContextCardsToEvents,
  type ContextCardInput,
  type CockpitChatScope,
  type CockpitChatMode,
  type CockpitChatLLM,
  type DocumentFact,
  type GovernanceMappedEvent,
  type GovernanceStreamRow,
} from '../services/cockpit-chat';
import { neonClient } from '../db/client';
import { recordLlmUsage } from '../dal/llm-usage-store'; // G2 260711
import { envFlagTrue } from '../lib/env-flag';
import { idempotencyMiddleware } from '../lib/idempotency'; // J-W1/IDEM-4
import { persistAssistantContextLineage, completeAssistantSkillLineage, type AssistantContextLineage } from '../lib/assistant-context-lineage';
import { createModelExecutionObserver } from '../lib/model-execution-lineage';
import { listDocumentsRow } from '../lib/document-store';
import { lineageFor } from '../lib/actor-lineage';
import type { EventListOpts, HarnessFlowEvent } from '../dal/types/event';
// Plane B fallback (defense in depth): the build-time operations-live-stream bundle — the SAME source
// the project board falls back to (mbp-projection.ts) — used only when the DB snapshot table is empty.
import operationsLiveStreamBundle from '../../../data/operations-live-stream.json';

export interface WorkspacesEnv extends AuthEnv {
  DATABASE_URL: string;
  MBP_OWNER_USER_ID?: string;
  MBP_OWNER_LINKED_USER_IDS?: string;
  CONTEXT_PACKET_PERSISTENCE_ENABLED?: string;
  ROLE_SKILL_CATALOG_ENABLED?: string;
  RESOLUTION_RECEIPT_SIGNING_SECRET?: string;
  RESOLUTION_RECEIPT_SIGNING_KEY_ID?: string;
  XLOOOP_DEPLOY_SHA?: string;
}

export interface WorkspacesVariables extends AuthVariables {
  dal: DalAdapter;
}

export const workspacesRoute = new Hono<{ Bindings: WorkspacesEnv; Variables: WorkspacesVariables }>();

async function assistantIntentRef(message: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(message));
  return `sha256:${Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

// GET /api/v1/workspaces — operator lists workspaces they own (identity set).
workspacesRoute.get('/workspaces', async (ctx) => {
  try {
    const auth = ctx.get('auth');
    const { user_id } = auth;
    const { ownerUserId, ids } = operatorIds(ctx.env);
    if (!ownerUserId || !user_id || user_id !== ownerUserId) {
      ctx.status(403);
      return ctx.json({ error: 'workspace listing is operator-only', code: 'FORBIDDEN', request_id: ctx.get('request_id') });
    }
    const dal = ctx.get('dal');
    const workspaces = await dal.listWorkspacesForOperator(ids);
    return ctx.json(withDataClass(withAuthority({ workspaces }, auth, 'workspace'), 'live'));
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

// GET /api/v1/workspaces/:id/activity-summary — accumulated-value + "since you left"
// summary for the retention surface (the switching-cost / must-have signal). Fail-closed
// tenancy: a non-operator can only read the workspace the middleware resolved them into
// (workspace_id === :id); the operator identity set can read any; clients are excluded.
// `?since=<ISO8601>` returns the delta (events/sign-offs since the caller's last visit).
workspacesRoute.get('/workspaces/:id/activity-summary', async (ctx) => {
  try {
    const auth = ctx.get('auth');
    const { user_id, workspace_id, role } = auth;
    const id = ctx.req.param('id');
    if (!id) {
      ctx.status(400);
      return ctx.json({ error: 'workspace id required', code: 'VALIDATION_ERROR', request_id: ctx.get('request_id') });
    }
    const { ownerUserId } = operatorIds(ctx.env);
    const isOperator = !!ownerUserId && user_id === ownerUserId;
    if (!isOperator && workspace_id !== id) {
      ctx.status(403);
      return ctx.json({ error: 'not a member of this workspace', code: 'FORBIDDEN', request_id: ctx.get('request_id') });
    }
    if (role === 'client') {
      ctx.status(403);
      return ctx.json({ error: 'client role cannot read the activity summary', code: 'FORBIDDEN', request_id: ctx.get('request_id') });
    }
    const since = ctx.req.query('since') || null;
    const dal = ctx.get('dal');
    const summary = await dal.getWorkspaceActivitySummary(id, since);
    return ctx.json(withDataClass(withAuthority({ summary }, auth, 'workspace'), 'live'));
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

// GET /api/v1/workspaces/:id/plan — OS-4 P2 · the workspace Plan aggregate (roadmaps + goals per
// visible domain). The "we don't see roadmaps, goals" fix: the planning DAL existed but the only
// render was 4 levels deep in SyntheticDomainsPanel; this is the ONE read the new ?screen=plan
// surface calls. Same fail-closed tenancy as activity-summary (member reads own; operator any;
// no client). Read-only; 3 bounded queries (see roadmap-store.listWorkspacePlanRow).
workspacesRoute.get('/workspaces/:id/plan', async (ctx) => {
  try {
    const auth = ctx.get('auth');
    const { user_id, workspace_id, role } = auth;
    const id = ctx.req.param('id');
    if (!id) {
      ctx.status(400);
      return ctx.json({ error: 'workspace id required', code: 'VALIDATION_ERROR', request_id: ctx.get('request_id') });
    }
    const { ownerUserId } = operatorIds(ctx.env);
    const isOperator = !!ownerUserId && user_id === ownerUserId;
    if (!isOperator && workspace_id !== id) {
      ctx.status(403);
      return ctx.json({ error: 'not a member of this workspace', code: 'FORBIDDEN', request_id: ctx.get('request_id') });
    }
    if (role === 'client') {
      ctx.status(403);
      return ctx.json({ error: 'client role cannot read the plan', code: 'FORBIDDEN', request_id: ctx.get('request_id') });
    }
    const dal = ctx.get('dal');
    const plan = await dal.listWorkspacePlan(id);
    return ctx.json(withDataClass(withAuthority(plan as unknown as Record<string, unknown>, auth, 'workspace'), 'live'));
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

// POST /api/v1/workspaces/:id/agent/digest — governed agent action. Drafts a workspace digest
// from the activity summary and posts it as a PENDING proposal (status='needs_review',
// approval_state='pending') into the existing approval spine: it appears in the "needs you"
// queue, and the operator approves it via POST /sign-offs (which atomically flips approval_state
// to 'approved' — the digest becomes a governed, official record). Idempotent per workspace per
// day. Same fail-closed tenancy as activity-summary (member reads own; operator any; no client).
workspacesRoute.post('/workspaces/:id/agent/digest', async (ctx) => {
  try {
    const { user_id, workspace_id, role } = ctx.get('auth');
    const id = ctx.req.param('id');
    if (!id) {
      ctx.status(400);
      return ctx.json({ error: 'workspace id required', code: 'VALIDATION_ERROR', request_id: ctx.get('request_id') });
    }
    const { ownerUserId } = operatorIds(ctx.env);
    const isOperator = !!ownerUserId && user_id === ownerUserId;
    if (!isOperator && workspace_id !== id) {
      ctx.status(403);
      return ctx.json({ error: 'not a member of this workspace', code: 'FORBIDDEN', request_id: ctx.get('request_id') });
    }
    if (role === 'client') {
      ctx.status(403);
      return ctx.json({ error: 'client role cannot run the digest agent', code: 'FORBIDDEN', request_id: ctx.get('request_id') });
    }
    const dal = ctx.get('dal');
    const summary = await dal.getWorkspaceActivitySummary(id, null);
    // LLM-richer draft when a Workers-AI binding is present; deterministic fallback otherwise.
    // Either way it lands as a PENDING proposal the operator approves — the LLM never posts to
    // the official record without sign-off.
    let digestLineage: AssistantContextLineage | null = null;
    let digestLineageSql: ReturnType<typeof neonClient> | null = null;
    if (envFlagTrue(ctx.env.CONTEXT_PACKET_PERSISTENCE_ENABLED)) {
      digestLineageSql = neonClient(ctx.env.DATABASE_URL);
      digestLineage = await persistAssistantContextLineage(digestLineageSql, ctx.env, {
        workspace_id: id,
        principal_id: user_id,
        role: String(role || 'operator'),
        mode: 'plan',
        action: 'assistant:digest',
        intent_ref: `digest:${id}`,
        scope: {
          event_count: summary.events_total,
          document_count: 0,
          unpromoted_document_count: 0,
          source_count: summary.connected_sources,
        },
        redaction_profile: 'operator-summary',
        client_empty: false,
      });
    }
    const digestObserver = digestLineage && digestLineageSql
      ? createModelExecutionObserver(digestLineageSql, id, user_id, digestLineage)
      : undefined;
    const digest = await buildWorkspaceDigestLLM(summary, (ctx.env as { AI?: AiRunner }).AI, digestObserver);
    if (digestLineage && digestLineageSql) {
      await completeAssistantSkillLineage(digestLineageSql, ctx.env, digestLineage, {
        workspace_id: id,
        principal_id: user_id,
      });
    }
    const now = new Date().toISOString();
    const eventId = `evt_agent_digest_${id}_${now.slice(0, 10)}`; // idempotent: one per workspace per day
    await dal.upsertEvent(id, {
      id: eventId,
      source_tool: 'xlooop',
      agent_id: 'xlooop:digest-agent',
      status: 'needs_review',
      approval_state: 'pending',
      summary: digest.summary,
      body: digest.body,
      next_action: 'approve_to_post_digest',
      visibility: 'internal_workspace',
      occurred_at: now,
    });
    ctx.status(201);
    return ctx.json({ proposal: { id: eventId, status: 'needs_review', approval_state: 'pending', summary: digest.summary, generated_by: digest.generated_by } });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

// POST /api/v1/cockpit-chat — "Chat-that-acts v1". The context-aware AI chief-of-staff: it reads the
// operator's REAL scoped events (a project / domain / whole workspace) and answers a question
// GROUNDED in them (counts, recent items, what's blocked / needs sign-off, top sources). LLM-richer
// via the Workers-AI binding when present; deterministic grounded digest otherwise — never throws,
// never invents (services/cockpit-chat.ts). READ-ONLY: it answers ABOUT the record, never writes.
//
// Operator-gated by the SAME identity-set overlay as the other org-OPTIONAL operator surfaces
// (user_id === MBP_OWNER_USER_ID): the scoped read uses listEventsForOperator, which resolves the
// operator's OWN workspaces inside the DAL — so a project that lives in a non-active Clerk org (the
// exact gap the GET /projects/:id/events overlay closes) is still answerable here. A non-operator is
// 403'd. Bounded to COCKPIT_CHAT_MAX_EVENTS for cost/latency.
// J-W1/IDEM-4 (260711-I): path-scoped so ONLY the LLM chat POST is covered (a retry re-invokes the
// model + re-meters + appends a duplicate message row) — the rest of the large workspaces group is
// untouched. Flag-off ⇒ passthrough, byte-identical; streamed/non-JSON 2xx degrades to no-dedupe.
workspacesRoute.use('/cockpit-chat', idempotencyMiddleware());
workspacesRoute.post('/cockpit-chat', async (ctx) => {
  try {
    const { user_id, role } = ctx.get('auth');
    const { ownerUserId, ids } = operatorIds(ctx.env);
    if (!ownerUserId || !user_id || user_id !== ownerUserId) {
      ctx.status(403);
      return ctx.json({ error: 'cockpit chat is operator-only', code: 'FORBIDDEN', request_id: ctx.get('request_id') });
    }
    const body = await ctx.req.json().catch(() => null) as { scope?: Partial<CockpitChatScope>; message?: string; mode?: string; llm?: string; context_cards?: ContextCardInput[] } | null;
    const message = typeof body?.message === 'string' ? body.message.trim() : '';
    if (!message || message.length > 1000) {
      ctx.status(400);
      return ctx.json({ error: 'body.message required (1-1000 chars)', code: 'VALIDATION_ERROR', request_id: ctx.get('request_id') });
    }
    // Read-side mode of the unified Send dropdown (ask | plan | recommend | deep-research). Anything
    // else (incl. the write modes chat/command/intent, which never POST here) falls back to 'ask'.
    const ALLOWED_MODES: CockpitChatMode[] = ['ask', 'plan', 'recommend', 'deep-research'];
    const mode: CockpitChatMode = ALLOWED_MODES.includes(body?.mode as CockpitChatMode) ? (body!.mode as CockpitChatMode) : 'ask';
    // User-selected model (the chat's model switcher). Default = free Llama; 'claude' uses the premium tier.
    const llm: CockpitChatLLM = body?.llm === 'claude' ? 'claude' : 'llama';
    const scopeIn = (body && typeof body.scope === 'object' && body.scope) || {};
    const workspaceId = typeof scopeIn.workspace_id === 'string' ? scopeIn.workspace_id.trim() : '';
    const projectId = typeof scopeIn.project_id === 'string' && scopeIn.project_id.trim() ? scopeIn.project_id.trim() : null;
    const domainId = typeof scopeIn.domain_id === 'string' && scopeIn.domain_id.trim() ? scopeIn.domain_id.trim() : null;
    const scope: CockpitChatScope = { workspace_id: workspaceId, project_id: projectId, domain_id: domainId };
    // ARCH-006 W1.1 — operator-wide ("All my workspaces") scope. Default-ON when the operator hasn't
    // narrowed to a workspace/project/domain (the chief-of-staff answers across everything the operator
    // owns — the fix for "0 blocked" while real blockers sit in another owned workspace). Explicit
    // `all_workspaces:true` also works. Plane A (listEventsForOperator) is already operator-wide; this
    // flag makes Plane B (governance) honor the SAME span (HR-SCOPE-SYMMETRY-1 — no plane asymmetry).
    const allWorkspaces = (scopeIn as { all_workspaces?: unknown }).all_workspaces === true
      || (!workspaceId && !projectId && !domainId);

    const dal = ctx.get('dal');
    // Read the REAL scoped events via the operator-identity overlay (own workspaces, resolved in the
    // DAL). project_id narrows to a project; absent → the whole workspace. Recency-capped. role is
    // forced to 'operator' so the operator's full visibility set is returned (same as the other
    // operator overlays). Defensive: a DAL without listEventsForOperator degrades to an empty read
    // (the deterministic answer still works — "no recorded activity yet").
    const opts: EventListOpts = { limit: COCKPIT_CHAT_MAX_EVENTS, role: 'operator', ...(projectId ? { project_id: projectId } : {}) };
    let events: HarnessFlowEvent[] = [];
    if (workspaceId && typeof dal.operatorOwnsWorkspace === 'function') {
      const ownsWorkspace = await dal.operatorOwnsWorkspace(ids, workspaceId);
      if (!ownsWorkspace) {
        ctx.status(403);
        return ctx.json({ error: 'workspace is outside the operator scope', code: 'FORBIDDEN', request_id: ctx.get('request_id') });
      }
      const page = await dal.listEvents(workspaceId, opts);
      events = Array.isArray(page?.events) ? page.events : [];
    } else if (typeof (dal as { listEventsForOperator?: unknown }).listEventsForOperator === 'function') {
      const page = await (dal as unknown as {
        listEventsForOperator: (operatorIds: string[], o: EventListOpts) => Promise<{ events?: HarnessFlowEvent[] }>;
      }).listEventsForOperator(ids, opts);
      events = Array.isArray(page?.events) ? page.events : [];
    }
    // Domain narrowing (when a life/work domain is focused but no project is selected): the scoped
    // page is already operator-owned; filter to the focused domain_id in-memory (bounded set).
    if (domainId && !projectId) {
      // HarnessFlowEvent's type omits domain_id, but the operator-overlay SELECT returns it
      // (migration 014). Read it defensively off the row without widening the shared type.
      events = events.filter((e) => e && ((e as { domain_id?: string | null }).domain_id ?? null) === domainId);
    }

    // Plane B — the governance plane (operations-live-stream packets/decisions). Wave 5a: read the
    // DURABLE operations_unified read-model FIRST (a queryable, provenance-stamped table). Fall back to
    // the live MB-P snapshot (Wave-1 path) and then the build-time bundle, and LAZILY materialize the
    // real snapshot rows into the table so it self-fills on first use. The mapping is unchanged
    // (mapGovernanceRowsToEvents) so chat and board still agree. Never throws — every layer degrades.
    let governance: GovernanceMappedEvent[] = [];
    try {
      let govRows: GovernanceStreamRow[] = [];

      // 1) durable read-model first.
      try {
        const listUnified = (dal as { listUnifiedGovernance?: (n: number) => Promise<unknown[]> }).listUnifiedGovernance;
        if (typeof listUnified === 'function') {
          const u = await listUnified.call(dal, 500);
          if (Array.isArray(u) && u.length > 0) govRows = u as GovernanceStreamRow[];
        }
      } catch (_) { /* fall through to the live snapshot */ }

      // 2) fallback — the live snapshot (real rows) then the bundle; materialize the real ones.
      if (govRows.length === 0) {
        let snapRows: GovernanceStreamRow[] = [];
        const getSnap = (dal as { getLatestLiveStreamSnapshot?: (s: string) => Promise<{ envelope?: { rows?: unknown } } | null> }).getLatestLiveStreamSnapshot;
        if (typeof getSnap === 'function') {
          const snap = await getSnap.call(dal, 'mbp-operations-live-stream');
          const envRows = snap?.envelope?.rows;
          if (Array.isArray(envRows) && envRows.length > 0) snapRows = envRows as GovernanceStreamRow[];
        }
        if (snapRows.length > 0) {
          // Best-effort lazy backfill so the durable table fills before the next MB-P push.
          try {
            const mat = (dal as { materializeGovernanceSnapshot?: (r: unknown[]) => Promise<number> }).materializeGovernanceSnapshot;
            if (typeof mat === 'function') await mat.call(dal, snapRows as unknown[]);
          } catch (_) { /* best-effort */ }
          govRows = snapRows;
        } else {
          const bundleRows = (operationsLiveStreamBundle as { rows?: unknown }).rows;
          if (Array.isArray(bundleRows)) govRows = bundleRows as GovernanceStreamRow[];
        }
      }

      governance = mapGovernanceRowsToEvents(govRows, scope, allWorkspaces);
    } catch (_) {
      governance = [];
    }

    // Wave 3b · pinned context cards the operator attached to this question (events/packets clicked
    // into the chat, possibly from other scopes). Mapped into the event shape; the answer leads with
    // them. Bounded + tolerant — bad/absent cards just yield none.
    const pinned = mapContextCardsToEvents(Array.isArray(body?.context_cards) ? body!.context_cards : []);

    // OS-4 P4 · GRAPH -> CHAT. For pinned cards, fetch the lineage NEIGHBORHOOD from the persisted
    // graph (v_artefact_lineage via getArtefactLineage) so the model finally SEES the graph — bounded
    // to what the operator pinned (<=5 cards, <=12 edges each, <=30 total). The node id is resolved by
    // the card's kind (intent:<id> vs event:<id> — the graph's node-id scheme). Best-effort: a missing
    // graph/table yields no lineage, never a failed answer.
    let lineage: import('../dal/graph-store').LineageEdgeRow[] = [];
    try {
      const rawCards = (Array.isArray(body?.context_cards) ? body!.context_cards : []) as Array<Record<string, unknown>>;
      const getLin = (dal as { getArtefactLineage?: (ws: string, o: { nodeId?: string }) => Promise<unknown[]> }).getArtefactLineage;
      if (typeof getLin === 'function') {
        const seenNode = new Set<string>();
        for (const c of rawCards.slice(0, 5)) {
          const cardWs = String((c as { workspace_id?: unknown })?.workspace_id || '').trim();
          const cardId = String((c as { id?: unknown })?.id || '').trim();
          if (!cardWs || !cardId) continue;
          const nodeId = `${(c as { kind?: unknown })?.kind === 'intent' ? 'intent' : 'event'}:${cardId}`;
          if (seenNode.has(nodeId)) continue;
          seenNode.add(nodeId);
          const edges = await getLin.call(dal, cardWs, { nodeId });
          if (Array.isArray(edges)) lineage.push(...(edges as import('../dal/graph-store').LineageEdgeRow[]).slice(0, 12));
        }
        lineage = lineage.slice(0, 30);
      }
    } catch (_) { lineage = []; }

    // W5 (260708) · G6 — GRAPH context beyond pinned cards, flag-gated. When CHAT_GRAPH_CONTEXT_ENABLED,
    // additionally fetch lineage anchored at the TOP scoped events (the record the answer is actually
    // about, not just what the operator pinned) and let the PURE selector (chat-graph-context.ts) keep
    // the ≤30-edge budget with terminating CAUSE-chains prioritized (RCA "why" > containment). The
    // selection rides the existing facts.lineage channel — cockpit-chat.ts is unchanged (WARN-band file).
    // L1 (260710-D) · durable context-assembly trace, flag-gated. The import runs ONLY when the flag is on
    // (this file's per-service dynamic-import convention) — so flag-OFF adds ZERO per-request cost and no
    // extra failure surface; attachAssembly falls back to identity, grounded_on persisted unchanged by
    // reference. Records ids/counts/enums only; console emissions below are KEPT.
    const assemblyTraceOn = envFlagTrue((ctx.env as { CHAT_ASSEMBLY_TRACE_ENABLED?: string }).CHAT_ASSEMBLY_TRACE_ENABLED);
    let trace: import('../services/chat-assembly-trace').AssemblyTrace | null = null;
    let attachAssembly: (g: unknown, t: typeof trace) => unknown = (g) => g;
    if (assemblyTraceOn) {
      try {
        const mod = await import('../services/chat-assembly-trace');
        trace = mod.createAssemblyTrace('operator');
        attachAssembly = mod.attachAssembly;
      } catch (_) { trace = null; /* trace is fail-safe: legacy grounded_on stands */ }
    }
    try {
      if (envFlagTrue((ctx.env as { CHAT_GRAPH_CONTEXT_ENABLED?: string }).CHAT_GRAPH_CONTEXT_ENABLED) && workspaceId) {
        const getLin2 = (dal as { getArtefactLineage?: (ws: string, o: { nodeId?: string }) => Promise<unknown[]> }).getArtefactLineage;
        if (typeof getLin2 === 'function') {
          const anchors = (events as Array<{ id?: unknown }>).slice(0, 5)
            .map((e) => `event:${String(e?.id || '').trim()}`)
            .filter((n) => n !== 'event:');
          const scopedEdges: import('../dal/graph-store').LineageEdgeRow[] = [];
          for (const nodeId of anchors) {
            const edges = await getLin2.call(dal, workspaceId, { nodeId });
            if (Array.isArray(edges)) scopedEdges.push(...(edges as import('../dal/graph-store').LineageEdgeRow[]).slice(0, 12));
          }
          const { selectGraphContext } = await import('../services/chat-graph-context');
          const considered = lineage.length + scopedEdges.length;
          const sel = selectGraphContext(lineage, scopedEdges, anchors);
          lineage = sel.edges;
          trace?.recordGraphEdges({ considered, selected: sel.edges.length, cause_chains: sel.cause_chains.length });
        }
      }
    } catch (_) { /* graph context is additive — the pinned-only lineage (or none) stands */ }

    const ai = (ctx.env as { AI?: AiRunner }).AI;
    // P6 · premium Claude tier (deep-research mode only) when ANTHROPIC_API_KEY is configured.
    const claudeKey = (ctx.env as { ANTHROPIC_API_KEY?: string }).ANTHROPIC_API_KEY;
    // S1 (260628) · company-aware chat when scoped to a customer workspace: the chief-of-staff reads
    // the captured context (focus/maturity/tools) instead of a hardcoded "accountant" stereotype.
    // Unscoped (operator overlay across workspaces) → null → the generic fallback preamble.
    // Guarded like every other dal call in this handler — a partial dal (tests, degraded boot) must
    // degrade to companyContext=null, never a sync TypeError → 500 (the pre-existing 10/16 suite rot).
    const companyContext = workspaceId && typeof dal.getCustomerContextProfile === 'function'
      ? await dal.getCustomerContextProfile(workspaceId).catch(() => null)
      : null;
    // Plane C (P1 · 260629) · uploaded documents (extracted_text) so the chief-of-staff answers FROM the
    // customer's own docs, not just events. Bounded (<=8 with text) + excerpt-truncated; workspace-scoped
    // (never cross-tenant — workspace_id from auth). Best-effort: missing table / no docs => none, never a
    // failed answer. Closes the pilot's "how do I add docs" felt gap (docs were write-only until now).
    let documents: DocumentFact[] = [];
    // G9 (260709) · §168 role-scoped context flag — OFF: every path below is byte-identical to today.
    const roleScopedOn = envFlagTrue((ctx.env as { CHAT_ROLE_SCOPED_CONTEXT_ENABLED?: string }).CHAT_ROLE_SCOPED_CONTEXT_ENABLED);
    let rscDocMeta: Array<{ filename: string; excerpt: string; id: string; admissibility?: string; uploaded_by?: string }> = [];
    if (workspaceId) {
      try {
        // 046 · document LIST via the RLS-subject client when configured (else owner → identical).
        const rows = await listDocumentsRow(neonClient(ctx.env.XLOOOP_RLS_APP_DATABASE_URL || ctx.env.DATABASE_URL), workspaceId, 20);
        documents = rows
          // M6 · AI-context admissibility — only admissible docs enter the model's grounding context. With
          // the 049 default 'approved' (+ pre-migration degrade to 'approved') this is a no-op today; the
          // moment an operator marks a doc excluded/candidate it drops from context. P11 governed control.
          .filter((d) => isAdmissibleForContext(d.admissibility))
          .filter((d) => typeof d.extracted_text === 'string' && d.extracted_text.trim().length > 0)
          .slice(0, 8)
          .map((d) => ({ filename: String(d.filename || 'document'), excerpt: String(d.extracted_text || '').slice(0, 1500), id: String((d as { id?: unknown }).id || '') }));
        if (roleScopedOn) {
          // G9 · the assembler (not this pipeline) owns the §168 admissibility decision, so it needs the
          // raw admissibility + uploader; only hard-'excluded' rows are dropped here (they never enter memory).
          rscDocMeta = rows
            .filter((d) => d.admissibility !== 'excluded')
            .filter((d) => typeof d.extracted_text === 'string' && d.extracted_text.trim().length > 0)
            .slice(0, 8)
            .map((d) => ({
              filename: String(d.filename || 'document'),
              excerpt: String(d.extracted_text || '').slice(0, 1500),
              id: String((d as { id?: unknown }).id || ''),
              admissibility: (d as { admissibility?: string }).admissibility,
              uploaded_by: (d as { uploaded_by?: string | null }).uploaded_by ?? undefined,
            }));
        }
        // W4 (260708) · G3 read-audit: a document's content entering the model's grounding IS the content
        // read — record it (day-grain deduped, migration 059), attributed to the ASKING user. Flag-gated;
        // fire-and-forget via waitUntil so the answer is never slowed by its own audit. Flag-ON the TRUE
        // grounded set is the assembler's — recorded in the G9 block below instead.
        if (!roleScopedOn) {
          const { recordChatGroundingReads } = await import('../dal/document-access-store');
          recordChatGroundingReads({
            enabled: envFlagTrue((ctx.env as { DOCUMENT_READ_AUDIT_ENABLED?: string }).DOCUMENT_READ_AUDIT_ENABLED),
            documents,
            makeSql: () => neonClient(ctx.env.DATABASE_URL),
            workspaceId,
            userId: user_id,
            waitUntil: (p) => ctx.executionCtx.waitUntil(p),
          });
        }
        documents = documents.map((d) => ({ filename: d.filename, excerpt: d.excerpt })); // facts stay shape-identical
      } catch (_) { documents = []; }
    }
    // G9 (260709) · §168 — flag-ON, the PURE assembler is the ONLY place the grounding set is built: the
    // asker's REAL role projects the bundle (grounding ≤ visibility ceiling · approved-only + own-candidate
    // flagged · client contribution-only · lineage owner/operator-class). Fixes the §26 risk: the operator-
    // plane event read is operator-wide; the projection re-scopes it to the asker. auditLine makes every
    // include/exclude decision traceable per answer.
    if (roleScopedOn) {
      try {
        const { assembleRoleScopedContext } = await import('../services/role-scoped-context');
        const rsc = assembleRoleScopedContext({ role: String(role || ''), user_id }, { events, documents: rscDocMeta, lineage });
        events = rsc.admissibleFacts.events as typeof events;
        lineage = rsc.visibleLineage as typeof lineage;
        documents = rsc.admissibleFacts.documents.map((d) => ({
          // D-6 "flagged unpromoted": encoded in the filename so the model + grounded_on see it without
          // growing cockpit-chat.ts (WARN-band file unchanged).
          filename: (d.unpromoted ? '[UNPROMOTED DRAFT] ' : '') + String(d.filename || 'document'),
          excerpt: String((d as { excerpt?: unknown }).excerpt || ''),
        }));
        const { recordChatGroundingReads } = await import('../dal/document-access-store');
        recordChatGroundingReads({
          enabled: envFlagTrue((ctx.env as { DOCUMENT_READ_AUDIT_ENABLED?: string }).DOCUMENT_READ_AUDIT_ENABLED),
          documents: rsc.admissibleFacts.documents,
          makeSql: () => neonClient(ctx.env.DATABASE_URL),
          workspaceId,
          userId: user_id,
          waitUntil: (p) => ctx.executionCtx.waitUntil(p),
        });
        trace?.recordRoleProjection(rsc.auditLine);
        console.log(JSON.stringify({ kind: 'role_scoped_context', plane: 'operator', workspace_id: workspaceId || null, ...rsc.auditLine }));
      } catch (_) { /* projection is fail-safe: on an unexpected throw the legacy facts stand (flag can be pulled) */ }
    }
    let assistantLineage: AssistantContextLineage | null = null;
    let lineageSql: ReturnType<typeof neonClient> | null = null;
    if (envFlagTrue(ctx.env.CONTEXT_PACKET_PERSISTENCE_ENABLED)) {
      if (!workspaceId) {
        ctx.status(409);
        return ctx.json({
          error: 'strict context lineage requires one workspace target',
          code: 'CONTEXT_LINEAGE_SCOPE_REQUIRED',
          request_id: ctx.get('request_id'),
        });
      }
      lineageSql = neonClient(ctx.env.DATABASE_URL);
      assistantLineage = await persistAssistantContextLineage(lineageSql, ctx.env, {
        workspace_id: workspaceId,
        principal_id: user_id,
        role: String(role || 'operator'),
        mode,
        intent_ref: await assistantIntentRef(message),
        scope: {
          event_count: events.length + governance.length,
          document_count: documents.length,
          unpromoted_document_count: documents.filter((d) => d.filename.startsWith('[UNPROMOTED DRAFT]')).length,
          source_count: 0,
        },
        redaction_profile: roleScopedOn ? `${String(role || 'operator')}-scoped` : 'operator-full',
        client_empty: false,
      });
    }
    const executionObserver = assistantLineage && lineageSql
      ? createModelExecutionObserver(lineageSql, workspaceId, user_id, assistantLineage)
      : undefined;
    const result = await answerCockpitChat(
      message,
      { events, governance, pinned, lineage, documents, total: events.length, scope, companyContext },
      ai,
      mode,
      claudeKey,
      llm,
      executionObserver,
    );
    if (assistantLineage && lineageSql) {
      await completeAssistantSkillLineage(lineageSql, ctx.env, assistantLineage, {
        workspace_id: workspaceId,
        principal_id: user_id,
      });
    }
    void role;
    // L1 · always record the operator-plane fact bundle when the trace flag is on — so flag-ON never
    // silently behaves like flag-OFF even if the role/graph sub-flags are off (the assembly is non-null).
    trace?.recordBundle({ events: events.length, sources_total: documents.length, sources_connected: lineage.length, generated_by: result.generated_by });

    // G2 (260711) · per-tenant LLM metering (operator plane), flag-gated default-off. The operator's
    // UNSCOPED chat has workspaceId='' and deliberately never records (not tenant spend — see the
    // llm-usage-store header). Fire-and-forget; failure never touches the answer.
    recordLlmUsage({
      enabled: envFlagTrue((ctx.env as { LLM_USAGE_METERING_ENABLED?: string }).LLM_USAGE_METERING_ENABLED),
      makeSql: () => neonClient(ctx.env.DATABASE_URL),
      workspaceId: workspaceId || '', userId: user_id, model: result.model,
      tokensIn: result.usage?.tokens_in, tokensOut: result.usage?.tokens_out,
      waitUntil: (p) => {
        try { ctx.executionCtx?.waitUntil ? ctx.executionCtx.waitUntil(p) : void p.catch(() => {}); }
        catch { void p.catch(() => {}); } // test/non-workers runtimes have no executionCtx — fire anyway
      },
    });

    // Wave 3 · persist the exchange so the thread survives a reload / another browser. READ modes
    // (Ask/Plan/Recommend/Deep-research) render an answer; WRITE modes confirm capture client-side and
    // do not POST here, so every exchange that reaches this route is a Q&A pair worth remembering.
    // Best-effort: a persistence failure must NEVER break the live answer.
    try {
      const appender = (dal as { appendChatExchange?: (u: string, s: CockpitChatScope, m: unknown[]) => Promise<void> }).appendChatExchange;
      if (typeof appender === 'function') {
        // W1 receipt substrate: live event links ride the assistant message only when the flag is on
        // (migration 058; chat-store degrades safely pre-058).
        const receiptLinks = envFlagTrue((ctx.env as { CHAT_RECEIPT_GROUNDING_ENABLED?: string }).CHAT_RECEIPT_GROUNDING_ENABLED)
          ? ((result.grounded_on as { event_ids?: string[] })?.event_ids ?? null)
          : null;
        await appender.call(dal, user_id, scope, [
          { role: 'you', body: message, mode },
          // L1 · attachAssembly(g, null) returns g unchanged by reference — flag-off stays byte-identical.
          { role: 'assistant', body: result.answer, mode, generated_by: result.generated_by, grounded_on: attachAssembly(result.grounded_on, trace), grounding_event_ids: receiptLinks },
        ]);
      }
    } catch (_) { /* persistence is best-effort; the answer already stands */ }

    return ctx.json({
      answer: result.answer,
      generated_by: result.generated_by,
      model: result.model ?? null,
      grounded_on: result.grounded_on,
      scope,
      mode,
    });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

// GET /api/v1/cockpit-chat/history — Wave 3 · load the operator's stored chat thread for a scope, so a
// conversation survives a reload or a different browser (it used to live only in React state). Same
// operator-only gate as POST /cockpit-chat. Returns [] when nothing is stored yet (the panel then
// auto-summarizes as before). Never 5xx on a missing table — degrades to an empty thread.
workspacesRoute.get('/cockpit-chat/history', async (ctx) => {
  try {
    const { user_id } = ctx.get('auth');
    const { ownerUserId } = operatorIds(ctx.env);
    if (!ownerUserId || !user_id || user_id !== ownerUserId) {
      ctx.status(403);
      return ctx.json({ error: 'cockpit chat is operator-only', code: 'FORBIDDEN', request_id: ctx.get('request_id') });
    }
    const workspaceId = String(ctx.req.query('workspace_id') || '').trim();
    const projectId = ctx.req.query('project_id') ? String(ctx.req.query('project_id')).trim() : null;
    const domainId = ctx.req.query('domain_id') ? String(ctx.req.query('domain_id')).trim() : null;
    const scope: CockpitChatScope = { workspace_id: workspaceId, project_id: projectId, domain_id: domainId };

    const dal = ctx.get('dal');
    let messages: unknown[] = [];
    try {
      const lister = (dal as { listChatHistory?: (u: string, s: CockpitChatScope, n?: number) => Promise<unknown[]> }).listChatHistory;
      if (typeof lister === 'function') messages = await lister.call(dal, user_id, scope, 100);
    } catch (_) { messages = []; }

    return ctx.json({ messages, scope });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

// GET /api/v1/audit-log — Wave 4 · the governance audit trail (sign-offs + the events they act on)
// across the operator's workspaces, newest first. Operator-only (same overlay as cockpit-chat). This
// is what makes "who approved what, when" READABLE — auditability the cockpit used to lack. Never
// 5xx on a missing column/table (degrades to an empty trail).
workspacesRoute.get('/audit-log', async (ctx) => {
  try {
    const { user_id } = ctx.get('auth');
    const { ownerUserId, ids } = operatorIds(ctx.env);
    if (!ownerUserId || !user_id || user_id !== ownerUserId) {
      ctx.status(403);
      return ctx.json({ error: 'audit log is operator-only', code: 'FORBIDDEN', request_id: ctx.get('request_id') });
    }
    const limitRaw = Number(ctx.req.query('limit'));
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(500, Math.floor(limitRaw)) : 100;
    const dal = ctx.get('dal');
    let entries: Record<string, unknown>[] = [];
    try {
      // Duck-typed access to an optional DAL method — declare its return as unknown[] (the concrete
      // GovernanceAuditEntry[] has no index signature, so a Record<string,unknown>[] cast on the method
      // signature is a mismatch); widen the rows to the generic record shape the CSV/JSONL exporters take.
      const lister = (dal as { listGovernanceAuditLogForOperator?: (o: string[], n?: number) => Promise<unknown[]> }).listGovernanceAuditLogForOperator;
      if (typeof lister === 'function') entries = (await lister.call(dal, ids, limit)) as Record<string, unknown>[];
    } catch (_) { entries = []; }
    // E2 · auditor self-serve export. ?format=csv|jsonl streams the trail as a downloadable file
    // (frozen column order); absent/unknown format keeps the existing JSON envelope (back-compatible).
    const format = parseAuditExportFormat(ctx.req.query('format'));
    if (format === 'csv') {
      ctx.header('Content-Type', 'text/csv; charset=utf-8');
      ctx.header('Content-Disposition', 'attachment; filename="audit-log.csv"');
      return ctx.body(auditToCsv(entries));
    }
    if (format === 'jsonl') {
      ctx.header('Content-Type', 'application/x-ndjson; charset=utf-8');
      ctx.header('Content-Disposition', 'attachment; filename="audit-log.jsonl"');
      return ctx.body(auditToJsonl(entries));
    }
    return ctx.json(withDataClass({ entries }, 'live'));
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

// ── Wave 5b · first-class intents ───────────────────────────────────────────────────────────────────
// An "intent" used to be a free-text pointer (operation_events.intent_id) to nothing. It is now a real
// artefact with a title, status, owner and lineage. These four routes read/write it, scoped to the
// operator's own workspaces (same overlay as cockpit-chat / audit-log). Every read degrades to empty on
// a missing table (023 not yet applied) — never 5xx.

// GET /api/v1/intents — list the operator's intents, optionally narrowed to a project/domain.
workspacesRoute.get('/intents', async (ctx) => {
  try {
    const { user_id } = ctx.get('auth');
    const { ownerUserId, ids } = operatorIds(ctx.env);
    if (!ownerUserId || !user_id || user_id !== ownerUserId) {
      ctx.status(403);
      return ctx.json({ error: 'intents are operator-only', code: 'FORBIDDEN', request_id: ctx.get('request_id') });
    }
    const scope = {
      workspace_id: ctx.req.query('workspace_id') ? String(ctx.req.query('workspace_id')).trim() : null,
      project_id: ctx.req.query('project_id') ? String(ctx.req.query('project_id')).trim() : null,
      domain_id: ctx.req.query('domain_id') ? String(ctx.req.query('domain_id')).trim() : null,
    };
    const limitRaw = Number(ctx.req.query('limit'));
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(500, Math.floor(limitRaw)) : 200;
    const dal = ctx.get('dal');
    let intents: unknown[] = [];
    try {
      const lister = (dal as { listIntentsForOperator?: (o: string[], s: typeof scope, n?: number) => Promise<unknown[]> }).listIntentsForOperator;
      if (typeof lister === 'function') intents = await lister.call(dal, ids, scope, limit);
    } catch (_) { intents = []; }
    return ctx.json({ intents });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

// GET /api/v1/intents/:id — one intent + its lineage (child events + derived intents). 404 if not theirs.
workspacesRoute.get('/intents/:id', async (ctx) => {
  try {
    const { user_id } = ctx.get('auth');
    const { ownerUserId, ids } = operatorIds(ctx.env);
    if (!ownerUserId || !user_id || user_id !== ownerUserId) {
      ctx.status(403);
      return ctx.json({ error: 'intents are operator-only', code: 'FORBIDDEN', request_id: ctx.get('request_id') });
    }
    const id = String(ctx.req.param('id') || '').trim();
    if (!id) {
      ctx.status(400);
      return ctx.json({ error: 'intent id required', code: 'VALIDATION_ERROR', request_id: ctx.get('request_id') });
    }
    const dal = ctx.get('dal');
    let lineage: unknown = null;
    try {
      const getter = (dal as { getIntentLineageForOperator?: (o: string[], i: string) => Promise<unknown> }).getIntentLineageForOperator;
      if (typeof getter === 'function') lineage = await getter.call(dal, ids, id);
    } catch (_) { lineage = null; }
    if (!lineage) {
      ctx.status(404);
      return ctx.json({ error: 'intent not found', code: 'NOT_FOUND', request_id: ctx.get('request_id') });
    }
    // ARCH-006 W6 — merge the generated enrichment (best-effort) so the detail view gets it in one fetch.
    let enrichment: unknown = null;
    try {
      const getEnr = (dal as { getIntentEnrichmentForIntent?: (i: string) => Promise<unknown> }).getIntentEnrichmentForIntent;
      if (typeof getEnr === 'function') enrichment = await getEnr.call(dal, id);
    } catch (_) { enrichment = null; }
    return ctx.json({ ...(lineage as Record<string, unknown>), enrichment });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

// POST /api/v1/intents — create a first-class intent (the Intent send-mode wires here). Owned by the
// operator + scoped to one of their workspaces. Body: { title, workspace_id, project_id?, domain_id?,
// summary?, status?, derived_from? }.
workspacesRoute.post('/intents', async (ctx) => {
  try {
    const { user_id } = ctx.get('auth');
    const { ownerUserId, ids } = operatorIds(ctx.env);
    if (!ownerUserId || !user_id || user_id !== ownerUserId) {
      ctx.status(403);
      return ctx.json({ error: 'intents are operator-only', code: 'FORBIDDEN', request_id: ctx.get('request_id') });
    }
    const body = await ctx.req.json().catch(() => null) as {
      title?: string; workspace_id?: string; project_id?: string; domain_id?: string;
      summary?: string; status?: string; derived_from?: string;
    } | null;
    const title = typeof body?.title === 'string' ? body.title.trim() : '';
    const workspaceId = typeof body?.workspace_id === 'string' ? body.workspace_id.trim() : '';
    if (!title || title.length > 200) {
      ctx.status(400);
      return ctx.json({ error: 'body.title required (1-200 chars)', code: 'VALIDATION_ERROR', request_id: ctx.get('request_id') });
    }
    if (!workspaceId) {
      ctx.status(400);
      return ctx.json({ error: 'body.workspace_id required', code: 'VALIDATION_ERROR', request_id: ctx.get('request_id') });
    }
    // Authorize the target workspace is the operator's own (same boundary as every read above).
    const dal = ctx.get('dal');
    let owned = false;
    try {
      const wss = await dal.listWorkspacesForOperator(ids) as Array<{ id?: string }>;
      owned = Array.isArray(wss) && wss.some((w) => w && String(w.id) === workspaceId);
    } catch (_) { owned = false; }
    if (!owned) {
      ctx.status(403);
      return ctx.json({ error: 'workspace not owned by operator', code: 'FORBIDDEN', request_id: ctx.get('request_id') });
    }
    const intent = await dal.createIntent({
      workspace_id: workspaceId,
      project_id: typeof body?.project_id === 'string' && body.project_id.trim() ? body.project_id.trim() : null,
      domain_id: typeof body?.domain_id === 'string' && body.domain_id.trim() ? body.domain_id.trim() : null,
      title,
      summary: typeof body?.summary === 'string' ? body.summary.trim() : null,
      status: typeof body?.status === 'string' ? body.status : undefined,
      derived_from: typeof body?.derived_from === 'string' && body.derived_from.trim() ? body.derived_from.trim() : null,
      owner_user_id: user_id,
      origin: 'operator',
    });
    // ARCH-005 action-recording: mirror the operator's intent into a FIRST-CLASS operation_event
    // (linked via intent_id) so the operator's action reaches the activity stream the chief-of-staff
    // reasons over. Before this, intents were created but invisible to the event stream — the operator
    // asked "did you record those actions?" and the chat couldn't answer "what are my next steps"
    // because operation_events held only github commits, never operator intent. Best-effort + idempotent
    // (deterministic id): a failed mirror NEVER blocks the intent create.
    let event_recorded = false;
    try {
      await dal.upsertEvent(workspaceId, {
        id: `evt_intent_${intent.id}`.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 128),
        source_tool: 'xlooop',
        agent_id: 'xlooop:operator-intent',
        project_id: intent.project_id ?? null,
        intent_id: intent.id,
        status: 'needs_review',
        summary: `[intent] ${title}`.slice(0, 512),
        body: intent.summary ?? null,
        visibility: 'internal_workspace',
        occurred_at: new Date().toISOString(),
        domain_id: intent.domain_id ?? null,
        // A-W4/P6 · intent-create lineage: the operator is principal + instrument (role
        // authority), server-derived from auth, never body -- mirrors projects.ts /
        // documents.ts (UGEC I1/I6). Moves lineage_stamp_sites 4->5.
        ...lineageFor(ctx.get('auth')),
      });
      event_recorded = true;
    } catch (_) { /* best-effort activity mirror — never block the intent create */ }
    // ARCH-006 W6 — pre-enrichment: generate the pros/cons / prior-resources / recommended-path enrichment
    // so the intent arrives ENRICHED (the operator's "done before I touch it"). Best-effort, bounded prior
    // context; Workers-AI or deterministic at create-time (Claude is gated to the on-demand /enrich for
    // cost). NEVER blocks the create.
    let enrichment_generated = false;
    try {
      const ai = (ctx.env as { AI?: AiRunner }).AI;
      let similar: Array<{ title?: string | null; status?: string | null }> = [];
      try {
        const prior = await dal.listIntentsForOperator(ids, { workspace_id: workspaceId }, 8) as Array<{ title?: string | null; status?: string | null }>;
        similar = (Array.isArray(prior) ? prior : []).filter((s) => s && s.title !== title);
      } catch (_) { similar = []; }
      let enrichmentLineage: AssistantContextLineage | null = null;
      let enrichmentLineageSql: ReturnType<typeof neonClient> | null = null;
      if (envFlagTrue(ctx.env.CONTEXT_PACKET_PERSISTENCE_ENABLED)) {
        enrichmentLineageSql = neonClient(ctx.env.DATABASE_URL);
        enrichmentLineage = await persistAssistantContextLineage(enrichmentLineageSql, ctx.env, {
          workspace_id: workspaceId,
          principal_id: user_id,
          role: 'operator',
          mode: 'plan',
          action: 'assistant:enrich',
          intent_ref: `intent:${intent.id}`,
          scope: { event_count: similar.length, document_count: 0, unpromoted_document_count: 0, source_count: 0 },
          redaction_profile: 'operator-intent-prior-summary',
          client_empty: false,
        });
      }
      const enr = await generateIntentEnrichment(
        { title, summary: intent.summary, project_id: intent.project_id, domain_id: intent.domain_id },
        { similar_intents: similar }, ai, undefined, false,
        enrichmentLineage && enrichmentLineageSql
          ? createModelExecutionObserver(enrichmentLineageSql, workspaceId, user_id, enrichmentLineage)
          : undefined,
      );
      if (enrichmentLineage && enrichmentLineageSql) {
        await completeAssistantSkillLineage(enrichmentLineageSql, ctx.env, enrichmentLineage, {
          workspace_id: workspaceId,
          principal_id: user_id,
        });
      }
      await dal.upsertIntentEnrichment(intent.id, enr);
      enrichment_generated = true;
    } catch (_) { /* best-effort enrichment — never block the create */ }
    ctx.status(201);
    return ctx.json({ intent, event_recorded, enrichment_generated });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

// POST /api/v1/intents/:id/enrich — ARCH-006 W6 · regenerate an intent's enrichment on demand (after the
// operator edits it, or to upgrade to the Claude tier). Operator-only + ownership-gated. Allows Claude.
workspacesRoute.post('/intents/:id/enrich', async (ctx) => {
  try {
    const { user_id } = ctx.get('auth');
    const { ownerUserId, ids } = operatorIds(ctx.env);
    if (!ownerUserId || !user_id || user_id !== ownerUserId) {
      ctx.status(403);
      return ctx.json({ error: 'intents are operator-only', code: 'FORBIDDEN', request_id: ctx.get('request_id') });
    }
    const id = String(ctx.req.param('id') || '').trim();
    if (!id) {
      ctx.status(400);
      return ctx.json({ error: 'intent id required', code: 'VALIDATION_ERROR', request_id: ctx.get('request_id') });
    }
    const dal = ctx.get('dal');
    // Resolve the intent via the operator-scoped lineage read (404s if not theirs → ownership gate).
    type IntentLineageShape = { intent?: { id?: string; title?: string; summary?: string | null; project_id?: string | null; domain_id?: string | null; workspace_id?: string | null }; child_events?: Array<{ summary?: string | null; status?: string | null }> };
    let lineage: IntentLineageShape | null = null;
    try {
      const getter = (dal as { getIntentLineageForOperator?: (o: string[], i: string) => Promise<unknown> }).getIntentLineageForOperator;
      if (typeof getter === 'function') lineage = await getter.call(dal, ids, id) as IntentLineageShape;
    } catch (_) { lineage = null; }
    if (!lineage || !lineage.intent) {
      ctx.status(404);
      return ctx.json({ error: 'intent not found', code: 'NOT_FOUND', request_id: ctx.get('request_id') });
    }
    const it = lineage.intent;
    const ai = (ctx.env as { AI?: AiRunner }).AI;
    const claudeKey = (ctx.env as { ANTHROPIC_API_KEY?: string }).ANTHROPIC_API_KEY;
    let similar: Array<{ title?: string | null; status?: string | null }> = [];
    try {
      const prior = await dal.listIntentsForOperator(ids, { workspace_id: it.workspace_id ?? null }, 8) as Array<{ title?: string | null; status?: string | null }>;
      similar = (Array.isArray(prior) ? prior : []).filter((s) => s && s.title !== it.title);
    } catch (_) { similar = []; }
    const enrichmentWorkspaceId = String(it.workspace_id || '').trim();
    if (!enrichmentWorkspaceId) {
      ctx.status(409);
      return ctx.json({ error: 'intent has no workspace lineage target', code: 'CONTEXT_LINEAGE_SCOPE_REQUIRED', request_id: ctx.get('request_id') });
    }
    let enrichmentLineage: AssistantContextLineage | null = null;
    let enrichmentLineageSql: ReturnType<typeof neonClient> | null = null;
    if (envFlagTrue(ctx.env.CONTEXT_PACKET_PERSISTENCE_ENABLED)) {
      enrichmentLineageSql = neonClient(ctx.env.DATABASE_URL);
      enrichmentLineage = await persistAssistantContextLineage(enrichmentLineageSql, ctx.env, {
        workspace_id: enrichmentWorkspaceId,
        principal_id: user_id,
        role: 'operator',
        mode: 'plan',
        action: 'assistant:enrich',
        intent_ref: `intent:${id}`,
        scope: {
          event_count: similar.length + (Array.isArray(lineage.child_events) ? lineage.child_events.length : 0),
          document_count: 0,
          unpromoted_document_count: 0,
          source_count: 0,
        },
        redaction_profile: 'operator-intent-prior-summary',
        client_empty: false,
      });
    }
    const enr = await generateIntentEnrichment(
      { title: String(it.title || ''), summary: it.summary ?? null, project_id: it.project_id ?? null, domain_id: it.domain_id ?? null },
      { similar_intents: similar, recent_events: Array.isArray(lineage.child_events) ? lineage.child_events : [] },
      ai, claudeKey, true, // useClaude on-demand
      enrichmentLineage && enrichmentLineageSql
        ? createModelExecutionObserver(enrichmentLineageSql, enrichmentWorkspaceId, user_id, enrichmentLineage)
        : undefined,
    );
    if (enrichmentLineage && enrichmentLineageSql) {
      await completeAssistantSkillLineage(enrichmentLineageSql, ctx.env, enrichmentLineage, {
        workspace_id: enrichmentWorkspaceId,
        principal_id: user_id,
      });
    }
    try { await dal.upsertIntentEnrichment(id, enr); } catch (_) { /* best-effort */ }
    return ctx.json({ enrichment: enr });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

// POST /api/v1/intents/:id/status — advance an intent's lifecycle (open|active|blocked|done|abandoned).
workspacesRoute.post('/intents/:id/status', async (ctx) => {
  try {
    const { user_id } = ctx.get('auth');
    const { ownerUserId, ids } = operatorIds(ctx.env);
    if (!ownerUserId || !user_id || user_id !== ownerUserId) {
      ctx.status(403);
      return ctx.json({ error: 'intents are operator-only', code: 'FORBIDDEN', request_id: ctx.get('request_id') });
    }
    const id = String(ctx.req.param('id') || '').trim();
    const body = await ctx.req.json().catch(() => null) as { status?: string } | null;
    const status = typeof body?.status === 'string' ? body.status.trim() : '';
    if (!id || !status) {
      ctx.status(400);
      return ctx.json({ error: 'intent id + body.status required', code: 'VALIDATION_ERROR', request_id: ctx.get('request_id') });
    }
    const dal = ctx.get('dal');
    const intent = await dal.updateIntentStatusForOperator(ids, id, status);
    if (!intent) {
      ctx.status(404);
      return ctx.json({ error: 'intent not found or invalid status', code: 'NOT_FOUND', request_id: ctx.get('request_id') });
    }
    return ctx.json({ intent });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

// PATCH /api/v1/intents/:id — OS-5 W4 · edit title/summary (J3: intents were immutable; a typo'd
// title could never be fixed). The intents TABLE is the mutable artefact; the store appends an
// evt_intent_edited_ receipt (prior title named) so the edit shows in the intent's lineage.
workspacesRoute.patch('/intents/:id', async (ctx) => {
  try {
    const { user_id } = ctx.get('auth');
    const { ownerUserId, ids } = operatorIds(ctx.env);
    if (!ownerUserId || !user_id || user_id !== ownerUserId) {
      ctx.status(403);
      return ctx.json({ error: 'intents are operator-only', code: 'FORBIDDEN', request_id: ctx.get('request_id') });
    }
    const id = String(ctx.req.param('id') || '').trim();
    const body = await ctx.req.json().catch(() => null) as { title?: string; summary?: string } | null;
    const hasTitle = typeof body?.title === 'string' && body.title.trim().length > 0;
    const hasSummary = typeof body?.summary === 'string';
    if (!id || (!hasTitle && !hasSummary)) {
      ctx.status(400);
      return ctx.json({ error: 'intent id + at least one of body.title / body.summary required', code: 'VALIDATION_ERROR', request_id: ctx.get('request_id') });
    }
    const dal = ctx.get('dal');
    const intent = await dal.updateIntentFieldsForOperator(ids, id, {
      title: hasTitle ? body!.title : undefined,
      summary: hasSummary ? body!.summary : undefined,
    });
    if (!intent) {
      ctx.status(404);
      return ctx.json({ error: 'intent not found', code: 'NOT_FOUND', request_id: ctx.get('request_id') });
    }
    return ctx.json({ intent });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

// POST /api/v1/intents/:id/attach-event — OS-4 P3 · attach a stray event to an intent (the missing
// reverse direction of the lineage). An L1 pointer re-point + APPENDED audit receipt (ia-001), the
// receipt threaded under the event (parent_event_id) + linked to the intent. Operator-only.
workspacesRoute.post('/intents/:id/attach-event', async (ctx) => {
  try {
    const { user_id } = ctx.get('auth');
    const { ownerUserId, ids } = operatorIds(ctx.env);
    if (!ownerUserId || !user_id || user_id !== ownerUserId) {
      ctx.status(403);
      return ctx.json({ error: 'intents are operator-only', code: 'FORBIDDEN', request_id: ctx.get('request_id') });
    }
    const id = String(ctx.req.param('id') || '').trim();
    const body = await ctx.req.json().catch(() => null) as { event_id?: string } | null;
    const eventId = typeof body?.event_id === 'string' ? body.event_id.trim() : '';
    if (!id || !eventId) {
      ctx.status(400);
      return ctx.json({ error: 'intent id + body.event_id required', code: 'VALIDATION_ERROR', request_id: ctx.get('request_id') });
    }
    const dal = ctx.get('dal');
    const result = await dal.repointEventIntentForOperator(ids, id, eventId);
    if (!result) {
      ctx.status(404);
      return ctx.json({ error: 'intent or event not found in your workspaces', code: 'NOT_FOUND', request_id: ctx.get('request_id') });
    }
    return ctx.json({ attached: result });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

// ── ARCH-006 W6 · first-class DECISIONS ───────────────────────────────────────────────────────────────
// A decision is the RICH governance record (context/criteria/rollback/causation) that a sign-off comment
// cannot hold. It REUSES sign_offs (the approval act) + audit_logs (the trail) — no duplication. Operator-
// only, same boundary as intents. POST best-effort mirrors a first-class operation_event (so the chief-of-
// staff sees it) + the DAL mirrors to operations_unified (graph `packet` node) + stamps audit_logs
// causation (graph caused_by edge). Every read degrades to empty/404 on a missing table (030 not applied).

// GET /api/v1/decisions — list the operator's decisions, optionally narrowed to a project/event.
workspacesRoute.get('/decisions', async (ctx) => {
  try {
    const { user_id } = ctx.get('auth');
    const { ownerUserId, ids } = operatorIds(ctx.env);
    if (!ownerUserId || !user_id || user_id !== ownerUserId) {
      ctx.status(403);
      return ctx.json({ error: 'decisions are operator-only', code: 'FORBIDDEN', request_id: ctx.get('request_id') });
    }
    const scope = {
      workspace_id: ctx.req.query('workspace_id') ? String(ctx.req.query('workspace_id')).trim() : null,
      project_id: ctx.req.query('project_id') ? String(ctx.req.query('project_id')).trim() : null,
      event_id: ctx.req.query('event_id') ? String(ctx.req.query('event_id')).trim() : null,
    };
    const limitRaw = Number(ctx.req.query('limit'));
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(500, Math.floor(limitRaw)) : 200;
    const dal = ctx.get('dal');
    let decisions: unknown[] = [];
    try {
      const lister = (dal as { listDecisionsForOperator?: (o: string[], s: typeof scope, n?: number) => Promise<unknown[]> }).listDecisionsForOperator;
      if (typeof lister === 'function') decisions = await lister.call(dal, ids, scope, limit);
    } catch (_) { decisions = []; }
    return ctx.json({ decisions });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

// GET /api/v1/decisions/:id — one decision + its sign-offs + audit trail. 404 if not theirs.
workspacesRoute.get('/decisions/:id', async (ctx) => {
  try {
    const { user_id } = ctx.get('auth');
    const { ownerUserId, ids } = operatorIds(ctx.env);
    if (!ownerUserId || !user_id || user_id !== ownerUserId) {
      ctx.status(403);
      return ctx.json({ error: 'decisions are operator-only', code: 'FORBIDDEN', request_id: ctx.get('request_id') });
    }
    const id = String(ctx.req.param('id') || '').trim();
    if (!id) {
      ctx.status(400);
      return ctx.json({ error: 'decision id required', code: 'VALIDATION_ERROR', request_id: ctx.get('request_id') });
    }
    const dal = ctx.get('dal');
    let detail: unknown = null;
    try {
      const getter = (dal as { getDecisionForOperator?: (o: string[], i: string) => Promise<unknown> }).getDecisionForOperator;
      if (typeof getter === 'function') detail = await getter.call(dal, ids, id);
    } catch (_) { detail = null; }
    if (!detail) {
      ctx.status(404);
      return ctx.json({ error: 'decision not found', code: 'NOT_FOUND', request_id: ctx.get('request_id') });
    }
    return ctx.json(detail as Record<string, unknown>);
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

// POST /api/v1/decisions — record a first-class decision. Owned by the operator + scoped to one of their
// workspaces. Body: { workspace_id, verdict, context, kind?, project_id?, event_id?, criteria?, rollback? }.
workspacesRoute.post('/decisions', async (ctx) => {
  try {
    const { user_id } = ctx.get('auth');
    const { ownerUserId, ids } = operatorIds(ctx.env);
    if (!ownerUserId || !user_id || user_id !== ownerUserId) {
      ctx.status(403);
      return ctx.json({ error: 'decisions are operator-only', code: 'FORBIDDEN', request_id: ctx.get('request_id') });
    }
    const body = await ctx.req.json().catch(() => null) as {
      workspace_id?: string; project_id?: string; event_id?: string; kind?: string;
      verdict?: string; context?: string; criteria?: unknown; rollback?: string; causation_id?: string;
    } | null;
    const workspaceId = typeof body?.workspace_id === 'string' ? body.workspace_id.trim() : '';
    const context = typeof body?.context === 'string' ? body.context.trim() : '';
    const verdict = typeof body?.verdict === 'string' ? body.verdict.trim() : '';
    if (!workspaceId) {
      ctx.status(400);
      return ctx.json({ error: 'body.workspace_id required', code: 'VALIDATION_ERROR', request_id: ctx.get('request_id') });
    }
    if (!context || context.length > 4000) {
      ctx.status(400);
      return ctx.json({ error: 'body.context required (1-4000 chars)', code: 'VALIDATION_ERROR', request_id: ctx.get('request_id') });
    }
    if (!['approved', 'rejected', 'deferred', 'noted'].includes(verdict)) {
      ctx.status(400);
      return ctx.json({ error: 'body.verdict must be one of: approved, rejected, deferred, noted', code: 'VALIDATION_ERROR', request_id: ctx.get('request_id') });
    }
    if (body?.criteria !== undefined && (typeof body.criteria !== 'object' || body.criteria === null)) {
      ctx.status(400);
      return ctx.json({ error: 'body.criteria must be an object/array', code: 'VALIDATION_ERROR', request_id: ctx.get('request_id') });
    }
    const dal = ctx.get('dal');
    let owned = false;
    try {
      const wss = await dal.listWorkspacesForOperator(ids) as Array<{ id?: string }>;
      owned = Array.isArray(wss) && wss.some((w) => w && String(w.id) === workspaceId);
    } catch (_) { owned = false; }
    if (!owned) {
      ctx.status(403);
      return ctx.json({ error: 'workspace not owned by operator', code: 'FORBIDDEN', request_id: ctx.get('request_id') });
    }
    const decision = await dal.createDecision({
      workspace_id: workspaceId,
      project_id: typeof body?.project_id === 'string' && body.project_id.trim() ? body.project_id.trim() : null,
      event_id: typeof body?.event_id === 'string' && body.event_id.trim() ? body.event_id.trim() : null,
      actor_user_id: user_id,
      kind: typeof body?.kind === 'string' ? body.kind : undefined,
      verdict,
      context,
      criteria: body?.criteria ?? [],
      rollback: typeof body?.rollback === 'string' ? body.rollback : null,
      causation_id: typeof body?.causation_id === 'string' && body.causation_id.trim() ? body.causation_id.trim() : null,
    });
    // ARCH-006 W1.2 — record the decision as a first-class OPERATION-tier event the chief-of-staff sees.
    let event_recorded = false;
    try {
      await dal.upsertEvent(workspaceId, {
        id: `evt_decision_${decision.id}`.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 128),
        source_tool: 'xlooop',
        agent_id: 'xlooop:operator-action',
        project_id: decision.project_id ?? null,
        status: decision.verdict === 'rejected' ? 'needs_review' : 'completed',
        summary: `[decision ${decision.verdict}] ${context}`.slice(0, 512),
        body: decision.rollback ?? context,
        visibility: 'internal_workspace',
        occurred_at: new Date().toISOString(),
      });
      event_recorded = true;
    } catch (_) { /* best-effort activity mirror — never block the decision */ }
    ctx.status(201);
    return ctx.json({ decision, event_recorded });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

// ── W1 · privacy-safe usage telemetry ────────────────────────────────────────────────────────────────
// IDS + COUNTS only — never content. The instrument that lets "based on usage" (W4) and prioritization
// stand on real data instead of a guess. Operator-only; ALWAYS best-effort (a telemetry write must never
// block the live action), so POST returns 202 even on a write failure and never 5xx's.

// POST /api/v1/usage — log one interaction. Body: { kind, ref_id?, scope_key? }.
workspacesRoute.post('/usage', async (ctx) => {
  try {
    const { user_id } = ctx.get('auth');
    const { ownerUserId } = operatorIds(ctx.env);
    if (!ownerUserId || !user_id || user_id !== ownerUserId) {
      ctx.status(403);
      return ctx.json({ error: 'usage telemetry is operator-only', code: 'FORBIDDEN', request_id: ctx.get('request_id') });
    }
    const body = await ctx.req.json().catch(() => null) as { kind?: string; ref_id?: string; scope_key?: string } | null;
    const kind = typeof body?.kind === 'string' ? body.kind.trim() : '';
    if (!kind) {
      ctx.status(400);
      return ctx.json({ error: 'body.kind required', code: 'VALIDATION_ERROR', request_id: ctx.get('request_id') });
    }
    const dal = ctx.get('dal');
    try {
      const rec = (dal as { recordUsageEvent?: (i: unknown) => Promise<void> }).recordUsageEvent;
      if (typeof rec === 'function') {
        await rec.call(dal, {
          user_id,
          kind,
          ref_id: typeof body?.ref_id === 'string' ? body.ref_id : null,
          scope_key: typeof body?.scope_key === 'string' ? body.scope_key : null,
        });
      }
    } catch (_) { /* telemetry is best-effort — never surface a write failure to the live action */ }
    ctx.status(202);
    return ctx.json({ ok: true });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

// GET /api/v1/usage?kind=&limit= — the operator's own usage aggregates {ref_id, clicks, last_used_at}.
workspacesRoute.get('/usage', async (ctx) => {
  try {
    const { user_id } = ctx.get('auth');
    const { ownerUserId, ids } = operatorIds(ctx.env);
    if (!ownerUserId || !user_id || user_id !== ownerUserId) {
      ctx.status(403);
      return ctx.json({ error: 'usage telemetry is operator-only', code: 'FORBIDDEN', request_id: ctx.get('request_id') });
    }
    const kind = String(ctx.req.query('kind') || '').trim();
    if (!kind) {
      ctx.status(400);
      return ctx.json({ error: 'query kind required', code: 'VALIDATION_ERROR', request_id: ctx.get('request_id') });
    }
    const limitRaw = Number(ctx.req.query('limit'));
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(500, Math.floor(limitRaw)) : 100;
    const dal = ctx.get('dal');
    let usage: unknown[] = [];
    try {
      const agg = (dal as { aggregateUsageForOperator?: (o: string[], k: string, n?: number) => Promise<unknown[]> }).aggregateUsageForOperator;
      if (typeof agg === 'function') usage = await agg.call(dal, ids, kind, limit);
    } catch (_) { usage = []; }
    return ctx.json({ usage });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

// ── W2 · durable per-operator prompt tags (the "Ask about X" quick-action chips) ─────────────────────
// GLOBAL per operator (one set across scopes). Makes the chips follow the operator across browsers/
// devices + adds EDIT (previously only add-via-window.prompt + remove existed). Operator-only; every
// read degrades to empty on a missing table (025 not yet applied). message is capped server-side.

// GET /api/v1/cockpit-chat/prompt-tags — the operator's stored chips (empty → client uses its defaults).
workspacesRoute.get('/cockpit-chat/prompt-tags', async (ctx) => {
  try {
    const { user_id } = ctx.get('auth');
    const { ownerUserId } = operatorIds(ctx.env);
    if (!ownerUserId || !user_id || user_id !== ownerUserId) {
      ctx.status(403);
      return ctx.json({ error: 'prompt tags are operator-only', code: 'FORBIDDEN', request_id: ctx.get('request_id') });
    }
    const dal = ctx.get('dal');
    let tags: unknown[] = [];
    try {
      const lister = (dal as { listPromptTagsForUser?: (u: string) => Promise<unknown[]> }).listPromptTagsForUser;
      if (typeof lister === 'function') tags = await lister.call(dal, user_id);
    } catch (_) { tags = []; }
    return ctx.json({ tags });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

// PUT /api/v1/cockpit-chat/prompt-tags — add OR edit a chip (same write). Body { tag_id, label, message, sort? }.
workspacesRoute.put('/cockpit-chat/prompt-tags', async (ctx) => {
  try {
    const { user_id } = ctx.get('auth');
    const { ownerUserId } = operatorIds(ctx.env);
    if (!ownerUserId || !user_id || user_id !== ownerUserId) {
      ctx.status(403);
      return ctx.json({ error: 'prompt tags are operator-only', code: 'FORBIDDEN', request_id: ctx.get('request_id') });
    }
    const body = await ctx.req.json().catch(() => null) as { tag_id?: string; label?: string; message?: string; sort?: number } | null;
    const tagId = typeof body?.tag_id === 'string' ? body.tag_id.trim() : '';
    const label = typeof body?.label === 'string' ? body.label.trim() : '';
    const message = typeof body?.message === 'string' ? body.message.trim() : '';
    if (!tagId || !label || !message || message.length > 600) {
      ctx.status(400);
      return ctx.json({ error: 'tag_id + label + message required (message ≤ 600 chars)', code: 'VALIDATION_ERROR', request_id: ctx.get('request_id') });
    }
    const dal = ctx.get('dal');
    const tag = await dal.upsertPromptTagForUser({ user_id, tag_id: tagId, label, message, sort: typeof body?.sort === 'number' ? body.sort : 0 });
    if (!tag) {
      ctx.status(500);
      return ctx.json({ error: 'could not save the prompt tag', code: 'INTERNAL', request_id: ctx.get('request_id') });
    }
    return ctx.json({ tag });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

// POST /api/v1/cockpit-chat/prompt-tags/migrate — one-time localStorage → server import. Body { tags:[…] }.
workspacesRoute.post('/cockpit-chat/prompt-tags/migrate', async (ctx) => {
  try {
    const { user_id } = ctx.get('auth');
    const { ownerUserId } = operatorIds(ctx.env);
    if (!ownerUserId || !user_id || user_id !== ownerUserId) {
      ctx.status(403);
      return ctx.json({ error: 'prompt tags are operator-only', code: 'FORBIDDEN', request_id: ctx.get('request_id') });
    }
    const body = await ctx.req.json().catch(() => null) as { tags?: Array<Record<string, unknown>> } | null;
    const tags = Array.isArray(body?.tags) ? body!.tags : [];
    const dal = ctx.get('dal');
    let migrated = 0;
    try {
      const bulk = (dal as { bulkUpsertPromptTagsForUser?: (u: string, t: unknown[]) => Promise<number> }).bulkUpsertPromptTagsForUser;
      if (typeof bulk === 'function') migrated = await bulk.call(dal, user_id, tags);
    } catch (_) { migrated = 0; }
    return ctx.json({ migrated });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

// POST /api/v1/cockpit-chat/enhance-prompt — W4 · "Improve wording" for a quick-prompt tag. Reuses the
// never-throws LLM (services/prompt-refine): returns { original, proposed, refined }. SUGGEST only — the
// client previews proposed vs original and the operator accepts; the server NEVER mutates a stored tag.
// On any failure proposed === original + refined === false, so the operator can never lose their text.
workspacesRoute.post('/cockpit-chat/enhance-prompt', async (ctx) => {
  try {
    const { user_id } = ctx.get('auth');
    const { ownerUserId } = operatorIds(ctx.env);
    if (!ownerUserId || !user_id || user_id !== ownerUserId) {
      ctx.status(403);
      return ctx.json({ error: 'prompt tags are operator-only', code: 'FORBIDDEN', request_id: ctx.get('request_id') });
    }
    const body = await ctx.req.json().catch(() => null) as { message?: string; workspace_id?: string } | null;
    const message = typeof body?.message === 'string' ? body.message.trim() : '';
    if (!message || message.length > 600) {
      ctx.status(400);
      return ctx.json({ error: 'body.message required (1-600 chars)', code: 'VALIDATION_ERROR', request_id: ctx.get('request_id') });
    }
    const ai = (ctx.env as { AI?: AiRunner }).AI;
    let refineLineage: AssistantContextLineage | null = null;
    let refineLineageSql: ReturnType<typeof neonClient> | null = null;
    const targetWorkspaceId = typeof body?.workspace_id === 'string' ? body.workspace_id.trim() : '';
    if (envFlagTrue(ctx.env.CONTEXT_PACKET_PERSISTENCE_ENABLED)) {
      if (!targetWorkspaceId || !await ctx.get('dal').operatorOwnsWorkspace(operatorIds(ctx.env).ids, targetWorkspaceId)) {
        ctx.status(targetWorkspaceId ? 403 : 409);
        return ctx.json({
          error: targetWorkspaceId ? 'workspace is outside the operator scope' : 'strict context lineage requires one workspace target',
          code: targetWorkspaceId ? 'FORBIDDEN' : 'CONTEXT_LINEAGE_SCOPE_REQUIRED',
          request_id: ctx.get('request_id'),
        });
      }
      refineLineageSql = neonClient(ctx.env.DATABASE_URL);
      refineLineage = await persistAssistantContextLineage(refineLineageSql, ctx.env, {
        workspace_id: targetWorkspaceId,
        principal_id: user_id,
        role: 'operator',
        mode: 'plan',
        action: 'assistant:refine',
        intent_ref: await assistantIntentRef(message),
        scope: { event_count: 0, document_count: 0, unpromoted_document_count: 0, source_count: 0 },
        redaction_profile: 'operator-input-only',
        client_empty: false,
      });
    }
    const result = await refinePromptText(
      message,
      ai,
      refineLineage && refineLineageSql
        ? createModelExecutionObserver(refineLineageSql, targetWorkspaceId, user_id, refineLineage)
        : undefined,
    );
    if (refineLineage && refineLineageSql) {
      await completeAssistantSkillLineage(refineLineageSql, ctx.env, refineLineage, {
        workspace_id: targetWorkspaceId,
        principal_id: user_id,
      });
    }
    return ctx.json({ original: message, proposed: result.proposed, refined: result.refined });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

// DELETE /api/v1/cockpit-chat/prompt-tags/:tagId — remove one of the operator's chips.
workspacesRoute.delete('/cockpit-chat/prompt-tags/:tagId', async (ctx) => {
  try {
    const { user_id } = ctx.get('auth');
    const { ownerUserId } = operatorIds(ctx.env);
    if (!ownerUserId || !user_id || user_id !== ownerUserId) {
      ctx.status(403);
      return ctx.json({ error: 'prompt tags are operator-only', code: 'FORBIDDEN', request_id: ctx.get('request_id') });
    }
    const tagId = String(ctx.req.param('tagId') || '').trim();
    if (!tagId) {
      ctx.status(400);
      return ctx.json({ error: 'tagId required', code: 'VALIDATION_ERROR', request_id: ctx.get('request_id') });
    }
    const dal = ctx.get('dal');
    let ok = false;
    try {
      const del = (dal as { deletePromptTagForUser?: (u: string, t: string) => Promise<boolean> }).deletePromptTagForUser;
      if (typeof del === 'function') ok = await del.call(dal, user_id, tagId);
    } catch (_) { ok = false; }
    return ctx.json({ ok });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

// ── W3 · reflection-only folder connector ────────────────────────────────────────────────────────────
// "Folders -> packets for people who don't use git." The operator's client posts a folder SNAPSHOT
// (files + checksums); the server diffs it against the durable baseline and emits ONE reflection_only
// event per add/modify/delete into the SAME operation_events spine the cockpit already reads. The server
// NEVER reads a filesystem and NEVER writes back — it only observes. Operator-only; on-demand (no cron).
// Distinct path from the OAuth /sources/* namespace to avoid collision.

// GET /api/v1/folder-sources — list the operator's registered folders (the baseline rows are the registry).
workspacesRoute.get('/folder-sources', async (ctx) => {
  try {
    const { user_id } = ctx.get('auth');
    const { ownerUserId, ids } = operatorIds(ctx.env);
    if (!ownerUserId || !user_id || user_id !== ownerUserId) {
      ctx.status(403);
      return ctx.json({ error: 'folder sources are operator-only', code: 'FORBIDDEN', request_id: ctx.get('request_id') });
    }
    const dal = ctx.get('dal');
    let folders: unknown[] = [];
    try {
      const wss = await dal.listWorkspacesForOperator(ids) as Array<{ id?: string }>;
      const wsIds = Array.isArray(wss) ? wss.map((w) => String(w.id)).filter(Boolean) : [];
      const lister = (dal as { listFolderBindingsForOperator?: (w: string[]) => Promise<unknown[]> }).listFolderBindingsForOperator;
      if (typeof lister === 'function' && wsIds.length > 0) folders = await lister.call(dal, wsIds);
    } catch (_) { folders = []; }
    return ctx.json({ folders });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

// POST /api/v1/folder-sources/register — register a folder. Body { workspace_id, project_id?, path }.
// Returns { binding_id }. Creates an empty baseline so the FIRST sync emits every file as "added".
workspacesRoute.post('/folder-sources/register', async (ctx) => {
  try {
    const { user_id } = ctx.get('auth');
    const { ownerUserId, ids } = operatorIds(ctx.env);
    if (!ownerUserId || !user_id || user_id !== ownerUserId) {
      ctx.status(403);
      return ctx.json({ error: 'folder sources are operator-only', code: 'FORBIDDEN', request_id: ctx.get('request_id') });
    }
    const body = await ctx.req.json().catch(() => null) as { workspace_id?: string; project_id?: string; path?: string } | null;
    const workspaceId = typeof body?.workspace_id === 'string' ? body.workspace_id.trim() : '';
    const projectId = typeof body?.project_id === 'string' ? body.project_id.trim() : '';
    const path = typeof body?.path === 'string' ? body.path.trim() : '';
    if (!workspaceId || !path || !projectId) {
      ctx.status(400);
      return ctx.json({ error: 'body.workspace_id + body.project_id + body.path required (a folder binds to a project)', code: 'VALIDATION_ERROR', request_id: ctx.get('request_id') });
    }
    const dal = ctx.get('dal');
    let owned = false;
    try {
      const wss = await dal.listWorkspacesForOperator(ids) as Array<{ id?: string }>;
      owned = Array.isArray(wss) && wss.some((w) => w && String(w.id) === workspaceId);
    } catch (_) { owned = false; }
    if (!owned) {
      ctx.status(403);
      return ctx.json({ error: 'workspace not owned by operator', code: 'FORBIDDEN', request_id: ctx.get('request_id') });
    }
    // Phase D (ADR-XLOOP-IA-001): registration creates the CANONICAL project_source_bindings row
    // (source_kind='desktop_folder'); folder_snapshots is keyed by that binding's id and serves ONLY as
    // the diff baseline. Idempotent: reuse a non-archived desktop_folder binding for the same path.
    let bindingId: string;
    try {
      const existing = await dal.listProjectSourceBindings(workspaceId, projectId) as Array<{ id?: string; source_kind?: string; status?: string; source_ref?: { path?: string } }>;
      const reuse = Array.isArray(existing)
        ? existing.find((b) => b && b.source_kind === 'desktop_folder' && b.status !== 'archived' && b.source_ref && b.source_ref.path === path)
        : undefined;
      if (reuse && reuse.id) {
        bindingId = reuse.id;
      } else {
        const created = await dal.createProjectSourceBinding(
          workspaceId,
          projectId,
          { source_kind: 'desktop_folder', source_ref: { path }, status: 'connected', read_policy: 'metadata_only', metadata: { connector: 'folder' } },
          user_id,
        );
        bindingId = created.id;
      }
    } catch (err) {
      // createProjectSourceBinding throws NOT_FOUND (404) when the project does not exist in the workspace.
      return errorEnvelope(ctx, err);
    }
    await dal.putFolderBaseline({
      binding_id: bindingId,
      workspace_id: workspaceId,
      project_id: projectId,
      path,
      files: [],
    });
    // ARCH-006 W1.2 — tiered provenance: record connect-a-folder as a first-class OPERATION-tier event
    // (distinct from the per-file reflection_only sync events) so the chief-of-staff sees the operator
    // registered a source. Carries project_id → feeds the lineage graph (source → project). Best-effort.
    try {
      await dal.upsertEvent(workspaceId, {
        id: `evt_source_connect_${bindingId}`.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 128),
        source_tool: 'xlooop',
        agent_id: 'xlooop:operator-action',
        project_id: projectId,
        status: 'completed',
        summary: `[folder connected] ${path}`.slice(0, 512),
        visibility: 'internal_workspace',
        occurred_at: new Date().toISOString(),
      });
    } catch (_) { /* best-effort operator-action mirror — never block the register */ }
    // R1 parity (2026-06-10 audit fix): the github bind route returns a propose-then-confirm
    // `suggested_context`; the folder register path dropped it even though inferSourceContext
    // already supports desktop_folder. Wire it so connect-a-folder also auto-links by context.
    const suggested_context = inferSourceContext({ source_kind: 'desktop_folder', source_ref: { path } });
    ctx.status(201);
    return ctx.json({ binding_id: bindingId, path, project_id: projectId, suggested_context });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

// POST /api/v1/folder-sources/sync — diff a posted snapshot vs the baseline + emit reflection_only
// events. Body { binding_id, workspace_id, project_id?, path?, files:[{path, checksum, size?}] }.
workspacesRoute.post('/folder-sources/sync', async (ctx) => {
  try {
    const { user_id } = ctx.get('auth');
    const { ownerUserId, ids } = operatorIds(ctx.env);
    if (!ownerUserId || !user_id || user_id !== ownerUserId) {
      ctx.status(403);
      return ctx.json({ error: 'folder sources are operator-only', code: 'FORBIDDEN', request_id: ctx.get('request_id') });
    }
    const body = await ctx.req.json().catch(() => null) as {
      binding_id?: string; workspace_id?: string; project_id?: string; path?: string; files?: unknown;
    } | null;
    const bindingId = typeof body?.binding_id === 'string' ? body.binding_id.trim() : '';
    const workspaceId = typeof body?.workspace_id === 'string' ? body.workspace_id.trim() : '';
    if (!bindingId || !workspaceId) {
      ctx.status(400);
      return ctx.json({ error: 'body.binding_id + body.workspace_id required', code: 'VALIDATION_ERROR', request_id: ctx.get('request_id') });
    }
    const files = normalizeFolderSnapshot(body?.files);
    if (files.length > 5000) {
      ctx.status(400);
      return ctx.json({ error: 'snapshot too large (max 5000 files)', code: 'VALIDATION_ERROR', request_id: ctx.get('request_id') });
    }
    const dal = ctx.get('dal');
    let owned = false;
    try {
      const wss = await dal.listWorkspacesForOperator(ids) as Array<{ id?: string }>;
      owned = Array.isArray(wss) && wss.some((w) => w && String(w.id) === workspaceId);
    } catch (_) { owned = false; }
    if (!owned) {
      ctx.status(403);
      return ctx.json({ error: 'workspace not owned by operator', code: 'FORBIDDEN', request_id: ctx.get('request_id') });
    }
    // Phase D (ADR-XLOOP-IA-001 / HR-SCOPE-INTEGRITY): the canonical project_id + path live on the binding
    // baseline (written at register time). The local sync CLI passes only --binding/--workspace/--path, so
    // derive project_id from the baseline — otherwise folder events would land workspace-scoped with no
    // project_id. Body values are a fallback only.
    let meta: { project_id: string | null; path: string | null } | null = null;
    try { meta = await dal.getFolderBindingMeta(bindingId); } catch (_) { meta = null; }
    const binding: FolderBinding = {
      binding_id: bindingId,
      workspace_id: workspaceId,
      project_id: (meta && meta.project_id) || (typeof body?.project_id === 'string' && body.project_id.trim() ? body.project_id.trim() : null),
      path: (meta && meta.path) || (typeof body?.path === 'string' ? body.path.trim() : null),
    };
    // Date.now() is available in the Worker runtime; stamp the sync time once for all emitted events.
    const nowIso = new Date(Date.now()).toISOString();
    const result = await syncFolderSnapshot(dal, binding, files, nowIso);
    return ctx.json(result);
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

// POST /api/v1/folder-sources/promote — ARCH-006 W6 folder→packet linker. The folder connector emits
// reflection-only ACTIVITY events; this OPERATOR-INITIATED action promotes one folder change into a
// governance PACKET (a needs-review work item) that surfaces on the project board + chat governance plane
// + the data-graph (a `packet` node), reusing the operations_unified governance mirror (no parallel model).
// Body { binding_id, workspace_id, change: { kind, path, checksum, size? } }. Best-effort + never 5xx.
workspacesRoute.post('/folder-sources/promote', async (ctx) => {
  try {
    const { user_id } = ctx.get('auth');
    const { ownerUserId, ids } = operatorIds(ctx.env);
    if (!ownerUserId || !user_id || user_id !== ownerUserId) {
      ctx.status(403);
      return ctx.json({ error: 'folder sources are operator-only', code: 'FORBIDDEN', request_id: ctx.get('request_id') });
    }
    const body = await ctx.req.json().catch(() => null) as {
      binding_id?: string; workspace_id?: string;
      change?: { kind?: string; path?: string; checksum?: string; size?: number };
    } | null;
    const bindingId = typeof body?.binding_id === 'string' ? body.binding_id.trim() : '';
    const workspaceId = typeof body?.workspace_id === 'string' ? body.workspace_id.trim() : '';
    const change = body?.change && typeof body.change === 'object' ? body.change : null;
    const kind = String(change?.kind || '') as FolderChangeKind;
    const path = typeof change?.path === 'string' ? change.path.trim() : '';
    if (!bindingId || !workspaceId) {
      ctx.status(400);
      return ctx.json({ error: 'body.binding_id + body.workspace_id required', code: 'VALIDATION_ERROR', request_id: ctx.get('request_id') });
    }
    if (!['added', 'modified', 'removed'].includes(kind) || !path) {
      ctx.status(400);
      return ctx.json({ error: 'body.change { kind: added|modified|removed, path } required', code: 'VALIDATION_ERROR', request_id: ctx.get('request_id') });
    }
    const dal = ctx.get('dal');
    let owned = false;
    try {
      const wss = await dal.listWorkspacesForOperator(ids) as Array<{ id?: string }>;
      owned = Array.isArray(wss) && wss.some((w) => w && String(w.id) === workspaceId);
    } catch (_) { owned = false; }
    if (!owned) {
      ctx.status(403);
      return ctx.json({ error: 'workspace not owned by operator', code: 'FORBIDDEN', request_id: ctx.get('request_id') });
    }
    // Derive the canonical project_id + path from the binding baseline (same as /sync) so the packet lands
    // under the focused project board, not workspace-scoped.
    let meta: { project_id: string | null; path: string | null } | null = null;
    try { meta = await dal.getFolderBindingMeta(bindingId); } catch (_) { meta = null; }
    const binding: FolderBinding = { binding_id: bindingId, workspace_id: workspaceId, project_id: meta?.project_id ?? null, path: meta?.path ?? null };
    const nowIso = new Date(Date.now()).toISOString();
    const row = folderChangeToPacketRow(binding, kind, { path, checksum: String(change?.checksum || ''), size: Number(change?.size) || 0 }, nowIso);

    // Write the governance packet (reuse the SSOT upsert) + best-effort mirror a needs_review event.
    let packet_written = 0;
    try { packet_written = await dal.materializeGovernanceSnapshot([row]); } catch (_) { packet_written = 0; }
    let event_recorded = false;
    try {
      await dal.upsertEvent(workspaceId, {
        id: `evt_folder_pkt_${String(row.row_id)}`.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 128),
        source_tool: 'folder',
        agent_id: 'xlooop:folder-promote',
        project_id: binding.project_id,
        status: 'needs_review',
        approval_state: 'pending',
        next_action: 'owner_sign_off',
        summary: String(row.title).slice(0, 512),
        evidence_link: path.slice(0, 400),
        visibility: 'internal_workspace',
        occurred_at: nowIso,
      });
      event_recorded = true;
    } catch (_) { /* best-effort activity mirror — never block the promote */ }
    ctx.status(201);
    return ctx.json({ packet: { row_id: row.row_id, status: 'needs_review', project_id: binding.project_id, title: row.title }, packet_written, event_recorded });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

// POST /api/v1/workspaces — operator creates a workspace they own.
workspacesRoute.post('/workspaces', async (ctx) => {
  try {
    const { user_id } = ctx.get('auth');
    const { ownerUserId } = operatorIds(ctx.env);
    if (!ownerUserId || !user_id || user_id !== ownerUserId) {
      ctx.status(403);
      return ctx.json({ error: 'workspace creation is operator-only', code: 'FORBIDDEN', request_id: ctx.get('request_id') });
    }
    const body = await ctx.req.json().catch(() => null) as Partial<WorkspaceCreateInput> | null;
    if (!body || typeof body.name !== 'string' || body.name.trim().length === 0 || body.name.length > 200) {
      ctx.status(400);
      return ctx.json({ error: 'body.name required (1-200 chars)', code: 'VALIDATION_ERROR', request_id: ctx.get('request_id') });
    }
    const dal = ctx.get('dal');
    const workspace = await dal.createWorkspace(
      { name: body.name.trim(), slug: typeof body.slug === 'string' ? body.slug : null, config: (body.config && typeof body.config === 'object') ? body.config : {} },
      user_id,
    );
    ctx.status(201);
    return ctx.json({ workspace });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

// POST /api/v1/workspaces/:id/projects — operator creates a project inside a
// workspace they own. This is the org-OPTIONAL operator create path (the strict
// org-scoped POST /projects stays unchanged for customers). TENANT GUARD: the
// operator must own :id, so a project can never be created in a customer space.
const VALID_PROJECT_STATUS = new Set<ProjectStatus>(['active', 'paused', 'completed', 'archived']);
workspacesRoute.post('/workspaces/:id/projects', async (ctx) => {
  try {
    const { user_id } = ctx.get('auth');
    const { ownerUserId, ids } = operatorIds(ctx.env);
    if (!ownerUserId || !user_id || user_id !== ownerUserId) {
      ctx.status(403);
      return ctx.json({ error: 'project creation here is operator-only', code: 'FORBIDDEN', request_id: ctx.get('request_id') });
    }
    const wsId = String(ctx.req.param('id') || '').trim();
    const body = await ctx.req.json().catch(() => null) as { name?: string; status?: string; description?: string; parent_project_id?: string | null } | null;
    if (!body || typeof body.name !== 'string' || body.name.trim().length === 0 || body.name.length > 200) {
      ctx.status(400);
      return ctx.json({ error: 'body.name required (1-200 chars)', code: 'VALIDATION_ERROR', request_id: ctx.get('request_id') });
    }
    const dal = ctx.get('dal');
    const owned = await dal.listWorkspacesForOperator(ids);
    if (!owned.some((w) => w.id === wsId)) {
      ctx.status(403);
      return ctx.json({ error: 'operator does not own that workspace', code: 'FORBIDDEN', request_id: ctx.get('request_id') });
    }
    const status = (body.status && VALID_PROJECT_STATUS.has(body.status as ProjectStatus)) ? body.status as ProjectStatus : 'active';
    const project = await dal.createProject({
      workspace_id: wsId,
      name: body.name.trim(),
      status,
      description: typeof body.description === 'string' ? body.description : undefined,
      parent_project_id: body.parent_project_id ?? null,
    }, user_id);
    ctx.status(201);
    return ctx.json({ project });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

// GET /api/v1/workspaces/:id/projects — R55-2 inc.3 · operator lists the projects
// in a workspace they own. Org-OPTIONAL operator overlay (same group as the POST
// sibling); reuses that sibling's exact tenant guard (must own :id) + the existing
// dal.listProjects (zero new DAL). This is the live read that makes the workspace
// view DB-authoritative for PROJECTS — the last static layer (window.WS_PROJECTS
// fixture) becomes a strictly-additive fallback. A project the operator creates
// now SURVIVES reload, and DB projects beyond the stale fixture become visible.
workspacesRoute.get('/workspaces/:id/projects', async (ctx) => {
  try {
    const auth = ctx.get('auth');
    const { user_id } = auth;
    const { ownerUserId, ids } = operatorIds(ctx.env);
    if (!ownerUserId || !user_id || user_id !== ownerUserId) {
      ctx.status(403);
      return ctx.json({ error: 'project listing here is operator-only', code: 'FORBIDDEN', request_id: ctx.get('request_id') });
    }
    const wsId = String(ctx.req.param('id') || '').trim();
    const dal = ctx.get('dal');
    const owned = await dal.listWorkspacesForOperator(ids);
    if (!owned.some((w) => w.id === wsId)) {
      ctx.status(403);
      return ctx.json({ error: 'operator does not own that workspace', code: 'FORBIDDEN', request_id: ctx.get('request_id') });
    }
    const projects = await dal.listProjects(wsId, { status: 'active' });
    // A-W2c · authority parity with the sibling projects.ts list (withAuthority was missed here).
    return ctx.json(withDataClass(withAuthority({ projects }, auth, 'project'), 'live'));
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

// PATCH /api/v1/workspaces/:id — R55-4 · operator edits a workspace they own:
// rename + origin (native/connected) + access_mode (read/read_write). Validated
// here; ownership enforced in the DAL (returns null → 403 if not owned). This is
// how the operator marks the one "native" workspace + sets read vs read-write.
const ALLOWED_ORIGIN = new Set(['native', 'connected']);
const ALLOWED_ACCESS = new Set(['read', 'read_write']);

// PROTECTED-DEFAULTS (operator 260531): system-default workspaces that can never be
// removed — the seeded mirrors of the operator's external sources (data/spaces.json).
// "Default workspaces created by the Xlooop system must not be deletable — same as MB-P."
// Protected by STABLE id, NOT by the mutable config.origin: a PATCH origin→'native' flip
// must not be able to defeat the DELETE guard (audit 260531: PATCH-then-DELETE bypass).
// Only cockpit-CREATED workspaces (minted ids, never in this set) are removable.
const PROTECTED_WORKSPACE_IDS = new Set([
  'me', 'mbp-private', 'xcp-platform', 'xlooop', 'x-biz', 'x-docs', 'x-front',
]);
workspacesRoute.patch('/workspaces/:id', async (ctx) => {
  try {
    const { user_id } = ctx.get('auth');
    const { ownerUserId, ids } = operatorIds(ctx.env);
    if (!ownerUserId || !user_id || user_id !== ownerUserId) {
      ctx.status(403);
      return ctx.json({ error: 'workspace settings are operator-only', code: 'FORBIDDEN', request_id: ctx.get('request_id') });
    }
    const wsId = String(ctx.req.param('id') || '').trim();
    const body = await ctx.req.json().catch(() => null) as { name?: string; origin?: string; access_mode?: string } | null;
    if (!body || typeof body !== 'object') {
      ctx.status(400);
      return ctx.json({ error: 'request body must be a JSON object', code: 'VALIDATION_ERROR', request_id: ctx.get('request_id') });
    }
    const config: Record<string, any> = {};
    if (typeof body.origin === 'string') {
      if (!ALLOWED_ORIGIN.has(body.origin)) { ctx.status(400); return ctx.json({ error: `invalid origin: ${body.origin}`, code: 'VALIDATION_ERROR', request_id: ctx.get('request_id') }); }
      // PROTECTED-DEFAULTS (audit 260531): a system-default workspace's origin is immutable.
      // Allowing origin→'native' here would defeat the DELETE protect guard (origin is the
      // guard signal). Name + access_mode edits on a protected workspace remain allowed.
      if (PROTECTED_WORKSPACE_IDS.has(wsId)) {
        ctx.status(403);
        return ctx.json({ error: 'origin of a system/default workspace cannot be changed', code: 'WORKSPACE_PROTECTED', request_id: ctx.get('request_id') });
      }
      config.origin = body.origin;
    }
    if (typeof body.access_mode === 'string') {
      if (!ALLOWED_ACCESS.has(body.access_mode)) { ctx.status(400); return ctx.json({ error: `invalid access_mode: ${body.access_mode}`, code: 'VALIDATION_ERROR', request_id: ctx.get('request_id') }); }
      config.access_mode = body.access_mode;
    }
    const name = (typeof body.name === 'string' && body.name.trim()) ? body.name.trim() : undefined;
    if (!name && Object.keys(config).length === 0) {
      ctx.status(400);
      return ctx.json({ error: 'nothing to update (provide name, origin, and/or access_mode)', code: 'VALIDATION_ERROR', request_id: ctx.get('request_id') });
    }
    const dal = ctx.get('dal');
    const workspace = await dal.updateWorkspace(wsId, { name, config }, ids);
    if (!workspace) {
      ctx.status(403);
      return ctx.json({ error: 'operator does not own that workspace', code: 'FORBIDDEN', request_id: ctx.get('request_id') });
    }
    return ctx.json({ workspace });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

// DELETE /api/v1/workspaces/:id — operator soft-archives a workspace they own.
// Soft-delete (REVERSIBLE): merges config.archived=true via the same jsonb-merge
// path as PATCH (other config keys preserved); listWorkspacesForOperator then
// excludes archived rows. Deliberately NOT a hard DELETE — workspace_members has
// ON DELETE CASCADE (destructive) and the HR-ARCHIVE ethos prefers reversible
// removal. Ownership enforced in the DAL: an unowned id matches 0 rows → null → 403.
workspacesRoute.delete('/workspaces/:id', async (ctx) => {
  try {
    const { user_id } = ctx.get('auth');
    const { ownerUserId, ids } = operatorIds(ctx.env);
    if (!ownerUserId || !user_id || user_id !== ownerUserId) {
      ctx.status(403);
      return ctx.json({ error: 'workspace removal is operator-only', code: 'FORBIDDEN', request_id: ctx.get('request_id') });
    }
    const wsId = String(ctx.req.param('id') || '').trim();
    if (!wsId) {
      ctx.status(400);
      return ctx.json({ error: 'workspace id required', code: 'VALIDATION_ERROR', request_id: ctx.get('request_id') });
    }
    const dal = ctx.get('dal');
    // PROTECTED-DEFAULTS (operator 260531): system/default workspaces are NOT
    // removable — "the same as MB-P". Only workspaces BORN in Xlooop
    // (config.origin === 'native') may be archived. Seeded/connected mirrors of
    // the operator's external sources (MB-P, XCP, Xlooop, x-*, APS) + the explicit
    // protected-id set are immutable here. Defense-in-depth: the UI also hides the
    // remove control for these, but the gate lives on the server.
    const owned = await dal.listWorkspacesForOperator(ids);
    const target = owned.find((w) => w.id === wsId);
    if (!target) {
      ctx.status(403);
      return ctx.json({ error: 'operator does not own that workspace', code: 'FORBIDDEN', request_id: ctx.get('request_id') });
    }
    const origin = String(target.config?.origin || '').trim();
    if (PROTECTED_WORKSPACE_IDS.has(wsId) || origin !== 'native') {
      ctx.status(403);
      return ctx.json({
        error: 'system/default workspaces cannot be removed; only workspaces created in Xlooop (origin: native) are removable',
        code: 'WORKSPACE_PROTECTED',
        request_id: ctx.get('request_id'),
      });
    }
    const workspace = await dal.updateWorkspace(wsId, { config: { archived: true, archived_at: new Date().toISOString() } }, ids);
    if (!workspace) {
      ctx.status(403);
      return ctx.json({ error: 'operator does not own that workspace', code: 'FORBIDDEN', request_id: ctx.get('request_id') });
    }
    // Recoverability doctrine (260706, ARCH-006 W1.2 pattern): mirror the archive onto the
    // customer-visible operation_events spine — destruction must never be silent to the customer.
    // Best-effort: never block the archive.
    try {
      await dal.upsertEvent(wsId, {
        id: `evt_workspace_archive_${wsId}`.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 128),
        source_tool: 'xlooop',
        agent_id: 'xlooop:operator-action',
        status: 'completed',
        summary: `[workspace archived] ${String(workspace.name || wsId)}`.slice(0, 512),
        body: 'Soft-archive (reversible): config.archived=true; restore by clearing config.archived via PATCH.',
        visibility: 'internal_workspace',
        occurred_at: new Date().toISOString(),
      });
    } catch (err) {
      console.warn('[workspaces] workspace-archive event mirror failed (best-effort)', { workspace_id: wsId, error: (err as Error)?.message });
    }
    return ctx.json({ ok: true, archived: true, workspace });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});
