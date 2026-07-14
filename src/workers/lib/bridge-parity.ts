// bridge-parity.ts — ABS-P1b · bridge-envelope v1 + ingest-side dead-man freshness classifier (PURE kernel).
//
// WHY. The MB-P↔Xlooop Parity Sentinel (MB-P _sys/scripts/verify_mbp_xlooop_parity.py) checks, per
// registered bridge plane, whether the projection is fresh. Its v0 freshness is a PRODUCER-mtime proxy
// (was the launchd producer's artifact touched recently); its own comments defer the accurate signal to
// a v1 "ingest-side manifest" — when XLOOOP last RECEIVED data for a bridge — served from this side. This
// module is the pure producer kernel for that manifest: bridge-envelope v1 + the dead-man freshness
// classifier, with semantics that MIRROR the Sentinel's assess_freshness EXACTLY so the two agree.
//
// DEAD-MAN SEMANTIC (mirrors the Sentinel): a bridge the registry marks 'live' going stale or dark
// (no ingest signal) is a NEW alarm. A non-live bridge (manual/broken/stale/no-op) going dark is EXPECTED
// (consistent with its registry status) — reported with an `expected_dark:` prefix, never alarmed.
//
// SCOPE (v0, PURE): this is a library. Wiring it into an owner-only GET /mbp-bridge/parity-manifest route
// (reading each bridge's last-ingest timestamp from prod) + in-app heartbeat event emission are the
// flag-gated follow-ons that pair with the Sentinel's own v1 step. Keeping the classifier isolated makes
// the dead-man logic exhaustively unit-testable against the Sentinel's contract.

/** The bridge-envelope schema version. Bumped when the manifest shape changes. */
export const BRIDGE_SCHEMA_VERSION = 1;

/** Registry statuses for which a dark bridge is EXPECTED (mirrors the Sentinel's EXPECTED_DARK set). */
export const EXPECTED_DARK_STATUSES: ReadonlySet<string> = new Set(['manual', 'broken', 'stale', 'no-op']);

export interface BridgeFreshnessInput {
  bridge_id: string;
  plane?: string;
  /** The bridge's BRIDGE_REGISTRY status ('live' is the only one that can raise a NEW alarm). */
  registry_status: string;
  /** ISO timestamp of when Xlooop last RECEIVED data for this bridge (ingest-side), or null if never. */
  last_ingest_at: string | null;
  /** Staleness threshold in seconds (mirror the per-plane BRIDGE_REGISTRY freshness_threshold). */
  threshold_seconds: number;
}

export interface BridgeFreshness {
  bridge_id: string;
  plane?: string;
  registry_status: string;
  /** 'fresh' | 'stale' | 'no_signal' | 'n/a' for LIVE bridges; 'expected_dark:<raw>' for non-live. */
  verdict: string;
  /** Ingest age in seconds, or null when there is no (parseable) last_ingest_at. */
  age_seconds: number | null;
  /** True ONLY for a LIVE bridge that is stale or has no signal (the Sentinel's alarm condition). */
  alarm: boolean;
}

/** Classify one bridge's ingest-side freshness. Pure; `now` is explicit. */
export function classifyBridgeFreshness(input: BridgeFreshnessInput, now: Date): BridgeFreshness {
  const live = String(input.registry_status).toLowerCase() === 'live';
  let raw: string;
  let ageSeconds: number | null = null;
  if (input.last_ingest_at == null) {
    raw = 'no_signal'; // dead-man: nothing ever ingested for this bridge
  } else {
    const t = Date.parse(input.last_ingest_at);
    if (Number.isNaN(t)) {
      raw = 'n/a';
    } else {
      ageSeconds = Math.max(0, Math.round((now.getTime() - t) / 1000));
      raw = ageSeconds > input.threshold_seconds ? 'stale' : 'fresh';
    }
  }
  // A non-live bridge going dark is EXPECTED — prefix + never alarm (matches the registry status).
  const verdict = live ? raw : `expected_dark:${raw}`;
  const alarm = live && (raw === 'stale' || raw === 'no_signal');
  return {
    bridge_id: input.bridge_id,
    plane: input.plane,
    registry_status: input.registry_status,
    verdict,
    age_seconds: ageSeconds,
    alarm,
  };
}

export interface BridgeParityManifest {
  bridge_schema_version: number;
  generated_at: string;
  /** 'degraded' iff ≥1 LIVE bridge is stale/no_signal; else 'ok'. */
  status: 'ok' | 'degraded';
  alarm_count: number;
  bridges: BridgeFreshness[];
}

/** Bridge-envelope v1: the ingest-side freshness manifest the Sentinel consumes (replacing its v0
 *  producer-mtime proxy). Pure; `now` explicit. */
export function buildBridgeParityManifest(inputs: readonly BridgeFreshnessInput[], now: Date): BridgeParityManifest {
  const bridges = inputs.map((i) => classifyBridgeFreshness(i, now));
  const alarm_count = bridges.filter((b) => b.alarm).length;
  return {
    bridge_schema_version: BRIDGE_SCHEMA_VERSION,
    generated_at: now.toISOString(),
    status: alarm_count > 0 ? 'degraded' : 'ok',
    alarm_count,
    bridges,
  };
}
