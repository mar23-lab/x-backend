// context-packet.ts · AR-2.2 (260713) · the context-packet builder kernel (pure).
//
// The operator's spine requirement is a traceable/auditable line from intent → the context an agent was
// given → the governed action. The pieces already exist server-side but are never assembled into ONE
// durable, customer-safe record: the role/skill RESOLUTION (role-skill-resolver.ts, real once AR-2.1's
// catalog loader is flagged on) + the role-scoped CONTEXT (services/role-scoped-context.ts: which events/
// documents were groundable under the §168 visibility/admissibility/authority axes + the redaction
// profile). This kernel folds them into a `ContextPacket` — the "what context, why, and under what
// capability" record that a future migration will persist and every governed action will reference.
//
// PURE by construction (no IO, no Date.now — `now` is injected; mirrors role-skill-resolver.ts). Deny-by-
// default CUSTOMER-SAFE: the packet carries COUNTS + a coarse capability summary + a deterministic
// fingerprint — NEVER internal ids, event/document ids, graph topology, prompts, or skill bodies.
// Assistant routes and background automation call this through assistant-context-lineage only when
// CONTEXT_PACKET_PERSISTENCE_ENABLED is true (contract: docs/contracts/context-packet.v1.json).

import type { RoleSkillResolution } from './role-skill-resolver';

export interface ContextScopeCounts {
  event_count: number;
  document_count: number;
  unpromoted_document_count: number;
  source_count: number;
}

export interface ContextPacketInput {
  tenant: string;
  principal: string;
  role: string;
  mode: string;
  intent?: string | null;
  /** the resolution from the keystone (its selected skills + tool grants + coverage) */
  resolution: RoleSkillResolution;
  /** counts of what the role-scoped-context assembler made groundable (never the ids themselves) */
  scope: ContextScopeCounts;
  /** the redaction profile name applied by the assembler (e.g. 'client-empty', 'owner-full') */
  redaction_profile: string;
  /** true when the role gets an empty grounding bundle (§168 D-7: client = contribution-only) */
  client_empty: boolean;
  /** the receipt id the resolution wrote, if any (linkage, not a secret) */
  receipt_ref?: string | null;
  /** seconds the packet's context is considered fresh (default 15 min, matches the resolution TTL) */
  stale_after_s?: number;
}

export interface ContextPacket {
  schema_id: 'xlooop.context_packet.v1';
  tenant: string;
  principal: string;
  role: string;
  mode: string;
  intent: string | null;
  selected_skills: Array<{ key: string; version: string }>;
  allowed_tools: string[];
  denied_tools: string[];
  skill_coverage: RoleSkillResolution['skill_coverage'];
  context_scope: ContextScopeCounts;
  redaction: { profile: string; client_empty: boolean };
  freshness: { generated_at: string; stale_after_s: number };
  /** CUSTOMER-SAFE one-liner (role + coverage + scope). No internal ids. */
  policy_summary: string;
  /** deterministic content id over the canonical packet body — for dedup + change-detection. Not a
   *  cryptographic signature (the receipt carries the HS256 signature); a stable FNV-1a content hash so the
   *  same context under the same policy always fingerprints identically. */
  context_fingerprint: string;
  receipt_ref: string | null;
}

/** FNV-1a (32-bit) over a string → 8-hex. Sync + deterministic (the resolver path can't await subtle). */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

const DEFAULT_STALE_S = 15 * 60;

/**
 * Build a customer-safe, auditable context packet. Pure; deterministic given the same inputs + `now`.
 * The fingerprint deliberately EXCLUDES `now`/receipt_ref so the same context+policy fingerprints
 * identically across requests (dedup), while `generated_at` records when this instance was assembled.
 */
export function buildContextPacket(input: ContextPacketInput, now: Date): ContextPacket {
  const stale_after_s = input.stale_after_s ?? DEFAULT_STALE_S;
  const selected_skills = input.resolution.selected_skills;
  const scope = input.scope;
  const policy_summary =
    `Role ${input.role} · ${input.resolution.skill_coverage} · ` +
    `${scope.event_count} events, ${scope.document_count} documents, ${scope.source_count} sources in scope` +
    (input.client_empty ? ' · contribution-only (no grounding bundle)' : '');

  // canonical fingerprint body — stable, order-fixed, no ids, no timestamp.
  const fingerprintBody = JSON.stringify([
    input.tenant, input.role, input.mode, input.intent ?? '',
    selected_skills.map((s) => `${s.key}@${s.version}`).sort(),
    input.resolution.allowed_tools.slice().sort(),
    input.resolution.denied_tools.slice().sort(),
    scope.event_count, scope.document_count, scope.unpromoted_document_count, scope.source_count,
    input.redaction_profile, input.client_empty,
  ]);

  return {
    schema_id: 'xlooop.context_packet.v1',
    tenant: input.tenant,
    principal: input.principal,
    role: input.role,
    mode: input.mode,
    intent: input.intent ?? null,
    selected_skills,
    allowed_tools: input.resolution.allowed_tools,
    denied_tools: input.resolution.denied_tools,
    skill_coverage: input.resolution.skill_coverage,
    context_scope: scope,
    redaction: { profile: input.redaction_profile, client_empty: input.client_empty },
    freshness: { generated_at: now.toISOString(), stale_after_s },
    policy_summary,
    context_fingerprint: fnv1a(fingerprintBody),
    receipt_ref: input.receipt_ref ?? null,
  };
}
