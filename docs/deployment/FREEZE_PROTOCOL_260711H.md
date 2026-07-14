# Xlooop-XCP-demo freeze protocol (260711-H Phase 2b) — PREPARED, awaiting operator sign-off

## Preconditions to declaring the seed SHA (operator, in order)
1. Complete the activation sheet (`ACTIVATION_SHEET_260711.md`) Phases 0–4 **in this repo**:
   the `wrangler.toml` `[[ratelimit]]` uncomment + redeploy (safety floor), migrations
   042/062/063/064/**065** applied to prod Neon, the flag flips you elect, and the **H1 flip**
   (`MBP_PROJECTION_LIVE_RAIL_ENABLED`) — flipping H1 pre-freeze removes the projection's
   repo-commit dependency entirely, so the frozen repo never needs data staging again.
2. Confirm the last runtime deploy receipt matches HEAD (emit-deploy-receipt refuses otherwise).

## The declaration (operator says: "freeze at <SHA>")
- The named SHA becomes the **x-backend seed SHA** — recorded in x-backend's
  `MIGRATION-PROVENANCE.md` with `git ls-tree -r <SHA>` per-file blob hashes (mechanical parity).
- From that SHA forward, Xlooop-XCP-demo accepts **emergency-only** changes. Every post-freeze
  commit MUST add a row to `docs/deployment/FREEZE_MIRROR_LEDGER.md` (created at freeze):
  `| date | SHA | files | why | cherry-picked-to-x-backend? |` — the drift-prevention ledger the
  cutover reconciles before switching deploy authority.
- Branch prune folds in here: the ~69 stale local `claude/*` branches + 40 remote go at freeze
  (archive tags per HR-PUSH-POLICY-1 exception protocol if any hold unmerged work — verify with
  `git branch --no-merged main` first).

## Unfreeze protocol (the only sanctioned exceptions)
1. **Emergency prod fix** while XCP-demo still holds deploy authority: fix → full ci-local →
   deploy → receipt → ledger row → cherry-pick to x-backend within 24h.
2. **Pages Functions hotfix** (until Phase 4b's worker-proxy takeover): same path, ledger row
   mandatory, and the fix must ALSO land in the worker-proxy implementation if it touches /api/*.
3. Anything else = NOT an exception; it lands in x-backend and rides the cutover.

## Post-cutover final state
After the operator cutover (deploy:api from x-backend, receipt-verified) + the Phase 4b Pages
/api/* proxy + the app.xlooop.com repoint: README archive banner, main branch protected, repo
archived on GitHub. History (all SHAs cited by receipts/evidence) stays queryable forever.
