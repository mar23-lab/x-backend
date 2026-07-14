# ADR-V3-023 · Hermes memory-browser pattern · adopt timeline filter idiom

**Status:** Accepted 2026-05-07 · Plan v3.6 Phase C
**Date:** 2026-05-07
**Decision-makers:** Marat
**Cross-link:** Plan v3 §N · Plan v3.6 item 6 · `xcp-platform/docs/inspirations/hermes-patterns.md` §3 · ADR-V3-013 (port mirror) · ADR-V3-014 (substrate widget mount)

## Context

Plan v3 §N evaluated Hermes-Workspace and concluded "DO NOT ADOPT · mine 3 patterns: Conductor parallel-spawn UX · terminal-in-UI · memory-browser pattern for evidence inspector." Operator initially marked low-value · Plan v3.6 (2026-05-07 directives) PROMOTED the memory-browser pattern as critical for "production-level Xlooop-XCP-demo + MB-P real data."

The MB-P workspace scenario (Plan v3.6 Phase B) ingests git commits from operator's actual repos · resulting in many bundles spanning weeks/months. Without timeline-first navigation, the demo shows a flat list with no temporal grouping affordance · pilot prospects with months-of-data scenarios cannot drill back through the chain.

## Decision

Adopt 3 specific idioms from Hermes-Workspace's memory-browser pattern, scoped to `EvidenceBrowserWidget`:

### Adopted

1. **Timeline filter chips** above the bundles list:
   ```
   [Today] [Last 7d] [Last 30d] [All]
   ```
   Default: `7d` (Hermes "recent emphasis"). Active chip styled via existing primitive vocabulary.

2. **Relative-time hint** on each bundle row (right-aligned):
   - "just now" · "5m ago" · "3h ago" · "yesterday" · "5d ago" · "2w ago" · "3mo ago"
   - Pure helper at `apps/intent-ai-app-template/src/lib/relative-time.ts`
   - 17 spec-first tests cover every threshold

3. **Drill-down enhancement** (visual polish):
   - Hover state on bundle row already styled
   - Detail pane shows attestation chain in vertical layout (existing · validated)

### NOT adopted (deferred)

- **Live indicator + auto-refresh** (Hermes pattern 3.4): defer to Sprint 7+ when streaming/SSE lands
- **Search/fuzzy match across bundles**: defer to Sprint 7+ when bundle count > 50
- **Pin to active context**: NEVER · conflicts with Plan §V append-only attestation chain
- **Server-side `?since=` query param**: defer until MB-P real data scale demands it (Sprint 7+); client-side filter is sufficient now

### Implementation locus

| File | Change |
|---|---|
| `apps/intent-ai-app-template/src/lib/relative-time.ts` | NEW · pure helpers (`formatRelativeTime` · `isWithinRange` · `TimeRange` type) |
| `apps/intent-ai-app-template/src/lib/relative-time.test.ts` | NEW · 17 spec-first tests · all PASS post-impl |
| `apps/intent-ai-app-template/src/widgets/evidence-browser/EvidenceBrowserWidget.tsx` | EXTEND · `timeRange` prop · 4 filter chips · relative-time hint on rows |
| `Xlooop-XCP-demo/v3/project/v3/widgets/project-modes/Substrate/Substrate.jsx` | EXTEND · pass `timeRange` from URL `?range=<r>` (defer until Substrate widget consumed at scale) |
| `xcp-platform/docs/inspirations/hermes-patterns.md` | EXTEND · "Plan v3.6 Phase C2 · concrete adoption" section appended |

### Spec-first per ADR-V3-011 §1

- 17 tests for `relative-time.ts` · ALL FAILED on first run · ALL PASS post-impl
- Existing 7 EvidenceBrowserWidget tests still pass (no regression)
- Total vitest: 44 → 61 (+17 new)

## Consequences

**Positive:**
- Demo's evidence navigation matches industry-standard memory-browser idiom · pilot prospect familiarity
- Filtering is client-side · zero backend cost · works offline against cached data
- Pure helpers in `lib/` reusable for future surfaces (Lineage mode · Sign-off ladder · Compliance report)
- Relative-time hint reduces cognitive load · operator scans bundle rows faster

**Negative:**
- Default `7d` may hide pre-existing seed bundles (TrinityOps preset uses 2026-05-04 dates · within 7d window from 2026-05-07 · safe today · ages out 2026-05-12)
- Client-side filter doesn't paginate · all bundles loaded then filtered · won't scale beyond ~500 bundles per workspace (Sprint 7+ server-side fix)
- Adds 1 prop + 4 UI elements + 1 helper file to substrate · reviewer cost +small

**Out of scope:**
- Server-side `?since=` query param (Sprint 7+)
- Storybook story for the new pattern (Phase D-equivalent · separate commit)
- Documentation update in `Cross-feed.mdx` (next docs sweep)

## Verification

- `pnpm exec vitest run src/lib/relative-time.test.ts` → 17/17 pass
- `pnpm exec vitest run` (substrate full) → 61/61 pass
- Manual: navigate to demo's Substrate mode · 4 filter chips visible · clicking changes counts in header (`N visible · M total`)
- Cross-feed parity validators: green (no port shape change · this is a UI enhancement only)

## Open questions (Sprint 7+)

- Make default `timeRange` operator-configurable per workspace? (compliance vertical may want 90d default)
- Add 90d / 1y chips for pilots with longer audit windows?
- Persist `timeRange` in URL (`?range=30d`) for deep-link parity with `?source=engine`?
