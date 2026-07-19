# ADR-XB-002 — One Scoped Planning Model

- **Status:** proposed (awaiting operator ratification — N-UX.0; execution = N-UX.3, P2)
- **Date:** 2026-07-20
- **Owner:** marat
- **Relates:** CANONICAL_DOMAIN_MODEL.md §1/§3; ADR-XB-007 R2/R5; mig 066/069/074

## Context

Three stores claim the plan concept today: `plan_entities` (mig 066 — the customer plan
facade: goal/milestone/todo/intent), `synthetic_domain_goals` + `synthetic_domain_roadmap_items`
(006/069 — the operator-lens planning surface), and `board_cards`. The ambiguity is
CODIFIED, not latent: mig 074's scope trigger resolves a goal `target_id` against **either
authority** — `plan_entities WHERE kind='goal'` PLUS `synthetic_domain_goals` — and raises
`'target_id is ambiguous across goal authorities'` when both match. A relationship edge
that cannot know which table its target lives in is the live defect this ADR closes. Both
external assessments independently prescribed the same consolidation (stop-condition:
"two stores claim the same plan concept").

## Decision

ONE scoped planning model: **`Objective / Initiative / Milestone / WorkItem / Risk /
Proposal / Roadmap`**, every row carrying a **`scope_ref`** (workspace / domain / project /
lens). It absorbs `plan_entities`, `synthetic_domain_goals`, `synthetic_domain_roadmap_items`,
and `board_cards`. Ownership per scope follows CANONICAL_DOMAIN_MODEL §3 (project = the
only scope owning executable WorkItems; lens contributes Proposals only). MB-P bridge:
mig-069's **`source_goal_id`** links scoped objectives to ECOSYSTEM_GOALS G-* — the
designed landing zone, already in schema. `plan_entities.kind='intent'` rows are renamed
to `plan_item` or promoted via the existing `promoted_to_intent_id` ref (ADR-XB-007 R2).

**Migration discipline (ratified stop-condition):** no destructive consolidation without a
rollback path AND a per-store reconciliation ledger (row counts in → rows migrated →
rows tombstoned, per source table). The mig-074 either-authority resolver retires in the
same migration.

## Options considered

- **A. Keep three stores, sync them** — rejected: sync IS the defect (074 proves it);
  every new consumer re-decides which authority to read.
- **B. Crown one existing table as-is** — rejected: 066 is customer-facade-shaped,
  069 is lens-scoped; neither closes the other's surface without a remodel anyway.
- **C. One scoped model with migration + ledger (chosen)** — the only option that kills
  goal×2 AND the fractal-planning NO-GO at the schema layer.

## Consequences

- The 4-projection read-models (ADR-XB-005) and the PLAN pane render from one store.
- Roll-ups (department/workspace task views) become queries, not copies.
- Until N-UX.3 executes, the three stores remain live — new features MUST NOT add a
  fourth planning surface, and new edges MUST NOT extend the either-authority pattern.
