// customer-safe-decision.ts · AR-0 (260713) · the shared customer-safe projection seam.
//
// The OAR spine audit flagged a shared `CustomerSafeDecision` serializer as ABSENT and two customer-facing
// IP-leak vectors as LIVE. This is that one serializer — a single mechanism instead of per-route ad-hoc
// stripping (consolidates the divergence between per-route `toTenantSafeSyntheticDomain` and nothing).
//
// Vectors closed:
//   - session.ts entitlement: internal provisioning fields (auto_provisioned_from_access_request_id is an
//     internal access-request UUID; auto_provisioned_from / auto_provision_skipped_reason / operator_bootstrapped
//     are internal provisioning mechanics) reaching the customer session payload.
//   - customer-chat.ts decision: `generated_by` (internal engine class), `model` (internal model id), and
//     `grounded_on.event_ids` (internal event ids) reaching the customer chat payload.
//
// PURE — no env, no io. The caller passes `enabled` (from envFlagTrue(CUSTOMER_SAFE_SERIALIZER_ENABLED)).
// **enabled=false (default) returns the INPUT BY REFERENCE → byte-identical to today** (shadow-first: this
// kernel lands inert; wiring is a separate flag-gated step; the flip is operator-gated). enabled=true emits
// a deny-by-default customer-safe projection.
//
// Doctrine (docs/security/DATA_CLASSIFICATION.md): a customer NEVER sees internal ids, engine/agent chains,
// or graph topology; they DO see a coarse assistant label, evidence COUNTS, and honest status booleans.

/**
 * Internal engine class → customer-safe label. `deterministic` stays honestly `rule_based` (a real trust
 * signal: this answer came from a rule, not an LLM); every AI engine collapses to `assistant` — the
 * customer never sees the provider/model name (`claude`/`workers_ai`) or the internal `llm` tag.
 */
/**
 * Fail-CLOSED gate (E7 hardening, 260713): the customer-safe projection is ON by default and turns OFF only
 * when an operator EXPLICITLY disables it (flag set to false/off/0/no/disabled). An ABSENT or unrecognised
 * value strips (safe), never leaks. Prod CUSTOMER_SAFE_SERIALIZER_ENABLED='true' -> byte-identical.
 */
export function customerSafeSerializerEnabled(flagRaw: string | undefined): boolean {
  const v = String(flagRaw ?? '').trim().toLowerCase();
  return !(v === 'false' || v === 'off' || v === '0' || v === 'no' || v === 'disabled');
}

/** Customer-safe grounding sources: counts + the customer's OWN provider labels (a trust signal), never
 *  internal source/binding ids, paths, scopes, or per-source user ids. Allow-list = deny-by-default. */
export interface CustomerSafeSources {
  total?: number;
  connected?: number;
  providers?: { provider: string; event_count: number }[];
}
function sanitizeSources(s: unknown): CustomerSafeSources | undefined {
  if (!s || typeof s !== 'object') return undefined;
  const src = s as Record<string, unknown>;
  const out: CustomerSafeSources = {};
  if (typeof src.total === 'number') out.total = src.total;
  if (typeof src.connected === 'number') out.connected = src.connected;
  if (Array.isArray(src.providers)) {
    out.providers = (src.providers as unknown[]).map((p) => {
      const pr = (p ?? {}) as Record<string, unknown>;
      return { provider: String(pr.provider ?? ''), event_count: Number(pr.event_count ?? 0) };
    });
  }
  return out;
}

const SAFE_GENERATED_BY: Record<string, 'assistant' | 'rule_based'> = {
  claude: 'assistant',
  llm: 'assistant',
  workers_ai: 'assistant',
  deterministic: 'rule_based',
};

/** The ONLY keys a customer-safe chat decision may carry (allow-list = deny-by-default for new leaky fields). */
export interface CustomerSafeChat {
  answer: string;
  generated_by: 'assistant' | 'rule_based';
  grounded_on: { evidence_count: number; sources?: CustomerSafeSources } | null;
  mode: unknown;
  claude_available?: boolean;
}

export interface ChatDecisionLike {
  answer: string;
  generated_by?: string;
  model?: string | null;
  grounded_on?: { event_ids?: string[]; [k: string]: unknown } | null;
  mode?: unknown;
  llm_requested?: unknown;
  claude_available?: boolean;
  [k: string]: unknown;
}

/**
 * Chat decision → customer-safe (allow-list). OFF: input returned unchanged (byte-identical).
 * ON: engine name collapsed to a coarse label; `model` dropped; `grounded_on` reduced to an evidence
 * count (internal `event_ids` never emitted). Unknown/absent `generated_by` defaults to `assistant`.
 */
export function customerSafeChat<T extends ChatDecisionLike>(payload: T, enabled: boolean): T | CustomerSafeChat {
  if (!enabled) return payload;
  const g = payload.grounded_on;
  const evidence_count = Array.isArray(g?.event_ids) ? (g!.event_ids as string[]).length : 0;
  const safe: CustomerSafeChat = {
    answer: payload.answer,
    generated_by: SAFE_GENERATED_BY[payload.generated_by ?? ''] ?? 'assistant',
    grounded_on: g ? (sanitizeSources((g as { sources?: unknown }).sources) ? { evidence_count, sources: sanitizeSources((g as { sources?: unknown }).sources) } : { evidence_count }) : null,
    mode: payload.mode,
  };
  if (payload.claude_available !== undefined) safe.claude_available = payload.claude_available;
  return safe;
}

/** Internal-only entitlement keys that must never reach a customer payload (deny-list). */
export const INTERNAL_ENTITLEMENT_KEYS = [
  'auto_provisioned_from_access_request_id',
  'auto_provisioned_from',
  'auto_provision_skipped_reason',
  'operator_bootstrapped',
] as const;

/**
 * Strip internal provisioning fields from an entitlement object (deny-list — every other field, which the
 * customer UI legitimately consumes, is preserved). OFF: input returned unchanged (byte-identical). ON: a
 * shallow clone with the internal keys removed, plus a coarse `auto_provisioned` boolean retained as the
 * honest customer-safe signal (was this workspace auto-provisioned, without leaking the access-request id).
 */
export function stripInternalProvisioning<T extends object>(entitlement: T, enabled: boolean): T {
  if (!enabled) return entitlement;
  // T extends object (not Record<string, unknown>) so typed route payloads (e.g. EntitlementResult) are
  // accepted without an index signature — same relaxation as withDataClass in response-envelope.ts.
  const e = entitlement as Record<string, unknown>;
  const auto_provisioned = Boolean(e.auto_provisioned_from_access_request_id || e.auto_provisioned_from);
  const clone: Record<string, unknown> = { ...e };
  for (const k of INTERNAL_ENTITLEMENT_KEYS) delete clone[k];
  clone.auto_provisioned = auto_provisioned;
  return clone as unknown as T;
}
