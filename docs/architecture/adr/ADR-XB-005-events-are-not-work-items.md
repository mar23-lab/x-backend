# ADR-XB-005 — Events Are Not Work Items (Four Projections of One Spine)

- **Status:** accepted (ratified by operator authorization, 2026-07-20 — Marat Basyrov, session 260720; execution rides the N-UX waves)
- **Date:** 2026-07-20
- **Owner:** marat
- **Relates:** CANONICAL_DOMAIN_MODEL.md §1; `operation_events`; `operations_unified`

## Context

The Events rail today renders the `operation_events` stream with work-ish statuses
(queued/running/blocked/needs_review/completed) and "% done" chips, and
`operations_unified.kind` mixes event/packet/governance_event/decision under one
"Events" label. But an event is an immutable occurrence — it cannot be "70% done". The
external assessment's "events are not done" finding is CONFIRMED by ground truth, and
treating the event stream as work-queue-and-audit simultaneously is one of its four
NO-GOs, ratified. Each audience (worker, observer, auditor, investigator) is currently
served the same mixed feed.

## Decision

ONE spine (intent → packet → events → evidence → decision → sign-off), FOUR read-model
projections — **no schema change**:

| Projection | Serves | Contents |
|---|---|---|
| **Work Queue** | people doing work | work items: mine · need-you · blocked · complete — status/progress lives HERE (packets/work items), nowhere else |
| **Activity** | observers | recorded events — immutable, timestamped, NEVER carrying "done%" |
| **Lineage** | investigators | caused_by / derived_from / realizes navigation |
| **Audit** | compliance | the append-only record view |

View × Group-by × Filters are separate controls, not new data. `operations_unified`
becomes an implementation detail behind the projections. The first step ships as a
client-side regroup of the existing feed (N-UX.1), the read-models follow.

## Options considered

- **A. Add status/progress columns to events** — rejected: mutates the meaning of the
  append-only spine; "done%" on an immutable occurrence is the defect, not a feature gap.
- **B. Split the schema into four tables** — rejected: the spine is correct; only the
  READS are conflated. Schema surgery adds migration risk for zero semantic gain.
- **C. Four read-model projections over the unchanged spine (chosen)** — each audience
  gets its truth; reversible; starts client-side.

## Consequences

- "% done" disappears from every event render; progress appears only on Work Queue items.
- The Events rail relearn is the biggest N-UX.1 frontend build (accepted trade-off).
- Audit/lineage surfaces stop inheriting work-queue noise, and vice versa.
