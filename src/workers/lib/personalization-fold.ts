// src/workers/lib/personalization-fold.ts · Y-wave MATERIALIZE (ADR-XB-012) · the PURE, deterministic
// signal→profile aggregation. Unit-tested in isolation (no DB, no clock, no LLM).
//
// DESIGN (ADR-XB-012 option B, ratified): DETERMINISTIC last-write-wins fold by signal_kind.
//   - A user's learning signals are folded, in created_at order, into 4 profile buckets keyed by
//     signal_kind. Later signal keys win (LWW). The whole profile is a pure function of the signals, so
//     re-running the materializer from the same signals yields the BYTE-IDENTICAL profile (idempotent).
//   - source_signal_ids carries FULL lineage — every contributing signal id — so any profile key can be
//     traced back to the signal that set it. Zero fabrication: nothing enters the profile that a signal
//     did not carry.
//   - FORBIDDEN_OVERRIDE_KEYS are stripped from every bucket at write time (defense-in-depth; the
//     resolver also strips on read). Personalization can shape HOW an agent answers, NEVER the security/
//     retention/redaction/tenant-isolation/tool-permission surface.
//
// NO LLM, NO weighting/decay (deferred until real signal volume shows LWW mishandles conflicts — the
// schema needs no change to evolve). NO tenant-profile writes (those are promotion+consent only).

/** The forbidden-override keys — MUST mirror template-policy-store.ts FORBIDDEN_OVERRIDE_KEYS (the read-time
 *  strip). Kept as a local const so the pure fold has no store/DB import; a unit test asserts parity. */
export const PERSONALIZATION_FORBIDDEN_KEYS: readonly string[] = [
  'security', 'retention', 'approval', 'redaction', 'forbidden_surfaces', 'tenant_isolation',
  'raw_graph', 'full_tenant_memory', 'governance_scoring', 'agent_routing', 'private_graph_schema',
  'secrets', 'search_all_memory',
];

export interface LearningSignalForFold {
  id: string;
  signal_kind: string;
  signal_json: Record<string, unknown>;
  created_at: string; // ISO — the LWW ordering key
}

export interface FoldedProfile {
  preference_json: Record<string, unknown>;
  personal_rules_json: Record<string, unknown>;
  personal_skills_json: Record<string, unknown>;
  learned_defaults_json: Record<string, unknown>;
  source_signal_ids: string[];
}

// signal_kind → target bucket (the 7 kinds from mig 036's CHECK).
const KIND_TO_BUCKET: Record<string, keyof Omit<FoldedProfile, 'source_signal_ids'>> = {
  preference: 'preference_json',
  personal_rule: 'personal_rules_json',
  personal_skill: 'personal_skills_json',
  workflow_default: 'learned_defaults_json',
  correction: 'learned_defaults_json',
  tool_usage: 'learned_defaults_json',
  role_fit: 'learned_defaults_json',
};

function stripForbidden(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!PERSONALIZATION_FORBIDDEN_KEYS.includes(k)) out[k] = v;
  }
  return out;
}

/**
 * Fold a user's signals into a deterministic personalization profile. Signals may arrive in any order;
 * they are sorted by created_at (tie-broken by id) so the result is a pure function of the SET.
 */
export function foldSignalsIntoProfile(signals: LearningSignalForFold[]): FoldedProfile {
  const ordered = [...signals].sort((a, b) =>
    a.created_at === b.created_at ? a.id.localeCompare(b.id) : a.created_at.localeCompare(b.created_at));
  const buckets: Omit<FoldedProfile, 'source_signal_ids'> = {
    preference_json: {}, personal_rules_json: {}, personal_skills_json: {}, learned_defaults_json: {},
  };
  const sourceIds: string[] = [];
  for (const s of ordered) {
    sourceIds.push(s.id);
    const bucketKey = KIND_TO_BUCKET[s.signal_kind];
    if (!bucketKey) continue; // unknown kind (schema evolution) ⇒ recorded in lineage, not merged
    const payload = (s.signal_json && typeof s.signal_json === 'object' && !Array.isArray(s.signal_json))
      ? (s.signal_json as Record<string, unknown>) : {};
    buckets[bucketKey] = { ...buckets[bucketKey], ...payload }; // LWW: later same-key wins
  }
  return {
    preference_json: stripForbidden(buckets.preference_json),
    personal_rules_json: stripForbidden(buckets.personal_rules_json),
    personal_skills_json: stripForbidden(buckets.personal_skills_json),
    learned_defaults_json: stripForbidden(buckets.learned_defaults_json),
    source_signal_ids: sourceIds,
  };
}
