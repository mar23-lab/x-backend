# OAR-W2 Activation Readiness — Evidence Packet (260713)

**Scope:** operator-mandated Track A of the activation-readiness review: independent verification of the
OAR-W2 role/skill resolution evidence plane (landed `29e39069`), Neon-branch validation of migration 070,
runtime DB-role/RLS proof, receipt-reliability tests, and a graded activation verdict.
**Hard constraints honored:** no prod migration apply · no prod secrets · no flag flips · no enforcement ·
no raw MB-P content · no "role/skill invocation is operational" claim.

## 1. STAGE-0 preflight (fresh reads at execution time)

| Fact | Value |
|---|---|
| Repo tip (origin/main at track start) | `29e39069` (= W2 landing commit); track branch `oar-w2w3-evidence-and-catalog` |
| Working tree | clean at branch creation |
| Prod schema head (read on the Neon validation branch, i.e. a fork of prod) | **69** |
| Migration 070 numbering | unique highest; upstream untouched since `29e39069` (amend-in-place valid) |
| `ROLE_SKILL_RESOLVER_ENABLED` | comment-only in wrangler.toml — **OFF** |
| `RESOLUTION_RECEIPT_SIGNING_SECRET` | secrets-comment only — **unset** |
| mig-035 catalog rows (on the prod fork) | template_definitions **0** · policy_definitions **0** |
| ADR-ABS-001..010 | all **Proposed** (x-ai-docs `26301bf`) |

## 2. Independent-review findings (each verified against source, file:line)

| Reviewer claim | Verdict | Evidence |
|---|---|---|
| R5 — "W2 uses a bundled agent-roles.yml manifest at runtime" | **REFUTED** | v0 binding source = `ROLE_SKILL_V0_FLOOR = Object.freeze([])` (lib/role-skill-resolver.ts); zero runtime reads of agent-roles.yml in `src/workers/` (grep); the yml is consumed only by build-time gates. Consequence: "bundled-vs-catalog parity" is a pure kernel fixture test, not a runtime comparison. |
| Receipt provenance gap (no source / deploy SHA / manifest hash) | **CONFIRMED → CLOSED** | 070 amended pre-apply (it was applied nowhere): `resolver_source` (`'v0-floor'|'catalog'|'mixed'`, NOT NULL), `deploy_sha` (nullable, from `XLOOOP_DEPLOY_SHA`), `catalog_manifest_sha256` (nullable, sha256 CHECK). Store + signing payload carry them; shadow derives them from the `BindingSource` seam. |
| R3 — RLS may be bypassed by the owner connection | **CONFIRMED architecturally · LATENT operationally · now PROVEN at the DB layer** | See §4. Owner connection IS bypass (by design, migration 037's own header); zero read paths exist on the evidence tables; 100% of evidence reads repo-wide carry explicit `WHERE workspace_id`. The live probe (§4) proves the RLS second layer bites for a non-bypass role. |
| R4 — `waitUntil` receipt loss could be silent | **CONFIRMED → CLOSED for shadow** | `role_skill_receipt_write_failed` ObservabilityKind now emitted on any receipt-write rejection (safe fields only; test A5). Enforce-mode durable write/outbox remains a named precondition of any future enforce flip — NOT built in this wave, by design. |
| R2 — Neon validation missing | **CLOSED** | §3. |

## 3. Neon branch validation transcript (control-plane only; prod primary never written)

- Project `flat-truth-23350426` (Xlooop, aws-ap-southeast-2, PG 17). Branch **`br-steep-truth-a78t4fvm`**
  (`oar-w2-070-validation-260713`) created off the default (prod) branch, auto-expiry 2026-07-14 as backstop.
- **Preflight (stop-conditions):** `schema_head=69` ✓ · `xlooop_rls_workspace_id` present ✓ · `xlooop_app`
  present with `rolbypassrls=false` ✓ (empirical confirmation of the 037 shape) · catalog/policy tables 0 rows ✓.
- **Apply (amended 070, file sha256 prefix `198480601e44fdec`):** clean, no errors.
- **Verify (single read, all 9 assertions):** `evidence_tables=4` · `provenance_cols=3` ·
  `classification_col=1` · `blocked_in_check=true` · `rls_enabled=4` · `rls_policies=4` ·
  `app_role_privs=SELECT` (exactly) · `app_can_insert_catalog=false` · `schema_v70=70`.
- **Idempotence:** guard re-check confirms the version-70 row gates re-runs; also proven twice on throwaway
  local Postgres (apply + re-apply clean, provenance row written, bad `resolver_source` rejected by CHECK).
- **Deletion receipt:** branch `br-steep-truth-a78t4fvm` deleted after validation (tool-confirmed);
  branch-scoped credentials died with it.

## 4. Runtime DB-role / RLS proof

**Connection topology (source-verified):** the Worker builds `sql = neonClient(DATABASE_URL)` (OWNER) and
`rlsSql = XLOOOP_RLS_APP_DATABASE_URL ? neonClient(that) : sql` (index.ts request + cron paths). The owner
BYPASSES RLS — stated verbatim in migration 037's header; the app-level `WHERE workspace_id` discipline is
the load-bearing boundary today (verified: 100% of evidence reads carry it). The 070 shadow WRITES are
owner-plane by design. RLS on the evidence tables is defense-in-depth that can now actually bite because
070 grants `xlooop_app` SELECT (045/046/047 precedent).

**Live cross-tenant probe** (`role-skill-evidence-live-rls.test.ts`, run against the §3 branch — a real
fork of the prod schema — via a freshly-provisioned LOGIN NOBYPASSRLS probe role with SELECT-only grants,
i.e. the `xlooop_app` shape): **5/5 PASS**

| # | Assertion | Result |
|---|---|---|
| 1 | Owner (write plane) sees both workspaces with no predicate — bypass acknowledged honestly | PASS |
| 2 | Probe + GUC=A, **NO workspace predicate** → only A's rows (resolutions AND denials) — DB-layer RLS, not app-WHERE | PASS |
| 3 | Probe + GUC=B → only B's rows | PASS |
| 4 | Probe with **no GUC set** → **0 rows** (unset GUC coerces to NULL — fail-closed) | PASS |
| 5 | Probe INSERT → `permission denied` (SELECT-only grant) | PASS |

**Static coverage added:** new BLOCKING gate `verify:role-skill-evidence-rls` (RLS+policy+grant shape over
070). NOT extended: `verify-rls-runtime-enforcement` — it structurally requires an adapter read call site,
and none exists for the evidence tables until the read-route wave (**TODO registered here**: extend its
`RLS_READS` list when that route ships). `verify-postgres-rls-phase2`'s TABLES list similarly covers only
the 5 spine tables; the new gate covers the 070 delta.

## 5. Receipt-reliability matrix (unit, `role-skill-shadow.test.ts` — all green)

| # | Property | Result |
|---|---|---|
| A1 | Missing secret ⇒ honest-unsigned receipt (`signature_alg='none'`, null signature) — shadow never 503s | PASS |
| A2 | `RESOLUTION_RECEIPT_SIGNING_KEY_ID` persisted; rotated secret ⇒ different signature; same key ⇒ deterministic | PASS |
| A3 | HMAC recompute reproduces the signature; `content_sha256` stable + 64-hex (DB CHECK shape) | PASS |
| A4 | Single-fire: one observe ⇒ exactly 1 resolution row; denial row only on actual deny | PASS |
| A5 | Receipt-write failure ⇒ `role_skill_receipt_write_failed` emitted (action/agreement/error-name ONLY — no tenant payload); caller unaffected | PASS |
| A6 | Provenance persisted: `resolver_source='v0-floor'`, `deploy_sha` from env, null catalog hash | PASS |

**Duplicate-receipt decision (recorded):** duplicates are ACCEPTED in shadow. Receipts are append-only
observations; a deterministic-id dedup would silently absorb genuine double-invocation defects — the exact
signal a shadow exists to surface. Revisit only at the enforce stage, where the durable-write design (outbox
+ idempotency key) is a stated precondition.

**Signing-language rule (R7):** receipts are **platform-signed integrity artifacts** — tamper-evident within
the platform trust boundary. They are NOT independently non-repudiable (the platform holds the secret); no
artifact or UI copy may claim otherwise.

## 6. Doc-contradiction register (operator-verify ⚙)

| Item | Contradiction | Resolution path |
|---|---|---|
| `XLOOOP_RLS_APP_DATABASE_URL` prod state | PRODUCTION_DEPENDENCIES.md says "SET in prod (043–047 live)"; TENANT_ONBOARDING (2026-06-22) says "not set"; LIVE_AUTHORITY handoff (2026-07-03) says "live credentials missing" | Unknowable from source (wrangler secret). **Operator: `wrangler secret list --config wrangler.toml`** and correct whichever doc is wrong. Gates the PRODUCTION SHADOW READY tier only in that the answer determines whether the RLS second layer is energized for 043/045/047 reads; the 070 shadow (owner-plane writes) is unaffected. |

## 7. Named operator gates ⚙ (activation prerequisites, in order)

1. `wrangler secret list` — settle §6.
2. Apply the **amended** 070 to prod Neon (file at this branch's tip; §3 proves it against a prod fork).
3. `wrangler secret put RESOLUTION_RECEIPT_SIGNING_SECRET` (+ optionally `RESOLUTION_RECEIPT_SIGNING_KEY_ID`,
   and `XLOOOP_DEPLOY_SHA` stamping in the deploy pipeline).
4. Deploy the API at ≥ this branch's tip.
5. Flip `ROLE_SKILL_RESOLVER_ENABLED=true` (shadow only) + monitor `role_skill_resolution` /
   `role_skill_receipt_write_failed` events and the two receipt tables for a soak window.
6. Enforce mode: NOT offered. Preconditions on record: durable synchronous/outbox receipt write,
   `governed_actions_without_receipt = 0` metric, ADR-ABS-006 ratified, shadow soak clean.

## 8. Verdict

**STAGING READY.**
- NOT-READY blockers: none remaining — migration validated on a prod fork; DB-layer RLS proven with a
  non-bypass role; receipt reliability + failure telemetry tested; provenance closed; R5 refuted with evidence.
- PRODUCTION SHADOW READY additionally requires (all operator ⚙): §6 secret-state confirmation, prod 070
  apply, signing-secret provisioning, deploy, then the named flag flip.
- Any enforce-mode claim is out of scope of this packet by construction.

*Non-claims:* role/skill invocation is **not** operational; production receipts remain **0** until the §7
gates are executed by the operator; nothing in this packet asserts IP-safety of catalog content (that is
Track B's evidence packet).
