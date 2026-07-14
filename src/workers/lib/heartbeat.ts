// heartbeat.ts · AR-2.5 / OAR Phase-9 (260713) · the health control-plane classifier KERNEL (pure, inert).
//
// OAR wants heartbeats at 5 scopes (platform, tenant, bridge, run, review) with a dead-man switch: a
// producer that goes silent must be DETECTED, not assumed healthy. The detection is pure arithmetic over
// (observed_at, expires_at, now) — this kernel is that arithmetic, with no IO and an injected `now`
// (mirrors role-skill-resolver.ts / context-packet.ts). The DB plane (migration 072: system_heartbeats +
// health_rollups) and the per-scope PRODUCERS that call this are the next steps; this lands INERT so the
// classification is unit-locked before anything emits.
//
// Statuses (OAR Phase-9): healthy · degraded · stale · failed · expected_dark. `stale` is the dead-man
// verdict (now past expires_at) and OVERRIDES a self-reported healthy — a silent producer cannot mask its
// own silence. `expected_dark` is a deliberate quiet window (e.g. a paused bridge) and is never an alert.

export type HeartbeatScope = 'platform' | 'tenant' | 'bridge' | 'run' | 'review';
export type HeartbeatStatus = 'healthy' | 'degraded' | 'stale' | 'failed' | 'expected_dark';

export interface HeartbeatObservation {
  /** what the producer last reported about itself (before staleness is applied) */
  reported: 'healthy' | 'degraded' | 'failed';
  observed_at: Date;
  /** the deadline by which the next beat must arrive; past it = dead-man = stale */
  expires_at: Date;
  /** a deliberate quiet window — suppresses staleness + never alerts */
  expected_dark?: boolean;
}

/**
 * Classify a heartbeat as of `now`. Pure + deterministic. Dead-man wins: once `now` is past `expires_at`
 * the verdict is `stale` regardless of what the producer last reported (a producer cannot self-certify
 * liveness it no longer has). `expected_dark` short-circuits everything.
 */
export function classifyHeartbeatStatus(obs: HeartbeatObservation, now: Date): HeartbeatStatus {
  if (obs.expected_dark) return 'expected_dark';
  if (now.getTime() > obs.expires_at.getTime()) return 'stale';
  return obs.reported; // healthy | degraded | failed, all within the freshness window
}

/** worst-of severity — used by health_rollups to fold many heartbeats of one scope into one status.
 *  expected_dark is the least severe (a deliberate quiet), then healthy < degraded < stale < failed. */
const SEVERITY: Record<HeartbeatStatus, number> = {
  expected_dark: 0, healthy: 1, degraded: 2, stale: 3, failed: 4,
};

/** Fold a set of statuses into the scope's rollup status (worst wins). Empty set → 'expected_dark'
 *  (nothing to report is not an incident). */
export function rollupStatus(statuses: HeartbeatStatus[]): HeartbeatStatus {
  let worst: HeartbeatStatus = 'expected_dark';
  for (const s of statuses) if (SEVERITY[s] > SEVERITY[worst]) worst = s;
  return worst;
}

/** Count statuses by kind — the health_rollups count columns. */
export function tallyStatuses(statuses: HeartbeatStatus[]): Record<HeartbeatStatus, number> {
  const t: Record<HeartbeatStatus, number> = { healthy: 0, degraded: 0, stale: 0, failed: 0, expected_dark: 0 };
  for (const s of statuses) t[s] += 1;
  return t;
}

/** Is this status one an operator must be paged about? stale (dead-man) + failed are; the rest are not. */
export function isAlerting(status: HeartbeatStatus): boolean {
  return status === 'stale' || status === 'failed';
}
