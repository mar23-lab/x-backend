# ADR-V3-014 · Substrate widget mount via UMD-React-shim

**Status:** Accepted 2026-05-06 (audit Day 3 backfill)
**Date:** 2026-05-05 (originating decision in commit `d3d3103` · C.4-B)
**Decision-makers:** Marat
**Supersedes:** none
**Cross-link:** [ADR-V3-001](ADR-V3-001-v3-canonical-saas-frontend.md), [ADR-V3-013](ADR-V3-013-port-mirror-pattern.md), audit item 2.4

## Context

C.4-B mounts substrate React/TSX widgets (`EvidenceBrowserWidget`, `SkillsBrowserWidget` from `@xcp/intent-ai-app-template`) inside the demo's babel-loaded JSX runtime. The substrate widgets use React 18 hooks (`useState`, `useEffect`, `useCallback`). The demo loads React 18 via UMD CDN at index.html load time. Mounting another React copy via the substrate bundle would cause hooks-mismatch (each `React.useState` checks its own internal state slot which differs across copies).

Three resolutions existed:
1. **Single React copy via UMD external** — esbuild bundle treats `react`/`react-dom`/`react/jsx-runtime` as external; bundle resolves them at runtime via `window.React`/`window.ReactDOM`.
2. **Single React copy via npm workspace** — fold demo into pnpm workspace; both sides resolve the same `node_modules/react`.
3. **Two React copies, one for each surface** — abandoned · breaks hooks.

C.4-B chose option 1 because option 2 requires the demo to abandon babel-standalone (Plan v3 §E defers).

## Decision

The substrate widget bundle is built via `scripts/build-substrate-widgets.mjs` with React/ReactDOM/jsx-runtime imports stubbed by an esbuild plugin (`react-globals`) that replaces them with thin shims pointing at `window.React`, `window.ReactDOM`, etc.

**Bundle structure:**
- Output: `v3/project/v3/dist/v3-substrate-widgets.js`
- Format: IIFE attaching to `window.SubstrateWidgets`
- Externals: react, react-dom, react/jsx-runtime, react-dom/client (resolved at runtime)
- Source: `apps/intent-ai-app-template/src/index.ts` from xcp-platform (filesystem path resolved via `XCP_PLATFORM_ROOT` env or `~/WIP/xcp-platform` default)

**Demo-side mount pattern:**
- `widgets/project-modes/Substrate/Substrate.jsx` (JSX shell)
- Reads `window.SubstrateWidgets` + `window.ReactDOM` + `window.xcpRuntime.createLiveEvidenceStorePort`
- Renders substrate widgets inside two React roots created via `ReactDOM.createRoot`
- Both widgets share a single port instance (live or http)

**jsx-runtime shim (Audit-2.10 fix):** `jsxs` assigns index keys to keyless static children (matching React's real jsx-runtime behaviour) to suppress benign "missing key" runtime warnings.

## Consequences

**Positive:**
- Single React identity · no hooks-mismatch.
- Substrate widgets ship to demo without rebuilding the demo's loader chain.
- Storybook can host the substrate widgets via the same UMD-external pattern (deferred · audit item 2.5/Day 3).

**Negative:**
- The bundle contains a hard-coded filesystem path to xcp-platform. Building the demo on a machine without xcp-platform fails. Mitigation: env override + clear error message.
- Cross-origin React version skew is invisible to the bundle. If `window.React` is 17 and substrate was compiled against React 18, hooks fail at runtime, not build time. Mitigation: add a runtime check to the bundle's IIFE that asserts React version matches the substrate's `peerDependencies`.
- Storybook stories require a parallel preview-head modification to load the substrate bundle (Substrate.stories.tsx flags this in its second story).
- Babel-standalone is a single point of failure for the whole chain; if unpkg.com drops the React UMD URL or version, demo breaks. Mitigation: pin the UMD to a local file in pre-pilot prep.

**Out of scope:**
- Production deploy: this pattern is dev-only. Production demos must precompile the demo's JSX through esbuild (T2-C extends to all of v3) so the substrate bundle becomes a regular ESM import.
- Storybook story rendering · adds complexity to preview-head.html (Day 3 deferred).

## Verification

- `node scripts/build-substrate-widgets.mjs` produces a bundle that contains `window.SubstrateWidgets = SubstrateWidgets` and exports `EvidenceBrowserWidget`/`SkillsBrowserWidget`.
- Demo loads in browser, navigates to Substrate mode, both widgets render without console errors (React-key warnings notwithstanding).
- `window.React === window.SubstrateWidgets.__react` (if exposed) returns true (post-runtime-version-check enhancement).

## Risk register additions (audit blind spots)

- **Hooks-mismatch lurks** if Storybook ever renders substrate widgets standalone via npm React. Mitigation: Storybook decorator that asserts `window.React === React`.
- **Babel-standalone deprecation** could break the entire chain. Mitigation: pin React UMD locally in pre-pilot prep.
- **Filesystem-direct import** of substrate src ships any private substrate module into the demo's bundle. Mitigation: post-build grep for `MARAT|PLO|ikigai|cv-` strings on the bundle output (audit item 2.6 follow-up).
