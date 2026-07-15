// operations-queue-consumer.ts · the PULL half of the execution pipeline (OS-3 UX Wave-2.1).
//
// North-star gap this closes: WRITE-mode chat actions (Command/Intent) log an operation_events row
// with status='queued' — but NOTHING consumes them. The operator "presses a button" and the work
// sits queued forever (the repeated felt pain: "proceed did nothing"). This service is the missing
// executor: it polls the operator's queued events, ATOMICALLY claims each one (queued -> running,
// run-exactly-once), runs the named verb, APPENDS the result as a NEW governed proposal event, and
// transitions the original request row to a terminal status.
//
// It is the dual of scheduled-digest-sweep.ts: that is PUSH (the agent proactively drafts), this is
// PULL (the agent consumes what the operator queued). Same safety contract, by construction:
//
//   1. SAFE-BY-DEFAULT — gated on executorEnabled (EXECUTOR_MODE === 'enabled'). OFF -> zero DB calls,
//      zero claims, zero writes. Ships INERT: wrangler.toml sets EXECUTOR_MODE = "disabled".
//   2. GOVERNED — a verb's result is APPENDED as status='needs_review' / approval_state='pending'.
//      The executor can NEVER post to the operator's official stream; only operator sign-off does.
//   3. RUN-EXACTLY-ONCE — the queued -> running transition is an ATOMIC CLAIM (updateEventStatus...
//      WHERE status='queued', RETURNING id). updated === 0 => another run already claimed it => skip.
//   4. NEVER-THROWS — each event is isolated in try/catch; a verb failure transitions THAT request to
//      'failed' (and appends a failure note) and the drain continues. A top-level guard means
//      runOperationsQueueConsumer itself never rejects — a scheduled background job must not 5xx.
//
// APPEND-ONLY MODEL (ADR-XLOOP-IA-001 invariant 2): operation_events CONTENT (summary/body/...) is
// immutable; only STATUS-class fields (status/approval_state/next_action) may be re-pointed. So the
// executor never mutates a row's body. The request row's content stays as the operator typed it; the
// executor INSERTs a SEPARATE result event (the digest proposal, or a failure note) and only flips the
// request row's STATUS to completed/failed. Two rows: the immutable command + the appended result —
// the same shape scheduled-digest-sweep already uses (it INSERTs evt_agent_digest_* rows).
//
// Verb contract: a queued event names its verb in `next_action`, under the `execute:` namespace (e.g.
// 'execute:digest'). Deliberately distinct from the approval-gate next_action values like
// 'approve_to_post_digest', so the two never collide:
//   - next_action WITHOUT the `execute:` prefix -> NOT the executor's concern -> left queued, untouched.
//   - `execute:<verb>` with a KNOWN verb        -> atomically claimed, run, result appended, completed.
//   - `execute:<verb>` with an UNKNOWN verb      -> claimed then transitioned to 'failed' (so it cannot
//     sit queued forever addressed to an executor that has no handler for it).
//
// Reuses (zero new DAL beyond updateEventStatusForOperator, zero new columns): listEventsForOperator
// (status='queued' filter), getWorkspaceActivitySummary, buildWorkspaceDigestLLM, upsertEvent. The
// digest verb produces the SAME pending-proposal shape as the manual route + the scheduled sweep, so
// all three paths share one approval spine.
//
// KNOWN LIMITATION (Wave 2.2 follow-up · stale-running reclaim): a request is claimed queued -> running
// and only THEN runs the verb. If the worker dies AFTER the claim but BEFORE the terminal transition,
// the request strands in 'running' — the next run polls status='queued' only, so it is not retried.
// (The common finalize-throw path still appends the result before stranding, so the operator still
// sees the proposal; only a crash between claim and verb leaves a result-less 'running' row.) A proper
// reclaim needs a claim TIMESTAMP to distinguish "stuck" from "legitimately in-flight"; that lands with
// Wave 2.2 (enqueue side + claimed_at). This is acceptable for the INERT v1: zero production exposure
// until EXECUTOR_MODE flips, and the stranding is a rare crash-window edge, not a steady-state path.

import type { DalAdapter } from '../dal/DalAdapter';
import type { HarnessFlowEvent, HarnessFlowEventInput } from '../dal/types';
import { buildWorkspaceDigestLLM, type AiRunner } from './agent-digest';
import { buildWorkspaceRoadmap } from './agent-roadmap';
import type { GovernedModelLineageFactory } from '../lib/model-execution-lineage';

/** next_action namespace that marks an event as addressed to THIS executor. */
const EXECUTE_PREFIX = 'execute:';

/** The proposal next_action a finalized digest carries — identical to the manual route + sweep. */
const DIGEST_NEXT_ACTION = 'approve_to_post_digest';
/** W3 Track A · the proposal next_action a finalized roadmap-synthesis carries (sibling of digest). */
const ROADMAP_NEXT_ACTION = 'approve_to_post_roadmap';

/** agent_id stamped on appended result/failure events (for filtering + lineage). */
const DIGEST_AGENT_ID = 'xlooop:digest-agent';
const ROADMAP_AGENT_ID = 'xlooop:roadmap-agent';
const EXECUTOR_AGENT_ID = 'xlooop:operations-executor';

/** Default max events drained per run. Hourly cadence + small batch = gentle, bounded DB load. */
const DEFAULT_MAX_BATCH = 20;

export interface OperationsQueueConsumerDeps {
  readonly dal: DalAdapter;
  /** Workers-AI binding (optional). Present -> LLM-richer verb output; absent -> deterministic fallback. */
  readonly ai?: AiRunner;
  /** Operator identity set (owner + linked) — the only workspaces whose queue this run may drain. */
  readonly ownerUserIds: string[];
  /** Master switch. OFF -> the consumer is inert (no DB calls). EXECUTOR_MODE === 'enabled'. */
  readonly executorEnabled: boolean;
  /** Injected clock so cron + tests are deterministic; stamps appended result events. */
  readonly now: () => Date;
  /** Max queued events to claim per run. Defaults to DEFAULT_MAX_BATCH. */
  readonly maxBatch?: number;
  readonly modelLineageFactory?: GovernedModelLineageFactory;
  readonly modelLineageRequired?: boolean;
}

export interface QueueConsumerResult {
  readonly status: 'completed' | 'skipped';
  /** Present only when skipped (e.g. 'executor_disabled'). */
  readonly reason?: string;
  /** Queued events inspected this run. */
  readonly scanned: number;
  /** Verbs run successfully -> result appended as a pending proposal, request completed. */
  readonly executed: number;
  /** Requests transitioned to 'failed' (unknown verb OR the handler threw). */
  readonly failed: number;
  /** Events whose atomic claim (or finalize) UPDATEd 0 rows — another run/change won the race. */
  readonly skipped_unclaimed: number;
  /** Queued events NOT addressed to this executor (no `execute:` prefix) — left untouched. */
  readonly skipped_foreign: number;
  /** Events whose processing threw at the orchestration level (isolated; drain continued). */
  readonly errors: number;
}

/**
 * A verb handler runs a claimed (running) request event and returns the RESULT event to APPEND — a
 * GOVERNED proposal (status='needs_review', approval_state='pending') the operator vets before it
 * becomes official. It may throw; the caller transitions the request to 'failed' and continues.
 */
type VerbHandler = (
  event: HarnessFlowEvent,
  deps: {
    readonly dal: DalAdapter;
    readonly ai?: AiRunner;
    readonly now: () => Date;
    readonly modelLineageFactory?: GovernedModelLineageFactory;
    readonly modelLineageRequired?: boolean;
  },
) => Promise<HarnessFlowEventInput>;

// ── Verb registry ────────────────────────────────────────────────────────────────────────────────
// The single source of truth for what the executor can run. Adding a verb = adding a key here (plus
// the enqueue side in the chat route, Wave 2.2). Keep handlers small + governed; never auto-post.
const VERB_HANDLERS: Readonly<Record<string, VerbHandler>> = Object.freeze({
  // 'execute:digest' — compile a workspace digest from the activity summary and APPEND it PENDING.
  // Mirrors services/agent-digest.ts (manual route) + scheduled-digest-sweep.ts (PUSH): same draft,
  // same proposal shape, same approval spine. The operator approves via POST /sign-offs to post it.
  digest: async (event, { dal, ai, now, modelLineageFactory, modelLineageRequired }) => {
    const summary = await dal.getWorkspaceActivitySummary(event.workspace_id, null);
    if (ai && modelLineageRequired && !modelLineageFactory) throw new Error('strict model lineage factory is unavailable');
    const governed = ai && modelLineageFactory
      ? await modelLineageFactory({
        workspace_id: event.workspace_id,
        principal_id: DIGEST_AGENT_ID,
        role: 'automation',
        mode: 'plan',
        action: 'assistant:digest',
        intent_ref: `event:${event.id}`,
        scope: { event_count: summary.events_total, document_count: 0, unpromoted_document_count: 0, source_count: summary.connected_sources },
        redaction_profile: 'automation-summary',
        client_empty: false,
      })
      : null;
    const draft = await buildWorkspaceDigestLLM(summary, ai, governed?.observer);
    if (governed) await governed.complete();
    return {
      // Deterministic id derived from the request -> idempotent (upsertEvent is insert-if-absent), and
      // the id itself is the lineage link back to the command that produced it.
      id: `evt_exec_digest_${event.id}`,
      source_tool: 'xlooop',
      agent_id: DIGEST_AGENT_ID,
      status: 'needs_review',
      approval_state: 'pending',
      summary: draft.summary,
      body: draft.body,
      next_action: DIGEST_NEXT_ACTION,
      visibility: 'internal_workspace',
      occurred_at: now().toISOString(),
      // W3-1 (2026-06-13) · machine-readable metrics on the live digest receipt — closes the
      // vision's actions -> METRICS arc for the executor's one live verb (EXECUTOR_MODE=enabled).
      // Same numbers the prose digest is compiled from (getWorkspaceActivitySummary), now also
      // emitted as structured data so downstream learning/observability can consume them without
      // re-parsing prose. Additive on a FRESH INSERT result event — append-only invariant intact
      // (no mutation of the request row); no new verb (verify-execution-pipeline-parity stays green).
      metadata: {
        metrics: {
          events_total: summary.events_total,
          events_completed: summary.events_completed,
          needs_you: summary.needs_you,
          signoffs_total: summary.signoffs_total,
          connected_sources: summary.connected_sources,
          projects_total: summary.projects_total,
          generated_at: now().toISOString(),
        },
      },
    };
  },
  // 'execute:roadmap' — synthesize a roadmap proposal from the workspace plan (domains -> roadmaps +
  // goals via listWorkspacePlan) and APPEND it PENDING. Exact sibling of digest: read DAL -> draft ->
  // governed proposal -> operator approves via POST /sign-offs. Deterministic (no LLM); the draft
  // flags planning gaps (goals with no roadmap, roadmaps with no movement). Fills the cataloged-but-
  // unimplemented /roadmap capability without colliding with the /goal /intent slash-command path.
  roadmap: async (event, { dal, now }) => {
    const plan = await dal.listWorkspacePlan(event.workspace_id);
    const draft = buildWorkspaceRoadmap(plan.domains);
    return {
      id: `evt_exec_roadmap_${event.id}`,
      source_tool: 'xlooop',
      agent_id: ROADMAP_AGENT_ID,
      status: 'needs_review',
      approval_state: 'pending',
      summary: draft.summary,
      body: draft.body,
      next_action: ROADMAP_NEXT_ACTION,
      visibility: 'internal_workspace',
      occurred_at: now().toISOString(),
      metadata: {
        // Same machine-readable-metrics discipline as the digest verb (W3-1): the plan rollup the
        // prose synthesis is built from, emitted as structured data for downstream learning.
        plan_metrics: {
          domains: plan.domains.length,
          roadmaps: plan.domains.reduce((n, d) => n + (d.roadmaps?.length || 0), 0),
          goals: plan.domains.reduce((n, d) => n + (d.goals?.length || 0), 0),
          generated_at: now().toISOString(),
        },
      },
    };
  },
});

/** Append a failure-note event (append-only forensics) so the operator sees WHY a command failed. */
async function appendFailureNote(
  dal: DalAdapter,
  request: HarnessFlowEvent,
  reason: string,
  now: () => Date,
): Promise<void> {
  await dal.upsertEvent(request.workspace_id, {
    id: `evt_exec_fail_${request.id}`,
    source_tool: 'xlooop',
    agent_id: EXECUTOR_AGENT_ID,
    status: 'failed',
    summary: `Execution failed: ${request.summary}`,
    body: `The queued command could not be executed: ${reason}.`,
    visibility: 'internal_workspace',
    occurred_at: now().toISOString(),
  });
}

/**
 * Drain the operator's queued operation_events, executing each recognized verb run-exactly-once,
 * appending its result as a governed (pending) proposal, and transitioning the request to terminal.
 *
 * Returns a QueueConsumerResult. NEVER throws — executor-disabled short-circuits with zero DB work,
 * and any per-event or top-level failure degrades to counters rather than a rejection.
 */
export async function runOperationsQueueConsumer(
  deps: OperationsQueueConsumerDeps,
): Promise<QueueConsumerResult> {
  const { dal, ai, ownerUserIds, executorEnabled, now } = deps;
  const maxBatch = deps.maxBatch ?? DEFAULT_MAX_BATCH;

  // (1) SAFE-BY-DEFAULT: switch OFF -> fully inert. No queue read, no claims, no writes.
  if (!executorEnabled) {
    return {
      status: 'skipped',
      reason: 'executor_disabled',
      scanned: 0,
      executed: 0,
      failed: 0,
      skipped_unclaimed: 0,
      skipped_foreign: 0,
      errors: 0,
    };
  }

  let scanned = 0;
  let executed = 0;
  let failed = 0;
  let skipped_unclaimed = 0;
  let skipped_foreign = 0;
  let errors = 0;

  try {
    // Poll the operator's queued events in ONE scoped query (status='queued', operator-owned only).
    const page = await dal.listEventsForOperator(ownerUserIds, {
      status: 'queued',
      limit: maxBatch,
      role: 'operator',
    });

    for (const ev of page.events) {
      scanned++;
      // Per-event isolation: one failure must NOT abort the drain for the others.
      try {
        const nextAction = String(ev.next_action || '');

        // (a) FOREIGN skip — not addressed to this executor. Leave it queued for whoever owns it.
        if (!nextAction.startsWith(EXECUTE_PREFIX)) {
          skipped_foreign++;
          continue;
        }
        const verb = nextAction.slice(EXECUTE_PREFIX.length);

        // (b) ATOMIC CLAIM queued -> running (run-exactly-once). Status-class only (append-only model).
        // updated === 0 => lost the race (another run/manual change already moved it) => skip.
        const claim = await dal.updateEventStatusForOperator(
          ownerUserIds,
          ev.id,
          { status: 'running' },
          'queued',
        );
        if (claim.updated === 0) {
          skipped_unclaimed++;
          continue;
        }

        // (c) UNKNOWN VERB — claimed but unservable. Append a failure note + transition request to
        // 'failed' (status-only) so it can't sit queued forever.
        const handler = VERB_HANDLERS[verb];
        if (!handler) {
          await appendFailureNote(dal, ev, `no handler registered for verb "${verb}"`, now);
          await dal.updateEventStatusForOperator(ownerUserIds, ev.id, { status: 'failed' }, 'running');
          failed++;
          continue;
        }

        // (d) RUN the verb -> the RESULT proposal event to append. A throw transitions THIS request to
        // 'failed' (+ failure note) and continues.
        let resultEvent: HarnessFlowEventInput;
        try {
          resultEvent = await handler(ev, {
            dal, ai, now,
            modelLineageFactory: deps.modelLineageFactory,
            modelLineageRequired: deps.modelLineageRequired,
          });
        } catch (verbErr) {
          await appendFailureNote(
            dal,
            ev,
            verbErr instanceof Error ? verbErr.message : String(verbErr),
            now,
          );
          await dal.updateEventStatusForOperator(ownerUserIds, ev.id, { status: 'failed' }, 'running');
          failed++;
          continue;
        }

        // (e) APPEND the governed result proposal (INSERT — not a content mutation), then transition
        // the request running -> completed (status-only), guarded on 'running' so a concurrent change
        // isn't clobbered. The proposal upsert is idempotent (deterministic id) so a finalize-race
        // re-run cannot duplicate it.
        await dal.upsertEvent(ev.workspace_id, resultEvent);
        const finalize = await dal.updateEventStatusForOperator(
          ownerUserIds,
          ev.id,
          { status: 'completed' },
          'running',
        );
        if (finalize.updated === 0) {
          skipped_unclaimed++;
          continue;
        }
        executed++;
      } catch (_evErr) {
        // Isolated per-event orchestration failure — count it and keep draining.
        errors++;
      }
    }
  } catch (_topErr) {
    // Top-level guard (e.g. listEventsForOperator itself threw). Never rethrow — return counters.
    errors++;
  }

  return { status: 'completed', scanned, executed, failed, skipped_unclaimed, skipped_foreign, errors };
}
