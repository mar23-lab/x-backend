// src/workers/lib/clerk-db-membership-parity.ts · the PURE set-difference behind the parity loop.
//
// WHY A COMPARATOR EXISTS AT ALL
// ------------------------------
// Two accepted Clerk invitations sat unmaterialized in the Xlooop database for two days with every
// gate green. Measured 2026-07-31, both sides at the same moment:
//
//     Clerk    Honest & Young — 3 members
//     Xlooop   workspace_members for that org — 1 row
//
// Nothing compared them. That is the estate's "two correct lists, no comparator" class: each side was
// internally consistent, and the divergence was invisible because no third thing looked at both.
//
// A comparator is not a fix. session.ts now materializes accepted memberships server-side (A5 Option
// B), which closes the known cause. This exists for the NEXT cause — a webhook that never fires, a
// revocation Clerk applies and we do not, a store guard that starts refusing. Detection has to be
// independent of the mechanism it watches, or it only ever catches the bug you already fixed.
//
// PURE BY CONSTRUCTION. No I/O, no clock, no env. The cron arm supplies both sides and persists the
// verdict; everything decidable is decided here so it is unit-testable without Clerk or a database.
// The same shape already ships as scripts/verify-clerk-db-membership-parity.mjs for operator runs;
// this is that contract on the RUNTIME plane, so the check no longer depends on someone remembering
// to run a script with a secret in their shell.

/** One membership on either side, normalized to the fields both planes actually agree on. */
export interface ParityMember {
  userId: string;
  /** Workspace role on the DB side; the Clerk role mapped through clerkRoleToWorkspaceRole. */
  role: string;
}

export interface ParityInput {
  workspaceId: string;
  clerk: ParityMember[];
  db: ParityMember[];
}

export interface ParityResult {
  workspaceId: string;
  /** In Clerk, absent from the DB. THE HARMFUL DIRECTION: a customer who cannot work. */
  clerkOnly: string[];
  /** In the DB, absent from Clerk. Authority Clerk can no longer revoke. */
  dbOnly: string[];
  /** Present both sides, roles disagree. Advisory — see the note below. */
  roleMismatch: Array<{ userId: string; clerk: string; db: string }>;
  clerkCount: number;
  dbCount: number;
  diverged: boolean;
}

/**
 * Set difference in BOTH directions, because the two directions are different incidents.
 *
 * `clerkOnly` is someone Clerk says belongs here and the product does not — they sign in and cannot
 * work. `dbOnly` is the inverse and is security-shaped: the product grants access Clerk believes it
 * has removed, so revoking in Clerk does not revoke in Xlooop.
 *
 * Role mismatch is reported but does NOT set `diverged`, deliberately. The mapping is intentionally
 * lossy — clerkRoleToWorkspaceRole collapses every unknown Clerk role to `viewer` — and an operator
 * may legitimately promote a member through PATCH /members/:id/role with no corresponding Clerk
 * change. Escalating that to a divergence would make the loop cry wolf on ordinary administration,
 * and an alarm that fires on normal operations is one that gets muted.
 */
export function diffMemberships(input: ParityInput): ParityResult {
  const clerkById = new Map<string, ParityMember>();
  for (const m of input.clerk) if (m && m.userId) clerkById.set(m.userId, m);
  const dbById = new Map<string, ParityMember>();
  for (const m of input.db) if (m && m.userId) dbById.set(m.userId, m);

  const clerkOnly: string[] = [];
  const roleMismatch: Array<{ userId: string; clerk: string; db: string }> = [];
  for (const [userId, m] of clerkById) {
    const d = dbById.get(userId);
    if (!d) clerkOnly.push(userId);
    else if (d.role !== m.role) roleMismatch.push({ userId, clerk: m.role, db: d.role });
  }
  const dbOnly: string[] = [];
  for (const userId of dbById.keys()) if (!clerkById.has(userId)) dbOnly.push(userId);

  clerkOnly.sort();
  dbOnly.sort();
  roleMismatch.sort((a, b) => a.userId.localeCompare(b.userId));

  return {
    workspaceId: input.workspaceId,
    clerkOnly,
    dbOnly,
    roleMismatch,
    clerkCount: clerkById.size,
    dbCount: dbById.size,
    diverged: clerkOnly.length > 0 || dbOnly.length > 0,
  };
}

/** Roll several workspaces into one loop verdict. Separated so the cron arm stays declarative. */
export function summarizeParity(results: ParityResult[]): {
  workspaces: number;
  diverged: number;
  clerkOnlyTotal: number;
  dbOnlyTotal: number;
  roleMismatchTotal: number;
  divergedWorkspaceIds: string[];
} {
  const divergedWorkspaceIds = results.filter((r) => r.diverged).map((r) => r.workspaceId).sort();
  return {
    workspaces: results.length,
    diverged: divergedWorkspaceIds.length,
    clerkOnlyTotal: results.reduce((n, r) => n + r.clerkOnly.length, 0),
    dbOnlyTotal: results.reduce((n, r) => n + r.dbOnly.length, 0),
    roleMismatchTotal: results.reduce((n, r) => n + r.roleMismatch.length, 0),
    divergedWorkspaceIds,
  };
}
