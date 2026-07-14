// scheduled-digest-sweep.ts · the SELF-DRIVING half of the governed digest agent.
//
// North-star gap this closes: the digest agent already does real work (services/agent-digest.ts)
// and posts a GOVERNED proposal (route POST /workspaces/:id/agent/digest), but only when the
// operator pulls the trigger. This service flips that to PUSH: on the weekly cron, the agent
// PROACTIVELY drafts a digest per active workspace as a PENDING proposal that lands in the
// notifications bell — the operator one-taps approve. The "return trigger": the operator comes
// back to a workspace that already prepared its own week-in-review, awaiting sign-off.
//
// Safety contract (all four, by construction):
//   1. SAFE-BY-DEFAULT — gated on flagEnabled. flag OFF → zero DB calls, zero drafts.
//   2. GOVERNED — every drafted proposal is approval_state='pending' / status='needs_review'.
//      The sweep NEVER posts to the official record; only operator sign-off does that.
//   3. IDEMPOTENT — at most ONE pending digest-agent proposal per workspace. A second sweep
//      (or a manual route trigger) does not pile up unapproved digests.
//   4. NEVER-THROWS — each workspace is isolated in try/catch; one failure increments `errors`
//      and the sweep continues. A top-level guard means runScheduledDigestSweep itself never
//      rejects — the worst case is status='completed' with errors > 0.
//
// Reuses (zero new DAL, zero new columns): buildWorkspaceDigestLLM, listWorkspacesForOperator,
// getWorkspaceActivitySummary, listEvents, upsertEvent. The drafted proposal is field-identical
// to the manual route (workspaces.ts POST .../agent/digest) so both share the same approval spine
// AND the same per-workspace-per-day event id — making manual + scheduled mutually idempotent.

import type { DalAdapter } from '../dal/DalAdapter';
import { buildWorkspaceDigestLLM, type AiRunner } from './agent-digest';

const DIGEST_AGENT_ID = 'xlooop:digest-agent';
const DIGEST_NEXT_ACTION = 'approve_to_post_digest';

export interface ScheduledDigestSweepDeps {
  readonly dal: DalAdapter;
  /** Workers-AI binding (optional). Present → LLM draft; absent → deterministic fallback. */
  readonly ai?: AiRunner;
  /** Operator identity set (owner + linked) — the workspaces the sweep is allowed to digest. */
  readonly ownerUserIds: string[];
  /** Master switch. OFF → the sweep is inert (no DB calls). */
  readonly flagEnabled: boolean;
  /** Injected clock so cron + tests are deterministic. */
  readonly now: () => Date;
}

export interface SweepResult {
  readonly status: 'completed' | 'skipped';
  /** Present only when skipped (e.g. 'flag_disabled'). */
  readonly reason?: string;
  /** Workspaces that got a fresh PENDING digest proposal this run. */
  readonly drafted: number;
  /** Workspaces skipped because they have no activity to digest (events_total === 0). */
  readonly skipped_dormant: number;
  /** Workspaces skipped because a pending digest-agent proposal already exists (idempotent). */
  readonly skipped_existing: number;
  /** Workspaces whose processing threw (isolated; sweep continued). */
  readonly errors: number;
}

/**
 * Proactively draft a governed workspace digest per active operator workspace.
 *
 * Returns a SweepResult. NEVER throws — flag-disabled short-circuits with zero DB work, and any
 * per-workspace or top-level failure degrades to counters rather than a rejection (HR-INPUT-
 * COERCION-NO-THROW-1 spirit: a scheduled background job must not surface a 5xx / crash the cron).
 */
export async function runScheduledDigestSweep(deps: ScheduledDigestSweepDeps): Promise<SweepResult> {
  const { dal, ai, ownerUserIds, flagEnabled, now } = deps;

  // (1) SAFE-BY-DEFAULT: flag OFF → fully inert. No workspace listing, no summaries, no writes.
  if (!flagEnabled) {
    return { status: 'skipped', reason: 'flag_disabled', drafted: 0, skipped_dormant: 0, skipped_existing: 0, errors: 0 };
  }

  let drafted = 0;
  let skipped_dormant = 0;
  let skipped_existing = 0;
  let errors = 0;

  try {
    const workspaces = await dal.listWorkspacesForOperator(ownerUserIds);

    for (const ws of workspaces) {
      // Per-workspace isolation: one failure must NOT abort the sweep for the others.
      try {
        const summary = await dal.getWorkspaceActivitySummary(ws.id, null);

        // (a) DORMANT skip — nothing has happened in this workspace, so there is nothing to digest.
        if (summary.events_total === 0) {
          skipped_dormant++;
          continue;
        }

        // (b) IDEMPOTENCY skip — at most ONE pending digest-agent proposal per workspace. If one is
        // already awaiting review (from a prior sweep OR the manual route), do not pile up another.
        const page = await dal.listEvents(ws.id, { status: 'needs_review', limit: 50, role: 'operator' });
        const hasPending = page.events.some(
          (e) => e.agent_id === DIGEST_AGENT_ID && e.next_action === DIGEST_NEXT_ACTION,
        );
        if (hasPending) {
          skipped_existing++;
          continue;
        }

        // (c) DRAFT — LLM-richer when a binding is present, deterministic fallback otherwise. Either
        // way it is posted PENDING; the agent never auto-posts to the official record.
        const digest = await buildWorkspaceDigestLLM(summary, ai);
        const occurredAt = now().toISOString();
        // Field-identical to workspaces.ts POST .../agent/digest, including the per-workspace-per-day
        // id — so a manual trigger and the scheduled sweep are mutually idempotent (same id collides).
        const eventId = `evt_agent_digest_${ws.id}_${occurredAt.slice(0, 10)}`;
        await dal.upsertEvent(ws.id, {
          id: eventId,
          source_tool: 'xlooop',
          agent_id: DIGEST_AGENT_ID,
          status: 'needs_review',
          approval_state: 'pending',
          summary: digest.summary,
          body: digest.body,
          next_action: DIGEST_NEXT_ACTION,
          visibility: 'internal_workspace',
          occurred_at: occurredAt,
        });
        drafted++;
      } catch (_wsErr) {
        // Isolated per-workspace failure — count it and keep sweeping.
        errors++;
      }
    }
  } catch (_topErr) {
    // Top-level guard (e.g. listWorkspacesForOperator itself threw). Never rethrow — return what we
    // have. drafted may be 0; errors captures that the run could not enumerate workspaces.
    errors++;
  }

  return { status: 'completed', drafted, skipped_dormant, skipped_existing, errors };
}
