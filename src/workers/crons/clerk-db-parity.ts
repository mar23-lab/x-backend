// src/workers/crons/clerk-db-parity.ts · P10 · the OBSERVE-only Clerk↔DB membership parity loop.
//
// The comparator itself is pure and already landed (lib/clerk-db-membership-parity.ts, 11 tests, the
// 260731 incident as its first fixture). This is the arm that runs it on a schedule, so the check
// stops depending on an operator remembering to run a script with a Clerk secret in their shell.
// That dependency is the ritual-writer class this estate has measured dying: every plane with a
// machine writer stayed green; every plane needing someone to remember went stale.
//
// SAFETY POSTURE (deliberately identical to customer-census.ts, which it chains beside):
//   - BORN-OFF. CLERK_DB_PARITY_ENABLED must be exactly "true". Anything else ⇒ zero reads, zero
//     Clerk calls, byte-inert.
//   - OBSERVE-ONLY. It compares and reports. It NEVER materializes, removes, or reconciles. The
//     session route owns materialization (#131); a detector that also repairs conflates detection
//     with action, and then a bug in the repair is invisible to the thing that would have caught it.
//   - NEVER THROWS at the batch level: a failing workspace is isolated and counted, the loop
//     completes, and the summary says how many it could not measure.
//   - NO CREDENTIALS ARE LOGGED and no member identities are persisted — the summary carries counts
//     and workspace ids only. User ids appear in the returned metadata for the operator's console,
//     bounded, never written to a customer-visible store.
//
// THE ONE THING THIS MUST NOT DO IS GO QUIET. A parity loop that reports "0 diverged" because it
// could not reach Clerk is worse than no loop at all: it converts an outage into a clean bill of
// health. `listOrgMembers` returns null (never []) on failure precisely so this arm can tell
// "Clerk says nobody" apart from "I could not ask Clerk", and an unmeasurable workspace escalates
// the loop to 'degraded' rather than passing silently.

import type { CronHandler, CronHandlerResult } from './types';
import { envFlagTrue } from '../lib/env-flag';
import { diffMemberships, summarizeParity, type ParityResult } from '../lib/clerk-db-membership-parity';
import { clerkRoleToWorkspaceRole } from '../dal/visibility';

const LOOP_NAME = 'clerk_db_parity';

/** Bounded per run. Our scale is low tens of workspaces; the cap is a safety ceiling, not a target. */
export const MAX_WORKSPACES = 100;

export const clerkDbParityCron: CronHandler = async (ctx) => {
  const startedAt = ctx.now();
  const run_id = `parity_${startedAt.toISOString()}`;
  const done = (r: Partial<CronHandlerResult>): CronHandlerResult => ({
    loop_name: LOOP_NAME,
    run_id,
    actions_taken: 0,
    cost_ms: ctx.now().getTime() - startedAt.getTime(),
    status: 'skipped',
    ...r,
  });

  if (!envFlagTrue(ctx.env?.CLERK_DB_PARITY_ENABLED)) {
    return done({ notes: 'flag_disabled · set CLERK_DB_PARITY_ENABLED=true to enable', metadata: { loop: LOOP_NAME, reason: 'flag_disabled' } });
  }

  const gw = ctx.parity;
  if (!gw) {
    return done({ notes: 'gateway_absent · ctx.parity not bound', metadata: { loop: LOOP_NAME, reason: 'gateway_absent' } });
  }
  const secret = ctx.env?.CLERK_SECRET_KEY;
  if (!secret) {
    // Skipped, NOT clean. Without the secret there is no Clerk side, so there is no comparison —
    // reporting a pass here would be the false-zero this loop exists to prevent.
    return done({ notes: 'clerk_secret_absent · cannot compare', metadata: { loop: LOOP_NAME, reason: 'clerk_secret_absent' } });
  }

  let workspaceIds: string[];
  try {
    workspaceIds = await gw.listWorkspaceIds(MAX_WORKSPACES);
  } catch (e) {
    return done({ status: 'failed', error: e instanceof Error ? e.message : String(e), metadata: { loop: LOOP_NAME, reason: 'enumeration_failed' } });
  }

  const results: ParityResult[] = [];
  const unmeasurable: Array<{ workspaceId: string; reason: string }> = [];

  for (const workspaceId of workspaceIds) {
    try {
      const clerkMembers = await gw.listClerkMembers(secret, workspaceId);
      if (clerkMembers === null) {
        // null means "could not ask Clerk". Treating it as an empty set would render a total
        // materialization failure as parity — the exact 260731 shape, inverted.
        unmeasurable.push({ workspaceId, reason: 'clerk_unreachable' });
        continue;
      }
      const dbMembers = await gw.listDbMembers(workspaceId);
      results.push(
        diffMemberships({
          workspaceId,
          clerk: clerkMembers.map((m) => ({ userId: m.userId, role: clerkRoleToWorkspaceRole(m.role) })),
          db: dbMembers.map((m) => ({ userId: m.userId, role: m.role })),
        }),
      );
    } catch (e) {
      unmeasurable.push({ workspaceId, reason: e instanceof Error ? e.message : String(e) });
    }
  }

  const summary = summarizeParity(results);

  // 'degraded' when ANYTHING diverged OR anything could not be measured. Divergence is the finding;
  // unmeasurability is the finding about the finding, and both must be visible in the status, not
  // only in metadata that nobody reads.
  const status: CronHandlerResult['status'] =
    summary.diverged > 0 || unmeasurable.length > 0 ? 'degraded' : 'completed';

  return done({
    status,
    actions_taken: 0, // observe-only, by contract
    notes:
      `${summary.workspaces} measured, ${summary.diverged} diverged, ` +
      `${unmeasurable.length} unmeasurable · OBSERVE-ONLY (nothing reconciled)`,
    metadata: {
      loop: LOOP_NAME,
      ...summary,
      unmeasurable,
      // The stranded/ghost ids, bounded, for the operator console. Divergence without WHO is a
      // number nobody can act on.
      details: results
        .filter((r) => r.diverged)
        .slice(0, 20)
        .map((r) => ({ workspaceId: r.workspaceId, clerkOnly: r.clerkOnly, dbOnly: r.dbOnly, clerkCount: r.clerkCount, dbCount: r.dbCount })),
    },
  });
};
