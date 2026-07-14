// engagement-store.ts · DAU / return-rate rollup — the "daily-active use" half of the
// indispensability launch criterion ("daily-active use + Sean-Ellis ≥40% very-disappointed").
//
// PMF (Sean Ellis) is already instrumented (019_pmf_responses + getPmfSummary). The other
// half — daily-active use — was NOT measured: workspace-activity-store gives a per-workspace
// "since you left" delta, not a cross-tenant DAU / return-rate rollup. This store closes that
// gap, operator-facing.
//
// NO MIGRATION (launch-safe, additive, read-only). Everything is DERIVED from the EXISTING
// operation_events timestamps joined to workspaces.owner_user_id:
//   - operation_events.occurred_at  (TIMESTAMPTZ NOT NULL · the activity clock)
//   - operation_events.workspace_id  (TEXT NOT NULL · the active-workspace dimension)
//   - operation_events.archived_at   (excluded when set · matches activity-summary semantics)
//   - workspaces.owner_user_id       (TEXT NOT NULL · the active-USER dimension; operation_events
//                                      has no per-end-user column — agent_id is an actor label
//                                      ('codex'/'claude'/…), frequently NULL, not a human user)
//
// "Active user"      = a workspaces.owner_user_id with ≥1 non-archived event that UTC day.
// "Active workspace" = a workspace_id with ≥1 non-archived event that UTC day.
// "Week-N return"    = of the users active in week 1 of the window, the % also active in week N.
//
// Reuses the existing idx_events_workspace (workspace_id, occurred_at DESC) index. Read-only;
// no writes, no schema change. Operator-scoped at the route boundary (mirrors /pmf-summary).

import type { Sql } from '../db/client';

export interface EngagementDay {
  /** UTC calendar day, YYYY-MM-DD. */
  date: string;
  /** Distinct owner_user_ids with ≥1 non-archived event that day. */
  active_users: number;
  /** Distinct workspace_ids with ≥1 non-archived event that day. */
  active_workspaces: number;
  /** Non-archived events that day (volume context for the DAU number). */
  events: number;
}

export interface EngagementRollup {
  /** Window length in UTC days (the daily series spans the last `window_days`). */
  window_days: number;
  /** One row per UTC day across the window, oldest → newest (zero-filled for quiet days). */
  daily: EngagementDay[];
  /**
   * Week-over-week return rate keyed weekN (week1 = the OLDEST 7 days of the window = the cohort
   * baseline). returnRate.week1 is always 100 when the cohort is non-empty (definitionally). Each
   * weekN value is the % of week-1-active users who were ALSO active in week N (0–100, 1 decimal).
   */
  returnRate: Record<string, number>;
  /** Cohort size: distinct users active in week 1 (the denominator for returnRate). */
  cohort_users: number;
  /** ISO-8601 generation time (cache-buster / freshness stamp). */
  generatedAt: string;
}

const DEFAULT_WINDOW_DAYS = 28;
const MIN_WINDOW_DAYS = 7;
const MAX_WINDOW_DAYS = 180;

/**
 * Read-only DAU / active-workspace + week-over-week return rollup over the EXISTING
 * operation_events timestamps. Tenant-agnostic by design: this is the OPERATOR's
 * cross-tenant launch instrument (gated to operator-only at the route, exactly like
 * /pmf-summary), so it aggregates across all workspaces.
 *
 * @param windowDays default 28; clamped to [7, 180].
 */
export async function getEngagementRollupRow(
  sql: Sql,
  windowDays: number = DEFAULT_WINDOW_DAYS,
): Promise<EngagementRollup> {
  const days = Number.isFinite(windowDays)
    ? Math.max(MIN_WINDOW_DAYS, Math.min(Math.trunc(windowDays), MAX_WINDOW_DAYS))
    : DEFAULT_WINDOW_DAYS;

  // Per-UTC-day distinct active users (owner_user_id) + distinct active workspaces + event volume.
  // Window anchored on the current UTC day: events with occurred_at on/after (today − (days−1)).
  // archived_at IS NULL matches the activity-summary "live events" semantics.
  const dailyRows = (await sql/*sql*/`
    SELECT
      to_char(date_trunc('day', e.occurred_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS date,
      count(DISTINCT w.owner_user_id)::int AS active_users,
      count(DISTINCT e.workspace_id)::int  AS active_workspaces,
      count(*)::int                        AS events
    FROM operation_events e
    JOIN workspaces w ON w.id = e.workspace_id
    WHERE e.archived_at IS NULL
      AND e.occurred_at >= (date_trunc('day', now() AT TIME ZONE 'UTC') - ((${days} - 1) || ' days')::interval)
    GROUP BY 1
    ORDER BY 1 ASC
  `) as Array<Record<string, unknown>>;

  // Week-over-week return: cohort = users active in week 1 (the OLDEST 7 UTC days of the window).
  // For each subsequent week-bucket, count how many of that cohort were active in that bucket.
  // Bucket index 0 = oldest 7 days; the window holds ceil(days / 7) buckets.
  const weekRows = (await sql/*sql*/`
    WITH bounds AS (
      SELECT date_trunc('day', now() AT TIME ZONE 'UTC')
             - ((${days} - 1) || ' days')::interval AS window_start
    ),
    active AS (
      SELECT DISTINCT
        w.owner_user_id AS user_id,
        floor(
          EXTRACT(EPOCH FROM ((e.occurred_at AT TIME ZONE 'UTC') - b.window_start)) / 86400 / 7
        )::int AS week_index
      FROM operation_events e
      JOIN workspaces w ON w.id = e.workspace_id
      CROSS JOIN bounds b
      WHERE e.archived_at IS NULL
        AND e.occurred_at >= b.window_start
    ),
    cohort AS (
      SELECT user_id FROM active WHERE week_index = 0
    )
    SELECT
      a.week_index::int AS week_index,
      count(DISTINCT a.user_id)::int AS returning_users
    FROM active a
    JOIN cohort c ON c.user_id = a.user_id
    GROUP BY a.week_index
    ORDER BY a.week_index ASC
  `) as Array<Record<string, unknown>>;

  // Zero-fill the daily series so quiet days are explicit (not gaps the UI must infer).
  const byDate = new Map<string, EngagementDay>();
  for (const r of dailyRows) {
    const date = String(r.date);
    byDate.set(date, {
      date,
      active_users: Number(r.active_users || 0),
      active_workspaces: Number(r.active_workspaces || 0),
      events: Number(r.events || 0),
    });
  }
  const daily: EngagementDay[] = [];
  const todayUtc = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(todayUtc.getUTCFullYear(), todayUtc.getUTCMonth(), todayUtc.getUTCDate() - i));
    const key = d.toISOString().slice(0, 10);
    daily.push(byDate.get(key) ?? { date: key, active_users: 0, active_workspaces: 0, events: 0 });
  }

  // returnRate: week1 baseline = cohort (week_index 0). Each weekN = returning / cohort * 100.
  const returningByWeek = new Map<number, number>();
  for (const r of weekRows) {
    returningByWeek.set(Number(r.week_index), Number(r.returning_users || 0));
  }
  const cohortUsers = returningByWeek.get(0) ?? 0;
  const weekCount = Math.ceil(days / 7);
  const returnRate: Record<string, number> = {};
  for (let w = 0; w < weekCount; w++) {
    const returning = returningByWeek.get(w) ?? 0;
    const pct = cohortUsers > 0 ? Math.round((returning / cohortUsers) * 1000) / 10 : 0;
    returnRate[`week${w + 1}`] = pct;
  }

  return {
    window_days: days,
    daily,
    returnRate,
    cohort_users: cohortUsers,
    generatedAt: new Date().toISOString(),
  };
}
