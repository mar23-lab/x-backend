// chat-assembly-trace.ts · L1 (260710-D) · durable context-assembly trace — PURE collector.
//
// THE GAP THIS CLOSES: every context-assembly decision the chat makes — the G9 role projection
// (role-scoped-context auditLine), source-truth demotions, D-16 tier weights, W5 graph-edge budget
// selection, and the fact-bundle numbers — was EPHEMERAL (`emitEvent` = console.log JSON only). The
// operator directive "traceable and auditable" needs a durable per-answer record. The rails already
// exist: `chat_messages.grounded_on` (migration 020) IS the frozen answer-time snapshot, persisted by
// appendChatExchange, served by the receipt route (W2) and the customer audit export. This module adds
// an `assembly` sub-object to that snapshot — ZERO migration, no new table, no spine row (migration-059
// doctrine: reads/derived observations are not causal facts; they must not flood the append-only spine).
//
// Flag: CHAT_ASSEMBLY_TRACE_ENABLED (default OFF ⇒ byte-identical — attachAssembly(g, null) returns g
// unchanged by reference). Console emitEvent emissions are KEPT — the log plane is unchanged; this is
// the persistence plane only.
//
// REDACTION (D-8 consistent): the trace carries ids/counts/enums ONLY. finalize() enforces it
// structurally — any key matching /body|text|email|token|summary|name/ is dropped recursively, arrays
// clamp at 50 entries, and the whole object clamps at 8KB (over-budget arrays collapse to counts).
// Every method is never-throw (the emitEvent contract): a trace failure degrades to today's exact
// grounded_on; the answer always stands.

import type { ContextAuditLine } from './role-scoped-context';

const FORBIDDEN_KEY = /body|text|email|token|summary|name/i;
const MAX_ARRAY = 50;
const MAX_BYTES = 8 * 1024;

export interface AssemblyTrace {
  readonly plane: 'customer' | 'operator';
  recordRoleProjection(auditLine: ContextAuditLine): void;
  recordOverrideDemotions(audit: { demoted_count: number; superseding_providers: string[] }): void;
  recordTierWeights(sources: Array<{ provider?: string; access_tier?: string }>): void;
  recordGraphEdges(sel: { considered: number; selected: number; cause_chains: number }): void;
  recordBundle(bundle: { events: number; sources_total: number; sources_connected: number; generated_by: string }): void;
}

interface TraceState {
  plane: 'customer' | 'operator';
  role_projection?: unknown;
  override_demotions?: unknown;
  tier_weights?: unknown;
  graph_edges?: unknown;
  bundle?: unknown;
}

const stateOf = new WeakMap<AssemblyTrace, TraceState>();

/** Create a per-answer collector. Every record* method is internally never-throw. */
export function createAssemblyTrace(plane: 'customer' | 'operator'): AssemblyTrace {
  const state: TraceState = { plane };
  const guard = (fn: () => void) => { try { fn(); } catch (_) { /* never-throw: a trace failure is silent */ } };
  const trace: AssemblyTrace = {
    plane,
    recordRoleProjection: (auditLine) => guard(() => { state.role_projection = auditLine; }),
    recordOverrideDemotions: (audit) => guard(() => { state.override_demotions = audit; }),
    recordTierWeights: (sources) => guard(() => {
      const tiers = (sources || []).filter((s) => s && typeof s.access_tier === 'string');
      state.tier_weights = {
        providers: tiers.map((s) => ({ provider: String(s.provider || ''), tier: String(s.access_tier) })),
        rely: tiers.filter((s) => s.access_tier === 'rely').length,
        operate: tiers.filter((s) => s.access_tier === 'operate').length,
      };
    }),
    recordGraphEdges: (sel) => guard(() => {
      state.graph_edges = { considered: Number(sel.considered) || 0, selected: Number(sel.selected) || 0, cause_chains: Number(sel.cause_chains) || 0 };
    }),
    recordBundle: (bundle) => guard(() => { state.bundle = bundle; }),
  };
  stateOf.set(trace, state);
  return trace;
}

/** Recursively drop forbidden keys + clamp arrays — the structural redaction guarantee. */
function sanitize(value: unknown, depth: number): unknown {
  if (value === null || value === undefined) return null;
  // Depth cap FAILS CLOSED: past the recursion budget an object/array could smuggle a forbidden key,
  // so beyond depth 6 anything non-scalar collapses to a marker (scalars are already safe — see below).
  if (depth > 6) return (value && typeof value === 'object') ? '[depth-clamped]' : (typeof value === 'string' ? value.slice(0, 200) : value);
  if (Array.isArray(value)) return value.slice(0, MAX_ARRAY).map((v) => sanitize(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_KEY.test(k)) continue;
      out[k] = sanitize(v, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string') return value.length > 200 ? value.slice(0, 200) : value;
  return value;
}

/** Collapse arrays to their lengths — the over-budget degrade (counts survive, ids don't). */
function collapseArrays(value: unknown): unknown {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = collapseArrays(v);
    return out;
  }
  return value;
}

/** Finalize to the persistable `assembly` object (or null when nothing was recorded). */
export function finalizeAssemblyTrace(trace: AssemblyTrace | null | undefined): Record<string, unknown> | null {
  try {
    if (!trace) return null;
    const state = stateOf.get(trace);
    if (!state) return null;
    const raw: Record<string, unknown> = { plane: state.plane };
    if (state.role_projection !== undefined) raw.role_projection = state.role_projection;
    if (state.override_demotions !== undefined) raw.override_demotions = state.override_demotions;
    if (state.tier_weights !== undefined) raw.tier_weights = state.tier_weights;
    if (state.graph_edges !== undefined) raw.graph_edges = state.graph_edges;
    if (state.bundle !== undefined) raw.bundle = state.bundle;
    if (Object.keys(raw).length <= 1) return null; // plane alone = nothing recorded
    let clean = sanitize(raw, 0) as Record<string, unknown>;
    if (JSON.stringify(clean).length > MAX_BYTES) {
      clean = { ...(collapseArrays(clean) as Record<string, unknown>), clamped: true };
    }
    return clean;
  } catch (_) { return null; }
}

/**
 * Merge the finalized trace into grounded_on. Null/failed trace ⇒ grounded_on returned UNCHANGED BY
 * REFERENCE (the byte-identical flag-off guarantee). Never throws; never mutates the input.
 */
export function attachAssembly(groundedOn: unknown, trace: AssemblyTrace | null | undefined): unknown {
  try {
    const assembly = finalizeAssemblyTrace(trace);
    if (!assembly) return groundedOn;
    if (groundedOn && typeof groundedOn === 'object' && !Array.isArray(groundedOn)) {
      return { ...(groundedOn as Record<string, unknown>), assembly };
    }
    // grounded_on absent or non-object: persist the trace without inventing a snapshot shape.
    return groundedOn === undefined || groundedOn === null ? { assembly } : groundedOn;
  } catch (_) { return groundedOn; }
}
