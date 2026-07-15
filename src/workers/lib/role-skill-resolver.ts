// role-skill-resolver.ts · OAR-W2 (260713) · mechanical role→skill resolution KERNEL (shadow, default-off).
//
// WHY (ADR-ABS-006 + OAR mission Phase 3). Role AUTHORITY is already mechanical and server-side
// (lib/spine-authority.ts → permissions.ts canActOnSpine). SKILL selection, by contrast, has never
// existed as a runtime concept — skills were post-hoc lineage labels from a YAML manifest. This kernel
// resolves (principal role, mode, action, intent, tenant signals) → a RoleSkillResolution: which role
// and skill versions apply, which tools are allowed/denied, whether approval is required, a
// CUSTOMER-SAFE explanation (no internal ids), plus a deny-wins verdict that composes with — never
// replaces — the entitlement decision.
//
// PURE by construction: no IO, no Date.now, no throw (mirrors services/policy-engine.ts:evaluateGovernedWrite).
// The DB read (the installed skill bindings) happens in the shadow observer; this kernel is pure over the
// bindings it is handed and over an injected `now`, so it is fully unit-testable and can run inside an
// observer that must never break the write path.
//
// v0 REALITY: the customer skill catalog (mig-035 template_definitions, category 'skill') has ZERO
// published rows until the publisher runs (OAR-W3). So at runtime today the observer passes an (almost)
// empty binding set and the kernel HONESTLY reports skill_coverage='no_catalog' — the mission metric
// "skill-resolution coverage" starts measured-and-low, never faked. As catalog rows appear, the observer
// layers them in and coverage rises with zero kernel change.

/** Resolution order (mission Phase 3): platform safety → workspace → role entitlements → project →
 *  client → intent/task → user prefs → model defaults. In v0 most layers are pass-through (no data yet);
 *  the gates implemented below are the ones with real signals today. */

export interface RoleSkillBinding {
  /** the membership/agent role this binding applies to; '*' = any role */
  role: string;
  skill_key: string;
  skill_version: string;
  lifecycle: 'active' | 'deprecated' | 'blocked';
  /** spine actions this skill covers; '*' = any governed action */
  actions: string[];
  allowed_tools: string[];
  denied_tools: string[];
  requires_approval?: boolean;
  /** provenance for the receipt (never surfaced to customers). */
  source: 'v0-floor' | 'catalog' | 'internal-service';
}

export interface RoleSkillResolutionInput {
  tenant: string; // workspace_id
  principal: string; // user_id
  role: string; // membership role (operator/owner/collaborator/viewer/client) or agent id
  mode: string; // operating mode (operator/test/watch)
  action: string; // SpineAction
  serviceP?: boolean; // service principal (automation)
  intent?: string | null;
  /** from principal hydration: did an active entitlement row exist? undefined = not evaluated (shadow) */
  entitlementActive?: boolean;
  /** Read-only assistant operations do not require operator mode. Defaults true for governed writes. */
  requiresOperatorMode?: boolean;
  /** true when the resource's tenant differs from the principal's tenant */
  tenantMismatch?: boolean;
}

export type ResolverDenyReason =
  | 'tenant_mismatch'
  | 'mode_requires_operator'
  | 'entitlement_missing'
  | 'skill_stale'
  | 'skill_not_installed';

export type SkillCoverage = 'resolved' | 'no_skill_for_action' | 'no_catalog';

export interface RoleSkillVerdict {
  allowed: boolean;
  reason: 'resolved' | ResolverDenyReason;
}

export interface RoleSkillResolution {
  schema_id: 'xlooop.role_skill_resolution.v1';
  selected_role: string;
  selected_role_version: string;
  selected_skills: Array<{ key: string; version: string }>;
  allowed_tools: string[];
  denied_tools: string[];
  required_approvals: string[];
  context_policy: 'role-scoped';
  skill_coverage: SkillCoverage;
  verdict: RoleSkillVerdict;
  /** CUSTOMER-SAFE: role + action-family + outcome only. NEVER principal/tenant/version/internal ids. */
  safe_explanation: string;
  expires_at: string; // ISO
}

/** v0 role→skill floor. Deliberately EMPTY of customer skills: no customer skill catalog is published
 *  until OAR-W3/W4. Kept as an explicit const (not implicit) so the honest "no_catalog" state is a
 *  measured floor, not an accident. Automation-agent skill labels live in docs/contracts/agent-roles.yml
 *  and are consumed by the lineage layer (AGENT_ROLE_REGISTRY) — NOT here, since crons do not transit
 *  authorizeSpineWrite as customer principals. */
export const ROLE_SKILL_V0_FLOOR: readonly RoleSkillBinding[] = Object.freeze([]);

const RESOLUTION_TTL_MS = 15 * 60 * 1000; // 15 min — a resolution is a short-lived authorization artifact

/** All actions reaching authorizeSpineWrite are governed writes, so the operator-mode gate always applies. */
function isGovernedMode(mode: string): boolean {
  return mode === 'operator';
}

/** Map a SpineAction to a coarse, customer-safe family for the explanation (no internal action ids leak). */
function actionFamily(action: string): string {
  const head = action.split(':')[0] || 'operation';
  const FAMILIES: Record<string, string> = {
    packet: 'work item',
    evidence: 'evidence',
    approval: 'approval',
    signoff: 'sign-off',
    tool_event: 'activity',
    metric_delta: 'progress update',
    customer_data: 'data operation',
    member: 'member management',
    authority: 'access management',
    token: 'access token',
    policy: 'policy',
    event: 'activity',
    runtime: 'model settings',
    assistant: 'grounded assistance',
  };
  return FAMILIES[head] || 'operation';
}

function buildSafeExplanation(role: string, action: string, verdict: RoleSkillVerdict, coverage: SkillCoverage): string {
  const family = actionFamily(action);
  if (verdict.allowed) {
    return `Your ${role} role is authorized for this ${family} action.`;
  }
  switch (verdict.reason) {
    case 'mode_requires_operator':
      return `This ${family} action needs operator mode. Switch to operator mode to proceed.`;
    case 'entitlement_missing':
      return `Your workspace access does not currently permit this ${family} action.`;
    case 'tenant_mismatch':
      return `This ${family} action targets a different workspace than the one you are in.`;
    case 'skill_stale':
      return `The capability for this ${family} action is being updated and needs review before use.`;
    case 'skill_not_installed':
      return coverage === 'no_catalog'
        ? `No operating pack is installed for this ${family} action yet.`
        : `Your role does not include a capability for this ${family} action.`;
    default:
      return `This ${family} action is not available right now.`;
  }
}

/**
 * Resolve role + skills for one governed-write attempt. Pure; deny-wins by a fixed precedence so a
 * conflicting/partial policy always yields the MOST RESTRICTIVE outcome (mission test 6). The verdict
 * is advisory in shadow; when promoted to enforce it composes with canActOnSpine (deny > allow), never
 * loosening an existing deny.
 */
export function resolveRoleAndSkills(
  input: RoleSkillResolutionInput,
  bindings: readonly RoleSkillBinding[],
  now: Date,
): RoleSkillResolution {
  const selectedRole = input.serviceP ? 'service-principal' : input.role || 'unknown';

  // Applicable bindings: role matches (exact or wildcard) AND action covered (exact or wildcard).
  const applicable = bindings.filter(
    (b) => (b.role === input.role || b.role === '*') && (b.actions.includes('*') || b.actions.includes(input.action)),
  );
  const active = applicable.filter((b) => b.lifecycle === 'active');
  const staleOnly = applicable.length > 0 && active.length === 0;

  const selected_skills = active.map((b) => ({ key: b.skill_key, version: b.skill_version }));
  const denied_tools = [...new Set(active.flatMap((b) => b.denied_tools))];
  const allowed_tools = [...new Set(active.flatMap((b) => b.allowed_tools))].filter((t) => !denied_tools.includes(t));
  const required_approvals = active.some((b) => b.requires_approval) ? ['operator-signoff'] : [];

  const skill_coverage: SkillCoverage =
    active.length > 0
      ? 'resolved'
      : applicable.length > 0
        ? 'no_skill_for_action'
        : bindings.length === 0
          ? 'no_catalog'
          : 'no_skill_for_action';

  // Deny-wins precedence (most restrictive first). The first gate that fails sets the verdict.
  let verdict: RoleSkillVerdict = { allowed: true, reason: 'resolved' };
  if (input.tenantMismatch === true) {
    verdict = { allowed: false, reason: 'tenant_mismatch' };
  } else if (input.requiresOperatorMode !== false && !isGovernedMode(input.mode)) {
    verdict = { allowed: false, reason: 'mode_requires_operator' };
  } else if (input.entitlementActive === false) {
    verdict = { allowed: false, reason: 'entitlement_missing' };
  } else if (staleOnly) {
    verdict = { allowed: false, reason: 'skill_stale' };
  } else if (active.length === 0) {
    // role resolved, but no active skill grants this action → "role label alone does not grant skill"
    verdict = { allowed: false, reason: 'skill_not_installed' };
  }

  return {
    schema_id: 'xlooop.role_skill_resolution.v1',
    selected_role: selectedRole,
    selected_role_version: 'v0',
    selected_skills,
    allowed_tools,
    denied_tools,
    required_approvals,
    context_policy: 'role-scoped',
    skill_coverage,
    verdict,
    safe_explanation: buildSafeExplanation(selectedRole, input.action, verdict, skill_coverage),
    expires_at: new Date(now.getTime() + RESOLUTION_TTL_MS).toISOString(),
  };
}
