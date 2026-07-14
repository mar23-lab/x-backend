// review-scheduler.ts — Stage-2 A10 · governance review-cadence engine (v0, PURE kernel).
//
// WHY. MB-P's operating rhythm is its review cadence — weekly domain closeouts, monthly finance/
// career reviews, quarterly re-evaluation. That rhythm is what makes governance OPERATE rather than
// merely exist. The product had no counterpart: no tenant-facing recurring-review mechanism (PROD
// plan Tier-A gap A10). SE-1 (mig 069) added `review_cadence` + `review_due` to
// synthetic_domain_goals; this module is the scheduler kernel that turns those into due-review
// signals.
//
// SCOPE (v0, PURE + INERT): pure cadence math + due-selection only — no IO, no cron wiring. The
// flag-gated follow-on (REVIEW_SCHEDULER_ENABLED, default off) wires a cron that: reads goals with
// review_due <= now, emits a `needs_review` operation_event per due goal (surfacing it in the
// events rail / needs-you queue), and bumps review_due by the cadence. Keeping the math isolated
// makes it exhaustively unit-testable with zero risk to the live crons.

/** Canonical cadence -> interval in days. MB-P cadences observed: weekly / monthly / quarterly, plus
 *  fortnightly and annual for completeness. Free-text like "weekly health closeout or fatigue signal"
 *  resolves by its leading cadence keyword. Returns null when no cadence keyword is present (an
 *  event-triggered-only review, which the scheduler does not time-schedule). */
export function cadenceToDays(cadence: string | null | undefined): number | null {
  if (!cadence) return null;
  const c = cadence.toLowerCase();
  if (/\bdaily\b/.test(c)) return 1;
  if (/\bweekly\b/.test(c)) return 7;
  if (/\bfortnight|bi-?weekly\b/.test(c)) return 14;
  if (/\bmonthly\b/.test(c)) return 30;
  if (/\bquarterly\b/.test(c)) return 90;
  if (/\b(annual|yearly)\b/.test(c)) return 365;
  return null;
}

/** The next review-due date after `from`, given a cadence. Returns null for event-only cadences.
 *  Pure — takes an explicit `from` (scripts have no ambient clock in some harnesses). */
export function nextReviewDue(cadence: string | null | undefined, from: Date): Date | null {
  const days = cadenceToDays(cadence);
  if (days === null) return null;
  const next = new Date(from.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

export interface GoalReviewRow {
  id: string;
  domain_id?: string;
  review_cadence: string | null;
  review_due: string | null; // ISO date (YYYY-MM-DD) or null
}

export interface DueReview {
  goal_id: string;
  domain_id?: string;
  cadence: string | null;
  cadence_days: number | null;
  review_due: string;
  overdue_days: number;
}

/** Pure selection: the goals whose review_due has passed (<= now), most-overdue first. A goal with a
 *  null review_due is NOT due (unscheduled). `now` is explicit. Total + deterministic. */
export function selectDueReviews(goals: readonly GoalReviewRow[], now: Date): DueReview[] {
  const nowMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const due: DueReview[] = [];
  for (const g of goals) {
    if (!g.review_due) continue;
    const d = Date.parse(g.review_due + 'T00:00:00Z');
    if (Number.isNaN(d) || d > nowMs) continue;
    due.push({
      goal_id: g.id,
      domain_id: g.domain_id,
      cadence: g.review_cadence,
      cadence_days: cadenceToDays(g.review_cadence),
      review_due: g.review_due,
      overdue_days: Math.round((nowMs - d) / 86_400_000),
    });
  }
  return due.sort((a, b) => b.overdue_days - a.overdue_days);
}

/** Bump a due goal's review_due to the next occurrence after `now` (never in the past — if a goal
 *  is many cycles overdue, advance to the first future slot). Returns the new ISO date, or null for
 *  event-only cadences (leave review_due as-is; those are surfaced but not auto-rescheduled). */
export function rescheduleReviewDue(cadence: string | null | undefined, now: Date): string | null {
  const days = cadenceToDays(cadence);
  if (days === null) return null;
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}
