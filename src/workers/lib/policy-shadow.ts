// policy-shadow.ts — Stage-2 A7 · flag-gated SHADOW wiring for the policy-engine (v0).
//
// WHY. src/workers/services/policy-engine.ts is a PURE evaluator (evaluateGovernedWrite) with three
// seed policy classes (no-placeholder-semantics / evidence-required-for-completion / archive-not-delete)
// that genericize MB-P HARD_RULES. It had NO production caller — governance for customers was UI copy,
// not enforcement (PROD plan Tier-A gap A7). This module is the FIRST caller: a thin, side-effect-free
// SHADOW that runs the evaluator against a real governed-write payload and OBSERVES the fired outcomes
// via the structured-log channel (emitEvent). It NEVER enforces, NEVER mutates the payload, NEVER throws.
//
// WHY SHADOW-VIA-LOG (not a policy_decisions DB write) for v0: policy_decisions.policy_id is NOT NULL +
// FK-RESTRICT to policy_definitions, and policy_definitions has ZERO seeded rows today — a DB write would
// FK-fail until a seed migration is applied (operator-gated). Structured-log shadow is truly additive:
// zero migration, zero RLS, immediate signal in wrangler-tail / Sentry. Persisting decisions to
// policy_decisions (with a seed migration + RLS-scoped insert) + an ENFORCE stage are documented follow-ons.
//
// FLAG CONTRACT: default off ⇒ observePolicyShadow is a pure early-return, so the write path is
// BYTE-IDENTICAL to today (the evaluator is never invoked, nothing is logged). Flag on ⇒ evaluate + log.

import { envFlagTrue } from './env-flag';
import { evaluateGovernedWrite, type GovernedWriteContext } from '../services/policy-engine';
import { emitEvent } from './observability';

/** True only when POLICY_ENGINE_ENABLED is set (read via the canonical envFlagTrue per the
 *  flag-parse-hygiene gate). Default off ⇒ the shadow is skipped entirely. */
export function policyEngineEnabled(env: unknown): boolean {
  return envFlagTrue((env as { POLICY_ENGINE_ENABLED?: string } | undefined)?.POLICY_ENGINE_ENABLED);
}

/**
 * SHADOW: when POLICY_ENGINE_ENABLED, evaluate the governed-write policies against `ctx` and emit one
 * `policy_shadow_decision` observability event per fired outcome. Observe-only — does NOT return or
 * enforce a decision, does NOT touch the payload, and can NEVER throw into the write path (the evaluator
 * is pure, but the whole body is defensively wrapped so a future logging sink can't break a real write).
 * `meta` carries small non-sensitive ids for correlation (workspace_id, domain_id, actor).
 */
export function observePolicyShadow(
  env: unknown,
  ctx: GovernedWriteContext,
  meta?: Record<string, unknown>,
): void {
  if (!policyEngineEnabled(env)) return; // flag-off ⇒ byte-identical no-op
  try {
    const outcomes = evaluateGovernedWrite(ctx); // pure; all known evaluators (no active-key filter in v0)
    for (const o of outcomes) {
      emitEvent('policy_shadow_decision', {
        action: ctx.action,
        policy_key: o.policy_key,
        decision: o.decision,
        reason: o.reason,
        ...meta,
      });
    }
  } catch {
    /* shadow observability must never break the write path */
  }
}
