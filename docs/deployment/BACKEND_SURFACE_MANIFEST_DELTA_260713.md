# Backend Surface Manifest — DELTA annex (260713)

**Extends (never mutates):** `BACKEND_SURFACE_MANIFEST_260711H.md` — the rehearsal receipt
(`SEED_REHEARSAL_RECEIPT_260711I.md`) references that file at rehearsal tip `3dd3156f`; its text is
frozen evidence. This annex dispositions every backend-relevant file **added since `3dd3156f`**
(OAR waves W0–W3, Stage-2, plan-entities, + this Wave C0), so the effective seed copy list =
**base manifest ∪ this delta**. Re-derive at seed time with:
`git diff --name-status 3dd3156f..<seed-SHA> -- src/workers scripts data docs/{contracts,deployment,security,governance,audits}`.

## COPY — travels with x-backend

### src/workers/** (all adds are backend runtime/tests — blanket COPY per base-manifest rule)
Runtime: `crons/review-schedule.ts` · `dal/{plan-entities-facade,plan-store,role-skill-resolution-store}.ts`
· `dal/types/plan-entity.ts` · `lib/{bridge-parity,policy-shadow,role-skill-resolver,role-skill-shadow}.ts`
· `routes/plan.ts` · `services/{domain-archetypes,policy-engine,review-scheduler}.ts`
Migrations (066–070; **all STAGED-or-applied per MIGRATION_STATE — 070 NEVER prod-applied by this program**):
`db/migrations/066_plan_entities.sql` · `067_user_source_connection_read_policy.sql` ·
`068_plan_hierarchy_repair.sql` · `069_smart_er_goal_schema.sql` · `070_role_skill_evidence_plane.sql`
Tests (14 new `__tests__/*.test.ts`, incl. the gated `role-skill-evidence-live-rls.test.ts`): COPY —
all are registered in ci-local vitest arrays (orphan gate holds).

### scripts/ (classify per GATE_DISPOSITION_LEDGER classes)
| File | Class | Disposition |
|---|---|---|
| `emit-routes-manifest.mjs` | A (contract producer) | COPY verbatim (has `--repo` flag; works in either repo) |
| `emit-api-contract.mjs` (C0.3) | A | COPY verbatim |
| `verify-api-contract-artifact.mjs` (C0.3) | A | COPY + register in forked ci-local |
| `verify-frontend-worker-import-ban.mjs` (C0.1) | A′ | COPY — in x-backend assertion (1) is vacuous (no frontend tree) and assertion (2) auto-degrades per its own header; keep for symmetry or drop in fork step — **fork-step decision** |
| `verify-flag-parse-hygiene.mjs` | A | COPY (blocking; scans src/workers) |
| `verify-role-skill-catalog-parity.mjs` · `verify-role-skill-evidence-rls.mjs` · `verify-domain-scaffold-honest-empty.mjs` | A | COPY + register in forked ci-local |
| `lib/role-skill-catalog.mjs` · `publish-role-skill-catalog.mjs` | A (operator tool) | COPY (publisher runs out-of-band; DSN via env) |
| `verify-no-mbp-runtime-dependency.mjs` (D0) | A | COPY + register in forked ci-local — the P2 runtime-independence lock rides the seed and holds in x-backend permanently |

### docs/
`docs/contracts/role-skill-catalog.json` + `docs/contracts/api-contract.v1.json` (C0.3) — COPY (contract SSOTs).
`docs/audits/{OPERATING_ARCHITECTURE_RUNTIME_AUDIT,OAR_W2_ACTIVATION_READINESS,OAR_W3_EVIDENCE_PACKET}.md` — COPY (evidence trail).
`docs/governance/FEATURE_FLAGS.md` — COPY. `docs/deployment/SEED_REHEARSAL_RECEIPT_260711I.md` — COPY (provenance).
This annex + `BACKEND_REPOSITORY_CUTOVER_PREFLIGHT.md` + `BACKEND_REPOSITORY_OWNERSHIP.yml` (C0.5) — COPY.

### D1 read-wave additions (260713) — surfaces the glob manifest missed

The 100%-disposition read wave (`data/decommission-disposition-ledger.json`, every tracked file
classified) is now the **authoritative per-file seed set**: every `class: to-x-backend` row travels;
the glob rules above are the *derivation*, the ledger is the *proof*. The reads surfaced three backend
surface classes that no prior manifest glob covered and that would otherwise have been **left behind at
seed** (each is enforced by a `to-x-backend` gate that fails in x-backend without its inputs):

- **`templates/customer-ecosystem-template/**` (18 files)** — the customer-onboarding contract bundle
  asserted by `verify:customer-ecosystem-template` (16 required files, content-scanned) and backed by
  `src/workers/routes/customer.ts` + `sources.ts`. COPY whole tree. Carries live schemas
  (`customer_source_register_v1`, `customer_do_not_ingest_v1`) + authority/consent + role-invite policy.
- **`deployment/cloudflare/**` + `deployment/github-actions-disabled/**` (6 files)** — Cloudflare
  env/access/entitlement policy (`environments.json`) read by `verify:cloudflare-access-evidence` /
  `verify:cloudflare-deployment-signal` / `verify:feedback-d1-cloudflare`, and the disabled GH-Actions
  deploy templates read by `verify:github-actions-disabled`. COPY.
- **`.dev.vars.example` (root)** — the Worker dev-var contract example. COPY (add to root-file allowlist).

Plus the `data/*.json` backend contracts the ledger marks `to-x-backend` (paid-pilot authority/action/
writeback, server-tenant-policy, customer-data-lifecycle, security-headers.manifest,
xcp-shared-access-contract-pack, document-anchor-contracts, and the runtime-read read-models) — these
are the authoritative data copy set; seed by ledger rows, not by the narrower `data/` glob. The gate's
`BACKEND_PREFIXES`/`BACKEND_ROOT_FILES` were extended (`templates/`, `deployment/`, `.dev.vars.example`)
so the class-invariant accepts them. **Operator action at GATE-SEED-METHOD:** copy by the ledger's
`to-x-backend` rows (authoritative), using these globs as the sanity cross-check.

**Two backend intents trapped in `legacy-frontend-frozen` scripts (re-port, don't copy):**
`verify-backend-proposal-receipts.mjs` + `verify-backend-receipt-gateway.mjs` assert a real backend
proposal-receipts feature whose impl currently lives in frozen `src/shared`; and
`verify-customer-chat-tenant-isolation.mjs` + `verify-customer-delete-export.mjs` +
`verify-server-tenant-policy.mjs` + `verify-self-maintenance-crons.mjs` +
`verify-project-source-binding-{contract,no-name-authority}.mjs` straddle both surfaces (frozen per the
BOTH→frozen rule) but encode backend security invariants. x-backend needs *equivalent* gates authored
against its own tree — the frozen originals do not travel. Full list: readiness doc §Valuable census.

## DO NOT COPY
Wave C0's frontend-side files: `src/shared/services/api-client/contract-types/*` + `types.ts` (the
browser copies STAY with the legacy frontend — that is their purpose); x-ai-front pin files (other repo).
Everything the base manifest already excludes (frontend trees, dist*, storybook, vite/playwright).
**Decommission program artifacts (D0) — explicitly excluded, they die with the archive:**
`scripts/generate-decommission-ledger.mjs` · `scripts/verify-decommission-disposition.mjs` ·
`data/decommission-disposition-ledger.json` · `docs/audits/DECOMMISSION_READINESS_AND_RETRO_260713.md`.
(The ledger is the permanent index INTO the archived repo; forking it into x-backend would create a
second denominator over a tree it doesn't describe.)

## Dependency-pin delta check (rehearsal gap #1 discipline)
`git diff 3dd3156f..HEAD -- package.json` at seed time: any NEW runtime dependency added since the
rehearsal must be exact-pinned from package-lock.json (same caret→exact rule as the 12 rehearsal pins).
As of 260713: no new runtime deps added by W0–W3/C0 (all waves used existing deps + node built-ins).
