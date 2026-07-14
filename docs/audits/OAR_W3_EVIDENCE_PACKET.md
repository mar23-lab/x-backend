# OAR-W3 Evidence Packet — Customer-Safe Role/Skill Catalog Publisher (260713)

**Scope:** Track B of the operator-approved plan: the deterministic publisher that fills the empty
mig-035 catalog with immutable, customer-safe role/skill/pack contracts — merged WITHOUT any production
publication. `--apply` against prod is a named operator gate ⚙.

## 1. Inventory reconciliation (the 4-vs-23-vs-223 question, settled)

| Asset set | Count | Source | Nature | Runtime-ready? |
|---|---|---|---|---|
| MB-P authoring skills | **223** | `MB-P/_sys/xcp-system/governance/skills-index.yaml` (v0.7.0) | INTERNAL authoring corpus; per-entry `fork_safe` (`true|false|template|unset`) is the **eligibility filter** for what may ever be *projected* — never a body-extraction source | ❌ never directly |
| MB-P session roles | **23** | `MB-P/_sys/xcp-system/governance/SESSION_ROLE_MANIFEST.yml` (v1.9, entry_skill contract) | INTERNAL operator session roles | ❌ never directly |
| Xlooop automation agents | **4** | `docs/contracts/agent-roles.yml` | deliberately **FILE-ONLY** SSOT (its header: a DB copy would violate HR-NO-PARALLEL-MODEL-1 and open agent self-registration). The publisher **hard-fails on any key collision** with these | ✅ (lineage labels; parity-gated) |
| Customer-safe catalog entries | **9** — 3 roles + 5 skills + 1 pack | `docs/contracts/role-skill-catalog.json` (`xlooop.role_skill_catalog.v1`) | **curated FRESH for customers** — content is authored, not extracted; zero MB-P body text (gate-scanned) | ✅ once published + bound (operator ⚙) |

These are **four distinct SSOTs with a stated boundary** — the earlier "3/4 vs 23/223" confusion was a
category error: the small numbers are Xlooop runtime surfaces, the large ones are MB-P's internal
authoring corpus. There are **9 published customer-safe entries** in catalog v2026.07.0.

## 2. Contract schema + curation provenance

- File: `docs/contracts/role-skill-catalog.json` — **JSON, not YAML** (deliberate deviation from the
  plan sketch: the repo has no YAML parser dependency; JSON.parse is native + deterministic; machine-first rule).
- Per entry: `key · category(role|skill|pack|tool) · version · classification · name · description ·
  capability · actions · allowed_tools · denied_tools · requires_approval · evidence_contract ·
  output_schema · closing_requirement · source_ref` (+ `skills`/`roles` refs for roles/packs).
- `classification` whitelist: **only `public` | `customer_visible` is publishable**; `internal_sensitive`
  is rejected by the validator BEFORE any SQL exists (mission: RESTRICTED content is a publisher-side
  refusal, never a DB row).
- `content_sha256` is COMPUTED by the publisher over `canonicalJson(projectEntry(entry))` — an
  **allow-list projection**: fields not named in `projectEntry` can never reach the DB.
- Curation rule (stated in the file's `_provenance` and enforced by marker scans): content is written
  fresh; MB-P `fork_safe` gates eligibility for future projection work, and **no MB-P body text, path,
  or internal identifier appears in any entry** (FORBIDDEN_MARKERS scan in the validator, the parity
  gate, and the extended `verifyNoRawGovernanceTemplateExposure` runtime scan).

## 3. Publisher invariants (scripts/publish-role-skill-catalog.mjs + scripts/lib/role-skill-catalog.mjs)

| Invariant | Mechanism | Proof |
|---|---|---|
| Dry-run is the DEFAULT; `--apply` explicit + requires DATABASE_URL | CLI arg handling | T-suite + parity gate |
| Byte-deterministic dry-run | canonical key-ordered JSON · hash-derived ids (`td_/tv_/tb_` + sha256 prefixes) · **no timestamps/randomness in SQL** | two full CLI runs diffed byte-identical (parity gate, every ci-local run) |
| Immutability HARD-FAIL | pre-SELECT existing `(template_key, version, content_sha256)`; same key+version with different hash ⇒ **exit 1, zero SQL emitted**; `ON CONFLICT … DO NOTHING` retained only as a race belt | T10/T11 |
| Identical republish = skip | hash-equal triplets are skipped with a notice | T10 |
| Reader-compatible rows | versions ship `lifecycle_state='approved'` + every reader-consumed NOT NULL; bindings (optional `--workspace`) ship `binding_scope='workspace'`, `lifecycle_state='active'`, `approved_by`, `approval_ref` | T9/T13/T14 |
| Runtime cannot do this | mig-070 REVOKEs catalog INSERT/UPDATE/DELETE from `xlooop_app`; the publisher is out-of-band with the operator's DSN | Neon-branch verify (Track A §3: `app_can_insert_catalog=false`) |
| Publish receipt | file artifact `docs/audits/receipts/role-skill-catalog-publish-<sha8>.json` (timestamps live HERE, not in SQL) | code path; exercised at first ⚙ apply |

## 4. Gates added / extended (ci-local 92→94 blocking)

- **NEW `verify:role-skill-catalog-parity`** — catalog validity (schema, whitelist, referential integrity,
  agent-key disjointness) · dry-run determinism (two CLI runs) · SQL exposure scan · kernel `RoleSkillBinding`
  field parity (5 bindings) · reader safe-tier predicate present · evidence-packet count parity.
- **NEW `verify:role-skill-evidence-rls`** (Track A) — 070 RLS/grant/provenance shape.
- **EXTENDED `verifyNoRawGovernanceTemplateExposure`** — the catalog contract file joins the raw-MB-P-path
  scan set (it is published verbatim into `redacted_content`); the publisher lib is deliberately excluded
  (its FORBIDDEN_MARKERS scanner constant contains the path it scans for).
- **Reader hardening** (`template-policy-store.ts`): `resolveEffectiveTemplatesRow` now filters
  `COALESCE(to_jsonb(td)->>'classification','customer_visible') IN ('public','customer_visible')` —
  safe-tier-only **by construction**, and **schema-tolerant**: the route is live in prod and the
  `classification` column only arrives with mig-070, so a bare column reference would 500 the route if
  code deploys before the operator applies 070. Pre-070 the predicate is a no-op (NULL → legacy
  customer_visible); post-070 it enforces for real.

## 5. Test evidence

`role-skill-catalog-publisher.test.ts` — the mission's 18 acceptance tests (T15/T16 share one block):
catalog parses+validates · internal_sensitive rejected · agent-key collision rejected · forbidden markers
rejected AND absent · canonicalJson reorder-invariant · 64-hex stable hashes · hash changes on any field
change · SQL byte-determinism + no timestamps · BEGIN/COMMIT + 9+9(+9 bindings) row families ·
identical-republish skip · hash-drift hard conflict · sqlString escaping · reader NOT NULLs + approved
lifecycle · binding validity · reader predicate present · kernel parity (catalog projection →
`resolved` with selected skills; empty floor → honest `no_catalog`) · SQL exposure scan.
**17/17 green.** Registered in ci-local (`verify:ip-boundary-suite` array) + orphan gate holds.

## 6. Explicit non-claims

- Role/skill invocation is **NOT operational**: the catalog is 0 rows in prod until the operator runs
  `--apply`; the resolver flag is OFF; production receipts are 0.
- No tenant binding exists anywhere; publish-and-bind are SEPARATE operator decisions (auto-binding
  would be a de-facto flag flip).
- The shadow's catalog LOADER (BindingSource seam → published rows) is deliberately NOT built in this
  wave — it is the activation-stage slice, designed against the seam in `role-skill-shadow.ts`.
- Rehearsal note: a `--apply` rehearsal against the Track A Neon branch was NOT performed (the branch was
  deleted after the 070 validation, before the publisher existed); the recommended rehearsal is a fresh
  disposable branch + `DATABASE_URL=<branch> node scripts/publish-role-skill-catalog.mjs --apply` at the
  operator's next validation session — the receipt file will capture it.

## 7. Operator gates ⚙ introduced by this track

1. Publish: `DATABASE_URL=<prod> node scripts/publish-role-skill-catalog.mjs --apply --approval-ref <ref>`
   (after mig-070 prod apply from Track A's queue).
2. Bind per workspace: re-run with `--workspace <ws_id>` (or the future admin surface).
3. Catalog content sign-off: the 9 curated entries are PROPOSED content — review the descriptions/action
   scopes before first publish.
