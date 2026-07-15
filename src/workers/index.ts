// index.ts · Xlooop API Worker entry point (Hono on Cloudflare Workers)
//
// Authority: API_CONTRACT_V1.md · BACKEND_ADR_001.md · AUTH_TENANCY_MODEL.md
//
// Routes mounted at /api/v1/*:
//   GET    /api/v1/health        (no auth)
//   GET    /api/v1/session       (auth)
//   GET    /api/v1/events        (auth)
//   POST   /api/v1/events        (auth · operator/owner only)
//   GET    /api/v1/projects      (auth · non-client only)
//   GET    /api/v1/board-cards   (auth · non-client only)
//   POST   /api/v1/sign-offs     (auth · operator/owner only)
//   GET/POST /api/v1/packets     (auth · workspace scoped)
//   GET/POST /api/v1/evidence    (auth · workspace scoped)
//   GET/POST /api/v1/approvals   (auth · workspace scoped)
//   GET/POST /api/v1/tool-events (auth · workspace scoped)
//   GET/POST /api/v1/metric-deltas (auth · workspace scoped)
//   GET/POST /api/v1/mcp/*      (auth · safe scoped packet/evidence gateway)
//   GET    /api/v1/whoami       (auth · redacted identity binding)
//   GET/POST /api/v1/template-policy/* (auth · effective template projection)
//
// All non-2xx responses return the standard ApiError envelope:
//   { error, code, request_id }

import { Hono } from 'hono';
import { corsMiddleware, type CorsEnv } from './middleware/cors';
import { securityHeaders } from './middleware/security-headers';
import { requestGuards } from './middleware/request-guards';
import { clerkAuth, type AuthEnv, type AuthVariables } from './middleware/auth';
import { errorEnvelope } from './middleware/error';
import * as Sentry from '@sentry/cloudflare';
import { sentryFlush, sentryOptions, captureException, captureMessage, type SentryEnv } from './sentry';
import { decideCronReport } from './lib/cron-observability';
import { neonClient } from './db/client';
import { WorkersDalAdapter } from './dal/WorkersDalAdapter';
import type { DalAdapter } from './dal/DalAdapter';
import { listGoalsWithReviewDueRow, updateGoalReviewDueRow } from './dal/propagation-store';
import { healthRoute } from './routes/health';
import { sessionRoute } from './routes/session';
import { eventsRoute } from './routes/events';
import { sourcesRoute } from './routes/sources';   // R50.3b · Clerk OAuth source connectors
import { documentsRoute } from './routes/documents'; // Stage 2 source-intake · POST/GET /documents (tenant-scoped upload)
import { customerRoute } from './routes/customer'; // R55 · customer authority/consent (IP-boundary unlock)
import { layoutRoute } from './routes/layout';     // R52-B1 · operator layout overlay (pillar 3)
import { profileRoute } from './routes/profile';   // Stage 2 · GET /api/v1/me (user identity + DB account attrs)
import { membersRoute } from './routes/members';    // Stage 3 · GET /api/v1/members (real workspace members from DB)
import { planRoute } from './routes/plan';          // G1 · /api/v1/plan/* (customer plan_entities facade; PLAN_ENTITIES_ENABLED default OFF)
import { sessionModeRoute } from './routes/session-mode'; // Wave B · PATCH /session/mode (canonical operating mode, audited)
import { modelRuntimesRoute } from './routes/model-runtimes'; // Wave C · /model-runtimes/* (encrypted-at-rest provider config)
import { readinessRoute } from './routes/readiness'; // M.7 · POST /api/v1/readiness/submit (in-app onboarding journey → scaled provision)
import { projectsRoute } from './routes/projects';
import { syntheticDomainsRoute } from './routes/synthetic-domains';
import { graphRoute } from './routes/graph';                       // ADR-XLOOP-ARCH-003 P2 · operator-gated data-graph rebuild/lineage/drift/digest
import { boardCardsRoute } from './routes/board-cards';
import { signOffsRoute } from './routes/sign-offs';
import { operationalSpineRoute } from './routes/operational-spine';
import { actionIntentShadowRoute } from './routes/action-intent-shadow';
import { mcpGatewayRoute } from './routes/mcp-gateway';
import { createMcpRpcRoute } from './routes/mcp-rpc';
import { developerAccessRoute } from './routes/developer-access';
import { customerWorkspaceFeedRoute } from './routes/customer-workspace-feed';
import { currentWorkRoute } from './routes/current-work'; // Wave I · customer-safe Current Work read-projection (CURRENT_WORK_PROJECTION_ENABLED default OFF)
import { customerChatRoute } from './routes/customer-chat'; // Customer-safe AI chat (tenant-isolated, company-aware)
import { intakeRoute } from './routes/intake'; // Default-off canonical resolve -> preview -> execute intake
import { customerLineageRoute } from './routes/customer-lineage'; // W3 · customer's own lineage/graph read (tenant-safe)
import { chatReceiptRoute } from './routes/chat-receipt'; // W2 · per-answer audit receipt (tenant-safe, redacted)
import { customerAuditLogRoute } from './routes/customer-audit-log'; // W2 · customer-scoped audit export (redacted)
import { llmUsageRoute } from './routes/llm-usage'; // G2 · per-tenant LLM usage read (metering surface)
import { workspaceUpgradeRoute } from './routes/workspace-upgrade'; // U4a · POST /workspace/upgrade-request (audited + notify, no billing)
import { feedbackRoute } from './routes/feedback'; // T6 · Test-mode feedback channel (flag-gated persistence)
import { templatePolicyRegistryRoute } from './routes/template-policy-registry';
import { inferenceHealthRoute } from './telemetry';   // R51-ζ-3 · 6-panel inference health
import { requestAccessRoute } from './routes/request-access';
import { rateLimit, rateLimitWhenFlag } from './middleware/rate-limit';
import { diagnoseRoute } from './routes/diagnose';
import { adminRoute } from './routes/admin';
// Wave R-I.7 Stage C · investor portal (DR-11/12/13/14)
import {
  investorPublicRoute,
  investorAuthedRoute,
  investorAdminRoute,
  type InvestorEnv,
} from './routes/investor';
import { mbpProjectionRoute, type MbpProjectionEnv } from './routes/mbp-projection';
import { githubWebhookRoute } from './routes/github-webhook';
import { activityWebhookRoute } from './routes/activity-webhook';   // R54-S3-A · operator/agent activity producer
import { workspacesRoute } from './routes/workspaces';             // R54-S3-C · operator create/list workspaces
import { pmfRoute } from './routes/pmf';                            // Wave 2 · PMF (Sean Ellis) must-have metric
import { requireAdmin, type AdminEnv } from './middleware/admin';
import type { NotifierEnv } from './services/email-notifier';

// Note: InvestorEnv not extended here — CLERK_SECRET_KEY is already provided
// by AuthEnv (required string) which is compatible. InvestorEnv adds only
// CLERK_INVITATIONS_ENABLED which is included below.
export interface AppEnv extends CorsEnv, AuthEnv, AdminEnv, NotifierEnv, MbpProjectionEnv, SentryEnv {
  DATABASE_URL: string;
  // RLS defense-in-depth (Plane 1 cutover, 260629): the restricted, RLS-subject app-role connection
  // (Neon role `xlooop_app`). When set, the spine DAL routes tenant-scoped ops through it so DB-level
  // RLS is a second layer under the app WHERE clauses. Absent → falls back to DATABASE_URL (no change).
  XLOOOP_RLS_APP_DATABASE_URL?: string;
  CLERK_INVITATIONS_ENABLED?: string;   // Wave R-I.7 Stage C · magic-link invitations gate
  CONTEXT_RESOLVER_ENABLED?: string;    // ctx_v1 day-1 resolver gate — default OFF (only 'true' enables)
  RECLASSIFY_CRON_ENABLED?: string;     // self-heal reclassification backstop (PR #517) — default OFF (only 'true' enables)
  EXECUTOR_MODE?: string;               // OS-3 UX Wave-2.1 ops-queue executor — default OFF (only 'enabled' activates)
  SAFETY_FLOOR_RATELIMIT_ENABLED?: string; // SF-2 (260711) · per-user cap on LLM-cost endpoints — default OFF (only 'true' enables)
  LLM_USAGE_METERING_ENABLED?: string;     // G2 (260711) · per-tenant LLM token/call metering (llm_usage_log, mig 064) — default OFF
  REVIEW_SCHEDULER_ENABLED?: string;       // A10 (260713) · review-cadence cron (crons/review-schedule.ts, chained into 05:00 slot) — default OFF (only 'true' enables)
  POLICY_ENGINE_ENABLED?: string;          // A7 (260713) · policy-engine SHADOW at goal writes (lib/policy-shadow.ts) — default OFF (only 'true' enables)
  DOMAIN_SCAFFOLD_ENABLED?: string;        // ABS-P3 (260713) · scaffold archetype honest-empty domain skeletons at provisioning (services/domain-archetypes.ts) — default OFF (only 'true' enables)
  ROLE_SKILL_RESOLVER_ENABLED?: string;    // OAR-W2 (260713) · role/skill resolver SHADOW at authorizeSpineWrite (lib/role-skill-shadow.ts, mig 070) — default OFF (only 'true' enables)
  RESOLUTION_RECEIPT_SIGNING_SECRET?: string; // OAR-W2 · HS256 secret for resolution/denial receipts (wrangler secret put) — unset ⇒ receipts written UNSIGNED (shadow never 503s)
  RESOLUTION_RECEIPT_SIGNING_KEY_ID?: string; // Track A (260713) · rotation label persisted on signed receipts — unset ⇒ 'default'
  XLOOOP_DEPLOY_SHA?: string;              // Track A (260713) · build SHA stamped into receipt provenance (deploy_sha) — unset ⇒ null (unstamped)
  SINGLE_INTAKE_ENABLED?: string;           // Commercial hardening; default OFF and not activated in this plan
  CONTEXT_PACKET_PERSISTENCE_ENABLED?: string; // Commercial pilot lineage gate; default OFF
}

export type AppVariables = AuthVariables & {
  dal: DalAdapter;
};

const app = new Hono<{ Bindings: AppEnv; Variables: AppVariables }>();

// ---- CORS (always first; handles OPTIONS preflight) ----
app.use('*', corsMiddleware());

// ---- Security headers (X-SCP P0.1) - defense-in-depth on every API response ----
app.use('*', securityHeaders());
app.use('*', requestGuards());

// ---- Request ID + DAL injector (runs before auth so health can use request_id too) ----
app.use('*', async (ctx, next) => {
  const requestId =
    ctx.req.header('cf-ray') ||
    ctx.req.header('x-request-id') ||
    cryptoRandomId();
  ctx.set('request_id', requestId);

  // DAL is bound per-request because @neondatabase/serverless requires
  // a connection URL (env-derived) and we don't want a module-level singleton
  // sharing connections across isolates in unexpected ways.
  try {
    const sql = neonClient(ctx.env.DATABASE_URL);
    const rlsSql = ctx.env.XLOOOP_RLS_APP_DATABASE_URL ? neonClient(ctx.env.XLOOOP_RLS_APP_DATABASE_URL) : sql;
    ctx.set('dal', new WorkersDalAdapter(sql, rlsSql));
  } catch (err) {
    // If DATABASE_URL is missing, only /health should still respond.
    // Defer the failure to the per-route DAL.* call (which is gated behind auth).
  }

  await next();
});

// R56 Stage 1 · public-surface hardening · strict per-IP rate-limit on the unauthenticated
// signup funnel (5 req/min/IP). Production uses the RATE_LIMITER_SIGNUP binding (wrangler.toml);
// until the operator provisions it, the middleware falls back to an in-isolate token bucket.
app.use(
  '/api/v1/request-access',
  rateLimit({ ip: { limit: 5, periodSeconds: 60, bindingName: 'RATE_LIMITER_SIGNUP' } })
);

// ---- Public routes (no auth) ----
app.route('/api/v1', healthRoute);
app.route('/api/v1', requestAccessRoute);          // R40 · public access-request funnel
app.route('/api/v1', diagnoseRoute);               // R43.17 · diagnose-user for stuck sign-in triage — OPERATOR-GATED (self-auth via MBP_OWNER_USER_ID; was public until 260710 sec-review)
app.route('/api/v1', githubWebhookRoute);          // R54-S1 · public HMAC-gated GitHub → operation_events producer
app.route('/api/v1', activityWebhookRoute);        // R54-S3-A · token-gated operator/agent activity → operation_events producer
app.route('/api/v1', investorPublicRoute);         // Wave R-I.7 Stage C · /investor/nda-accept (public)

// ---- /session has its own JWT path (allows orgless via state machine) ----
app.route('/api/v1', sessionRoute);                // R40 · entitlement state machine

// ---- MB-P operator-only data endpoints (R43.7) ----
// Self-auth inside the route handlers via MBP_OWNER_USER_ID match; do NOT use
// clerkAuth() middleware here (which requires org_id and would 403 the operator
// when they're not in a specific Clerk org context). Operator's identity is
// the only gate.
app.route('/api/v1', mbpProjectionRoute);          // R43.7 · /api/v1/mbp-projection + /mbp-live-stream

// ---- Operational spine + MCP canary routes ----
// Mount before any broad authenticated route group: Hono group middleware can
// reject by prefix before a later route group is considered.
// Normal users authenticate via Clerk. The scoped canary service principal is
// accepted only here, as role=viewer, so existing route-level RBAC keeps it
// read-only. It cannot reach product/admin/customer routes.
const operationalRoutes = new Hono<{ Bindings: AppEnv; Variables: AppVariables }>();
operationalRoutes.use('*', clerkAuth({ allowCanary: true, allowCustomerToken: true }));
operationalRoutes.route('/mcp', mcpGatewayRoute);         // Safe MCP/client gateway over signed scoped packets.
operationalRoutes.route('/mcp', createMcpRpcRoute((req, c) => Promise.resolve(app.fetch(req, c.env, c.executionCtx)))); // Native MCP (Streamable HTTP/JSON-RPC) at /mcp/rpc; dispatches to the REST tools above.
operationalRoutes.route('/', templatePolicyRegistryRoute); // Customer-safe template/policy projection + whoami.
operationalRoutes.route('/', operationalSpineRoute);     // Backend-first packet/evidence/approval/tool-event/metric spine.

app.route('/api/v1', operationalRoutes);

// ---- Events route · org-OPTIONAL so the operator overlay is reachable from a
//      personal (orgless) session. The overlay scopes by the operator IDENTITY
//      SET (MBP_OWNER_USER_ID + linked ids), not by the JWT org, so requiring
//      org_id at the middleware would 403 the operator before the overlay runs
//      (the exact "chat shows governance-only" failure mode). Customer tenant
//      isolation is preserved IN-HANDLER: every non-operator path 403s when
//      workspace_id (= org_id) is empty. Same gate as protectedRoutes for
//      customers; only the verified operator bypasses the org requirement —
//      identical to mbpProjectionRoute above. ----
// This group is org-OPTIONAL operator-overlay surfaces: the events overlay and
// (R54-S3-C) workspace create/list. Both gate on the operator IDENTITY in-handler
// and must work from a personal (orgless) operator session, so requireOrg:false.
const eventsRoutes = new Hono<{ Bindings: AppEnv; Variables: AppVariables }>();
eventsRoutes.use('*', clerkAuth({ requireOrg: false }));
eventsRoutes.route('/', eventsRoute);
eventsRoutes.route('/', workspacesRoute);          // R54-S3-C · operator workspace create/list (operator-gated in-handler)
eventsRoutes.route('/', syntheticDomainsRoute);    // audit 260531 · synthetic-domain recommendations — operator-gated + tenant-scoped IN-HANDLER (isOperatorContext + recommendationTenantScope); org-OPTIONAL so the orgless operator's "Suggested" rail (GET /recommendations) is reachable. Customers stay scoped to their own workspace; unscoped callers get nothing (fail-closed DAL).
eventsRoutes.route('/', graphRoute);               // ADR-XLOOP-ARCH-003 P2 · data-graph rebuild/drift/lineage/digest — OPERATOR-ONLY in-handler (owned-workspace guard); the graph is Tier-3a system infra, never a tenant surface.
app.route('/api/v1', eventsRoutes);

// Wave R-I.7 Stage C · investor portal split routes are mounted above:
// - investorPublicRoute: public (no auth) at /api/v1/investor/nda-accept
// - investorAuthedRoute: clerk-authed at /api/v1/investor/request-deck-download (in userRoutes)
// - investorAdminRoute: admin-only at /api/v1/admin/investor/* (in adminRoutes)

// ---- Workspace-scoped routes (require JWT + org_id via clerkAuth) ----
const protectedRoutes = new Hono<{ Bindings: AppEnv; Variables: AppVariables }>();
protectedRoutes.use('*', clerkAuth());
// Safety floor (SF-2, 260711): per-user caps on the two LLM-cost endpoints, flag-gated default-OFF
// (SAFETY_FLOOR_RATELIMIT_ENABLED). OFF ⇒ byte-identical. Registered AFTER clerkAuth so the limiter
// keys on the authenticated user. Defense-in-depth for the "unbounded LLM spend by an authed user"
// concern until per-tenant metering exists; the operator flips it once RATE_LIMITER_* is provisioned.
protectedRoutes.use('/customer-chat', rateLimitWhenFlag('SAFETY_FLOOR_RATELIMIT_ENABLED', { routeBucket: { limit: 60, periodSeconds: 60, bindingName: 'RATE_LIMITER_CHAT' } }));
protectedRoutes.use('/readiness/*', rateLimitWhenFlag('SAFETY_FLOOR_RATELIMIT_ENABLED', { routeBucket: { limit: 10, periodSeconds: 60, bindingName: 'RATE_LIMITER_READINESS' } }));
protectedRoutes.route('/', projectsRoute);
protectedRoutes.route('/', customerRoute);           // R55 · POST /customer/authority-consent (workspace-scoped)
protectedRoutes.route('/', developerAccessRoute);    // Customer-safe API/Desktop setup status + redacted connection receipt
protectedRoutes.route('/', customerWorkspaceFeedRoute); // Customer-safe starter/read-only feed
protectedRoutes.route('/', customerChatRoute);       // Customer-safe AI chat — tenant-isolated, company-aware (POST /customer-chat)
protectedRoutes.route('/', intakeRoute);             // Canonical customer intake (default OFF)
protectedRoutes.route('/', actionIntentShadowRoute); // Advisory action-intent classifier (default-off; never role/skill authority)
protectedRoutes.route('/', customerLineageRoute);    // W3 · customer lineage + graph digest (GET /customer-lineage, /customer-graph-digest)
protectedRoutes.route('/', chatReceiptRoute);        // W2 · per-answer audit receipt (GET /chat/receipt/:receipt_uid)
protectedRoutes.route('/', customerAuditLogRoute);   // W2 · customer-scoped audit export (GET /customer-audit-log)
protectedRoutes.route('/', llmUsageRoute);           // G2 · per-tenant LLM usage (GET /llm-usage — owner/operator-gated)
protectedRoutes.route('/', workspaceUpgradeRoute);   // U4a · POST /workspace/upgrade-request (audited request + admin notify, no billing)
protectedRoutes.route('/', feedbackRoute);           // T6 · POST/GET /feedback (Test-mode channel; FEEDBACK_PERSISTENCE_ENABLED, default off)
// syntheticDomainsRoute moved to eventsRoutes (org-OPTIONAL) — audit 260531; see above.
protectedRoutes.route('/', boardCardsRoute);
protectedRoutes.route('/', signOffsRoute);
protectedRoutes.route('/', membersRoute);            // Stage 3 · GET /api/v1/members (real workspace members, workspace-scoped)
protectedRoutes.route('/', planRoute);               // G1 · /api/v1/plan/* (member-scoped plan_entities; flag-gated, inert until migration 066 + PLAN_ENTITIES_ENABLED)
  protectedRoutes.route('/', currentWorkRoute);        // Wave I · GET /current-work (one server-derived Current Work projection; flag-gated CURRENT_WORK_PROJECTION_ENABLED, default OFF)
protectedRoutes.route('/', sessionModeRoute);        // Wave B · PATCH /session/mode (canonical operating mode, audited)
protectedRoutes.route('/', modelRuntimesRoute);      // Wave C · /model-runtimes/* (provider config, encrypted-at-rest credentials, audited default flip)
protectedRoutes.route('/', readinessRoute);          // M.7 · POST /readiness/submit (in-app first-login onboarding journey → scaled provision)
protectedRoutes.route('/', inferenceHealthRoute);    // R51-ζ-3 · 6-panel inference health
protectedRoutes.route('/', documentsRoute);          // Stage 2 source-intake · /documents (org required → workspace-scoped, no cross-tenant)

app.route('/api/v1', protectedRoutes);

// ---- User-scoped routes (require JWT only; org_id NOT required because
//      OAuth connections belong to the user account, not the workspace) ----
//      R50.3b · CLERK_OAUTH_PROVIDER_CONFIG.md
const userRoutes = new Hono<{ Bindings: AppEnv; Variables: AppVariables }>();
userRoutes.use('*', clerkAuth({ requireOrg: false }));
userRoutes.route('/', sourcesRoute);              // R50.3b · /api/v1/sources/*
userRoutes.route('/', layoutRoute);               // R52-B1 · /api/v1/layout (operator layout overlay)
userRoutes.route('/', profileRoute);              // Stage 2 · /api/v1/me (user identity + DB account attrs)
userRoutes.route('/', investorAuthedRoute);       // Wave R-I.7 Stage C · /investor/request-deck-download
userRoutes.route('/', pmfRoute);                  // Wave 2 · POST /pmf (authed) + GET /pmf-summary (operator-gated in-handler)

app.route('/api/v1', userRoutes);

// ---- Admin routes (require JWT + admin check; do NOT require org_id) ----
const adminRoutes = new Hono<{ Bindings: AppEnv; Variables: AppVariables }>();
adminRoutes.use('*', clerkAuth({ requireOrg: false }));   // admins don't need to be in an org
adminRoutes.use('*', requireAdmin());
adminRoutes.route('/', adminRoute);
adminRoutes.route('/admin', investorAdminRoute);          // Wave R-I.7 Stage C · /admin/investor/{tier-1-grant,tier-2-escalate,tier-2-revoke}

app.route('/api/v1', adminRoutes);

// ---- 404 fallback ----
app.notFound((ctx) => {
  ctx.status(404);
  return ctx.json({
    error: `route not found: ${ctx.req.method} ${ctx.req.path}`,
    code: 'NOT_FOUND',
    request_id: (ctx.get('request_id') as string) || '',
  });
});

// ---- Global error handler ----
app.onError((err, ctx) => {
  const res = errorEnvelope(ctx, err); // captures 5xx into Sentry (dormant-safe) at the central chokepoint
  // A-W6 · flush buffered telemetry before the isolate suspends (Workers don't auto-flush). No-op when
  // Sentry has no client (SENTRY_DSN unset). Never let flush-wiring affect the response.
  try { ctx.executionCtx?.waitUntil(sentryFlush()); } catch { /* executionCtx may be absent in tests */ }
  return res;
});

// ---- Cloudflare Cron Trigger dispatcher (R49' PR-5+6 + R51-ζ-2) ----
//
// Wrangler config defines multiple cron triggers; this handler dispatches
// each event.cron string to the matching handler in CRON_REGISTRY
// (src/workers/crons/index.ts).
//
// Cron triggers active (per wrangler.toml [triggers] crons):
//   "*/5 * * * *"  → propagation-tick (R49' PR-5+6 · existing)
//   "0 * * * *"    → permanent-suppress (§16.5 loop 4 · hourly)
//   "0 4 * * *"    → threshold-retune (§16.5 loop 2 · daily 04:00 UTC)
//   "30 4 * * *"   → pattern-suspend (§16.5 loop 3 · daily 04:30 UTC)
//   "0 5 * * *"    → calibration-retrain (§16.5 loop 5 · daily 05:00 UTC)
//   "15 5 * * *"   → shadow-eval (§16.5 loop 6 · daily 05:15 UTC)
//   "0 3 * * 1"    → weight-retune (§16.5 loop 1 · weekly Mon 03:00 UTC)
//   "45 * * * *"   → reclassify-unattributed (PR #517 self-heal backstop · hourly · flag-gated, default OFF)
//
// Unknown cron expressions log a warning but don't throw — better to skip
// than to crash a misconfigured trigger.
import { CRON_BY_EXPRESSION } from './crons';

const scheduledHandler = async (
  event: { cron: string; scheduledTime: number },
  env: AppEnv,
  ctx: { waitUntil: (p: Promise<unknown>) => void },
) => {
  const entry = CRON_BY_EXPRESSION[event.cron];
  // Safety floor (SF-1, 260711): every exit path flushes Sentry (scheduled invocations get no request
  // lifecycle to piggyback on) and reports via decideCronReport — the pure, tested rule (report on
  // thrown/failed, stay quiet on routine degraded/skipped). Dormant-safe: with SENTRY_DSN unbound
  // captureException/Message degrade to console.error; the DSN IS bound in prod, so this is live.
  const flush = () => { try { ctx.waitUntil(sentryFlush()); } catch { /* executionCtx absent in tests */ } };
  if (!entry) {
    console.warn('[cron-dispatcher] no handler for cron expression:', event.cron);
    const d = decideCronReport({ routed: false, cron: event.cron });
    if (d.report === 'message') captureMessage(d.message!, { cron: event.cron, kind: d.kind });
    flush();
    return;
  }
  try {
    const sql = neonClient(env.DATABASE_URL);
    const rlsSql = env.XLOOOP_RLS_APP_DATABASE_URL ? neonClient(env.XLOOOP_RLS_APP_DATABASE_URL) : sql;
    const dal = new WorkersDalAdapter(sql, rlsSql);
    const result = await entry.handler({
      dal,
      now: () => new Date(),
      cronExpression: event.cron,
      // Additive: carries the Workers-AI binding + digest-sweep flag + operator identity
      // set so the self-driving digest sweep (chained into weight_retune) can derive its
      // deps. Loops that don't need env ignore it.
      env,
      // A10 (260713) · review-scheduler data gateway, bound from the store functions here rather than
      // added to the FROZEN WorkersDalAdapter facade. Only reviewScheduleCron (chained into 05:00) reads it.
      reviewSchedule: {
        listDue: (nowDateIso: string, limit: number) => listGoalsWithReviewDueRow(sql, nowDateIso, limit),
        bumpReviewDue: (goalId: string, nextReviewDue: string) => updateGoalReviewDueRow(sql, goalId, nextReviewDue),
      },
    });
    console.log(`[cron:${entry.loop_name}]`, JSON.stringify(result));
    // A cron returning status:'failed' has SWALLOWED its error into the result envelope (the composite
    // catches in crons/index.ts stuff errors into metadata rather than throwing) — surface it.
    const d = decideCronReport({ routed: true, resultStatus: (result as { status?: string })?.status, loopName: entry.loop_name, cron: event.cron });
    if (d.report === 'message') {
      captureMessage(d.message!, { cron: event.cron, loop_name: entry.loop_name, kind: d.kind, metadata: (result as { metadata?: unknown })?.metadata });
    }
  } catch (e: any) {
    // The dispatcher CATCH previously only console.error'd and never re-threw, so withSentry's
    // unhandled-exception capture never fired and no cron throw ever reached Sentry (grep of crons/
    // for captureException = 0 hits). Report explicitly — the exact silent-cron class.
    console.error(`[cron:${entry.loop_name}] error:`, e?.message ?? String(e));
    const d = decideCronReport({ routed: true, threw: true, loopName: entry.loop_name, cron: event.cron });
    if (d.report === 'exception') captureException(e, { cron: event.cron, loop_name: entry.loop_name, kind: d.kind });
  } finally {
    flush();
  }
};

// A-W6 ACTIVATION (260707) · wrap the exported handler with Sentry. withSentry initializes the SDK
// per-request from the env (Workers have no module-load env), captures unhandled exceptions, and is a
// PASS-THROUGH no-op when sentryOptions(env) returns undefined (SENTRY_DSN unbound) — dormant-safe.
// The explicit 5xx capture + flush in errorEnvelope/app.onError still run inside this request scope.
export default Sentry.withSentry(
  (env: AppEnv) => sentryOptions(env),
  {
    fetch: app.fetch.bind(app),
    scheduled: scheduledHandler,
  },
);

// ---- helpers ----
function cryptoRandomId(): string {
  try {
    return (globalThis.crypto as any).randomUUID();
  } catch {
    return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}
