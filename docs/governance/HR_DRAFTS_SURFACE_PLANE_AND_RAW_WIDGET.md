# HR rule drafts — surface+plane DoD & raw-widget served-integrity

**Status:** DRAFT (agents draft, operator applies into MB-P `HARD_RULES.md` per ADR-0079).
**Date:** 2026-06-11. **Trigger:** the recurring "the logic shipped, the perception didn't" defect class
surfaced across the lens issue + U1/U2/U3 + the inert-lens-trigger near-miss this session.

These two rules turn that recurring surprise into a blocking gate. One already has a landed, biting
verifier in this repo; the other is partly mechanizable + partly a Definition-of-Done discipline.

---

## HR-INTERACTION-SURFACE-PLANE-DoD-1 (BLOCKING)

**Rule.** "Done" for any cockpit *interaction* fix (a gate, a re-scope, an attach, a per-project render)
requires a **surface + plane** assertion, not just a code/unit assertion:
1. the visible affordance change is **screenshot-asserted on the SAME surface the user reaches** — the
   prominent lane / board / ticker, NOT a co-located preview, a gated N-row list, or a DOM-present check.
   *DOM-present ≠ visually-correct.*
2. the behaviour is **exercised on the signed-out / preview data plane** (`ENRICHED_STREAM`), not only
   signed-in — because that is the operator's (and every demo/customer's) default entry.

A fix that only passes signed-in, or only on a secondary surface, is **DoR-incomplete → re-open, do not
mark done.** This is *why* U1/U2/U3 were re-reported despite genuine merges: each closed the mechanism
but not the operator-visible surface or the signed-out plane.

**Why it recurs without this:** the previous DoD stopped at "merged + ci-green," which is true and
non-load-bearing for the operator's experience.

**Mechanization status:** partly automatable (a PR touching an interaction widget must add/scope a
signed-out-plane test + a served-artifact check); the screenshot-on-real-surface step stays a reviewer
checklist item. Pair with the existing `verify:ia-001-scope-integrity` (already proves two projects
render different boards on a prod-bug-shaped fixture).

---

## HR-RAW-WIDGET-SERVED-INTEGRITY-1 (BLOCKING) — LANDED + ENFORCED

**Rule.** Cockpit widgets that ship as **copied raw `.jsx`** (browser-loaded directly, not bundled —
`prepare-cloudflare-pages.mjs` `copyFile`s them, they self-register `window.<Name>`) MUST be covered by
an integrity gate, because the bundle-integrity check **structurally cannot see them**: a stale/broken
edit can ship as "done" with green ci-local. (This nearly happened to the lens re-scope trigger in
`SyntheticDomainsPanel` — the edit was absent from every `dist/*.js`; only curling the served raw `.jsx`
proved it shipped.)

**Verifier (landed this PR): `scripts/verify-raw-served-widgets.mjs`** — biting `--self-test`.
- **Static (ci-local, BLOCKING):** every raw-served widget exists, self-registers `window.<Name>` (the
  mount contract — without it the screen renders nothing), and is referenced in
  `prepare-cloudflare-pages.mjs` (so the deploy copies it).
- **Live (`--live <url>`, post-cutover in `deploy-app-prod.mjs`):** curls each served
  `/src/widgets/.../X.jsx`, asserts 200 + non-trivial body + the `window.<Name>` register string is
  present (fresh + runnable on the deployed surface).
- Single source of truth: the widget list is discovered from `prepare-cloudflare-pages.mjs`, so a new
  raw widget is auto-covered.

**Covered widgets (2026-06-11):** SyntheticDomainsPanel, DbProjectDetail, DbWorkspaceOverview,
ProjectScopeBindingPanel, R51CockpitMount.

---

## Operator apply note (ADR-0079)
The verifier + wiring (this repo) is the enforcement. To codify the *policy* across the ecosystem,
add both `HR-*` ids to MB-P `_sys/xcp-system/governance/HARD_RULES.md` (via the worktree gauntlet),
citing this draft + the `verify-raw-served-widgets.mjs` verifier as the paired teeth
(HR-NO-HR-WITHOUT-VERIFIER-1).
