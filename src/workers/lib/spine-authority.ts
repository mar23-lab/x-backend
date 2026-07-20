// spine-authority.ts · OA cutover (260708) · the flag-gated governed-write authority gate for the
// operational-spine + mcp-gateway write routes, PLUS the read-side projection the UI consumes so an affordance
// can never contradict enforcement (B1).
//
// ONE decision core, TWO consumers:
//   - ENFORCE  (writes): authorizeSpineWrite(ctx, action) gates the 12 spine/mcp write sites.
//   - PROJECT  (reads):  projectSpineAuthority(ctx, opts) returns the SAME decision for every SpineAction, so
//     GET /session can tell the UI which governed writes are allowed right now (and why not). Because both
//     call decideSpineAction(), the button's enabled/disabled state and the server's 403 are computed by the
//     same code — no "enabled control → 403" drift, in either flag state.
//
// DEFAULT (ENTITLEMENT_ENFORCEMENT != 'on'): authority is BYTE-IDENTICAL to the legacy canWrite(role) gate —
// zero behaviour change in prod, no extra DB read on the write path. FLIPPED ON (operator-named): authority =
// ENTITLEMENT + MODE + ACTION via canActOnSpine(resolvePrincipal(...)); mode is read SERVER-SIDE from
// user_session_preferences (migration 052), never client-asserted. Service principals are exempt (they carry
// issuance-scoped authority enforced by a downstream guard). See docs/governance/OPERATOR_AXIS_AUTHORITY.md.

import type { Context } from 'hono';
import { neonClient, type Sql } from '../db/client';
import { canWrite, canActOnSpine, type SpineAction, type SpineWriteDecision, type SpineDenyReason } from './permissions';
import { resolvePrincipal } from '../dal/principal-hydration';
import { observeRoleSkillResolution } from './role-skill-shadow';

/** The full governed action set — the projection covers every one so the UI never guesses. */
export const SPINE_ACTIONS: readonly SpineAction[] = [
  'packet:create', 'evidence:submit', 'approval:request', 'approval:decide', 'tool_event:report',
  'metric_delta:record', 'customer_data:export', 'customer_data:delete', 'customer_data:execute',
  'authority:revoke', 'member:invite', 'token:create', 'token:read', 'signoff:decide',
  'event:ingest', 'event:self_service', 'policy:write', 'runtime:configure',
] as const;

/** True only when the operator has flipped ENTITLEMENT_ENFORCEMENT='on' (default off ⇒ legacy path). */
export function entitlementEnforcementOn(env: unknown): boolean {
  return String((env as { ENTITLEMENT_ENFORCEMENT?: string } | undefined)?.ENTITLEMENT_ENFORCEMENT || 'off').toLowerCase() === 'on';
}

type SpineAuth = { role?: string; user_id?: string; workspace_id?: string; service_principal?: string };

/** The legacy role gate — no DB read. Used for the flag-off path AND for service principals (§5c Gate 2). */
function legacyDecision(auth: SpineAuth | undefined): SpineWriteDecision {
  return canWrite(auth?.role)
    ? { allowed: true, reason: 'active_entitlement' }
    : { allowed: false, reason: 'mode_not_allowed' };
}

/** Injectable Sql seam: a test (or the caller) may pre-set ctx.get('sql'); else build the Neon client from env.
 *  This lets the flag-on path be exercised end-to-end against a seeded DB without the Neon HTTP driver. */
function sqlFor(ctx: Context): Sql {
  return (ctx.get('sql') as Sql | undefined) ?? neonClient((ctx.env as { DATABASE_URL?: string }).DATABASE_URL);
}

/**
 * The resolved enforcement context for the flag-ON path (human users). Resolved ONCE so the projection can
 * evaluate all 18 actions (SPINE_ACTIONS) without re-reading the DB per action.
 */
async function resolveEnforcement(ctx: Context, auth: SpineAuth, presetMode?: 'watch' | 'test' | 'operator') {
  const dal = ctx.get('dal') as { getOperatingMode(u: string, w: string): Promise<'watch' | 'test' | 'operator'> };
  const mode = presetMode ?? (await dal.getOperatingMode(auth?.user_id || '', auth?.workspace_id || ''));
  const principal = await resolvePrincipal(sqlFor(ctx), auth as never);
  return { mode, principal };
}

/**
 * Governed-write authority for ONE spine/mcp action — the ENFORCEMENT entry point (writes).
 *   - flag OFF (default) or service principal: legacy canWrite(role), no DB read (byte-identical to today).
 *   - flag ON, human: entitlement + mode + action (canActOnSpine); operator-mode required, deny-wins, fail-closed.
 */
export async function authorizeSpineWrite(ctx: Context, action: SpineAction): Promise<SpineWriteDecision> {
  const auth = ctx.get('auth') as SpineAuth | undefined;
  // Compute the decision exactly as before (return value UNCHANGED in both flag states) …
  let decision: SpineWriteDecision;
  // …carrying the effective mode for the shadow: the legacy path is mode-blind and grants like operator,
  // so 'operator' is the honest shadow label there; the enforce path uses the real resolved mode.
  let mode: 'watch' | 'test' | 'operator' = 'operator';
  // ENTITLEMENT flip (260720): CUSTOMER agent tokens (service_principal==='customer_token') now go
  // through canActOnSpine (the mandate: customer agents are entitlement-gated). PLATFORM service
  // principals (canary_lifecycle/canary_read — the deploy-verification system) KEEP the legacy path;
  // they are trusted platform identities, not customer agents. Removing their exemption would deny the
  // canary (0 entitlement) and blind deploy verification.
  const isPlatformService = !!auth?.service_principal && auth.service_principal !== 'customer_token';
  if (!entitlementEnforcementOn(ctx.env) || isPlatformService) {
    decision = legacyDecision(auth);
  } else {
    const resolved = await resolveEnforcement(ctx, auth ?? {});
    mode = resolved.mode;
    decision = canActOnSpine(resolved.principal, 'xlooop', mode, action);
    if (!decision.allowed) {
      // Structured denial reason for staging debuggability (server-side observability only; NOT in the 403 body).
      try {
        console.warn(JSON.stringify({ evt: 'spine_authority.deny', action, reason: decision.reason, user_id: auth?.user_id, workspace_id: auth?.workspace_id }));
      } catch { /* best-effort */ }
    }
  }
  // OAR-W2 shadow observer: fires on BOTH paths (the legacy path is what executes in prod today), so
  // role/skill resolution coverage + receipts move off zero. Flag-gated internally (default OFF ⇒
  // byte-identical no-op, no DB read); never throws; receipt write deferred to ctx.executionCtx.waitUntil.
  observeRoleSkillResolution(
    ctx,
    { allowed: decision.allowed, reason: decision.reason },
    {
      action,
      role: auth?.role ?? 'unknown',
      mode,
      workspace_id: auth?.workspace_id ?? '',
      principal_id: auth?.user_id ?? '',
      service_principal: !!auth?.service_principal,
      intent: null,
    },
  );
  return decision;
}

/** Per-site options that preserve a migrated inline gate's EXACT legacy predicate (P5(b)). */
export interface GovernedWriteOpts {
  /** Platform-admin overlay (template-policy class): `auth.is_admin === true` passes in BOTH flag states.
   *  HONESTY NOTE (declared-axes verify 260708): on the current mounts `is_admin` is set ONLY by
   *  requireAdmin() (adminRoutes), which does NOT front templatePolicyRegistryRoute — so this branch is
   *  presently UNREACHABLE there and exists solely to reproduce the legacy `canAdminMutate` predicate SHAPE
   *  byte-for-byte (the old inline check read the same never-set field). It becomes live only if the route
   *  is ever mounted behind requireAdmin. */
  adminOverride?: boolean;
  /** Sites whose legacy predicate EXCLUDED service principals (e.g. template-policy `canAdminMutate`):
   *  deny them in BOTH flag states instead of applying the spine service-principal exemption. */
  denyServicePrincipals?: boolean;
}
// PROJECTION-vs-OPTS CONTRACT (declared-axes verify 260708): projectSpineAuthority evaluates the plain
// decision core WITHOUT per-site GovernedWriteOpts. That is exact for every actor who can consume the
// projection — GET /session is Clerk-human-only, and for Clerk humans on current mounts is_admin is never
// set and service_principal never applies, so projection == enforcement for all 18 actions. The latent
// divergence (an is_admin admin or a service principal seeing a different policy:write outcome) concerns
// actors who CANNOT reach the projection; if /session is ever exposed to those principals, project
// policy:write with its site opts.

/**
 * P5(b) · governed-write authority for the inline-gated sites (authority:revoke · member:invite ·
 * token:create/read · signoff:decide · event:ingest/self_service · policy:write). Same decision core as
 * authorizeSpineWrite; the opts reproduce each site's legacy predicate byte-identically while the flag is
 * off, so migrating a site changes NOTHING until the operator flips ENTITLEMENT_ENFORCEMENT.
 */
export async function authorizeGovernedWrite(
  ctx: Context,
  action: SpineAction,
  opts: GovernedWriteOpts = {},
): Promise<SpineWriteDecision> {
  const auth = ctx.get('auth') as (SpineAuth & { is_admin?: boolean }) | undefined;
  if (opts.denyServicePrincipals && auth?.service_principal) {
    return { allowed: false, reason: 'mode_not_allowed' };
  }
  if (opts.adminOverride && auth?.is_admin === true) {
    return { allowed: true, reason: 'active_entitlement' };
  }
  return authorizeSpineWrite(ctx, action);
}

/** The wire shape the UI consumes (mirrors the M4 withAuthority envelope: allowed set + per-action reasons). */
export interface SpineAuthorityEnvelope {
  allowed_actions: SpineAction[];
  disabled_reasons: Partial<Record<SpineAction, SpineWriteDecision['reason']>>;
  /** true once ENTITLEMENT_ENFORCEMENT is on — the UI can label mode as authority-bearing vs presentation. */
  enforced: boolean;
}

/**
 * Per-action authority PROJECTION for the current caller — the READ side the UI renders (B1). Returns the SAME
 * decision authorizeSpineWrite would return for each action, so an enabled control can never 403 (nor a hidden
 * one silently succeed). Resolves the DB ONCE on the flag-on path. `opts.auth` / `opts.mode` let GET /session
 * pass the caller it already resolved (it is not always ctx.get('auth')).
 */
export async function projectSpineAuthority(
  ctx: Context,
  opts?: { auth?: SpineAuth; mode?: 'watch' | 'test' | 'operator' },
): Promise<SpineAuthorityEnvelope> {
  const auth = opts?.auth ?? (ctx.get('auth') as SpineAuth | undefined) ?? {};
  const enforced = entitlementEnforcementOn(ctx.env);
  const map = {} as Record<SpineAction, SpineWriteDecision>;

  if (!enforced || auth.service_principal) {
    const d = legacyDecision(auth); // action-blind on the legacy path (matches enforcement)
    for (const a of SPINE_ACTIONS) map[a] = d;
  } else {
    const { mode, principal } = await resolveEnforcement(ctx, auth, opts?.mode);
    for (const a of SPINE_ACTIONS) map[a] = canActOnSpine(principal, 'xlooop', mode, a);
  }
  return { ...toEnvelope(map), enforced };
}

/** Shape the raw per-action decision map into the wire envelope (allowed set + reasons for the denied). */
export function toEnvelope(map: Record<SpineAction, SpineWriteDecision>): Omit<SpineAuthorityEnvelope, 'enforced'> {
  const allowed_actions: SpineAction[] = [];
  const disabled_reasons: Partial<Record<SpineAction, SpineWriteDecision['reason']>> = {};
  for (const a of SPINE_ACTIONS) {
    const d = map[a];
    if (d?.allowed) allowed_actions.push(a);
    else disabled_reasons[a] = d?.reason ?? ('mode_not_allowed' as SpineDenyReason);
  }
  return { allowed_actions, disabled_reasons };
}
