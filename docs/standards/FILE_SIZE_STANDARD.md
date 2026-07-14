# File-Size Standard (all agents · all programming tasks)

**Status:** normative. Applies to every agent and every code change in this repo.
**Enforced by:** `scripts/verify-workspace-component-size.mjs --strict` (in `ci-local`, blocking).
**Discoverable from:** the repo `CLAUDE.md` links here; the gate prints the bands on every run.

## The rule

Keep every source file small and single-responsibility. Target and thresholds (the gate's
own bands):

| Band | LOC | Meaning / action |
|---|---|---|
| **PASS** | **≤ 400** | Healthy. The target for any new file. (≤ ~250 for a React component.) |
| **ADVISORY** | 401–800 | Getting large — look for a helper to extract. |
| **WARN** | 801–1200 | A real problem — split by responsibility. |
| **FAIL** | > 1200 | Hard ceiling. Blocked unless already baselined; repeat offenders get **FROZEN_DECOMPOSE**. |

**Why:** single-responsibility files are easier to review, test, and change safely; large
files hide bugs and become god-objects. This repo already hit the "ceiling-bump treadmill"
(WorkersDalAdapter: 6 bumps / 48h, +81 LOC, 0 decompositions) — which is why growth is now
gated, not advisory.

## How to comply (the only sanctioned way to add code to a large file)

You may **never** make a baselined file grow above its ratchet ceiling. To add behaviour:

1. **Extract pure helpers** to a sibling `./_shared/*` module and import them (see
   DetailedWorkspaceShellDesign's `_shared/*` decompositions).
2. **Compose a sub-facade** the parent delegates to — do NOT add methods to a frozen root
   file. Precedent this session: `dal/workspace-member-facade.ts` (the adapter composes it;
   the frozen `WorkersDalAdapter.ts` netted *down*, not up).
3. **Split by responsibility** (one screen slice / one entity / one concern per file).
4. Keep the new modules **≤ 400 LOC** too — decomposition must not just relocate a god-file.

The `--strict` ratchet is **down-only**: a baselined file may sit at/below its recorded
ceiling; growing it above = `RATCHET_BREACH` (blocking). Lowering the actual LOC lets you
**ratchet the ceiling down** (record the win). New files > 1200 with no baseline = `NEW_FAIL`.

## Enforcement + tracing status (kept current)

- **FAIL (>1200), all ceiling-tracked in the baseline (traced), decomposition targets:**
  `DetailedProjectShellDesign.jsx` 2887 · `DetailedWorkspaceShellDesign.jsx` 2034 ·
  `DesignFrame.jsx` 1718 · `WorkersDalAdapter.ts` 1641 (FROZEN) · `AccountScreens.jsx` 1505 ·
  `SyntheticDomainsPanel.jsx` 1306 · `operations/PaneOperations.jsx` 1305 · `app/App.jsx` 1263.
- **WARN (801–1200), above target and NOT ratchet-tracked — the "untraced" watch-list**
  (they can silently grow to FAIL; tracking gap to close):
  `pages/workspace/Workspace.jsx` 1188 · `dal/DalAdapter.ts` 1141 ·
  `InlineEventsBoard.jsx` 1077 · `dal/propagation-store.ts` 1056 ·
  `cockpit-stream-source/CockpitStreamSource.jsx` 1053 · `LiveStreamRailV3.jsx` 881 ·
  `pages/personal/Personal.jsx` 865 · `operations/OpsHelpers.jsx` 802.

**Recommendation (trace everything):** extend the ratchet to also record WARN-tier ceilings
(down-only) so no file between 800–1200 can drift upward untracked — closing the one gap
where growth is currently invisible. Until then, treat the WARN list as decomposition
backlog and never grow one.

## Agent checklist (apply on every programming task)

1. New file? Aim **≤ 400 LOC**.
2. Touching an existing file? Do **not** push it above its ratchet ceiling — extract/compose
   instead (§How to comply).
3. Big new capability? Design it as small composed modules from the start.
4. Run `npm run verify:workspace-component-size -- --strict` (or `ci-local`) before commit.
5. Reduced a god-file? Ratchet its ceiling **down** and note the win in the baseline comment.
6. **Decomposed a component into `./_shared/*`?** A split can break a *sidecar* bundle that the
   main-app checks never rebuild (the AccountScreens incident: `ci-local` green while
   `dist/v3-account-screens.js` was stale/broken). `verify:decomposition-safety` (in `ci-local`,
   blocking) byte-rebuilds the 4 uncovered sidecar bundles (readiness / account-screens /
   shell-widgets / investor). After ANY decomposition, run `npm run build:standalone` +
   `npm run verify:decomposition-safety` and commit the refreshed `dist/`.
