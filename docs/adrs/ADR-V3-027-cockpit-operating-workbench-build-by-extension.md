# ADR-V3-027 · Cockpit operating-workbench — build by extension, reject the OSS-heavy path

**Status:** Accepted — Stage-0 decision-freeze of the 2026-06-27 "Cockpit → Operating Workbench" program
**Date:** 2026-06-27
**Decision-makers:** Marat
**Supersedes:** none — **amends** the program plan's Track-A Stage 4 ("Dockview + new Vite `dist/v3-workbench.js`") with an evidence-based reuse-first path
**Cross-link:** [ADR-V3-024](ADR-V3-024-workbench-shell-and-pane-registry.md) (native pane engine, render-proven) · [ADR-V3-017](ADR-V3-017-fsd-features-layer-decision.md) (5-layer FSD) · `ADR-0053` (esbuild build path deprecated → Vite) · `~/Downloads/Ui and UX cockpit/*` (the operator's OSS research that proposed the heavy path) · `docs/frontend/contracts/pane.contract.schema.json`

## Context

The 2026-06-27 program proposes evolving the live Xlooop cockpit (`app.xlooop.com`) into a multi-pane "operating workbench" with 6 modes (Command/Plan/Operate/Govern/Build/Admin), a chat-with-entity-widgets surface, and a right inspector. The operator's research folder + the program's Plan-agent pass recommended adopting **Dockview** (workbench layout), **shadcn/Radix** (design system), **TanStack Table** (grids), and **React Flow** (lineage) as a new Vite-built `dist/v3-workbench.js` bundle.

A Stage-0 grounding audit of `origin/main` (`b1ab35bd`, PR #761) found that premise **substantially over-stated** — the capabilities those libraries provide **already exist in the app**, and none of the libraries are actually present:

| Capability the OSS lib was for | Already in the app (evidence) |
|---|---|
| Multi-pane workbench layout | **`PROJECT_WORKSPACE_LAYOUTS_DPS = [one_up, two_up, four_up, reference_stack, freeform]`** in `src/widgets/DetailedProjectShellDesign/project-workspace-model.js` — a resizable freeform multi-pane engine, **render-proven** end-to-end (ADR-V3-024, `shell.workbenchPaneHost` flag renders `SignoffEvidence` as a live `pane-host`, 0 console errors) + the app-level adapter `workbench-pane-adapter.js` (`withWorkbenchPane`, 4/4 unit tests) |
| Design-system primitives | **`src/shared/uiKit/*` — 44 components** (ActionButton, StatusBadge, MetricCard, ProjectsTable, EmptyState, ContextChip, Popover, FilterBar, ModeBadge, GovernancePacket, …) on CSS-var tokens |
| Lineage / graph canvas | **`src/widgets/LineageWithComments/`** (widget + `contract.json` + stories + tests) |
| Data grids / queues | **`src/shared/uiKit/ProjectsTable/`** + table widgets |
| Screen routing / modes | **`XcpScreenRouter` SCREEN_REGISTRY — 24 screens** incl. chat/plan/operate/audit/workspace/project/project-workspace/settings/profile/boards/folders/insights/intents |

Authoritative check: `package.json` contains **no** `dockview`, `@radix-ui/*`, `@tanstack/react-table`, `reactflow`/`@xyflow`; `grep` of `src/` for those imports returns **0**. (Earlier tree-wide `git grep` hits were docs/lockfile noise, not real adoption.) Adopting any of them would therefore be a **net-new heavy dependency** introduced to duplicate a capability the app already has — the "broken-duplicate" failure mode ADR-V3-024 was written to prevent.

## Decision

**Build the operating-workbench by EXTENSION + COMPOSITION of existing engine, primitives, widgets, and screens — introduce zero new heavy OSS UI dependencies in Stages 0–5.**

1. **Layout = elevate the native engine.** Promote the project-scoped `PROJECT_WORKSPACE_LAYOUTS_DPS` engine to an app-level workbench via the existing `workbench-pane-adapter.js` boundary (ADR-V3-024). **REJECT Dockview** — it would be the second shell ADR-V3-024 forbids.
2. **Primitives = the existing uiKit.** Compose `src/shared/uiKit/*` + the CSS-var design tokens. **REJECT Radix/shadcn/Tailwind** — redundant with the 44-component kit, and Tailwind's global utility classes would trip `verify:host-css-render` (no Tailwind/PostCSS config exists today, by design).
3. **Lineage = extend `LineageWithComments`.** **REJECT React Flow** as a Stage-0–5 dependency; reconsider it ONLY at Stage 6 (source→evidence graph) IF the existing widget proves insufficient — and then only behind a spike + an isolated bundle-budget gate.
4. **Grids = reuse `ProjectsTable`** + existing table widgets. **REJECT TanStack Table** unless a specific advanced-grid gap is proven.
5. **Modes = compose existing screens.** Map the 6 modes onto SCREEN_REGISTRY: Command→`chat`, Plan→`plan`, Operate→`operate`, Govern→`audit` (+ evidence/`operator-consent-approvals`), Admin→`settings`/`profile`/`boards`; **Build** = a new operator-only screen (the only net-new mode). No new bundle for layout — reuse `v3-app`/`v3-shell-widgets`. Because **no new heavy dep is added, the deprecated-esbuild constraint (ADR-0053) and the "new Vite `v3-workbench.js`" are moot** for layout; a separate Vite bundle is introduced LATER *only if* a genuinely heavy dep (e.g. React Flow at Stage 6) is sanctioned.
6. **The one genuinely-new artifact = the chat entity-widget renderer + entity-card registry** (program Stage 3): the 11 entity cards (Source/Goal/Intent/Packet/Event/Evidence/Sign-off/Metric/ToolRun/Connector/Risk) that open the existing `OperatingObjectDrawer` right-inspector and emit Events via `operator-capture.js`. No existing equivalent — this is where net-new build effort belongs.

## Consequences

**Positive:** removes the single biggest risk and cost (Dockview-in-Vite integration + 300–600 KB of OSS bundle weight against ~1.4 KB `v3-app` headroom); `v3-app` size ratchet untouched; no new OSS license/supply-chain/secrets review; reuses already-green gates (`verify:pane-contract-conformance`, `verify:shell-preservation`, `verify:screen-global-parity`); the program collapses from an OSS-heavy multi-week build into a reuse-first extension whose only net-new surface is the chat-widget renderer.
**Negative / cost:** the native pane engine is project-scoped — app-level elevation needs the adapter boundary (already spiked, 4/4 tests per ADR-V3-024) plus a workbench-scoped persistence key; the existing `LineageWithComments` may need enrichment for a full source→evidence graph (deferred to Stage 6, spike-gated).
**Out of scope:** customer-visible terminal; Tailwind/shadcn-as-library; a second shell or `App.jsx` substitution (ADR-V3-024 preserved); mobile full-cockpit (review/sign-off only).

## Verification

- The felt-pain stages (program Stage 1 chat-clarity, Stage 3 chat entity-widgets) and the workbench composition reuse existing green gates and add composition gates (`verify:visible-controls-backend-backed` etc.) that wrap existing ones (`verify-connector-no-dead-stub`, `verify-executable-self-serve-flows`, `verify:source-binding-tenant-isolation`).
- Every stage stays flag-gated (`shell.*` default OFF), flag-OFF byte-identical (r13.16 chat/workspace baselines + `verify:cache-token-completeness` + `verify:build-idempotence`), ci-local green, design-review ≥85 before any default flip, deploys operator-named.
- **No Stage-0 OSS license review needed** — deps unchanged. The only future license review is gated to a Stage-6 React-Flow spike *if* it is ever sanctioned.

## Re-evaluation triggers

- The native engine proves too project-coupled to elevate to app-level without a rewrite (gate on an app-level adapter spike, not assumption) → reconsider a single, isolated OSS layout lib.
- `LineageWithComments` cannot render the source→evidence graph at Stage 6 → spike React Flow behind an isolated bundle budget + license review.
- A genuine advanced-grid requirement (virtualized 10k-row queue) that `ProjectsTable` cannot meet → spike TanStack Table behind the same isolation.
