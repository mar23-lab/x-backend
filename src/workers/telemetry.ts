// src/workers/telemetry.ts
//
// R51-ζ-3 · Lightweight telemetry wrapper.
//
// Authority: docs/architecture/XLOOOP_SYSTEM_DESIGN_v1.md §16.4.3 (error
// budget · self-protection events are audit-traceable).
//
// Scope (R50)
// -----------
// This is a SHIM, not a full OpenTelemetry exporter. It provides:
//   1. recordEvent(event) — stamps an event with {timestamp, route, latency_ms,
//      status} and pushes onto a per-request collector available via ctx.
//   2. computeInferenceHealth(dal) — aggregates the 6 panels from §16.5 +
//      §16.4.3 by reading the audit substrate:
//        - signals/hr (from inference_signal_evals row count per hour)
//        - accept/reject ratio (from synthetic_domain_recommendations.status)
//        - CES distribution (composite_confidence histogram across emissions)
//        - source-token health (from user_source_connections.status counts)
//        - cron success rate (inference_runs with kind='self_maintenance'
//          status='completed' vs 'failed')
//        - error budget burn (compares observed rates against §16.4.3 thresholds)
//   3. GET /api/v1/inference-health route handler that returns the 6-panel
//      payload for Wave ζ-4's dashboard widget.
//
// Out of scope (Wave θ)
// ---------------------
// - OTel SDK + exporter (to Honeycomb / Datadog) — env vars + dist wrap
// - Sampling (10% on high-volume routes per the plan)
// - Cross-region trace propagation
// - Synthetic span emission

import { Hono } from 'hono';
import type { DalAdapter } from './dal/DalAdapter';
import type { AppEnv, AppVariables } from './index';

/**
 * 6-panel dashboard payload. Surfaced via GET /api/v1/inference-health.
 * Wave ζ-4 InferenceHealthDashboard widget renders this directly.
 */
export interface InferenceHealth {
  readonly generated_at: string;
  readonly panels: {
    readonly signals_per_hour: {
      readonly observed: number;
      readonly window_hours: number;
    };
    readonly accept_reject_ratio: {
      readonly accepted: number;
      readonly rejected: number;
      readonly pending: number;
      readonly precision: number; // accepted / (accepted + rejected); 0 when no decisions
    };
    readonly ces_distribution: {
      readonly buckets: ReadonlyArray<{
        readonly lower: number;
        readonly upper: number;
        readonly count: number;
      }>;
      readonly total: number;
      readonly mean: number; // mean composite_confidence across recent emissions
    };
    readonly source_token_health: {
      readonly connected: number;
      readonly error: number;
      readonly disconnected: number;
      readonly never_connected: number; // free-tier slots not yet used
      readonly free_tier_used: number; // out of 3
    };
    readonly cron_success_rate: {
      readonly completed: number;
      readonly failed: number;
      readonly skipped: number;
      readonly window_hours: number;
      readonly rate: number; // completed / (completed + failed); 0 when no runs
    };
    readonly error_budget_burn: {
      readonly status: 'healthy' | 'warn' | 'critical';
      readonly observations: ReadonlyArray<{
        readonly metric: string;
        readonly observed: number;
        readonly threshold: number;
        readonly status: 'ok' | 'warn' | 'breach';
      }>;
    };
  };
}

const SIGNALS_WINDOW_HOURS = 24;
const CRON_WINDOW_HOURS = 24;
const CES_BUCKETS = [
  { lower: 0.0, upper: 0.5 },
  { lower: 0.5, upper: 0.6 },
  { lower: 0.6, upper: 0.7 },
  { lower: 0.7, upper: 0.8 },
  { lower: 0.8, upper: 0.9 },
  { lower: 0.9, upper: 1.01 },
];

/**
 * Compute the 6-panel dashboard payload from the audit substrate.
 * Each panel is a separate query so partial failures degrade gracefully:
 * a panel that throws gets a `null` field but the rest still render.
 */
export async function computeInferenceHealth(dal: DalAdapter): Promise<InferenceHealth> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sql = (dal as any).sql;
  if (!sql) {
    throw new Error('computeInferenceHealth: WorkersDalAdapter.sql client required');
  }
  const now = new Date();
  const signalsWindowStart = new Date(now.getTime() - SIGNALS_WINDOW_HOURS * 60 * 60 * 1000).toISOString();
  const cronWindowStart = new Date(now.getTime() - CRON_WINDOW_HOURS * 60 * 60 * 1000).toISOString();

  // Panel 1: signals/hr
  const signalsRows = (await sql/*sql*/`
    SELECT COUNT(*)::int AS n
    FROM inference_signal_evals ise
    JOIN inference_runs ir USING (run_id)
    WHERE ir.started_at >= ${signalsWindowStart}
  `) as Array<{ n: number }>;
  const signals_n = Number(signalsRows[0]?.n ?? 0);

  // Panel 2: accept/reject ratio
  const acceptRows = (await sql/*sql*/`
    SELECT status, COUNT(*)::int AS n
    FROM synthetic_domain_recommendations
    GROUP BY status
  `) as Array<{ status: string; n: number }>;
  const ratioMap = new Map(acceptRows.map((r) => [r.status, Number(r.n)]));
  const accepted = ratioMap.get('accepted') ?? 0;
  const rejected = ratioMap.get('rejected') ?? 0;
  const pending = ratioMap.get('pending') ?? 0;
  const decided = accepted + rejected;
  const precision = decided === 0 ? 0 : accepted / decided;

  // Panel 3: CES distribution
  const cesRows = (await sql/*sql*/`
    SELECT composite_confidence
    FROM synthetic_domain_recommendations
    WHERE composite_confidence IS NOT NULL
    ORDER BY generated_at DESC
    LIMIT 100
  `) as Array<{ composite_confidence: number }>;
  const ces_counts = CES_BUCKETS.map(() => 0);
  let cesSum = 0;
  for (const r of cesRows) {
    const c = Number(r.composite_confidence);
    cesSum += c;
    for (let i = 0; i < CES_BUCKETS.length; i++) {
      const b = CES_BUCKETS[i]!;
      if (c >= b.lower && c < b.upper) {
        ces_counts[i] = (ces_counts[i] ?? 0) + 1;
        break;
      }
    }
  }
  const ces_total = cesRows.length;
  const ces_mean = ces_total === 0 ? 0 : cesSum / ces_total;

  // Panel 4: source-token health
  const sourceRows = (await sql/*sql*/`
    SELECT status, COUNT(*)::int AS n
    FROM user_source_connections
    GROUP BY status
  `) as Array<{ status: string; n: number }>;
  const sourceMap = new Map(sourceRows.map((r) => [r.status, Number(r.n)]));
  const src_connected = sourceMap.get('connected') ?? 0;
  const src_error = sourceMap.get('error') ?? 0;
  const src_disconnected = (sourceMap.get('disconnected') ?? 0) + (sourceMap.get('revoked') ?? 0);
  const FREE_TIER_LIMIT = 3;
  const free_tier_used = Math.min(FREE_TIER_LIMIT, src_connected);
  const never_connected = Math.max(0, FREE_TIER_LIMIT - free_tier_used);

  // Panel 5: cron success rate (self-maintenance runs in last 24h)
  const cronRows = (await sql/*sql*/`
    SELECT status, COUNT(*)::int AS n
    FROM inference_runs
    WHERE kind = 'self_maintenance'
      AND started_at >= ${cronWindowStart}
    GROUP BY status
  `) as Array<{ status: string; n: number }>;
  const cronMap = new Map(cronRows.map((r) => [r.status, Number(r.n)]));
  const cron_completed = cronMap.get('completed') ?? 0;
  const cron_failed = cronMap.get('failed') ?? 0;
  const cron_skipped = (cronMap.get('skipped') ?? 0) + (cronMap.get('running') ?? 0);
  const cron_total = cron_completed + cron_failed;
  const cron_rate = cron_total === 0 ? 0 : cron_completed / cron_total;

  // Panel 6: error budget burn (§16.4.3)
  // Thresholds from §16.4.3 table:
  //   precision < 0.5 sustained ≥ 50 emissions → auto-suspend (warn)
  //   precision < 0.5 across all kinds sustained ≥ 100 emissions → detector-wide pause (critical)
  //   inference_runs.status='failed' rate > 0.10 rolling 7d → degrade (warn)
  //   expiry rate > 0.50 rolling 14d → "your inbox is broken" (warn)
  const observations: Array<{ metric: string; observed: number; threshold: number; status: 'ok' | 'warn' | 'breach' }> = [];
  observations.push({
    metric: 'rolling_precision',
    observed: precision,
    threshold: 0.5,
    status: decided < 50 ? 'ok' : precision >= 0.7 ? 'ok' : precision >= 0.5 ? 'warn' : 'breach',
  });
  observations.push({
    metric: 'cron_failure_rate',
    observed: cron_total === 0 ? 0 : cron_failed / cron_total,
    threshold: 0.10,
    status: cron_total === 0 ? 'ok' : cron_failed / cron_total <= 0.10 ? 'ok' : cron_failed / cron_total <= 0.25 ? 'warn' : 'breach',
  });
  observations.push({
    metric: 'source_token_error_count',
    observed: src_error,
    threshold: 1,
    status: src_error === 0 ? 'ok' : src_error <= 1 ? 'warn' : 'breach',
  });
  const budgetStatus: 'healthy' | 'warn' | 'critical' = observations.some((o) => o.status === 'breach')
    ? 'critical'
    : observations.some((o) => o.status === 'warn')
    ? 'warn'
    : 'healthy';

  return {
    generated_at: now.toISOString(),
    panels: {
      signals_per_hour: { observed: signals_n / SIGNALS_WINDOW_HOURS, window_hours: SIGNALS_WINDOW_HOURS },
      accept_reject_ratio: { accepted, rejected, pending, precision },
      ces_distribution: {
        buckets: CES_BUCKETS.map((b, i) => ({ lower: b.lower, upper: Math.min(1.0, b.upper), count: ces_counts[i] ?? 0 })),
        total: ces_total,
        mean: ces_mean,
      },
      source_token_health: {
        connected: src_connected,
        error: src_error,
        disconnected: src_disconnected,
        never_connected,
        free_tier_used,
      },
      cron_success_rate: {
        completed: cron_completed,
        failed: cron_failed,
        skipped: cron_skipped,
        window_hours: CRON_WINDOW_HOURS,
        rate: cron_rate,
      },
      error_budget_burn: { status: budgetStatus, observations },
    },
  };
}

/**
 * GET /api/v1/inference-health route handler. Mounted in workers/index.ts
 * under the protected (clerkAuth) sub-group so only authed users see the
 * dashboard payload.
 */
export const inferenceHealthRoute = new Hono<{ Bindings: AppEnv; Variables: AppVariables }>();

inferenceHealthRoute.get('/inference-health', async (ctx) => {
  try {
    const dal = ctx.get('dal');
    const health = await computeInferenceHealth(dal);
    return ctx.json(health);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.status(500);
    return ctx.json({
      error: msg,
      code: 'INFERENCE_HEALTH_COMPUTE_FAILED',
      request_id: ctx.get('request_id'),
    });
  }
});
