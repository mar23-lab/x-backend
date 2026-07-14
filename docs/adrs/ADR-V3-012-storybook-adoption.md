# ADR-V3-012 · Storybook (or Ladle) adoption

**Status:** Tooling decision Accepted 2026-05-04 (T2-A.1 spike). Implementation Accepted on T2-A.2 landing (5 stories + contract.json). See spike report at `docs/sessions/2026-05-04_t2a-storybook-spike/`.

**T2-A.1 spike measurements (2026-05-04):**
- Storybook 8.6.12 already installed (Phase P10D.1 c176, v2 era).
- `node_modules` total: **156 MB**. `@storybook/*` direct footprint: **40 MB**.
- Cold start (`storybook dev`): **~4 s**. Both decision-rule thresholds (>100 MB / >10 s) cleared by a large margin.
- Historical spike context: `.storybook/main.ts` was hand-written with a narrow `v2/src/ui/**/*.stories.@(ts|tsx)` glob, then T2-A.2 added `v3/project/v3/shared/uiKit/**/*.stories.tsx`.
- C5/C6 update (2026-05-08): active Storybook globs are now v3-owned. The v2 glob above is historical spike context, not current configuration.

**Outcome:** GO with Storybook. Ladle remains a documented fallback only if T2-A.2 reveals a config-incompatibility.
**Date:** 2026-05-03
**Decision-makers:** Marat
**Cross-link:** [ADR-V3-007](ADR-V3-007-foundation-first-sequencing.md), [ADR-V3-008](ADR-V3-008-fsd-layout.md), x-front Storybook (audit 2026-05-03 → 5/10 — quantity yes, contracts no)

## Context

Audit 2026-05-03 standards scorecard: Widget Contract Matrix 0/10. v3 has zero Storybook stories, zero `contract.json` files, zero `Component-DoD.mdx` documents. Component review is "scroll the live app." When component count exceeds ~15 (likely after x-front uiKit migration begins), this becomes a maintenance bottleneck.

x-front has 107 stories (good) but **zero contract.json files** (audit 2026-05-03 → discipline gap). Stories document UI but not API contracts. This is one of the gaps where v3 should *improve* on x-front, not just mirror it.

Adopting Storybook adds 80MB+ of `node_modules` and ~45s cold start. v3 is currently CDN-only (zero `node_modules`). This is a real cost.

## Decision

**T2-A spike: measure Storybook 8.x vs Ladle in a sandbox; adopt the cheaper one. Then ship 5 stories + contract.json for each.**

### Tooling decision (made during T2-A spike, not now)

Spike measures:
- Cold install: `time pnpm install` after `npx storybook init` vs `npm i @ladle/react`.
- Cold start: `time npm run storybook` (or `npm run ladle`) until first frame in the browser.
- Bundle size: `du -sh node_modules`.
- DX: ability to render existing v3 components without rewrites.

**Decision rule:** if Storybook adds >100MB to repo or >10s to start, adopt Ladle. Otherwise Storybook (richer ecosystem; matches x-front).

### Initial story set (5 components, T2-A)

1. `shared/uiKit/Pill` — `kind: 'good' | 'warn' | 'bad' | 'info' | 'acc'`
2. `shared/uiKit/Badge` — used across Sign-off, Build, Evidence
3. `shared/uiKit/Chip` — Round chip, status chips
4. `shared/uiKit/Avatar` — used across Spaces switcher, Members
5. `shared/uiKit/SettingsGear` — small light-grey gear next to user avatar (recent UI redesign)

### Component contract discipline (improves on x-front)

Every component shipped after T2-A has a `contract.json` sibling file:
```json
{
  "name": "Pill",
  "version": "1.0.0",
  "props": {
    "kind": { "type": "'good'|'warn'|'bad'|'info'|'acc'", "required": true },
    "children": { "type": "ReactNode", "required": true }
  },
  "events": [],
  "state": "stateless",
  "dependencies": ["shared/theme/tokens"],
  "story": "shared/uiKit/Pill/Pill.stories.tsx",
  "test": "shared/uiKit/Pill/Pill.test.tsx",
  "maturity": "production",
  "visibility": "client-visible"
}
```

`smoke-cli` enforces every entry in `shared/uiKit/` has a `contract.json`.

`Component-DoD.mdx` lives at the top of each story bundle and lists the gates (TS clean, A11y green, Visual diff approved, Contract test pass).

### Decorators (port selectively from x-front)

Reuse x-front's pattern but only the decorators v3 actually needs:
- `AuthDecorator` — wraps stories in `AuthProvider` stub (T1-D).
- `EventBusDecorator` — provides EventBus context.
- `ThemeDecorator` — light/dark/dim toggle.
- `WireframeDecorator` (optional) — for drift-dot visualization.

Skip: `DatabaseDecorator`, `FocusEntityDecorator`, `PresetCollectionDecorator`, `WorkspaceSettingsDecorator` — x-front-specific surfaces v3 doesn't have yet.

### Anti-patterns rejected (explicit improvements over x-front)

- ❌ Stories without contracts. **Mandatory `contract.json` from day one.**
- ❌ Decorators without `__contracts__` test. Each decorator's contract is part of T1-F.
- ❌ Visual diff tooling that doesn't block PR. Chromatic or Percy must gate (T3-B).
- ❌ Story files >300 LOC. Split into separate stories per variant.

## Consequences

**Positive:**
- Component review surface ready for x-front uiKit absorption.
- Contract.json discipline gives Widget Contract Matrix 8/10+ (vs current 0/10).
- Storybook = engineering-credibility artifact for technical-buyer conversations.
- A11y + visual diff testing inherits Storybook's tooling.

**Negative:**
- ~80MB `node_modules` (Storybook) or ~30MB (Ladle). v3 stops being CDN-only at T2-A.
- Spec-first discipline (ADR-V3-011) extends to stories: write story → write contract.json → implement. ~1.3× token cost per component.
- Maintenance: stories rot if not co-evolved with components. Mitigated by smoke-cli enforcing 1:1 ratio.

## Verification

- T2-A spike artifact: `v3/project/v3/docs/sessions/2026-05-03_t2a-storybook-spike/manifest.yaml` records the measurements.
- 5 stories rendered on `npm run storybook` (or `npm run ladle`).
- 5 `contract.json` files; smoke-cli validates each against TypeScript types.
- Chromatic or Percy baseline captured (T3-B will make it block-on-diff).
- All existing 6 e2e specs still pass (Storybook adoption doesn't break the live app).

## References

- x-front `src/shared/storybook/` (decorator port reference)
- x-front 107 `*.stories.tsx` (anti-pattern reference: quantity without contracts)
- [Ladle](https://ladle.dev/) (lightweight alternative)
- [Storybook 8.x](https://storybook.js.org/) (rich-ecosystem default)
- [ADR-V3-007 Foundation-first sequencing](ADR-V3-007-foundation-first-sequencing.md)
- [ADR-V3-011 TDD discipline](ADR-V3-011-tdd-discipline.md)
- [plan-foundation-2026-05-03.md](../plan-foundation-2026-05-03.md) §T2-A
