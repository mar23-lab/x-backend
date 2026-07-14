# ADR-V3-001 · v3 as the canonical SaaS frontend

**Status:** Accepted
**Date:** 2026-05-03
**Decision-makers:** Marat (CEO/CTO + frontend-architecture lead)
**Supersedes:** none
**Cross-link:** [ADR-V3-002 DAL adapters](ADR-V3-002-dal-adapters.md), [ADR-V3-006 TypeScript migration](ADR-V3-006-typescript-migration.md), [MIGRATION_TRACK.md](../MIGRATION_TRACK.md)

## Context

We have three frontend codebases:

- **v2** at `/Users/maratbasyrov/Xlooop-XCP-demo/v2/app.html` — single-file demo, 15,137 LOC, Phase 10D in progress, audit-flagged P0 issues unresolved (buyer wizard, persistent context bar gap, contrast).
- **v3** at `/Users/maratbasyrov/Xlooop-XCP-demo/v3/project/v3/` — modular prototype, audit-conformance verified (12/12 verifier · 0 axe violations · 86/100 design review · 2 regression specs).
- **x-front** at `/Users/maratbasyrov/WIP/Xlooop/x-front/` — engine + mature frontend with React 18 + TS 5.8 + Vite 6 + MUI 6 + Monaco + Storybook 8 + Playwright. Holds the Babel-AST bi-sync engine, DAL contract, EventBus topic registry, mature uiKit.

v3 has **better presentation**. v2 has **more substance** (17 contract kinds, AC, decision records, Compliance Fabric, workflow_events). x-front has **the engine** + mature design system.

The strategic question is which surface becomes canonical.

## Decision

**v3 is the canonical SaaS frontend going forward.**

- v3 absorbs v2's substance via cherry-pick (contract kinds, AC, decision records, workflow_events, Compliance Fabric, demo presets, internal harness — all migrate as TS modules).
- v2 is **feature-frozen** as legacy reference. No further audit-fix work in v2. Cherry-picks flow v2 → v3, never the reverse.
- x-front continues as the engine + mature-component repo. Ilmir is separating frontend and engines via typed contracts. Mature x-front surfaces (uiKit, theme, contract-tests, token entities, AuthProvider) migrate to v3 in a separate phase **after** Ilmir's engine separation lands. Migration timing is set by the engine track, not the frontend track.
- The Babel-AST bi-sync engine becomes an embedded library inside v3's Studio surface, gated by typed contracts that v3 mirrors in `v3/project/v3/__contracts__/`.

## Consequences

**Positive:**
- Single canonical demo surface; defensibility story is one-place-to-look.
- v3's audit-conformance baseline (axe 0, design 86/100) is preserved.
- Modular FSD-light layout absorbs new features cleanly.
- v2's substance ports as TS modules; no architectural lock-in.

**Negative:**
- v2 audit work invested in Phases 8–10D becomes reference-only.
- TS migration introduces friction (mitigated by ADR-V3-006 file-by-file gate).
- Engine integration timing depends on Ilmir's track.

**Out of scope of this ADR:**
- Pitch / deck content.
- Backend implementation (covered by ADR-V3-002).
- Specific x-front feature migration list (covered by [MIGRATION_TRACK.md](../MIGRATION_TRACK.md)).

## Verification

- v3 verifier (`scripts/verify-v3.mjs`) returns 12/12 PASS at the time of writing.
- Both v3 specs pass; axe 0/0/0/0/0 across 5 surfaces × 2 themes.
- `audit/design-review-v3-2026-05-03.md` records GO verdict for unscripted desktop walkthrough.
- v2 freeze: no commits to `v2/app.html` after 2026-05-03 (verified at decision time; ongoing discipline).

## References

- [demo-ux-blueprint.md](../demo-ux-blueprint.md)
- [ECOSYSTEM_ARCHITECTURE.md](../ECOSYSTEM_ARCHITECTURE.md)
- [audit-conformance-v3.md](../sessions/audit-conformance-v3.md)
- [risk-register.md A1, D5, D7, D9](../risk-register.md)
