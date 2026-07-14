// cron-observability.ts · Safety floor SF-1 (260711) — the pure "is this cron outcome a Sentry
// finding?" decision, extracted from the scheduled dispatcher so the reporting RULE is unit-testable
// without the full worker import graph (index.ts pulls the entire Hono/Clerk app).
//
// The rule closes the silent-cron class (a live loop failing invisibly — the generalization of the
// MB-P dark-hook incident): a cron that throws OR reports status:'failed' becomes a Sentry finding;
// routine 'degraded'/'skipped'/'completed' do NOT report (alarm fatigue would bury the real signal);
// an UNROUTED cron expression is itself a misconfiguration worth surfacing.

export interface CronReportDecision {
  report: 'exception' | 'message' | null;
  kind: 'cron_threw' | 'cron_failed_status' | 'cron_degraded_status' | 'cron_unrouted' | 'cron_ok';
  message?: string;
}

export function decideCronReport(input: {
  routed: boolean;
  threw?: boolean;
  resultStatus?: string;
  loopName?: string;
  cron?: string;
}): CronReportDecision {
  if (!input.routed) {
    return { report: 'message', kind: 'cron_unrouted', message: `cron dispatch: no handler for cron expression ${input.cron ?? '?'}` };
  }
  if (input.threw) {
    return { report: 'exception', kind: 'cron_threw' };
  }
  if (input.resultStatus === 'failed') {
    return { report: 'message', kind: 'cron_failed_status', message: `cron loop reported failed: ${input.loopName ?? '?'}` };
  }
  // OBS-1/OBS-2 (J-W3 260711-I): 'degraded' now REPORTS. Before, a composite cron whose PRIMARY loop
  // succeeded but a SECONDARY loop failed (graph_rebuild throw, ops-queue drain error, purge error) —
  // or a per-item cron (reclassify) where every item errored — returned 'completed'/'degraded' and was
  // treated as routine, so the failure never reached Sentry (the exact SF-1 silent-cron class, one layer
  // deeper). 'degraded' = partial failure; report it as a message (distinct from a full 'failed').
  if (input.resultStatus === 'degraded') {
    return { report: 'message', kind: 'cron_degraded_status', message: `cron loop reported degraded (partial failure): ${input.loopName ?? '?'}` };
  }
  // 'completed' | 'skipped' | undefined → routine, no finding.
  return { report: null, kind: 'cron_ok' };
}
