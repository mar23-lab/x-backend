# ADR-XB-003 — Lenses Are Derived-Only

- **Status:** proposed (awaiting operator ratification — N-UX.0)
- **Date:** 2026-07-20
- **Owner:** marat
- **Relates:** CANONICAL_DOMAIN_MODEL.md §1/§3; mig 005 (synthetic_domains); the LEM-v4 recommendations plane

## Context

`synthetic_domains` (mig 005) is a derived membership view of projects selected by a
declarative binding — and it simultaneously renders as "Departments" in the UI and hosts
its own goals/roadmaps (006/069). The backend itself encodes the ambiguity
(`ResolvedDomain.kind ∈ {lens, life, unknown}`). Both assessments flagged domain/lens
conflation as the #1 UX confusion; both listed lens-owned canonical plans as a NO-GO.
Meanwhile the promotion machinery a lens actually needs is ALREADY LIVE:
`synthetic_domain_recommendations` accept/reject plus the LEM-v4 inference plane
(calibration, anti-recommendation memory, suppression loops) — richer than either
assessment prescribed.

## Decision

1. A **lens** is a computed view: signals, insights, and PROPOSALS. It owns NOTHING
   canonical — never objectives, never work items, never a plan store.
2. The lens PLAN pane EXISTS, but as a **proposals inbox**: promote/reject via the
   existing recommendations accept flow. Promotion is the ONLY path from lens content
   to canonical planning (landing in the ADR-XB-002 model under a real scope).
3. `synthetic_domains` splits by **kind-discriminated rendering**, not by table:
   domain-kind rows (life/company/work/custom) render as knowledge boundaries with
   adaptive labels (CANONICAL_DOMAIN_MODEL §5); lens-kind rows render as Lens/View
   with distinct icons/labels.
4. **"Synthetic domain" is retired as customer-facing language.** It survives only as
   the internal table name until a later rename rides a structural migration.

## Options considered

- **A. Split into two tables now** — rejected: zero-backend-change adoption (N-UX.1)
  gets the full UX win via `kind`; a table split is cost without new capability.
- **B. Let lenses keep their goals/roadmaps** — rejected: that is the lens-owned-
  canonical-plans NO-GO; it re-creates goal×2 the day after ADR-XB-002 closes it.
- **C. Derived-only + kind-discriminated rendering + existing promotion flow (chosen).**

## Consequences

- Frontend adopts `/synthetic-domains` (8 governed endpoints, 0 refs today) as the
  lens/area SSOT — kills the lossy `/plan`-flatten derivation.
- Lens goals/roadmap rows migrate into the scoped model or tombstone at N-UX.3.
- New lens features must ship as proposals, or they don't ship.
