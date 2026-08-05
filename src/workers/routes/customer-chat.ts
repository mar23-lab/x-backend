// customer-chat.ts · customer-safe AI chat (tenant-isolated).
//
// The operator cockpit chat (workspaces.ts POST /cockpit-chat) is operator-only — it 403s a customer
// and reads the OPERATOR's events. This is the CUSTOMER counterpart: a signed-in customer asks about
// THEIR OWN workspace and the AI chief-of-staff answers grounded in their events + their captured
// company context (S1), reusing the SAME answerCockpitChat service + the Workers-AI → Claude →
// deterministic ladder.
//
// Why this exists: before this route, the in-app customer chat panel (CockpitChatPanel.jsx) short-
// circuited to a hardcoded CLIENT-SIDE stub ("read-only validation / Available / Blocked") and NEVER
// reached the AI — so the S1 company-context wiring only ever fed the operator cockpit, never a
// customer. This closes that gap.
//
// TENANT-SAFE BY CONSTRUCTION: workspace_id comes ONLY from the verified Clerk JWT (auth.workspace_id),
// never from the request body; events are read workspace-scoped via dal.listEvents (the DAL tenant
// guard). A customer can only ever ask about their own workspace.

import { Hono } from 'hono';
import { errorEnvelope } from '../middleware/error';
import { emitEvent } from '../lib/observability'; // T3/P6
import { gateCustomerWorkspace } from '../lib/workspace-gates';
import { neonClient } from '../db/client'; // D-16 · workspace source-tier read
import { listWorkspaceSourceReadPoliciesRow } from '../dal/source-store'; // D-16
import { effectiveTier, tierRank, type SourceTier } from '../services/source-tier'; // D-16
import { createAssemblyTrace, attachAssembly, type AssemblyTrace } from '../services/chat-assembly-trace'; // L1 260710-D
import { recordLlmUsage } from '../dal/llm-usage-store'; // G2 260711
import { envFlagTrue } from '../lib/env-flag';
import { resolveScopedWorkspace } from '../lib/operator-workspace-scope'; // JA 260714 · operator-workspace-scope
import { idempotencyMiddleware } from '../lib/idempotency'; // J-W1/IDEM-4
import type { AuthEnv, AuthVariables } from '../middleware/auth';
import type { DalAdapter } from '../dal/DalAdapter';
import type { EventListOpts, EventPage, HarnessFlowEvent, UserSourceConnection } from '../dal/types';
import { type AiRunner } from '../services/agent-digest';
import { customerSafeChat, customerSafeSerializerEnabled } from '../lib/customer-safe-decision'; // AR-0.2 · customer-safe projection (P3 260714: default-SAFE)
import { persistAssistantContextLineage, completeAssistantSkillLineage, type AssistantContextLineage } from '../lib/assistant-context-lineage';
import { createModelExecutionObserver } from '../lib/model-execution-lineage';
import { parseContextReferences } from '../lib/context-reference';
import { resolveDocumentContext } from '../services/document-context';
import { recordChatGroundingReads } from '../dal/document-access-store';
import {
  answerCockpitChat,
  classifyRequestedProjectFacts,
  classifyRequestedWorkspaceInventoryFacts,
  isProjectInventoryQuestion,
  type ProjectPlanGrounding,
  type CockpitChatScope,
  type CockpitChatMode,
  type CockpitChatLLM,
  type ProjectGroundingFact,
  type ProjectSourceGroundingFact,
  type SourceGroundingFact,
} from '../services/cockpit-chat';

export interface CustomerChatEnv extends AuthEnv {
  DATABASE_URL: string;
  AI?: AiRunner;
  ANTHROPIC_API_KEY?: string;
  // D-16 · grounding-tier consumer. Default OFF → byte-identical (no access_tier, no reorder). When on,
  // each source's effective per-project read_policy tier weights its place in the grounding fact bundle.
  SOURCE_TIER_GROUNDING_ENABLED?: string;
  /** L1 (260710-D) · persist the context-assembly trace into grounded_on.assembly (default off = byte-identical). */
  CHAT_ASSEMBLY_TRACE_ENABLED?: string;
  // JA (260714) · operator-workspace-scope. Default-OFF (undeclared in wrangler.toml) ⇒ the chat is
  // scoped to auth.workspace_id ALWAYS (byte-identical; a body workspace_id is ignored). ON: an
  // owner/active-member operator may scope the chat to a workspace they own via body.workspace_id; an
  // unauthorized override is a hard 403 (never a silent read of the token org).
  OPERATOR_WORKSPACE_SCOPE_ENABLED?: string;
  /** Commercial pilot gate: synchronously persist role/skill + context + completion lineage for every LLM run. */
  CONTEXT_PACKET_PERSISTENCE_ENABLED?: string;
  /** Commercial pilot gate: never return a successful chat answer unless the exchange is durably recorded. */
  CHAT_HISTORY_PERSISTENCE_REQUIRED?: string;
  CHAT_RECEIPT_GROUNDING_ENABLED?: string;
  DOCUMENT_READ_AUDIT_ENABLED?: string;
  ROLE_SKILL_CATALOG_ENABLED?: string;
  RESOLUTION_RECEIPT_SIGNING_SECRET?: string;
  RESOLUTION_RECEIPT_SIGNING_KEY_ID?: string;
  XLOOOP_DEPLOY_SHA?: string;
}

export interface CustomerChatVariables extends AuthVariables {
  dal: DalAdapter;
  sql?: ReturnType<typeof neonClient>; // D-16 · injectable seam for the source-tier read (tests)
}

const ALLOWED_MODES: CockpitChatMode[] = ['ask', 'plan', 'recommend', 'deep-research'];
const MAX_EVENTS = 40;

export const customerChatRoute = new Hono<{ Bindings: CustomerChatEnv; Variables: CustomerChatVariables }>();

// J-W1/IDEM-4 (260711-I): a retried POST /customer-chat re-invokes the LLM + re-meters + appends a
// duplicate message row. Group idempotency makes a retry with an Idempotency-Key replay the first
// answer instead (flag-off ⇒ passthrough, byte-identical; streamed/non-JSON 2xx degrades to no-dedupe).
customerChatRoute.use('*', idempotencyMiddleware());

// Exported for the D-16 consumer unit test — the annotate+reorder logic is the new behavior and its
// natural unit boundary (access_tier isn't surfaced in the route response, only used for grounding weight).
export function buildSourceFacts(
  workspaceId: string,
  rows: UserSourceConnection[],
  events: HarnessFlowEvent[],
  tierByConnId?: Map<string, SourceTier>, // D-16 · absent ⇒ no tier weighting (byte-identical)
): SourceGroundingFact[] {
  // Commercial customer grounding requires an explicit workspace binding. Legacy user-account
  // source rows with workspace_id NULL are not tenant facts; admitting them here can leak one
  // user's unbound source truth into multiple workspaces for that user.
  const scopedRows = rows.filter((row) => row && row.workspace_id === workspaceId);
  const facts: SourceGroundingFact[] = scopedRows.map((row): SourceGroundingFact => {
    const provider = String(row.provider || '');
    const providerEvents = events.filter((event) => String(event?.source_tool || '') === provider);
    const latest = providerEvents
      .map((event) => String(event?.occurred_at || ''))
      .filter(Boolean)
      .sort((a, b) => Date.parse(b) - Date.parse(a))[0] || null;
    return {
      provider,
      status: String(row.status || 'unknown'),
      provider_username: row.provider_username ?? null,
      workspace_id: row.workspace_id ?? null,
      workspace_binding: 'workspace_bound',
      connected_at: row.connected_at ?? null,
      last_sync_at: row.last_sync_at ?? null,
      last_sync_error: row.last_sync_error ?? null,
      event_count: providerEvents.length,
      latest_event_at: latest,
      // T1/P3 (260710) · granted OAuth scopes — the answer can say "connected but missing gmail.readonly".
      scopes: Array.isArray(row.scopes) ? row.scopes.map(String) : undefined,
      // D-16 (260710) · effective per-project trust tier (undefined when the flag is off ⇒ byte-identical).
      access_tier: tierByConnId?.get(String(row.id || '')),
    };
  });
  // D-16 · when tiers are resolved, order rely/operate FIRST so the grounding bundle leads with the sources
  // the customer trusts most (a metadata-only weight signal — no content read). Stable within a tier.
  if (tierByConnId) {
    facts.sort((a, b) => tierRank((b.access_tier ?? 'index') as SourceTier) - tierRank((a.access_tier ?? 'index') as SourceTier));
  }
  return facts;
}

customerChatRoute.get('/customer-chat/history', async (ctx) => {
  try {
    const auth = ctx.get('auth');
    const gate = await gateCustomerWorkspace(ctx as never);
    if (!gate.ok) return gate.res;

    const requestedWorkspace = String(ctx.req.query('workspace_id') || '').trim() || null;
    const scoped = await resolveScopedWorkspace(
      ctx as never,
      ctx.env.OPERATOR_WORKSPACE_SCOPE_ENABLED,
      gate.ws,
      auth.user_id,
      requestedWorkspace,
      gate.dal,
    );
    if (!scoped.ok) return scoped.res;

    const requestedProjectId = String(ctx.req.query('project_id') || '').trim() || null;
    if (requestedProjectId) {
      const project = await gate.dal.getProject(scoped.ws, requestedProjectId);
      if (!project || project.status === 'archived') {
        return errorEnvelope(ctx, { status: 404, code: 'NOT_FOUND', message: 'project not found in this workspace' });
      }
    }

    const strict = envFlagTrue(ctx.env.CHAT_HISTORY_PERSISTENCE_REQUIRED);
    const lister = (gate.dal as unknown as {
      listChatHistory?: (userId: string, scope: CockpitChatScope, limit?: number) => Promise<unknown[]>;
    }).listChatHistory;
    if (typeof lister !== 'function') {
      if (strict) {
        emitEvent('chat_history_persistence_unavailable', { workspace_id: scoped.ws, required: true });
        ctx.status(503);
        return ctx.json({
          error: 'chat history persistence is required for this deployment',
          code: 'CHAT_HISTORY_PERSISTENCE_UNAVAILABLE',
          request_id: ctx.get('request_id'),
        });
      }
      return ctx.json({ messages: [], scope: { workspace_id: scoped.ws, project_id: requestedProjectId, domain_id: null } });
    }

    const scope: CockpitChatScope = { workspace_id: scoped.ws, project_id: requestedProjectId, domain_id: null };
    try {
      const messages = await lister.call(gate.dal, auth.user_id, scope, 100);
      return ctx.json({ messages: Array.isArray(messages) ? messages : [], scope });
    } catch (err) {
      emitEvent('chat_history_persistence_failed', {
        workspace_id: scoped.ws,
        required: strict,
        error: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
      });
      if (strict) {
        ctx.status(503);
        return ctx.json({
          error: 'chat history could not be loaded',
          code: 'CHAT_HISTORY_PERSISTENCE_FAILED',
          request_id: ctx.get('request_id'),
        });
      }
      return ctx.json({ messages: [], scope });
    }
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

async function messageIntentRef(message: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(message));
  return `sha256:${Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

customerChatRoute.post('/customer-chat', async (ctx) => {
  try {
    const auth = ctx.get('auth');
    // Provisioning gate — the shared lib/workspace-gates.ts driver (S3; byte-identical responses).
    // Only a real, provisioned workspace can chat; no governed overlay (any provisioned member may ask).
    const gate = await gateCustomerWorkspace(ctx as never);
    if (!gate.ok) return gate.res;
    const dal = gate.dal;

    const body = (await ctx.req.json().catch(() => null)) as {
      message?: string;
      mode?: string;
      llm?: string;
      workspace_id?: string;
      project_id?: string | null;
      interaction_id?: string;
      context_refs?: unknown;
    } | null;
    const message = typeof body?.message === 'string' ? body.message.trim() : '';
    if (!message || message.length > 1000) {
      ctx.status(400);
      return ctx.json({ error: 'body.message required (1-1000 chars)', code: 'VALIDATION_ERROR', request_id: ctx.get('request_id') });
    }

    // JA (260714) · resolve the effective read workspace. Flag OFF (default) ⇒ gate.ws (=auth.workspace_id)
    // unconditionally (byte-identical; body.workspace_id ignored). Flag ON ⇒ an owner/active-member operator
    // may scope the chat to a workspace they own via body.workspace_id; an unauthorized override is a hard 403.
    const scoped = await resolveScopedWorkspace(
      ctx as never,
      ctx.env.OPERATOR_WORKSPACE_SCOPE_ENABLED,
      gate.ws,
      auth.user_id,
      typeof body?.workspace_id === 'string' ? body.workspace_id : null,
      dal,
    );
    if (!scoped.ok) return scoped.res;
    const workspaceId = scoped.ws;
    const projectId = typeof body?.project_id === 'string' && body.project_id.trim()
      ? body.project_id.trim()
      : null;
    const interactionId = typeof body?.interaction_id === 'string' && body.interaction_id.trim()
      ? body.interaction_id.trim()
      : `ix_${crypto.randomUUID().replace(/-/g, '')}`;
    if (interactionId.length > 200) {
      ctx.status(400);
      return ctx.json({
        error: 'interaction_id must be at most 200 characters',
        code: 'VALIDATION_ERROR',
        request_id: ctx.get('request_id'),
      });
    }
    const contextRefs = parseContextReferences(body?.context_refs);
    if (contextRefs.some((ref) => ref.kind !== 'document')) {
      ctx.status(400);
      return ctx.json({
        error: 'customer chat currently supports document context references only',
        code: 'VALIDATION_ERROR',
        request_id: ctx.get('request_id'),
      });
    }
    const selectedProject = projectId ? await dal.getProject(workspaceId, projectId) : null;
    if (projectId && (!selectedProject || selectedProject.status === 'archived')) {
      return errorEnvelope(ctx, { status: 404, code: 'NOT_FOUND', message: 'project not found in this workspace' });
    }
    // 260805 · A SILENT ENUM COERCION IS INDISTINGUISHABLE FROM CORRECT OPERATION.
    // The frontend sent `mode: 'research'` for its Research-brief button. That value is not in
    // ALLOWED_MODES, so this line quietly rewrote it to 'ask' — no error, no log, and an answer that
    // still read plausibly. It survived because nothing ever said it was happening.
    //
    // The cost was not one button. cockpit-chat.ts reaches Claude only on an explicit `llm: 'claude'`
    // or `mode === 'deep-research'`, and the chat body carries no `llm` field, so deep-research was
    // the ONLY route to Claude from that UI — closed by a one-word mismatch nobody could see.
    //
    // Still coerced rather than rejected: a 400 here would break any client mid-flight, and the
    // answer is genuinely better than an error. But it now ANNOUNCES itself.
    const requestedMode = body?.mode;
    const mode: CockpitChatMode = ALLOWED_MODES.includes(requestedMode as CockpitChatMode) ? (requestedMode as CockpitChatMode) : 'ask';
    if (requestedMode !== undefined && requestedMode !== mode) {
      console.log(JSON.stringify({
        kind: 'cockpit_chat_unknown_mode_coerced',
        requested: String(requestedMode).slice(0, 40),
        served: mode,
        allowed: ALLOWED_MODES,
      }));
    }
    // User-selected model (the chat's model switcher). Default = free Llama; 'claude' uses the premium tier.
    const llm: CockpitChatLLM = body?.llm === 'claude' ? 'claude' : 'llama';
    const chatHistoryPersistenceRequired = envFlagTrue(ctx.env.CHAT_HISTORY_PERSISTENCE_REQUIRED);
    const appendChatExchange = (dal as unknown as {
      appendChatExchange?: (
        userId: string,
        scope: CockpitChatScope,
        messages: import('../dal/chat-store').ChatMessageInput[],
      ) => Promise<import('../dal/chat-store').ChatExchangeWriteResult>;
    }).appendChatExchange;
    if (chatHistoryPersistenceRequired && typeof appendChatExchange !== 'function') {
      emitEvent('chat_history_persistence_unavailable', { workspace_id: workspaceId, required: true });
      ctx.status(503);
      return ctx.json({
        error: 'chat history persistence is required for this deployment',
        code: 'CHAT_HISTORY_PERSISTENCE_UNAVAILABLE',
        request_id: ctx.get('request_id'),
      });
    }

    let projects: ProjectGroundingFact[] | undefined;
    if (isProjectInventoryQuestion(message)) {
      try {
        const rows = await dal.listProjects(workspaceId, { status: 'active' });
        projects = rows.map((project) => {
          const id = String(project.id ?? '').trim();
          const name = String(project.name ?? '').trim();
          if (!id || !name) throw new Error('invalid project inventory row');
          return {
            id,
            name,
            status: project.status,
            updated_at: project.updated_at,
          };
        });
      } catch {
        emitEvent('chat_project_inventory_failed', {
          workspace_id: workspaceId,
        });
        return errorEnvelope(ctx, {
          status: 503,
          code: 'SERVICE_UNAVAILABLE',
          message: 'the current project inventory could not be loaded',
        });
      }
    } else if (selectedProject) {
      projects = [{
        id: selectedProject.id,
        name: selectedProject.name,
        status: selectedProject.status,
        updated_at: selectedProject.updated_at,
      }];
    }

    let workspaceName: string | null = null;
    if (classifyRequestedWorkspaceInventoryFacts(message).includes('workspace_name')) {
      try {
        workspaceName = (await dal.getSession(auth.user_id, workspaceId)).workspace.name;
      } catch (err) {
        emitEvent('chat_workspace_identity_failed', {
          workspace_id: workspaceId,
          error: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
        });
      }
    }

    let plan: ProjectPlanGrounding | null = null;
    if (selectedProject) {
      try {
        const rows = await dal.plan.listPlanEntities(selectedProject.id, { workspaceId });
        plan = {
          project_id: selectedProject.id,
          project_name: selectedProject.name,
          project_status: selectedProject.status,
          project_updated_at: selectedProject.updated_at,
          entities: rows.flatMap((entity) => {
            if (!entity.kind || !['goal', 'milestone', 'todo', 'intent'].includes(entity.kind)) return [];
            return [{
              id: entity.id,
              kind: entity.kind,
              title: entity.title,
              status: entity.status,
              position: entity.position,
              target_date: entity.target_date,
              updated_at: entity.updated_at,
            }];
          }),
        };
      } catch (err) {
        emitEvent('chat_project_plan_failed', {
          workspace_id: workspaceId,
          project_id: selectedProject.id,
        });
        return errorEnvelope(ctx, {
          status: 503,
          code: 'SERVICE_UNAVAILABLE',
          message: 'the selected project plan could not be loaded',
          cause: err,
        });
      }
    }

    let projectSources: ProjectSourceGroundingFact[] | undefined;
    const requestedProjectFacts = selectedProject ? classifyRequestedProjectFacts(message) : [];
    if (selectedProject && requestedProjectFacts.includes('project_sources')) {
      try {
        const rows = await dal.listProjectSourceBindings(workspaceId, selectedProject.id);
        projectSources = rows.map((binding) => ({
          id: binding.id,
          source_kind: binding.source_kind,
          status: binding.status,
          read_policy: binding.read_policy,
        }));
      } catch (err) {
        emitEvent('chat_project_sources_failed', {
          workspace_id: workspaceId,
          project_id: selectedProject.id,
          error: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
        });
      }
    }

    const documentContext = await resolveDocumentContext({
      dal,
      workspace_id: workspaceId,
      project_id: projectId,
      user_id: auth.user_id,
      role: String(auth.role || ''),
      refs: contextRefs,
    });
    const documents = documentContext.facts;
    recordChatGroundingReads({
      enabled: envFlagTrue(ctx.env.DOCUMENT_READ_AUDIT_ENABLED),
      documents: documentContext.documents,
      makeSql: () => neonClient(ctx.env.DATABASE_URL),
      workspaceId,
      userId: auth.user_id,
      waitUntil: (promise) => {
        try {
          if (ctx.executionCtx?.waitUntil) ctx.executionCtx.waitUntil(promise);
          else void promise.catch(() => {});
        } catch {
          void promise.catch(() => {});
        }
      },
    });

    // TENANT-SAFE event read — workspace-scoped via the DAL guard (never operator-wide, never body-supplied).
    const opts: EventListOpts = { limit: MAX_EVENTS, role: auth.role, top_level: true, project_id: projectId ?? undefined };
    const page: EventPage = await dal
      .listEvents(workspaceId, opts)
      .catch((err) => {
        // FALSE-ZERO DISCLOSURE (260806). This catch substitutes an EMPTY event page for a FAILED
        // read, so the model is then grounded on "the record shows 0 events" and answers
        // confidently about an empty workspace. The substitution stays (chat must degrade, not
        // 500) — but it must SAY SO: silently, a DB blip and a genuinely empty workspace produce
        // byte-identical answers, which is the exact operator-reported symptom class.
        console.log(JSON.stringify({ kind: 'cockpit_chat_grounding_read_failed', surface: 'events_page', error: String((err as Error)?.message || err).slice(0, 200) }));
        return { events: [], pagination: { has_more: false, next_before: null } } as EventPage;
      });
    let events: HarnessFlowEvent[] = Array.isArray(page.events) ? page.events : [];

    // 260805 · Whole-workspace state counts, aggregated in SQL. `page` above is capped at MAX_EVENTS
    // by recency, so its length is what we LOOKED AT, never what EXISTS. Same primitive the
    // /current-work fix uses (dal/event-store.ts countEventStatesRow) — reuse, not new machinery.
    //
    // Fallback is `events.length`, deliberately NOT 0: cockpit-chat.ts:1032 flips to the empty-state
    // narrative when events_total === 0 and drops source facts, so a failed aggregate read must
    // never claim less than the page we already hold.
    const chatTotals = await dal
      .countEventStates(workspaceId, { role: auth.role, project_id: projectId ?? null })
      .catch((err) => {
        // FALSE-ZERO DISCLOSURE (260806): fabricated zero counts enter the chat's structured fact
        // block on a failed aggregate. The events.length floor stays (see comment above); the log
        // is what distinguishes "counted zero" from "could not count".
        console.log(JSON.stringify({ kind: 'cockpit_chat_grounding_read_failed', surface: 'state_counts', error: String((err as Error)?.message || err).slice(0, 200) }));
        return { needs_you: 0, blocked: 0, done: 0, total: events.length };
      });

    const sourceRows = await dal.listUserSources(auth.user_id).catch((err) => {
      // FALSE-ZERO DISCLOSURE (260806): a failed source-list read otherwise makes the prompt
      // assert the customer has NO connected sources — a false statement served as grounding.
      console.log(JSON.stringify({ kind: 'cockpit_chat_grounding_read_failed', surface: 'sources', error: String((err as Error)?.message || err).slice(0, 200) }));
      return [] as UserSourceConnection[];
    });
    // D-16 (260710) · resolve each source's effective per-project trust tier, flag-gated (OFF = byte-
    // identical: no map → no access_tier, no reorder). 'rely' leans on a source's METADATA more; NO content
    // read (reflection_only preserved). Fail-safe: any read error → no tiers, grounding unchanged.
    let tierByConnId: Map<string, SourceTier> | undefined;
    if (envFlagTrue(ctx.env.SOURCE_TIER_GROUNDING_ENABLED)) {
      try {
        const sql = ctx.get('sql') ?? neonClient(ctx.env.DATABASE_URL);
        const policies = await listWorkspaceSourceReadPoliciesRow(sql, workspaceId);
        const byConn = new Map<string, string[]>();
        for (const p of policies) {
          if (!p.user_source_connection_id) continue;
          (byConn.get(p.user_source_connection_id) ?? byConn.set(p.user_source_connection_id, []).get(p.user_source_connection_id)!).push(p.read_policy);
        }
        tierByConnId = new Map([...byConn].map(([id, pols]) => [id, effectiveTier(pols)]));
      } catch (_) { tierByConnId = undefined; }
    }
    let sources = buildSourceFacts(workspaceId, sourceRows, events, tierByConnId);
    let redactionProfile = auth.role === 'client' ? 'client-empty' : auth.role === 'viewer' ? 'viewer-limited' : 'operator-full';
    let clientEmpty = auth.role === 'client';

    // L1 (260710-D) · durable context-assembly trace, flag-gated (OFF ⇒ trace null ⇒ grounded_on is
    // persisted unchanged BY REFERENCE — byte-identical). Records ids/counts/enums only; each record*
    // is never-throw and console emitEvent emissions below are KEPT (log plane unchanged).
    const trace: AssemblyTrace | null =
      envFlagTrue(ctx.env.CHAT_ASSEMBLY_TRACE_ENABLED) ? createAssemblyTrace('customer') : null;

    // G9 (260709) · §168 role-scoped context, flag-gated (OFF = byte-identical). The DAL read above is
    // already role-filtered; the PURE assembler re-projects as defense-in-depth AND applies the D-7 client
    // rule (an external client gets NO grounded spine — contribution-only) + the audit line that makes
    // every include/exclude decision traceable per answer. T1/P3 (260710): SOURCES now ride the same
    // projection (ops-internal class → owner/operator ground on them; viewer/client don't).
    if (envFlagTrue((ctx.env as { CHAT_ROLE_SCOPED_CONTEXT_ENABLED?: string }).CHAT_ROLE_SCOPED_CONTEXT_ENABLED)) {
      try {
        const { assembleRoleScopedContext } = await import('../services/role-scoped-context');
        const rsc = assembleRoleScopedContext({ role: String(auth.role || ''), user_id: auth.user_id }, { events, sources });
        events = rsc.admissibleFacts.events as HarnessFlowEvent[];
        sources = rsc.visibleSources;
        redactionProfile = `${rsc.auditLine.role}-${rsc.redactionProfile.expose}`;
        clientEmpty = rsc.redactionProfile.expose === 'none';
        trace?.recordRoleProjection(rsc.auditLine);
        console.log(JSON.stringify({ kind: 'role_scoped_context', plane: 'customer', workspace_id: workspaceId, ...rsc.auditLine }));
      } catch (_) { /* projection is fail-safe: legacy facts stand; the flag can be pulled */ }
    }

    // T1/P3 (260710) · MECHANICAL source-truth override, flag-gated (OFF = byte-identical): a queued system
    // setup reminder ("Connect Gmail") is demoted OUT of the grounding set once that provider is actually
    // CONNECTED — connectedness supersedes the reminder, so the model can't tell a connected customer to
    // connect. Pure module (services/source-truth-override.ts); every demotion is logged for the audit trail.
    if (envFlagTrue((ctx.env as { CHAT_SOURCE_TRUTH_OVERRIDE_ENABLED?: string }).CHAT_SOURCE_TRUTH_OVERRIDE_ENABLED)) {
      try {
        const { demoteSupersededSetupEvents } = await import('../services/source-truth-override');
        const override = demoteSupersededSetupEvents(events, sources);
        trace?.recordOverrideDemotions(override.audit);
        if (override.audit.demoted_count > 0) {
          events = override.events;
          console.log(JSON.stringify({ kind: 'source_truth_override', workspace_id: workspaceId, ...override.audit }));
        }
      } catch (_) { /* override is fail-safe: unmodified facts stand */ }
    }

    // S1 · the customer's captured company context → the chief-of-staff is company-aware, not generic.
    // FALSE-ZERO DISCLOSURE (260806) on the three grounding planes below: a failed read degrades
    // to null — swapping the company-aware preamble for the generic stereotype, dropping the
    // charter plane, or serving the unpersonalized answer — with no way to tell that from "the
    // customer never configured it". The degrade stays; the log names which plane was lost.
    const disclose = (surface: string) => (err: unknown) => {
      console.log(JSON.stringify({ kind: 'cockpit_chat_grounding_read_failed', surface, error: String((err as Error)?.message || err).slice(0, 200) }));
      return null;
    };
    const companyContext = await dal.getCustomerContextProfile(workspaceId).catch(disclose('company_profile'));

    // PR-4 (260721) · the workspace CHARTER (mission/background/goals) → the info->plan->context join.
    // Flag-gated (CHARTER_GROUNDING_ENABLED, born-OFF ⇒ null ⇒ answerCockpitChat prompt byte-identical).
    // Degrade-safe: any read error → null → grounding unchanged. Seeded by PR-3, read here.
    const charter = envFlagTrue((ctx.env as { CHARTER_GROUNDING_ENABLED?: string }).CHARTER_GROUNDING_ENABLED)
      ? await dal.getCharter(workspaceId).catch(disclose('charter'))
      : null;

    // Y-wave APPLY (ADR-XB-012) · the effective personalization PROFILE (learned prefs/rules/skills,
    // forbidden-keys stripped by the resolver) → the APPLY stage. Flag-gated (PERSONALIZATION_APPLY_ENABLED,
    // born-OFF ⇒ null ⇒ answerCockpitChat prompt byte-identical). Degrade-safe: any read error → null.
    // Inert until the materialize stage writes profiles (they are empty today).
    const personalizationProfile = envFlagTrue((ctx.env as { PERSONALIZATION_APPLY_ENABLED?: string }).PERSONALIZATION_APPLY_ENABLED)
      ? await dal.getEffectivePersonalizationProfile(workspaceId, auth.user_id, String(auth.role || 'member')).catch(disclose('personalization_profile'))
      : null;

    const scope: CockpitChatScope = { workspace_id: workspaceId, project_id: projectId, domain_id: null };
    const ai = ctx.env.AI;
    const claudeKey = ctx.env.ANTHROPIC_API_KEY;

    // Commercial lineage gate: when explicitly enabled, no LLM call begins until its role/skill
    // resolution and customer-safe context packet are durable. Raw prompt text is never stored.
    let assistantLineage: AssistantContextLineage | null = null;
    let lineageSql: ReturnType<typeof neonClient> | null = null;
    if (envFlagTrue(ctx.env.CONTEXT_PACKET_PERSISTENCE_ENABLED)) {
      lineageSql = ctx.get('sql') ?? neonClient(ctx.env.DATABASE_URL);
      assistantLineage = await persistAssistantContextLineage(lineageSql, ctx.env, {
        workspace_id: workspaceId,
        principal_id: auth.user_id,
        role: String(auth.role || 'client'),
        mode,
        intent_ref: await messageIntentRef(message),
        scope: {
          // Deliberately the PAGE length: this records what the answer actually looked at.
          // The whole-workspace figure is `chatTotals.total`, passed to buildContext below.
          event_count: events.length,
          document_count: documents.length,
          unpromoted_document_count: documentContext.unpromoted_count,
          source_count: sources.length,
        },
        redaction_profile: redactionProfile,
        client_empty: clientEmpty,
      });
      emitEvent('context_packet_persisted', {
        workspace_id: workspaceId,
        context_packet_id: assistantLineage.context_packet_id,
        action: assistantLineage.action,
        skill_count: assistantLineage.resolution.selected_skills.length,
      });
    }

    // L1 · tier weights recorded from the FINAL grounding set (AFTER the role-scoped projection may have
    // emptied a viewer's sources) — the trace must reflect what actually grounded, never the pre-projection set.
    if (tierByConnId) trace?.recordTierWeights(sources);
    const executionObserver = assistantLineage && lineageSql
      ? createModelExecutionObserver(lineageSql, workspaceId, auth.user_id, assistantLineage)
      : undefined;
    const result = await answerCockpitChat(
      message,
      // 260805 · `total` is the WHOLE-WORKSPACE count from a SQL aggregate, not `events.length`.
      // `events` is a 40-row RECENCY page (MAX_EVENTS), and cockpit-chat.ts documents this field as
      // "Total Plane-A count for the scope (may exceed events.length when capped)" — passing the
      // page length made that promise false on every call, so the honesty hedge at
      // cockpit-chat.ts:1059 ("I looked at the N most recent") was structurally dead: it compares
      // events_considered against events_total, and both were the same number. Chat could state
      // "1 item needs your sign-off" for a workspace holding eleven, and never disclose the cap.
      //
      // THE FALLBACK IS THE PAGE LENGTH, NEVER 0. cockpit-chat.ts:1032 switches to the empty-state
      // narrative when events_total === 0, which drops source facts entirely. A degraded aggregate
      // read must not under-report below what we can already see.
      { workspaceName, companyContext, events, documents, projects, plan, projectSources, sources, total: chatTotals.total, scope, charter, personalizationProfile },
      ai,
      mode,
      claudeKey,
      llm,
      executionObserver,
    );
    if (assistantLineage && lineageSql) {
      const receipts = await completeAssistantSkillLineage(lineageSql, ctx.env, assistantLineage, {
        workspace_id: workspaceId,
        principal_id: auth.user_id,
      });
      emitEvent('skill_invocation_completed', {
        workspace_id: workspaceId,
        action: assistantLineage.action,
        receipt_count: receipts.length,
      });
    }
    // G2 (260711) · per-tenant LLM metering, flag-gated default-off (LLM_USAGE_METERING_ENABLED).
    // Fire-and-forget; deterministic answers (model null) never record; failure never touches the answer.
    recordLlmUsage({
      enabled: envFlagTrue((ctx.env as { LLM_USAGE_METERING_ENABLED?: string }).LLM_USAGE_METERING_ENABLED),
      makeSql: () => neonClient(ctx.env.DATABASE_URL),
      workspaceId, userId: auth.user_id, model: result.model,
      tokensIn: result.usage?.tokens_in, tokensOut: result.usage?.tokens_out,
      waitUntil: (p) => {
        try { ctx.executionCtx?.waitUntil ? ctx.executionCtx.waitUntil(p) : void p.catch(() => {}); }
        catch { void p.catch(() => {}); } // test/non-workers runtimes have no executionCtx — fire anyway
      },
    });
    if (result.model && envFlagTrue((ctx.env as { LLM_USAGE_METERING_ENABLED?: string }).LLM_USAGE_METERING_ENABLED)) {
      emitEvent('llm_usage', { workspace_id: workspaceId, model: result.model, tokens_in: result.usage?.tokens_in ?? null, tokens_out: result.usage?.tokens_out ?? null });
    }
    // T3/P6 · the fact-bundle assembly metric (customer plane): size + provenance of what grounded this answer.
    emitEvent('chat_fact_bundle', {
      workspace_id: workspaceId, events: events.length, documents: documents.length,
      projects_total: projects?.length ?? null, sources_total: sources.length,
      sources_connected: sources.filter((s) => s.status === 'connected').length,
      generated_by: result.generated_by,
    });
    trace?.recordBundle({
      events: events.length, sources_total: sources.length,
      sources_connected: sources.filter((s) => s.status === 'connected').length,
      generated_by: result.generated_by,
    });

    // W1 (260708) · FOUND GAP: customer chat never persisted exchanges (only the operator cockpit did), so
    // customers had no thread history and receipts (G4) were impossible. Legacy/default deployments still
    // tolerate a persistence failure, but commercial pilot-shadow sets CHAT_HISTORY_PERSISTENCE_REQUIRED
    // so the route fails closed instead of returning a successful answer with no durable thread.
    // Receipt links ride the assistant message only when CHAT_RECEIPT_GROUNDING_ENABLED.
    let conversation: {
      thread_id: string;
      user_message_id: string;
      assistant_message_id: string;
    } | null = null;
    try {
      if (typeof appendChatExchange === 'function') {
        const receiptLinks = envFlagTrue(ctx.env.CHAT_RECEIPT_GROUNDING_ENABLED)
          ? ((result.grounded_on as { event_ids?: string[] })?.event_ids ?? null)
          : null;
        const persisted = await appendChatExchange.call(dal, auth.user_id, scope, [
          { role: 'you', body: message, mode, interaction_id: interactionId, entry_type: 'user_request' },
          // L1 · attachAssembly(g, null) returns g unchanged by reference — flag-off stays byte-identical.
          {
            role: 'assistant',
            body: result.answer,
            mode,
            generated_by: result.generated_by,
            grounded_on: attachAssembly(result.grounded_on, trace),
            grounding_event_ids: receiptLinks,
            interaction_id: interactionId,
            entry_type: 'assistant_answer',
          },
        ]);
        const messages = Array.isArray(persisted?.messages) ? persisted.messages : [];
        const userMessage = messages.find((entry) =>
          entry.entry_type === 'user_request' || entry.role === 'you');
        const assistantMessage = messages.find((entry) =>
          entry.entry_type === 'assistant_answer' || entry.role === 'assistant');
        if (!persisted?.thread_id || !userMessage?.id || !assistantMessage?.id) {
          throw new Error('chat persistence did not return canonical conversation ids');
        }
        conversation = {
          thread_id: persisted.thread_id,
          user_message_id: userMessage.id,
          assistant_message_id: assistantMessage.id,
        };
      } else if (chatHistoryPersistenceRequired) {
        throw new Error('appendChatExchange unavailable');
      }
    } catch (err) {
      emitEvent('chat_history_persistence_failed', {
        workspace_id: workspaceId,
        required: chatHistoryPersistenceRequired,
        error: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
      });
      if (chatHistoryPersistenceRequired) {
        ctx.status(503);
        return ctx.json({
          error: 'chat answer could not be durably recorded',
          code: 'CHAT_HISTORY_PERSISTENCE_FAILED',
          request_id: ctx.get('request_id'),
        });
      }
    }

    // AR-0.2 · customer-safe projection (flag-gated). OFF (default) = payload unchanged (byte-identical);
    // ON collapses the engine name, drops the internal model id, reduces grounded_on to an evidence count.
    return ctx.json(customerSafeChat({
      interaction_id: interactionId,
      scope,
      answer: result.answer,
      generated_by: result.generated_by,
      model: result.model,
      grounded_on: result.grounded_on,
      mode,
      llm_requested: llm,
      claude_available: !!claudeKey, // so the UI can show/enable the Claude option
      requested_facts: result.grounded_on.requested_facts,
      grounding: {
        evidence_count: result.grounded_on.event_ids?.length ?? 0,
        project_plan_fact_count: result.grounded_on.plan.entities.length,
        project_source_fact_count: result.grounded_on.project_sources.total,
        document_count: result.grounded_on.documents.total,
        freshness: result.grounded_on.plan.updated_at
          ?? result.grounded_on.projects.updated_at
          ?? result.grounded_on.data_freshness.newest_event_at,
      },
      lineage: assistantLineage ? {
        context_receipt_id: assistantLineage.context_packet_id,
        role_skill_resolution_id: assistantLineage.resolution_id,
      } : null,
      conversation,
    }, customerSafeSerializerEnabled((ctx.env as { CUSTOMER_SAFE_SERIALIZER_ENABLED?: string }).CUSTOMER_SAFE_SERIALIZER_ENABLED))); // P3 (260714): DEFAULT-SAFE — a missing/malformed flag serializes; only an explicit 'false' (internal testing) yields raw. Was envFlagTrue = fail-open when the wrangler var vanished.
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});
