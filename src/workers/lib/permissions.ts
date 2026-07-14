// permissions.ts — central RBAC SSOT (P4 · single-intake+RBAC program, 260629).
//
// Consolidates the role/capability + MB-P-operator-identity helpers that were DUPLICATED verbatim across the
// worker routes (operator directive: "roles respected with the right permissions, enforced in one place" +
// "consolidate duplicates"). These are PURE functions, behavior-identical to the inlined originals they
// replace — no policy change, just one auditable source so the RBAC surface can be reasoned about + extended
// (e.g. a future `developer` role) in a single place instead of N scattered copies.
//
// Increment 1 (260629): canWrite — was duplicated VERBATIM in operational-spine.ts + mcp-gateway.ts.
// Increment 2 (260629): isOperatorRole (was in synthetic-domains.ts) + operatorIds (was triplicated in
// workspaces.ts + graph.ts + synthetic-domains.ts) — same SSOT, behavior-identical.
//
// Increment 3 (Wave OA-SAFE, 260708): adds the CANONICAL entitlement-backed helper canActOnSpine()
// (authority = entitlement + mode + action via evaluateAppAccess; deny-wins; operator-mode-required;
// fail-closed). canWrite/isOperatorRole are now @deprecated legacy shims (behaviour-IDENTICAL — routes still
// use them; canActOnSpine is NOT wired into any route yet, because the entitlement source
// (customer_entitlements) is empty in prod and the middleware does not attach a principal/mode). The cutover
// is operator-gated + staged. See docs/governance/OPERATOR_AXIS_AUTHORITY.md.

import type { AuthenticatedPrincipal, OperatingMode, XcpAppId } from '../dal/types/xcp-identity-contracts';
import { evaluateAppAccess } from '../dal/types/xcp-identity-contracts';

/**
 * @deprecated LEGACY role-string gate — CONFLATES the `operator` OperatingMode with a MembershipRole. It
 * ignores entitlement status/expiry/allowed_modes/allowed_actions and is NOT canonical authority. Do not add
 * new callers. Migrate governed writes to `canActOnSpine(principal, appId, mode, action)` at the cutover.
 * Retained behaviour-identical so existing routes + permissions.test.ts stay green during migration.
 * Roles permitted to WRITE the operational spine; viewer + client are read-only. */
export function canWrite(role: string | undefined): boolean {
  return role === 'owner' || role === 'operator';
}

/**
 * @deprecated LEGACY role-string gate for operator-only READ surfaces. Same operator-mode-as-role conflation
 * as canWrite. Do not extend. Behaviour-identical; migrate to entitlement/visibility at the cutover.
 * Owner/operator role — gates operator-only READ surfaces (synthetic-domain authorship, cockpit chat, audit
 * log, data-graph rebuild). Pair with the per-route isMbpOperator() for the orgless fallback. */
export function isOperatorRole(role: string | undefined): boolean {
  return role === 'owner' || role === 'operator';
}

/** MB-P operator identity by stable user_id. The default operator runs an ORGLESS personal Clerk session
 *  (role resolves to 'viewer', workspace_id=''), so a role-only gate would 403 them — match by user_id too.
 *  Structural env type so every route's `*Env` (each carries these two fields) is compatible without import. */
export function operatorIds(
  env: { MBP_OWNER_USER_ID?: string; MBP_OWNER_LINKED_USER_IDS?: string } | null | undefined,
): { ownerUserId: string; ids: string[] } {
  const ownerUserId = String(env?.MBP_OWNER_USER_ID || '').trim();
  const linked = String(env?.MBP_OWNER_LINKED_USER_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return { ownerUserId, ids: [ownerUserId, ...linked].filter(Boolean) };
}

/** MB-P operator by stable user_id (the orgless personal-session fallback — see operatorIds). */
export function isMbpOperator(
  userId: string | undefined,
  env: { MBP_OWNER_USER_ID?: string; MBP_OWNER_LINKED_USER_IDS?: string } | null | undefined,
): boolean {
  if (!userId) return false;
  return operatorIds(env).ids.includes(userId);
}

/** Owner or operator (incl. the orgless MB-P operator by stable user_id). Denies viewer/client/service
 *  tokens. S3 consolidation (260709): was byte-identical per-route copies in model-runtimes.ts and
 *  synthetic-domains.ts — ONE driver so the operator-context predicate can never fork per-route. */
export function isOperatorContext(
  auth: { role?: string; user_id?: string },
  env: { MBP_OWNER_USER_ID?: string; MBP_OWNER_LINKED_USER_IDS?: string } | null | undefined,
): boolean {
  return isOperatorRole(auth.role) || isMbpOperator(auth.user_id, env);
}

// ─────────────────────────────────────────────────────────────────────────────
// CANONICAL entitlement-backed governed-write authority (Wave OA-SAFE · handoff bundle).
// Authority = ENTITLEMENT + MODE + ACTION, never a role string. NOT wired into any route yet.
// ─────────────────────────────────────────────────────────────────────────────

/** Governed spine actions, namespaced so allowed_actions / denied_actions can grant/revoke individually.
 *  P5(b) extended the vocabulary beyond the operational-spine to the inline-gated governed writes
 *  (authority-consent revoke · member invite · connector tokens · sign-offs · event ingestion/self-service ·
 *  template-policy writes) so ONE decision core covers every canWrite-class gate. */
export type SpineAction =
  | 'packet:create'
  | 'evidence:submit'
  | 'approval:request'
  | 'approval:decide'
  | 'tool_event:report'
  | 'metric_delta:record'
  | 'customer_data:export'
  | 'customer_data:delete'
  | 'customer_data:execute'
  | 'authority:revoke'
  | 'member:invite'
  | 'token:create'
  | 'token:read'
  | 'signoff:decide'
  | 'event:ingest'
  | 'event:self_service'
  | 'policy:write'
  | 'runtime:configure';

export type SpineDenyReason =
  | 'missing_entitlement'
  | 'entitlement_not_active'
  | 'mode_not_allowed'
  | 'session_expired'
  | 'mode_requires_operator'
  | 'action_denied'
  | 'action_not_allowed';

export interface SpineWriteDecision {
  allowed: boolean;
  reason: 'active_entitlement' | SpineDenyReason;
}

function actionMatches(list: string[], action: SpineAction): boolean {
  return list.includes('*') || list.includes(action);
}

/**
 * CANONICAL governed-write authority. Authority is ENTITLEMENT + MODE + ACTION — never a role string.
 * `operator` is an OperatingMode; this asks evaluateAppAccess() whether the principal may act in operator
 * mode on `appId`, then applies the action allow/deny lists. The frontend role label is NEVER consulted.
 *   - session expiry / entitlement status / allowed_modes → via evaluateAppAccess()
 *   - governed spine writes REQUIRE operator mode → watch/test are denied
 *   - denied_actions ALWAYS override (deny wins) · allowed_actions must include the action (or '*')
 * NOT wired into any route yet — the entitlement source is empty in prod (see OPERATOR_AXIS_AUTHORITY.md).
 */
export function canActOnSpine(
  principal: AuthenticatedPrincipal,
  appId: XcpAppId,
  mode: OperatingMode,
  action: SpineAction,
  now: Date = new Date(),
): SpineWriteDecision {
  // Governed spine writes are operator-class — a watch/test session cannot perform them, regardless of
  // entitlement. This is an AXIS rule (mode), not a role check.
  if (mode !== 'operator') {
    return { allowed: false, reason: 'mode_requires_operator' };
  }
  const decision = evaluateAppAccess(principal, appId, 'operator', now);
  if (!decision.allowed || !decision.entitlement) {
    return { allowed: false, reason: decision.reason as SpineDenyReason };
  }
  const ent = decision.entitlement;
  if (actionMatches(ent.denied_actions, action)) {
    return { allowed: false, reason: 'action_denied' }; // deny wins
  }
  if (!actionMatches(ent.allowed_actions, action)) {
    return { allowed: false, reason: 'action_not_allowed' };
  }
  return { allowed: true, reason: 'active_entitlement' };
}
