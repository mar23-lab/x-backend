# ADR-V3-002 · Backend-agnostic data layer via DAL adapters

**Status:** Accepted
**Date:** 2026-05-03
**Decision-makers:** Marat
**Supersedes:** none
**Cross-link:** [ADR-V3-001](ADR-V3-001-v3-canonical-saas-frontend.md), x-front `src/__contracts__/dal.contract.test.ts`, x-front `src/shared/services/storeAdapter`

## Context

x-front has a DAL (Data Access Layer) pattern that decouples UI from any specific backend. Concretely:

- `src/__contracts__/dal.contract.test.ts` — a type-only contract test pinning the DAL shape.
- `src/shared/services/storeAdapter` — adapter implementations.
- `src/shared/storybook/contracts/DAL.mdx` — narrative documentation.
- `src/__contracts__/storeShape.contract.test.ts` and `providerChain.contract.test.ts` — adjacent pins for store + provider order.

This means x-front (and by extension v3 once contracts are ported) can swap the persistence backend without changing UI code. PostgreSQL, in-memory, mocked, REST, GraphQL — all are *adapter implementations* against the DAL contract, not architectural decisions baked into UI.

For the v3 demo today, the persistence backend is `localStorage` keyed at `xcp.v3.store.v2`, mutated by a `useReducer`. This is effectively the **in-memory + LS adapter**. It works for the demo and for Playwright tests.

## Decision

**v3 adopts x-front's DAL adapter pattern.** The contract is the canonical seam between UI and persistence.

- The DAL contract test is mirrored in `v3/project/v3/__contracts__/dal.contract.test.ts` once the contract surface stabilises (currently empty placeholder; populated post-Phase 2.5 of the roadmap).
- v3 ships with an **in-memory + LocalStorage adapter** today. No code reaches for a specific database; all reads/writes go through the adapter interface.
- PostgreSQL is **one possible adapter**, not the only one; not implemented in v3 today.
- When the engine merges in (post-Ilmir's track), the engine consumes the same DAL contract surface; UI does not change.
- The Intent Graph storage shape (per `Xlooop_Runtime_Workbench_SSOT_Updated.extracted.md` §7 PostgreSQL node/edge) is *one adapter implementation*. v3 demo runs an in-memory implementation today.

**No backend lock-in.**

## Consequences

**Positive:**
- v3 demo never depends on a real backend; ships standalone (`index.standalone.html`) with file:// boot.
- Real backend integrations (Postgres, REST APIs, GraphQL) are pluggable; UI tests remain stable.
- Aligns v3 with x-front's existing pattern; engine merge requires no UI rewrite.
- Defensibility story holds: "we choose the DB, not the DB chooses us."

**Negative:**
- One layer of indirection between UI and storage today (negligible; reducer pattern already absorbs it).
- Adapter contract must stay versioned and stable; breaking changes ripple.

**Out of scope of this ADR:**
- The actual choice of production backend (Postgres vs alternatives) — owned by engine + ops tracks.
- Intent Graph storage schema details — pinned in SSOT; this ADR governs only the seam.

## Verification

- `v3/project/v3/__contracts__/README.md` documents the placeholder for the DAL contract test (populated in Phase 2.5 of the roadmap).
- After Phase 2.5: `npx vitest run __contracts__/dal.contract.test.ts --environment node` passes.
- v3 reducer never imports a backend client directly; all writes route through the DAL adapter interface (enforced by TS once Phase 2.1 lands).

## References

- x-front `src/__contracts__/dal.contract.test.ts`
- x-front `src/shared/storybook/contracts/DAL.mdx`
- [ADR-V3-001](ADR-V3-001-v3-canonical-saas-frontend.md)
- [ADR-V3-006](ADR-V3-006-typescript-migration.md)
- [risk-register.md A1, D7](../risk-register.md)
