# ADR-V3-006 · TypeScript migration for v3 shell

**Status:** Accepted
**Date:** 2026-05-03
**Decision-makers:** Marat
**Supersedes:** none
**Cross-link:** [ADR-V3-001](ADR-V3-001-v3-canonical-saas-frontend.md), [ADR-V3-002](ADR-V3-002-dal-adapters.md), x-front (TS 5.8 native), [risk-register.md D9](../risk-register.md)

## Context

The v3 shell today is JSX (plain JavaScript with React components). x-front and the DAL/EventBus contract tests are TypeScript. As v3 absorbs:

1. Mature x-front contract tests (post Phase 2.5),
2. The v2 contract layer (`contracts/`, post Phase 2.3),
3. Eventually mature x-front uiKit primitives (post engine merge),

…the boundary between TS and JSX becomes friction. Contract tests want TS types; uiKit primitives are typed; the v3 reducer is plain JS. Mixed-language projects produce: (a) duplicated declarations, (b) incomplete IntelliSense, (c) silent shape drift between contract test and reducer.

## Decision

**v3 migrates to TypeScript, file-by-file, behind verifier gates.**

Migration order (least → most risky):

1. `data.jsx` → `data.ts` (no React; pure loader)
2. `switcher.jsx` → `switcher.tsx`
3. `tweaks-panel.jsx` → `tweaks-panel.tsx`
4. `palette.jsx` → `palette.tsx`
5. `demo-tour.jsx` → `demo-tour.tsx`
6. `personal.jsx` → `personal.tsx`
7. `workspace.jsx` → `workspace.tsx`
8. `studio-tokens.jsx` → `studio-tokens.tsx`
9. `project.jsx` → `project.tsx` (largest; most reducer types)
10. `app.jsx` → `app.tsx`

**Per-file gate (must pass before next file):**

- `npx tsc --noEmit --jsx preserve` reports 0 errors.
- `node v3/project/v3/scripts/build-standalone.mjs` succeeds and bumps `__V3_BUILD`.
- `node scripts/verify-v3.mjs` returns 12/12 PASS.
- Both v3 specs (`v3-reverse-loop`, `v3-lineage-failure-trace`) pass.
- `node scripts/axe-v3-sweep.mjs` returns 0/0/0/0/0 across 5 surfaces × 2 themes.
- Console clean on cold load, both themes.

**Babel + TS coexistence in modular `index.html`:**

> **2026-05-03 finding (Phase 2.1 spike):** In-browser Babel-standalone with
> `data-presets="react,typescript"` on a single `<script>` tag silently broke
> the auto-loader chain — sibling `text/babel` scripts loaded but no globals
> were exposed and `__xcpDataReady` never fired. Reproduced regardless of file
> extension (`.ts`, `.tsx`, or `.jsx` with TS content). The Python `http.server`
> MIME map serves `.ts` as `video/mp2t`, blocking script execution; `.tsx`
> falls back to `application/octet-stream` which Babel can fetch but the
> mixed-presets auto-load still fails. **Conclusion:** in-browser TS via
> `data-presets` is not viable for the modular dev path.
>
> **Revised plan:** Phase 2.1 requires a precompile pipeline before any source
> file converts. `build-standalone.mjs` must:
>   1. Call `npx tsc` (or `esbuild --loader=tsx`) to emit JS into a `dist/`
>      sibling directory.
>   2. Update `index.html` to reference the emitted `.js` files (no
>      `data-presets` mixing required).
>   3. Inline the emitted JS into `index.standalone.html` as today.
>
> Until that pipeline lands, all 10 source files remain `.jsx`. The contracts/
> and runtime/ layers (already `.ts`) stay as type-checked source consumed by
> Playwright specs (which run under their own TS runtime).

- Original aspiration retained for the post-pipeline state: `<script type="text/babel" data-presets="react,typescript">` on each shell file once the precompile gate is set up. Babel-standalone is no longer the runtime transformer in that target state — it remains only for the `.jsx` legacy files until they migrate.

**Strict mode:**

- `tsconfig.json` enables `strict: true`, `noImplicitAny: true`, `strictNullChecks: true`.
- Allow `any` only where reducer payloads are genuinely heterogeneous; flag with `// TODO: type` so refactor pass can find them.

**TS does not break the cache-bust workflow:**

- Every TS edit still requires `node v3/project/v3/scripts/build-standalone.mjs` to bump `__V3_BUILD`. Pre-commit hook (Phase 4.5 of roadmap) catches forgotten bumps.

## Consequences

**Positive:**
- Contract tests can import shared types directly; no shape duplication.
- IntelliSense recovers across the codebase.
- Refactor confidence rises (TS catches reducer-action shape changes that previously needed runtime test exposure).
- Aligns with x-front; engine merge requires no language conversion at the seam.

**Negative:**
- ~4 days of focused migration work (per-file gate is real).
- Babel-standalone in dev adds compile cost on every reload; cache-bust workflow takes the hit (negligible at 5–15 ms).
- `tsconfig.json` introduces new tooling surface to maintain.
- New build dependency (`typescript` in devDependencies) — already present (x-front uses it; we add to repo root).

**Out of scope:**
- Migrating Playwright specs (already TS).
- Migrating Node scripts (`scripts/*.mjs`) — they remain JS unless a script needs types.
- Migrating v2 (frozen).

## Verification

- After each file lands: per-file gate above.
- After file 10: `tsc --noEmit` clean across the entire `v3/project/v3/` source tree.
- Bundle size delta tracked in `audit/perf-*.md`; expectation: <5% growth (mostly type erasure leaves runtime size flat).
- Contract test imports compile (post-Phase 2.5 of roadmap).

## References

- x-front `tsconfig.json`, `TYPESCRIPT_DEBT_ANALYSIS.md`
- [ADR-V3-001 v3 canonical](ADR-V3-001-v3-canonical-saas-frontend.md)
- [ADR-V3-002 DAL adapters](ADR-V3-002-dal-adapters.md)
- [risk-register.md D9](../risk-register.md)

## Amendment · T2-B.1 (2026-05-04) · TS precompile pipeline lands

Phase T2-B.1 ships an esbuild precompile of `runtime/*.ts` + `contracts/*.ts`
into `v3/project/v3/dist/v3-runtime.js`, an IIFE bundle that attaches every
named export to `window.xcpRuntime`. This **partially supersedes** the G1
dual-file pattern (jsx runtime + ts types-only paired) for non-React code:

- Constants (e.g. `TRACE_CAP_DEFAULT`) and pure functions (`recordEntry`,
  `stripHiddenFields`, `evalRiskPolicies`, `newEventEnvelope`) are now
  consumable by jsx code at runtime via `window.xcpRuntime.<export>`.
- ADR-V3-006 G1 remains in force for **React/JSX components**
  (`shared/uiKit/*.jsx`, page/widget JSX) until T2-C migrates them off
  babel-standalone.

**Pipeline:**
- Entry: `v3/project/v3/dist-entry/runtime-bundle.ts` re-exports both barrels.
- Build: `npm run build:runtime` → `dist/v3-runtime.js` (~36 KB, ~15 ms).
- Wired into `index.html` as a plain `<script src="dist/v3-runtime.js">`
  before any `<script type="text/babel">` tag.
- `build-standalone.mjs` inlines the bundle for the standalone HTML target.
- smoke-cli enforces 6 invariants (entry exists · dist exists · attaches
  window.xcpRuntime · exports TRACE_CAP_DEFAULT · loads before babel · at
  least one consumer migrated).

**First consumer migration:** `app/App.jsx::WORKFLOW_EVENTS_CAP` now reads
`window.xcpRuntime?.TRACE_CAP_DEFAULT || 50`. The smoke-cli drift guard
between `runtime/state-trace.ts::TRACE_CAP_DEFAULT` and the App.jsx fallback
literal is preserved.

**Deferred to T2-C (next):** migrating React/JSX components to a real
build step (Vite or esbuild's JSX mode), which would let us delete
babel-standalone entirely and remove the dual-file workaround for JSX too.
