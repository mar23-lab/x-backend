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
import {
  answerCockpitChat,
  type CockpitChatScope,
  type CockpitChatMode,
  type CockpitChatLLM,
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
  const scopedRows = rows.filter((row) => row && (row.workspace_id === workspaceId || row.workspace_id === null));
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
      workspace_binding: row.workspace_id === workspaceId ? 'workspace_bound' : 'legacy_user_account_unbound',
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

    const body = (await ctx.req.json().catch(() => null)) as { message?: string; mode?: string; llm?: string; workspace_id?: string } | null;
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
    const mode: CockpitChatMode = ALLOWED_MODES.includes(body?.mode as CockpitChatMode) ? (body!.mode as CockpitChatMode) : 'ask';
    // User-selected model (the chat's model switcher). Default = free Llama; 'claude' uses the premium tier.
    const llm: CockpitChatLLM = body?.llm === 'claude' ? 'claude' : 'llama';

    // TENANT-SAFE event read — workspace-scoped via the DAL guard (never operator-wide, never body-supplied).
    const opts: EventListOpts = { limit: MAX_EVENTS, role: auth.role, top_level: true };
    const page: EventPage = await dal
      .listEvents(workspaceId, opts)
      .catch(() => ({ events: [], pagination: { has_more: false, next_before: null } } as EventPage));
    let events: HarnessFlowEvent[] = Array.isArray(page.events) ? page.events : [];

    const sourceRows = await dal.listUserSources(auth.user_id).catch(() => [] as UserSourceConnection[]);
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
    const companyContext = await dal.getCustomerContextProfile(workspaceId).catch(() => null);

    const scope: CockpitChatScope = { workspace_id: workspaceId, project_id: null, domain_id: null };
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
        scope: { event_count: events.length, document_count: 0, unpromoted_document_count: 0, source_count: sources.length },
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
      { companyContext, events, sources, total: events.length, scope },
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
      workspace_id: workspaceId, events: events.length, sources_total: sources.length,
      sources_connected: sources.filter((s) => s.status === 'connected').length,
      generated_by: result.generated_by,
    });
    trace?.recordBundle({
      events: events.length, sources_total: sources.length,
      sources_connected: sources.filter((s) => s.status === 'connected').length,
      generated_by: result.generated_by,
    });

    // W1 (260708) · FOUND GAP: customer chat never persisted exchanges (only the operator cockpit did), so
    // customers had no thread history and receipts (G4) were impossible. Persist best-effort — reusing
    // appendChatExchange verbatim; a persistence failure never breaks the live answer. Receipt links ride
    // the assistant message only when CHAT_RECEIPT_GROUNDING_ENABLED (chat-store degrades safely pre-058).
    try {
      const appender = (dal as unknown as { appendChatExchange?: (u: string, s: unknown, m: unknown[]) => Promise<void> }).appendChatExchange;
      if (typeof appender === 'function') {
        const receiptLinks = envFlagTrue((ctx.env as { CHAT_RECEIPT_GROUNDING_ENABLED?: string }).CHAT_RECEIPT_GROUNDING_ENABLED)
          ? ((result.grounded_on as { event_ids?: string[] })?.event_ids ?? null)
          : null;
        await appender.call(dal, auth.user_id, { workspace_id: workspaceId }, [
          { role: 'you', body: message, mode },
          // L1 · attachAssembly(g, null) returns g unchanged by reference — flag-off stays byte-identical.
          { role: 'assistant', body: result.answer, mode, generated_by: result.generated_by, grounded_on: attachAssembly(result.grounded_on, trace), grounding_event_ids: receiptLinks },
        ]);
      }
    } catch (_) { /* best-effort — the answer already stands */ }

    // AR-0.2 · customer-safe projection (flag-gated). OFF (default) = payload unchanged (byte-identical);
    // ON collapses the engine name, drops the internal model id, reduces grounded_on to an evidence count.
    return ctx.json(customerSafeChat({
      answer: result.answer,
      generated_by: result.generated_by,
      model: result.model,
      grounded_on: result.grounded_on,
      mode,
      llm_requested: llm,
      claude_available: !!claudeKey, // so the UI can show/enable the Claude option
    }, customerSafeSerializerEnabled((ctx.env as { CUSTOMER_SAFE_SERIALIZER_ENABLED?: string }).CUSTOMER_SAFE_SERIALIZER_ENABLED))); // P3 (260714): DEFAULT-SAFE — a missing/malformed flag serializes; only an explicit 'false' (internal testing) yields raw. Was envFlagTrue = fail-open when the wrangler var vanished.
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});
