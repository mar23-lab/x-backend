# ADR-V3-028 · Never `-X ours` a generated file — rebuild to reconcile

**Status:** Accepted — 260628, after the source-intake wave's reconcile dropped a sidecar tag (the 2nd such incident)
**Date:** 2026-06-28
**Decision-makers:** Marat
**Supersedes:** none — fills the gap that `docs/STRUCTURE-FINDINGS-260530.md` left open (no documented generated-file conflict procedure)
**Cross-link:** `scripts/lib/expected-sidecars.mjs` (the sidecar SSOT) · `scripts/lib/ensure-sidecar-tags.mjs` (self-heal) · `scripts/verify-sidecar-manifest.mjs` (detection gate) · `docs/engineering/RELEASE_INTEGRITY_DDD.md` (the bounded context) · `docs/engineering/generated-artifact-policy.json` (artifact lanes)

## Context

Twice, reconciling a feature branch with an advanced `main` corrupted a **generated, committed** file by resolving its conflict with `-X ours` (or `--ours`):

| Incident | What dropped | Symptom | Caught by |
|---|---|---|---|
| #771 | `<script src="dist/v3-readiness.js">` tag in `index.html` | `window.ReadinessJourney` never registered → in-app readiness journey dead in prod | manual browser-verify only (bypassed ci-local 45/45, current-integrity 64/64, curl smoke, deploy live-verify) |
| #790 (source-intake reconcile, 260628) | `<script src="dist/v3-account-screens.js">` tag in `index.html` | `window.ProfileScreen` never loaded → topbar/profile dead | `verify-sidecar-manifest` (added after #771) + the topbar usability proof — **pre-prod, not shipped** |

Root cause: `index.html` and `dist/*` are **generated artifacts that are also git-tracked** (`generated-artifact-policy.json` → class `generated-runtime-deliverable`). When such a file conflicts, `-X ours`/`--ours` keeps the *current branch's* side wholesale — silently discarding any line `main` added after the branch point (e.g. a sidecar `<script>` tag for a bundle that was code-split on `main`). The file still builds, deploys, and serves HTTP 200, so every *file-existence* check stays green; only the missing *reference* matters, and only a runtime/browser check sees it.

There was **no documented procedure** for resolving these conflicts — so each session re-learned the trap.

## Decision

**Generated artifacts are never hand-merged. Resolve their conflicts by REBUILDING from source, then verifying.**

For any merge/rebase conflict in `index.html`, `index.standalone.html`, or `dist/*`:

1. **Do NOT** resolve with `git checkout --ours/--theirs` or `git merge -X ours/-X theirs`, and do NOT hand-edit the conflict markers in these files.
2. Resolve the conflict by taking **either side arbitrarily** (the content is about to be overwritten) **then rebuild**: `npm run build:standalone` (or the full `npm run build`). The build is the SSOT for these files.
3. The build now **self-heals** dropped sidecar tags: `scripts/lib/ensure-sidecar-tags.mjs` (called by `build-standalone.mjs`) re-inserts any `EXPECTED_SIDECARS` tag missing from `index.html`, at its correct ordered position. A `-X ours` drop can no longer survive a rebuild.
4. **Verify before committing:** `node scripts/verify-sidecar-manifest.mjs` (all expected sidecars referenced) and `npm run ci-local` (the `sidecar-heal-selftest` + the manifest gate). The deploy step (`deploy-app-prod.mjs [6a-2]`) re-checks the LIVE `index.html` as a final backstop.

**Source files conflict normally** — this ADR is scoped to generated artifacts only.

## Consequences

**Positive:** the #771/#790 class cannot recur — prevention (self-heal) + two detections (ci-local + live) now guard three different surfaces (build / commit / edge); the reconcile procedure is written down once, so sessions stop re-learning it; aligns the merge behavior with `generated-artifact-policy.json` ("commit_only_in_explicit_build_artifact_lane" → rebuild, don't hand-resolve).
**Negative / cost:** a rebuild (~30–60s) is required to resolve a generated-file conflict rather than a one-line `-X ours`; acceptable given the failure mode it prevents.
**Future (deferred, tracked in `docs/STRUCTURE-FINDINGS-260530.md`):** untracking the reproducible generated artifacts entirely (a `build:all` that regenerates them on a fresh checkout) would remove the conflict surface at the source — blocked today on the vendored `dist/v3-substrate-widgets.js` non-reproducibility. Until then, this ADR + the self-heal are the mitigation.
