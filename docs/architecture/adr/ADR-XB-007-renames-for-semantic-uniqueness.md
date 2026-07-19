# ADR-XB-007 — Renames for Semantic Uniqueness

- **Status:** proposed (awaiting operator ratification — N-UX.0; executions ride N-UX.2/.3 migrations)
- **Date:** 2026-07-20
- **Owner:** marat
- **Relates:** CANONICAL_DOMAIN_MODEL.md §2 (the full rename register); ADR-XB-002

## Context

The ontology extraction found 10 x-backend internal double-meanings. The dangerous class
is same-NAME-different-CONCEPT: code reads correctly and means the wrong thing. Three
renames + one ruling + one single-source fix close the x-backend side (the MB-P-side
`pillar_fit`→`quality_dimension` rename is recorded in the model doc §2 R4 and executes
in MB-P, not here).

## Decision

1. **`context_packets` → `context_receipts`** (kills packet×3). A context record is a
   receipt of what a run knew, not a work unit. Mig 071 is STAGED with no live data —
   the rename rides inside the 071 activation migration itself, so no live-table rename
   ever occurs.
2. **`customer_entitlements.allowed_actions` → `granted_spine_actions`** (kills
   allowed_actions×2). The M4 envelope keeps `allowed_actions` (server-derived authority
   result, `src/workers/lib/allowed-actions.ts` / `permissions.ts`); the entitlement
   column is a GRANT of SpineActions and says so. Column rename + code sweep + contract
   version note.
3. **`plan_entities.kind='intent'` ruling** (kills intent×2): `intents` (023/081) is the
   sole durable-ask authority (ADR-ABS-011). The plan-facade kind renames to
   **`plan_item`** — or the row promotes to a real intent REF via the existing
   `promoted_to_intent_id` column. Executes inside the ADR-XB-002 consolidation.
4. **Graph vocabulary single-source** (kills the ×3 drift): the vocabulary is defined
   three disagreeing ways — `src/workers/graph/data-graph.ts` (8 node types, `evidences`,
   `governs` deprecated) vs mig-029 CHECK (7 types, `governs`) vs mig-069 CHECK (9 types
   + 3 goal edges). **`data-graph.ts` becomes the ONE authority**; the DB CHECK
   constraints are REGENERATED from it (generator emits the constraint DDL; a drift
   check compares deployed CHECKs against the generated set).

## Options considered

- **A. Document the collisions, rename nothing** — rejected: gloss can't stop a new
  consumer from binding to the wrong meaning; 074's either-authority resolver shows
  collisions get CODIFIED if left standing.
- **B. Big-bang rename wave** — rejected: `context_receipts` is free only inside the
  staged 071; forcing live-table renames now buys nothing and risks the spine.
- **C. Each rename rides its natural migration; single-source generated constraints (chosen).**

## Consequences

- Grep for any of these terms returns exactly one concept each.
- The graph CHECK generator becomes the pattern for every future closed vocabulary
  (source_type follows it per the model doc §1).
- Contract v1 consumers of `customer_entitlements` see one versioned field rename.
