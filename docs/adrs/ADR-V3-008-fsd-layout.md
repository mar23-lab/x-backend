# ADR-V3-008 · FSD layout for v3

**Status:** Accepted 2026-05-04 (T1-A landed in commit `e0870ac`; T1-B entity restructure in `528d8c3` validated layout · 28 entity files in 7 bounded contexts · smoke-cli FSD checks 13/13 pass)
**Date:** 2026-05-03
**Decision-makers:** Marat
**Cross-link:** [ADR-V3-007](ADR-V3-007-foundation-first-sequencing.md), x-front `tsconfig.json` paths, x-front `src/` layout (audit 2026-05-03 → FSD 7/10)

## Context

v3 today is flat. `app.jsx` (~970 LOC) and `project.jsx` (~1500+ LOC) own the entire surface. Placeholder folders (`widgets/`, `entities/`, `theme/`, `ui/`) exist with READMEs that say "post engine-merge" — but every new component lands in the flat scaffold because there is no forcing function.

x-front (audit 2026-05-03) is FSD 7/10: canonical `app/processes/pages/widgets/features/entities/shared/` hierarchy with 4 minor `app→shared` exceptions (intentional auth/global). v3 has nothing to mirror against.

## Decision

**v3 adopts FSD-strict layout mirroring x-front.** Initial folder set:

```
v3/project/v3/
├── app/                      ← bootstrap, providers, root
├── pages/                    ← page-level shells (project, workspace, personal)
├── widgets/                  ← compound feature surfaces (inbox, triage, build, studio, evidence, signoff, lineage, fabric)
├── features/                 ← reserved (no cross-page workflows yet → ADR-V3-008.A)
├── entities/                 ← domain entities (per ADR-V3-008.B / DDD discipline)
│   ├── actor/
│   ├── workspace/
│   ├── project/
│   ├── work_item/
│   ├── decision_record/
│   ├── ac/
│   └── evidence/
├── shared/                   ← cross-cutting primitives
│   ├── services/             ← StoreAdapter, EventBus, AuthProvider, BroadcastChannelAdapter
│   ├── uiKit/                ← Pill, Badge, Chip, Avatar (post T2-A migration target)
│   ├── theme/                ← design tokens (Tokens-the-design-system, ADR-V3-003)
│   └── lib/                  ← pure utilities, helpers
├── runtime/                  ← TS types + spec source (post-precompile-pipeline, ADR-V3-006)
└── contracts/                ← canonical contract definitions (currently dead code; revives in T2-C)
```

**Variant choices vs x-front:**

- `processes/` deferred. v3 has no cross-page workflow today (Phase 5 may add one for Client Review handoff). Add when first cross-page flow needs it.
- `__contracts__/` (test directory) lives at `v3/project/v3/__contracts__/` mirroring x-front exactly.
- `widgets/` is the home for project-mode-specific compound UI (Inbox, Triage, Build pane, etc.). Pages import widgets; widgets import entities + shared.

**Import direction enforced (FSD canonical):**
```
app → pages → widgets → features → entities → shared
                                  ↘            ↘ (shared is leaf)
                                    runtime + contracts (peer of shared, types-only)
```

Lower layers must not import upper layers. Same-layer imports allowed only via barrel exports (`index.ts` per folder).

**Rejected alternative:** "v3-flavored variant — keep flat for now, restructure post-Phase-5." Rejected because Phase 5 multiplies file count; restructure cost grows quadratically with consumer count.

## Consequences

**Positive:**
- Every new component has a canonical home; "where does this live" stops being a per-PR debate.
- x-front uiKit migration drops into `shared/uiKit/` with zero relocation.
- ESLint folder-boundary rule (T2-D) enforces the import direction mechanically.
- Pages stay thin (compose widgets); widgets stay focused (consume entities + shared); domain logic lives in entities.

**Negative:**
- T1-A is a real refactor (10 jsx files → ~25–35 file scaffold). One-time pain.
- Imports paths grow (`../widgets/inbox/InboxPane` vs current root-relative).
- Cognitive load on first navigation grows before familiarity catches up.

**Mitigations:**
- Restructure mechanically file-by-file with verifier loop after each move.
- Document folder responsibilities at the top of each folder's `README.md` (already exists for placeholders; replace content).
- T2-D ESLint rule blocks accidental upward imports.

## Verification

- `node v3/project/v3/scripts/smoke-cli.mjs` includes `app/index.jsx exists`, `pages/project/index.jsx exists`, `widgets/{8 widget folders} exist`, `entities/{7 entity folders} exist with model.ts + index.ts`.
- ESLint rule `boundaries/element-types` (or custom smoke-cli regex) asserts no upward imports.
- All existing 6 e2e specs still pass after restructure.
- `runBootCheck` adds `FSD layout present` check.

## References

- [ADR-V3-007 Foundation-first sequencing](ADR-V3-007-foundation-first-sequencing.md)
- x-front `src/` layout (audit 2026-05-03)
- [Feature-Sliced Design canonical reference](https://feature-sliced.design/)
- [plan-foundation-2026-05-03.md](../plan-foundation-2026-05-03.md) §3 architecture comparison
