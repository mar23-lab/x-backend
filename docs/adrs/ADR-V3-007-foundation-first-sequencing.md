# ADR-V3-007 · Foundation-first sequencing (T1 → T2 → T3 → Phase 5)

**Status:** Accepted 2026-05-04 (T1 cascade green across commits e0870ac → 528d8c3 → 5fd566b · 22 specs · smoke-cli 118/118 · axe 0/10 at audit time)
**Date:** 2026-05-03
**Decision-makers:** Marat
**Supersedes:** none
**Cross-link:** [ADR-V3-001](ADR-V3-001-v3-canonical-saas-frontend.md), [ADR-V3-002](ADR-V3-002-dal-adapters.md), [ADR-V3-006](ADR-V3-006-typescript-migration.md), [ADR-V3-008](ADR-V3-008-fsd-layout.md), [ADR-V3-009](ADR-V3-009-eventbus-topic-registry.md), [ADR-V3-010](ADR-V3-010-store-adapter-shim.md), [risk-register.md D10–D18](../risk-register.md), x-docs `compiler-engine-xfront.md`

## Context

After Phases 0–6 + the audit + UI redesign, v3 is a working demo prototype on a flat scaffold. The 2026-05-03 audit confirmed three load-bearing surfaces (`runtime/*.ts`, `contracts/*.ts`, `window.policy` API) are loaded but **dead code** (zero imports). The 2026-05-03 x-front audit confirmed x-front is *a peer with gaps*, not a flawless reference: it leads on EventBus (9/10), StoreAdapter (9/10), contract tests (8/10), and FSD (7/10), but lags on async/RTC (3/10), Storybook contracts (5/10), TS strictness (6/10), and dead-code hygiene (4/10).

Phase 5 (Client Review) and any x-front migration multiply consumer count. Building on the current scaffold compounds structural debt at LOC × file_count rate.

## Decision

**Adopt foundation-first sequencing: T1 → T2 → T3 → Phase 5 → x-front migration → Phase 8 (engine merge).**

| Tier | Scope | Stop condition |
|---|---|---|
| **T1** | FSD layout, DDD entities, StoreAdapter shim, AuthProvider stub, EventBus + topic registry, contract test ports (DAL/EventBus/providerChain/storeShape + R2 engine surface), BroadcastChannel cross-tab | Any existing e2e spec breaks |
| **T2** | Storybook (Ladle if SB exceeds budget), TS precompile pipeline, live imports for `runtime/state-trace.ts` + `runtime/event-envelope.ts`, FSD lint, component contract.json | TS pipeline blocked by Babel ceiling |
| **T3** | Husky pre-commit, GitHub Actions CI, gitleaks secret scan, perf budget assertion | CI green; secrets scan passes |
| **Phase 5** | Multi-tenant Client Review (signed-URL + register stub + read-only pane) | Drops onto T1 seams |
| **x-front migration** | uiKit, theme, contract tests for component library | Only after T1 + T2 land |
| **Phase 8** | Babel-AST bi-sync engine merge per `compiler-engine-xfront.md` R2 contract | Only after Ilmir's track ready and v3 `__contracts__/r2-engine-surface.contract.test.ts` is green |

**Rejected alternative:** "Ship Phase 5 on the current flat scaffold, refactor later." Estimated cost ratio is ~3× (refactoring after Phase 5 means touching every new Client Review consumer; refactoring before Phase 5 means touching today's 10 jsx files).

**Discipline adopted:** the **research → decision → plan → tasks → audit** cycle from x-docs (e.g. `1-research-AST-proxy.md` → `2.2-decision-target-architecture.md` → `3-plan-AST-proxy.md` → `task-*.md` → `r2-adr-acceptance-review.md`). For this ADR specifically:
- **Research:** `Plan · v3 Foundation` (the comprehensive plan file) §2.8 audit of x-front + x-docs.
- **Decision:** this ADR.
- **Plan:** that plan file's §4 (T1/T2/T3 tier table).
- **Tasks:** that plan file's §8 (file-level breakdown).
- **Audit:** T1 verification cascade — `verify-v3` 12/12, axe 0/10, all 6+ specs green, smoke-cli 32+/32+, runBootCheck 15/15, bundle parse <2s.

## Consequences

**Positive:**
- v3 closes the gap on FSD/DDD/EventBus/StoreAdapter discipline before Phase 5 multiplies consumers.
- v3 leapfrogs x-front on async + cross-tab + RTC seam, keeping the Kafka swap path open.
- Adopting the x-docs audit cycle gives every future ADR a verifiable closure step.
- Phase 5 ships into a clean foundation; investor/CTO conversation has a credible engineering surface.

**Negative:**
- Phase 5 (Client Review — the demo wedge) is delayed by one foundation pass.
- Increased upfront token spend on restructuring before user-visible progress.
- T1 introduces 28+ new entity files and several service files; cognitive load on first navigation grows before it shrinks.

**Out of scope:**
- Real backend, OIDC, Kafka — post-Phase-8 / post-backend-arrival.
- Migrating existing v2 to FSD — v2 is frozen per ADR-V3-001.
- Mirroring x-front's technical debt (1093 type casts, 9 dead `_old-*` folders, no Storybook contracts) — v3 explicitly improves on these per audit findings.

## Verification

**T1 gate (this ADR moves Proposed → Accepted only when all green):**

- `node scripts/verify-v3.mjs` returns 12/12 PASS.
- `node v3/project/v3/scripts/smoke-cli.mjs` returns 32/32+ PASS (new checks for FSD layout, entity files, EventBus topics, AuthProvider stub, StoreAdapter API, contract test files).
- `node scripts/axe-v3-sweep.mjs` returns 0 violations × 5 surfaces × 2 themes.
- `npx playwright test tests/e2e/v3-*.spec.ts` returns ≥7 PASS (existing 6 + new `v3-cross-tab-bus.spec.ts`).
- `npx vitest run v3/project/v3/__contracts__/` returns 4+ contract tests PASS.
- `runBootCheck()` reports `ok: true · 15/15` (added: `eventbus rendered`, `auth provider rendered`, `store adapter rendered`).
- Bundle parse time ≤ 2s cold (measured via `benchmark-v3.mjs`).
- Working tree clean; commit on `main` with attestation in message body.

**T2 / T3 gates:** see ADR-V3-008 / 009 / 010 / 011 / 012 for tier-specific verification.

## References

- [ADR-V3-001 v3 canonical SaaS frontend](ADR-V3-001-v3-canonical-saas-frontend.md)
- [ADR-V3-002 DAL adapters](ADR-V3-002-dal-adapters.md)
- [ADR-V3-006 TypeScript migration](ADR-V3-006-typescript-migration.md) (amended; precompile pipeline prerequisite)
- [risk-register.md D10–D18](../risk-register.md)
- x-docs `compiler-engine-xfront.md` (R2 stable surface, ACCEPTED 2026-04-28)
- x-docs `XLOOOP_CONCURRENCY_ASYNC_AND_XCP_ROADMAP_GAPS.md` (G-ASYNC-2 confirms RTC is net-new for ecosystem)
