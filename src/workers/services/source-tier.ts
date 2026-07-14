// source-tier.ts · D-16 (260710) · the per-project source TRUST-TIER core (pure, reusable).
//
// The prototype's L1/L2/L3 (Index / Rely / Operate) map 1:1 onto the EXISTING
// `project_source_bindings.read_policy` values (migration 016): metadata_only / read_only / proposal_only.
// So the tier STORAGE already exists (set per-(project, source) via PATCH /projects/:id/sources/:bindingId).
// This module is only the reusable resolution logic the grounding CONSUMER needs.
//
// OPERATOR DECISION (D-16, 260710): Rely = **metadata + higher grounding WEIGHT only, NO content read** —
// the `reflection_only` "never the full body" invariant is preserved. So `readPolicyToTier` maps the policy
// NAME to a trust tier, but this module NEVER implies content access: 'rely' means "lean on this source's
// metadata more", not "read its body". 'operate' rides the spine-authority plane (canActOnSpine) and is
// carried here only for display/ordering — it grants no write here.

export type SourceTier = 'index' | 'rely' | 'operate';

/** project_source_bindings.read_policy → trust tier (unknown/absent ⇒ the safe default 'index'). */
export function readPolicyToTier(readPolicy: string | null | undefined): SourceTier {
  switch (String(readPolicy || '')) {
    case 'read_only': return 'rely';
    case 'proposal_only': return 'operate';
    case 'metadata_only':
    default: return 'index';
  }
}

/** Ordering weight — higher = leaned on more heavily by grounding. index<rely<operate. */
export function tierRank(tier: SourceTier): number {
  return tier === 'operate' ? 2 : tier === 'rely' ? 1 : 0;
}

/**
 * A source may be bound to several projects at different tiers. Its EFFECTIVE workspace-wide tier is the
 * MOST-trusted one (max rank) — if it's Rely in any project, the chat leans on it. Empty ⇒ 'index'.
 */
export function effectiveTier(readPolicies: Array<string | null | undefined>): SourceTier {
  let best: SourceTier = 'index';
  for (const rp of readPolicies) {
    const t = readPolicyToTier(rp);
    if (tierRank(t) > tierRank(best)) best = t;
  }
  return best;
}

/** Human label for the grounding prompt / source line. */
export function tierLabel(tier: SourceTier): string {
  return tier === 'operate' ? 'Operate (may propose)' : tier === 'rely' ? 'Rely (leaned on)' : 'Index (known)';
}
