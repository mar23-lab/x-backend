// operator-workspace-scope.ts · JA (260714) — the ONE resolver for an operator-scoped read workspace.
//
// PROBLEM this closes: the operator OWNS a big workspace (via workspaces.owner_user_id + the workspace-
// switcher) but their Clerk JWT active org is a different small one. The cockpit chat + current-work
// projection scope events to auth.workspace_id (the JWT org) ONLY, so they ground in the small org while
// the Events rail shows the selected big one — the two surfaces diverge.
//
// THE RESOLUTION (security-critical). Flag OFF (default, OPERATOR_WORKSPACE_SCOPE_ENABLED undeclared) ⇒
// this returns auth.workspace_id UNCONDITIONALLY, ignoring any requested id — byte-identical to today.
// Flag ON:
//   1. no requested id, OR requested === auth.workspace_id  → auth.workspace_id (unchanged).
//   2. a DIFFERENT requested id → dal.userCanScopeWorkspace(user_id, requested):
//        TRUE  (owner OR active member) → the requested id.
//        FALSE → HARD 403 FORBIDDEN (customer-safe envelope). NEVER a silent fall-back to the token org —
//                an unauthorized override is a denial, not a quiet read of a different workspace.
//
// TENANT-SAFE BY CONSTRUCTION: the ONLY way to read a non-JWT workspace is to pass the owner/active-member
// authorization check; every other path resolves to the verified JWT org.

import { envFlagTrue } from './env-flag';
import type { DalAdapter } from '../dal/DalAdapter';

export interface ScopeCtx {
  get: (k: 'request_id') => unknown;
  status: (n: number) => void;
  json: (o: unknown) => Response;
}

export type ScopeResult = { ok: true; ws: string } | { ok: false; res: Response };

/**
 * Resolve the effective read workspace for an operator-scoped surface.
 * @param flag        raw env value of OPERATOR_WORKSPACE_SCOPE_ENABLED (undeclared ⇒ OFF ⇒ auth org).
 * @param authWs      the verified JWT workspace (auth.workspace_id) — the default + safe floor.
 * @param userId      the caller (auth.user_id) — authorized against the requested workspace.
 * @param requested   the requested workspace id (query param / body field), or null/undefined.
 * @param dal         DAL facade exposing userCanScopeWorkspace (owner OR active-member predicate).
 * @param requireOwner when true (governed WRITES), authorize via dal.userOwnsWorkspace (owner_user_id
 *                     ONLY) instead of the owner-OR-member read predicate — a mere member cannot redirect
 *                     a write to a non-token workspace. Defaults to false (read semantics, unchanged).
 */
export async function resolveScopedWorkspace(
  ctx: ScopeCtx,
  flag: string | undefined,
  authWs: string,
  userId: string,
  requested: string | null | undefined,
  dal: DalAdapter,
  requireOwner = false,
): Promise<ScopeResult> {
  // Flag OFF (default) — byte-identical to today: the requested id is never even looked at.
  if (!envFlagTrue(flag)) return { ok: true, ws: authWs };

  const want = String(requested ?? '').trim();
  // No override, or the requested id IS the JWT org → unchanged.
  if (!want || want === authWs) return { ok: true, ws: authWs };

  // A DIFFERENT workspace is requested — authorize the caller against it. WRITES require ownership
  // (owner_user_id only); READS accept owner OR active member.
  const allowed = requireOwner
    ? await dal.userOwnsWorkspace(userId, want)
    : await dal.userCanScopeWorkspace(userId, want);
  if (!allowed) {
    ctx.status(403);
    return {
      ok: false,
      res: ctx.json({ error: 'you are not authorized to scope to this workspace', code: 'FORBIDDEN', request_id: ctx.get('request_id') }),
    };
  }
  return { ok: true, ws: want };
}
