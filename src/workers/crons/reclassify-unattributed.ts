// src/workers/crons/reclassify-unattributed.ts
//
// SELF-HEALING BACKSTOP to the going-forward producer (PR #517 ·
// routes/github-webhook.ts + lib/classify-body-of-work.ts).
//
// The producer classifies NEW events at ingest so they self-file into one of the
// 8 bodies-of-work projects. But events that were ingested BEFORE the split, or
// that arrived while split was off (or via a path the producer doesn't cover),
// sit unattributed (project_id IS NULL, or in the '%-allactivity' catch-all
// bucket). This cron periodically RE-FILES that backlog using the SAME classifier
// — so the cockpit's 8 projects converge to completeness without manual cleanup.
//
// Per run (mirrors the scheduled-digest-sweep cron's structure + safety):
//   1. SCOPE GUARD — only workspaces that opted into the split (have ≥1 project
//      with metadata->>'origin' = the split-origin marker). A non-split workspace
//      is never touched.
//   2. Pull the unattributed backlog within those workspaces, bounded by
//      MAX_BATCH (so a large backlog drains over several runs — no long query).
//   3. For each event: slug = classifyBodyOfWork(summary) — NO changed-paths are
//      available post-hoc (they aren't persisted on the event), so this is a
//      summary-only classification (still total: always one of the 8 slugs).
//   4. Target project_id = `${workspace_id}-<slug>`. UPDATE only if that project
//      ROW EXISTS in the workspace → FK-safe (never assigns to a missing project).
//   5. Best-effort per event: one failure never aborts the batch. Idempotent: the
//      UPDATE only touches rows still unattributed at write time, so a re-run or a
//      concurrent producer write is a safe no-op.
//
// SAFETY POSTURE (identical ethos to the digest sweep):
//   - FLAG-GATED, DEFAULT OFF. RECLASSIFY_CRON_ENABLED must be exactly "true"
//     (case-insensitive). Anything else → no-op, ZERO DB reads/writes.
//   - NEVER THROWS at the batch level: a failing workspace/event is isolated +
//     counted; the loop completes and returns a structured summary.
//
// Telemetry: returns a CronHandlerResult logged by the dispatcher
// (console.log(`[cron:reclassify_unattributed]`, ...)) — same sink as every other
// cron — with per-bucket counts in metadata.

import type { CronHandler, CronHandlerContext, CronHandlerResult } from './types';
import { envFlagTrue } from '../lib/env-flag';
import { classifyBodyOfWork, BODY_OF_WORK_SLUGS, type BodyOfWorkSlug } from '../lib/classify-body-of-work';

const LOOP_NAME = 'reclassify_unattributed';

/** Bounded batch per run so a backlog drains over several runs without a
 *  long-running query. Hard-capped by the store at 500 as well. */
export const MAX_BATCH = 500;

/** Zeroed per-bucket tally (one entry per canonical slug). */
function emptyBuckets(): Record<BodyOfWorkSlug, number> {
  return BODY_OF_WORK_SLUGS.reduce((acc, slug) => {
    acc[slug] = 0;
    return acc;
  }, {} as Record<BodyOfWorkSlug, number>);
}

/** The minimal DAL surface this loop touches — kept narrow so the cron unit-tests
 *  with a tiny DAL double (same approach as scheduled-digest-sweep). */
type ReclassifyDal = Pick<
  CronHandlerContext['dal'],
  'listSplitEnabledWorkspaceIds' | 'listUnattributedEvents' | 'listProjectIdsForWorkspaces' | 'reassignEventProject'
>;

export const reclassifyUnattributedCron: CronHandler = async (ctx) => {
  const startedAt = ctx.now();
  const run_id = `reclassify_${startedAt.toISOString()}`;

  // ── SAFE-BY-DEFAULT: flag must be exactly "true" (case-insensitive) ──────────
  const flagEnabled = envFlagTrue(ctx.env?.RECLASSIFY_CRON_ENABLED);
  if (!flagEnabled) {
    return {
      loop_name: LOOP_NAME,
      run_id,
      actions_taken: 0,
      cost_ms: ctx.now().getTime() - startedAt.getTime(),
      status: 'skipped',
      notes: 'flag_disabled · set RECLASSIFY_CRON_ENABLED=true to enable',
      metadata: { loop: LOOP_NAME, reason: 'flag_disabled' },
    };
  }

  const dal = ctx.dal as ReclassifyDal;
  const buckets = emptyBuckets();
  const workspacesSeen = new Set<string>();
  const workspacesTouched = new Set<string>();
  let scanned = 0;
  let reclassified = 0;
  let skipped_missing_project = 0;
  let errors = 0;

  try {
    // (1) SCOPE GUARD — split-enabled workspaces only.
    const splitWorkspaceIds = await dal.listSplitEnabledWorkspaceIds();
    if (!Array.isArray(splitWorkspaceIds) || splitWorkspaceIds.length === 0) {
      return done(ctx, startedAt, run_id, {
        buckets,
        workspaces_seen: 0,
        workspaces_touched: 0,
        scanned: 0,
        reclassified: 0,
        skipped_missing_project: 0,
        errors: 0,
        notes: 'no split-enabled workspaces',
      });
    }

    // (2) the bounded unattributed backlog within those workspaces.
    const events = await dal.listUnattributedEvents(splitWorkspaceIds, MAX_BATCH);
    scanned = events.length;

    // The project rows that actually exist (FK-safety set), fetched once.
    const existingProjectIds = await dal.listProjectIdsForWorkspaces(splitWorkspaceIds);

    // (3)+(4)+(5) classify + re-file, best-effort per event.
    for (const ev of events) {
      try {
        if (!ev?.id || !ev?.workspace_id) continue;
        workspacesSeen.add(ev.workspace_id);

        // NOTE: changed paths are NOT available post-hoc (not persisted on the
        // event), so this is a summary-only classification.
        const slug = classifyBodyOfWork(ev.summary);
        const targetProjectId = `${ev.workspace_id}-${slug}`;

        // FK-safe: skip if the target project row doesn't exist in the workspace.
        if (!existingProjectIds.has(targetProjectId)) {
          skipped_missing_project += 1;
          continue;
        }

        const updated = await dal.reassignEventProject(ev.workspace_id, ev.id, targetProjectId);
        if (updated > 0) {
          reclassified += updated;
          buckets[slug] += updated;
          workspacesTouched.add(ev.workspace_id);
        }
      } catch (_err) {
        // Per-event isolation: one failure never aborts the batch.
        errors += 1;
      }
    }

    return done(ctx, startedAt, run_id, {
      buckets,
      workspaces_seen: workspacesSeen.size,
      workspaces_touched: workspacesTouched.size,
      scanned,
      reclassified,
      skipped_missing_project,
      errors,
      notes:
        `${reclassified} event(s) re-filed across ${workspacesTouched.size} workspace(s); ` +
        `${scanned} scanned, ${skipped_missing_project} skipped (missing project), ${errors} error(s)` +
        (scanned >= MAX_BATCH ? ` · batch full (≥${MAX_BATCH}) — more runs will drain the rest` : ''),
    });
  } catch (err) {
    // Top-level failure (e.g. the workspace scan itself) is swallowed: the cron
    // never throws, it returns a failed result the dispatcher logs.
    return {
      loop_name: LOOP_NAME,
      run_id,
      actions_taken: reclassified,
      cost_ms: ctx.now().getTime() - startedAt.getTime(),
      status: 'failed',
      error: err instanceof Error ? err.message : String(err),
      metadata: { loop: LOOP_NAME, buckets, scanned, reclassified, skipped_missing_project, errors },
    };
  }
};

interface DoneArgs {
  buckets: Record<BodyOfWorkSlug, number>;
  workspaces_seen: number;
  workspaces_touched: number;
  scanned: number;
  reclassified: number;
  skipped_missing_project: number;
  errors: number;
  notes: string;
}

function done(
  ctx: CronHandlerContext,
  startedAt: Date,
  run_id: string,
  a: DoneArgs,
): CronHandlerResult {
  return {
    loop_name: LOOP_NAME,
    run_id,
    actions_taken: a.reclassified,
    cost_ms: ctx.now().getTime() - startedAt.getTime(),
    // OBS-2 (J-W3 260711-I): a run where per-event reclassify errors occurred is NOT healthy — return
    // 'degraded' (which decideCronReport now reports to Sentry) so a run that fails to re-file every
    // scanned event (errors>0, reclassified low) is distinguishable from a clean 'completed'. Before,
    // errors only landed in metadata/notes, so the alerting layer saw it as routine (silent-cron class).
    status: a.errors > 0 ? 'degraded' : 'completed',
    notes: a.notes,
    metadata: {
      loop: LOOP_NAME,
      workspaces_seen: a.workspaces_seen,
      workspaces_touched: a.workspaces_touched,
      scanned: a.scanned,
      reclassified: a.reclassified,
      skipped_missing_project: a.skipped_missing_project,
      errors: a.errors,
      buckets: a.buckets,
    },
  };
}
