# Backend Repository Cutover — Preflight & Program SSOT (260713)

**Program:** establish `x-backend` as an independently buildable/testable/deployable SHADOW backend
now; flip production deployment authority later, behavior-neutrally, behind the freeze/health gates.
**Authority invariant:** Xlooop-XCP-demo remains SOLE deploy authority until the operator-executed
flip. **Sentinel-green-7d gates the FLIP, not the seeding** (operator-ratified reinterpretation of
ABS-P6, 260713 — supersedes the earlier wait-for-freeze-before-seed sequencing).

This document CONSOLIDATES and REFERENCES the ratified artifacts — it duplicates none of them:

| Artifact | Role |
|---|---|
| `BACKEND_SURFACE_MANIFEST_260711H.md` | the seed COPY/DO-NOT-COPY path list (frozen; rehearsal-referenced) |
| `BACKEND_SURFACE_MANIFEST_DELTA_260713.md` | dispositions for the 45+ files added since rehearsal tip `3dd3156f` |
| `GATE_DISPOSITION_LEDGER_260711H.md` | the ci-local gate fork classes (A/B/C/D) + 6 class-A corrections |
| `SEED_REHEARSAL_RECEIPT_260711I.md` | PROOF the seed recipe runs green end-to-end (5 gaps pre-fixed) |
| `FREEZE_PROTOCOL_260711H.md` | the freeze declaration + mirror-ledger + unfreeze exceptions (flip-side) |
| `ACTIVATION_SHEET_260711.md` | the operator activation phases that are freeze preconditions |
| `docs/architecture/GOVERNED_LINEAGE_MAP_260711H.md` | backend route/gate/flag spine (travels with seed) |
| `BACKEND_REPOSITORY_OWNERSHIP.yml` | machine-readable authority/receipt/gate pointers (this wave) |

## Deployed truth (Wave C0 preflight reads, 260713)

| Surface | Receipt | SHA | Verified |
|---|---|---|---|
| **API worker `xlooop-api` → api.xlooop.com** | `docs/deployment/evidence/cloudflare-api-deploy-receipt.json` | `daafbaa3` | /health readback `build == build_sha` ✓ (2d old) |
| Pages app → app.xlooop.com | `docs/deployment/evidence/latest-cloudflare-prod-deploy-receipt.json` | `a01aa8a9` | `live_verified: true` |

**Hazard #3 (FIXED in C0.2):** the readiness-state generator read only the Pages receipt while naming
the worker. It now tracks both as distinct `deploy_receipts.api_worker` / `deploy_receipts.prod` fields.

## Settled program decisions (operator-approved plan, 260713)

1. **Seed method = manifest-driven fresh copy + `git ls-tree` blob-hash provenance** (rehearsal-proven).
   NOT `git filter-repo`: unrehearsed at 298MiB/2458 commits, re-opens the 5 fixed gaps, and exports
   internal commit history (IP liability) into a customer-adjacent repo. ⚙ **GATE-SEED-METHOD** (sign-off
   below — deviates from the external reviewer's history-preserving default).
2. **Shadow-seed timing = now**, via ⚙ **GATE-BOUNDARY-AMEND-XB-SHADOW**: amend the MB-P
   `BOUNDARY_MATRIX.yml` x-backend row `write_status: seed_pending_operator_freeze → shadow_seed_active`
   (+ session class in `writable_by_sessions_in`; unblock text: shadow mirror only, XCP-demo stays
   canonical, transfer still requires FREEZE_PROTOCOL + Sentinel green 7d) and `ECOSYSTEM_MANIFEST.yaml`
   lifecycle `seeded-empty → shadow-seeded`. The `transfer_trigger` line is untouched.
3. **Seed SHA = post-C0 main tip** (⚙ **GATE-SEED-SHA** names it). Main is a fast-forward of deployed
   `daafbaa3`; every interim commit is flag-off inert; the C0 decoupling must be IN the seed.
4. **One-variable flip:** operator redeploys XCP-demo→then-current main (already a freeze precondition,
   ratelimit redeploy) → declares "freeze at <SHA>" → x-backend re-syncs to that SHA → ⚙ **GATE-FLIP**
   deploys the SAME SHA from x-backend with prod config. Only the deploy-source repo changes; proof =
   `BUILD_SHA` equality in /health readback. Rollback = redeploy XCP-demo @ same SHA (minutes; no DB
   action — migration 070 is never applied by this program).
5. **Shadow deploy** (Wave C2) = worker `xlooop-api-shadow`, workers.dev only, NO routes/custom domain,
   **crons removed**, `[[send_email]]` removed, `[ai]` kept, staging vars; DB = Neon copy-on-write branch.
   Account mutations are operator gates: ⚙ **GATE-NEON-BRANCH · GATE-SHADOW-SECRETS · GATE-SHADOW-DEPLOY-1**.
6. **Parity = L1 bundle-hash equality** (dry-run bundles, both repos, same SHA) **+ L2 HTTP corpus**
   (/health · ~15–20 representative reads · 401/403 · error envelope · CORS preflight; goldens +
   documented dynamic-field normalizers). No SSE exists — plain request/response covers the surface.

## Seam status (the complete cut list — recon-verified, zero backend→frontend imports)

| Seam | Status |
|---|---|
| 9 root `data/*.json` worker-build inputs (`mbp-projection.ts:37-49`, `workspaces.ts:50`) | in the base manifest's data subset — travels with seed |
| Reverse type import `src/shared/services/api-client/types.ts → workers/dal/types` | **CLOSED (C0.1)**: byte-identical copies (5 files — identity re-exports xcp-identity-contracts, caught by the v3-contract typecheck) in `api-client/contract-types/` + blocking `verify:import-ban` (import ban + byte-sync) |
| Readiness-state receipt conflation | **CLOSED (C0.2)** |
| Unversioned consumer pin | **CLOSED (C0.3/C0.4)**: `api-contract.v1.json` (version+hash, `verify:contract` drift gate) + x-ai-front snapshot pins version/hash |
| Scripts with `src/workers` string paths (`smoke-cli.v3-source.mjs`, `onboard-customer.mjs`) | XCP-demo-side tools; recorded, no change |

## Standing hazards (operator-visible, pre-flip decisions)

- **Cron cap:** `wrangler.toml` carries 6 cron schedules; Cloudflare hard cap is 5 (error 10072 seen in
  repo history). x-backend's PRODUCTION wrangler config needs an operator decision (merge two schedules
  or drop one) before GATE-FLIP. Shadow runs cron-less, so C1/C2 are unaffected.
- **Migration 070 never-apply rule:** no step of this program applies 066–070 beyond the operator's
  elected activation set. The flip must be schema-neutral.
- **Backend smoke subset:** the 4,654-line smoke monolith has no backend-only extraction yet — post-seed
  shakedown work (per the gate ledger), not a seed blocker.

## Operator gate register ⚙

| Gate | Action | Status |
|---|---|---|
| GATE-SEED-METHOD | sign off fresh-copy + blob-hash provenance (deviation from reviewer default) | ☐ |
| GATE-BOUNDARY-AMEND-XB-SHADOW | amend BOUNDARY_MATRIX + ECOSYSTEM_MANIFEST rows (exact edits above) | ☐ |
| GATE-SEED-SHA | name the seed SHA (= post-C0 main tip) | ☐ |
| GATE-SEED-PUSH | authorize the push to `github.com/mar23-lab/x-backend` | ☐ |
| GATE-NEON-BRANCH | create the `shadow-cutover` Neon branch | ☐ |
| GATE-SHADOW-SECRETS | `wrangler secret put` staging values on `xlooop-api-shadow` | ☐ |
| GATE-SHADOW-DEPLOY-1 | run `npm run deploy:shadow` (first shadow deploy) | ☐ |
| GATE-FLIP | freeze-SHA production deploy from x-backend (per FREEZE_PROTOCOL + Sentinel 7d) | ☐ |
| GATE-CANONICAL-CLAIM | BOUNDARY_MATRIX `canonical_for` update — only after receipt evidence | ☐ |

## Stop conditions

Route count/hash drift during C0 (`verify:contract`) · L1 bundle divergence after stamp-normalization ·
boundary amendment unratified (x-backend stays empty; nothing lands only there) · Sentinel not green 7d
at the flip window · shadow receipt shows any route/cron/send_email binding · large seed-to-freeze drift
without full C1 re-verification · any prod mutation required by a non-gated step.
