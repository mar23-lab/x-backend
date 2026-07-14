# ADR-V3-024 · Workbench shell & pane registry · extend the existing engine

**Status:** Accepted — **render-proven** 2026-06-06 (SignoffEvidence renders as a flag-gated `pane-host` in the live engine end-to-end; workbench-scoped persistence still deferred to Phase-3+)
**Date:** 2026-06-06
**Decision-makers:** Marat
**Supersedes:** none
**Cross-link:** [ADR-V3-008](ADR-V3-008-fsd-layout.md) · [ADR-V3-017](ADR-V3-017-fsd-features-layer-decision.md) · `docs/frontend/WORKBENCH_SHELL_READINESS_AUDIT.md` · `docs/frontend/MODULE_ACCOUNTABILITY_MATRIX.md` · `docs/frontend/WORKBENCH_MODULE_REGISTRY_PROPOSAL.md` · `docs/frontend/WORKBENCH_TEST_GATES.md` · `docs/frontend/contracts/` · `docs/disposition/260606_workbench-module-disposition.yml` · `prototypes/workspace-shell/` (isolated design prototype, PR #411)

## Context

A request was raised to run a "module accountability inventory **before introducing** a configurable
split-screen workspace shell." A read-only Phase 0 audit (2026-06-06) found the founding premise false: **a
configurable split-screen, multi-pane, multi-layout workspace engine already exists**, together with a screen
registry and a per-widget contract system.

Evidence (paths in `Xlooop-XCP-demo/`):

- **Pane/layout engine** — `src/widgets/DetailedProjectShellDesign/project-workspace-model.js`:
  `PROJECT_WORKSPACE_LAYOUTS_DPS = [one_up, two_up, four_up, reference_stack, freeform]`, a resizable
  freeform grid (`panelGridStyleDPS`, `panelResizeNextDPS`), 7+ panel types. Persistence:
  `…/project-workspace-stores.js` — named saved layouts, `BoardLayout.v2` with v1→v2 migration.
- **Screen registry** — `src/widgets/XcpScreenRouter/XcpScreenRouter.jsx`: `SCREEN_REGISTRY` = 18 enumerable
  screens, `window.XcpScreens`, `?screen=` deep-linking; widgets resolved at runtime via `window[config.widget]`.
- **Contract surface** — 49 of 73 top-level widgets carry `contract.json`; `runtime/topic-registry.ts` declares 28 typed events.
- **The engine's own gates are green** — `verify:board-layout-v2-operability`, `verify:project-workspace-module-boundaries`
  ("deeper extraction can proceed safely"), `verify:project-workspace-responsive`, `verify:navigation-taxonomy`.

The engine is project-scoped. The request targets an app-level workbench. A greenfield "new shell" would fork
layout/routing/persistence already present and tested — the classic broken-duplicate failure mode.

## Decision

**Extend the existing engine; do not build a second shell.**

1. `DetailedProjectShellDesign`'s layout engine + `XcpScreenRouter`'s `SCREEN_REGISTRY` are the canonical workbench foundation.
2. The pane registry is a **read-model over existing sources** (`SCREEN_REGISTRY` + `contract.json` + `nav-config.json`), not a new parallel registry.
3. **Preserve the left nav and the top strip**, and do not substitute `src/app/App.jsx`.
4. Sequence: Phase 0 inventory → Phase 1 ratify → Phase 2 author the missing Pane contract + close test gaps → Phase 3 controlled extension behind a flag → Phase 4 cross-domain (deferred).
5. The 5-layer FSD variant (no `features/`) stands (ADR-V3-017).
6. UX is validated by an **isolated reference prototype** (`prototypes/workspace-shell/`, PR #411) that mirrors the engine vocabulary — it feeds this ADR, it is not a second production shell.

## Consequences

**Positive:** no duplicate engine; builds on already-green gates; pane registry derives from existing contracts.
**Negative / cost:** the engine is project-scoped — elevating to app-level needs an adapter boundary (the spike
localised it to a generic pane assembler + a workbench-scoped persistence key); 22 contract-less/under-tested
widgets need backfill before confident pane-hosting.
**Out of scope:** cross-domain side-by-side (Phase 4); deleting the 5 superseded prototype predecessors (verify refs first).

## Verification

- `docs/frontend/WORKBENCH_SHELL_READINESS_AUDIT.md` + `docs/disposition/260606_workbench-module-disposition.yml`
  classify all 73 widgets + 18 screens. Exit gate satisfied: **keep 16 / refactor 22 / defer 14 / delete-candidate 5 / promote-to-pane 16**; pane_eligible 22.
- No second shell, no `App.jsx` substitution, left nav + top strip untouched.

## Ratification (Phase 1 → Phase 2 → Phase 3 · 2026-06-06)

- **Adapter spike** (`tests/unit/spike-workbench-pane-host.test.mjs`) — **6/6 pass**. Proves the framework-free
  layout MODEL (`panelGridStyleDPS` / `panelResizeNextDPS` / `buildBoardLayoutDPS`) is project-agnostic and
  localises the adapter boundary to (a) a generic pane assembler and (b) a workbench-scoped persistence key.
- **Pane contract authored** (`docs/frontend/contracts/`) — the genuinely-missing abstraction with the explicit `state_isolation` guarantee.
- **Gates green & wired** into `verify:stability-suite`: `verify:screen-global-parity` PASS · 18 screens · 1
  resolver-exception; `verify:shell-preservation` PASS · 10/10; `verify:pane-contract-conformance` PASS.
- **Phase-3 render proof (2026-06-06) — claim EARNED.** `shell.workbenchPaneHost` (default OFF) injects
  `SignoffEvidence` as a `pane-host` panel through `workbench-pane-adapter.js` (`withWorkbenchPane`, 4/4 unit
  tests) → `project-operating-space.jsx` controller → `project-workspace-panels.jsx` renderer. Verified live
  (`?screen=project-workspace`, flag ON): `[data-testid=workbench-pane-host][data-mounts=SignoffEvidence]`
  renders with real content (not the fallback), **left nav + top strip preserved**, **0 console errors**.

## Re-evaluation triggers

- The engine proves too coupled to project-only flows to elevate without a rewrite (gate on a Phase-2 adapter spike, not assumption).
- A pilot requires true cross-domain side-by-side before the project-scoped workbench is stable.
