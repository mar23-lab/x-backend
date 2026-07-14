// policy-engine.ts — Stage-2 A7 · in-product governance policy evaluator (v0, PURE + INERT).
//
// WHY. MB-P (customer-zero) enforces governance with 371 file-native verifiers + git hooks — a
// single-user machinery that cannot run inside a multi-tenant SaaS. The product had the policy
// REGISTRY tables (policy_definitions / policy_decisions, mig 035) but NO evaluator: governance
// for customers was UI copy, not enforcement (PROD plan Tier-A gap A7). This module is the kernel:
// a set of pure evaluators keyed by policy_key that map a governed-write context to a decision.
//
// SCOPE (v0, deliberately inert): this file is a PURE library — it performs NO IO and is NOT wired
// into the write-authorization path. Wiring `evaluateGovernedWrite` into authorizeGovernedWrite
// behind POLICY_ENGINE_ENABLED (default off, byte-identical when off) + logging decisions to
// policy_decisions is a separate, flag-gated follow-on. Keeping the kernel isolated means it can be
// exhaustively unit-tested with zero risk to the live write path.
//
// The three seed policy classes genericize MB-P HARD_RULES that this very session's work proved
// matter: no-placeholder-semantics (ABS-P2 fabricated metric='' incident), evidence-required (a
// completion claim needs an evidence ref), archive-not-delete (HR-ARCHIVE-1). Each is a Tier-A
// PLATFORM capability — it belongs to no account.

export type PolicyDecision = 'allow' | 'deny' | 'require_approval' | 'redact' | 'quarantine';

export interface GovernedWriteContext {
  /** stable id of the policy being evaluated (matches policy_definitions.policy_key) */
  action: string;                 // e.g. 'goal.create', 'goal.complete', 'document.delete'
  fields?: Record<string, unknown>; // the write payload's inspectable fields
  role?: string;                  // actor role (owner/operator/contributor/reviewer/client)
  mode?: string;                  // watch/test/operator
}

export interface PolicyOutcome {
  policy_key: string;
  decision: PolicyDecision;
  reason: string;
}

/** A pure evaluator: given the write context, return an outcome (or null if the policy does not
 *  apply to this action). No IO, no throw. */
export type PolicyEvaluator = (ctx: GovernedWriteContext) => PolicyOutcome | null;

// ---------------------------------------------------------------------------
// Seed policy classes (genericized MB-P HARD_RULES). Registry keyed by policy_key.
// ---------------------------------------------------------------------------

/** no-placeholder-semantics: a written field must not carry a fabricated placeholder value that
 *  masquerades as real data (empty-string metric name, 0/NaN target presented as a target,
 *  '{}' derivation presented as provenance). Born from the ABS-P2 metric=''/target=0 incident. */
const noPlaceholderSemantics: PolicyEvaluator = (ctx) => {
  const f = ctx.fields ?? {};
  const bad: string[] = [];
  // a metric NAME present-but-empty is a fabricated field
  if ('metric_name' in f && typeof f.metric_name === 'string' && f.metric_name.trim() === '') {
    bad.push('metric_name is an empty-string placeholder');
  }
  // a target of exactly 0 alongside an empty metric name is the classic placeholder pair
  if (f.metric_name === '' && (f.target_value === 0 || f.target_value === '0')) {
    bad.push('metric_name+target_value are the empty/0 placeholder pair');
  }
  if (bad.length === 0) return null;
  return { policy_key: 'no-placeholder-semantics', decision: 'deny', reason: bad.join('; ') };
};

/** evidence-required-for-completion: marking a goal/packet/roadmap-item as done/achieved requires an
 *  evidence reference. Genericizes MB-P's evidence-bound-assertion + no-stage-complete-without-evidence. */
const evidenceRequiredForCompletion: PolicyEvaluator = (ctx) => {
  const completes = /\.(complete|achieve|signoff)$/.test(ctx.action)
    || ctx.fields?.status === 'achieved' || ctx.fields?.status === 'done' || ctx.fields?.status === 'completed';
  if (!completes) return null;
  const ev = ctx.fields?.evidence_ref_id ?? ctx.fields?.evidence_refs;
  const hasEvidence = (typeof ev === 'string' && ev.length > 0)
    || (Array.isArray(ev) && ev.length > 0);
  if (hasEvidence) return null;
  return {
    policy_key: 'evidence-required-for-completion',
    decision: 'require_approval',
    reason: 'completion asserted without an evidence reference',
  };
};

/** archive-not-delete: hard-delete of a governed record is denied; the caller must soft-delete/archive.
 *  Genericizes HR-ARCHIVE-1 (never delete; archive instead). */
const archiveNotDelete: PolicyEvaluator = (ctx) => {
  if (!/\.(delete|destroy|purge)$/.test(ctx.action)) return null;
  if (ctx.fields?.hard === true || ctx.fields?.mode === 'hard') {
    return {
      policy_key: 'archive-not-delete',
      decision: 'deny',
      reason: 'hard-delete of a governed record is forbidden; soft-delete/archive instead',
    };
  }
  return null;
};

/** Registry: policy_key -> evaluator. A DB `policy_definitions` row is ACTIVE governance only when
 *  its policy_key resolves here AND lifecycle_state='active' (the caller supplies the active set). */
export const POLICY_EVALUATORS: Record<string, PolicyEvaluator> = {
  'no-placeholder-semantics': noPlaceholderSemantics,
  'evidence-required-for-completion': evidenceRequiredForCompletion,
  'archive-not-delete': archiveNotDelete,
};

/** Evaluate every ACTIVE policy against a governed-write context. `activePolicyKeys` is the set of
 *  policy_definitions.policy_key with lifecycle_state='active' for the tenant (the caller loads it;
 *  omitting it evaluates ALL known evaluators — useful for tests/dry-run). Returns the outcomes that
 *  fired (deny/require_approval/redact/quarantine); an empty array means "allow". Pure + total. */
export function evaluateGovernedWrite(
  ctx: GovernedWriteContext,
  activePolicyKeys?: ReadonlySet<string>,
): PolicyOutcome[] {
  const outcomes: PolicyOutcome[] = [];
  for (const [key, evaluate] of Object.entries(POLICY_EVALUATORS)) {
    if (activePolicyKeys && !activePolicyKeys.has(key)) continue;
    const o = evaluate(ctx);
    if (o) outcomes.push(o);
  }
  return outcomes;
}

/** The single decision for a write: the most restrictive outcome (deny > quarantine > require_approval
 *  > redact), or 'allow' if nothing fired. */
export function resolveDecision(outcomes: PolicyOutcome[]): PolicyDecision {
  const order: PolicyDecision[] = ['deny', 'quarantine', 'require_approval', 'redact'];
  for (const d of order) if (outcomes.some((o) => o.decision === d)) return d;
  return 'allow';
}
