# ADR-V3-025 - W0 three-surface IA takeover

**Status:** Accepted with restrictions
**Date:** 2026-06-13
**Decision-makers:** Marat, Codex session `codex/w0-pr6-adrs-flip-checklist-260613`
**Supersedes:** none
**Cross-link:** `data/ui-journey-priority-matrix.json` · `docs/design/target-user-journey-ia.md` · `docs/engineering/ddd-glossary.md` · `docs/frontend/W0_W1_FLIP_CHECKLIST.md`

## Context

W0 was opened because the current Xlooop operator cockpit was not clear enough for customer-facing self-serve operation. The operator identified duplicated/stale functions, unclear goals and roadmaps, weak intent/comment/event operations, source/domain/project terminology drift, and insufficient production confidence for onboarding two businesses without guided control.

Claude's handoff plan was directionally right, but required correction before execution:

- Correct baseline app bundle was `1,188,678 B`, not `1,165,356 B`.
- Smoke was `599/599`, not `396/396`.
- Perf command was `npm run scan:perf`.
- PR-4 deletion was high risk because live globals had to be relocated before any widget deletion.
- Strict paid-pilot/private Operator mode evidence was missing; guided controlled pilots remained the only honest near-term posture.

## Decision

Adopt the three-surface W0 shell model as the ordinary operator IA:

1. **Home** - chat command surface: chat + scoped slash commands, live event stream, artifact side panel, recommendations inbox.
2. **Workspace** - plan, build, connect: goals + roadmap, projects board, domains as lenses, source bindings, members + roles.
3. **Govern** - trust and measurement: intent lineage, evidence + sign-offs, audit trail, usage insights.

Fullscreen surfaces such as investor portal and customer consent remain outside the ordinary shell.

The object flow for production UX is:

`Source binding -> Workspace/Project context -> Goal/Roadmap -> Intent -> Packet -> Event/Action/Comment -> Decision -> Evidence -> Sign-off -> Metric/Learning`.

DDD terms are fixed as follows:

- **Source** is an origin of facts or files; it never owns product meaning.
- **Source Binding** links a source to a workspace/project with posture, freshness, and provenance.
- **Project** is the real unit of work.
- **Domain/Lens** is a derived or cross-cutting view, including AI-suggested groupings.
- **Intent** is the request/goal.
- **Packet** is the governed operational artifact.
- **Event/Comment** records what happened next.
- **Evidence** proves a claim.
- **Sign-off** is a role-bound decision.
- **Metric/Learning** measures and improves the loop.

## What shipped in W0 slices

- **PR #644** - PR-2 shell flag/extraction slice landed as the default-off three-surface nav foundation.
- **PR #645** - stale `r13.16` visual baselines repaired so later visual parity claims are meaningful.
- **PR #646** - PR-3 retired singular `intent` route with redirect to `intents`, added Suggested lane behind `shell.threeSurfaceNav`, and kept `recommendations` screen for W1.
- **PR #647** - PR-4 relocated five live globals to shared services and retired only inactive `AgentActivityStrip` and `ConnectedCockpit` sidecars. Active `DetailedWorkspaceShell`, `DetailedProjectShell`, and `CollaborationBoardHost` were preserved.
- **PR #648** - PR-5 aligned the journey matrix, target IA, and DDD glossary with Home / Workspace / Govern; preserved three user stories and protected C76 aspect IDs; repaired assisted-mode registry drift.

## Consequences

Positive:

- Ordinary operator IA now has one coherent shell model and one machine-readable matrix guard.
- Source/project/domain terminology is durable in the glossary and matrix.
- Assisted-mode registry now covers the live `global.cockpit_intro` key and primary J1 rail controls.
- Duplicate deletion was conservative: only inactive sidecars were removed, and live globals stayed protected.

Negative / cost:

- W0 is not a full self-serve UX implementation. It documents and guards the intended shell, but it does not yet restructure every surface into the final Home / Workspace / Govern product.
- Bundle reduction target is not met. `dist/v3-app.js` is `1,181,527 B`, only `7,151 B` below the corrected `1,188,678 B` baseline.
- `projection-cron-liveness` remains warn-tier debt in `ci-local`.
- Strict paid-pilot/private Operator mode remains blocked until real evidence is populated and the strict gate passes.

## Non-decisions

- No production flag flip in W0.
- No claim of self-serve production readiness.
- No automatic WIP import.
- No direct MB-P writeback from Xlooop.
- No deletion of active `DetailedWorkspaceShell`, `DetailedProjectShell`, or `CollaborationBoardHost` entrypoints.

## Verification

Evidence run across W0 slices included:

- `npm run verify:current-integrity` - PASS, `54/54` after PR-4/PR-5.
- `npm run ci-local` - PASS, `38/38` blocking gates, with warn-tier `projection-cron-liveness`.
- `npm run scan:perf` - PASS; `dist/v3-app.js` `1,181,527 B`.
- `npx playwright test tests/e2e/r13.16-visual-regression.spec.ts` - PASS, `5/5` after restoring generated data drift.
- `npm run verify:w0-ia-pr4-shared-global-relocation` - PASS.
- `npm run verify:ui-journey-priority-matrix` - PASS, `3 stories`, `52 aspects`.
- `npm run verify:navigation-taxonomy` - PASS.
- `npm run verify:assisted-mode-journey-registry` - PASS, `4/4`.
- `npm run verify:assisted-mode-e2e` - PASS, `5 passed`.

## Re-evaluation triggers

- A W1 implementation changes visible Home / Workspace / Govern IA.
- A production/private Operator claim is requested before strict evidence passes.
- Bundle headroom drops below the W0/W1 threshold or the 100 KiB shrink target is re-scoped.
- A new source connector or WIP import flow risks confusing Source, Project, and Domain/Lens.
- Any deletion candidate touches a live global or runtime entrypoint.
