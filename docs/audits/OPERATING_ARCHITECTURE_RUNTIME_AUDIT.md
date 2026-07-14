# Operating Architecture Runtime Audit (OAR Phase 0) — 260713

**Mission:** the backend-native Xlooop Operating Architecture Runtime — mechanical role/skill resolution with
receipts, versioned customer bootstrap packs, closed-loop execution, zero physical /WIP/MB-P runtime
dependency, IP-safe customer projection, and a 5-scope heartbeat control plane. This audit is the
evidence-first current-state baseline (mission Phase 0). It supersedes any prior claim that merging ABS
branches or landing flag-off kernels completes MB-P absorption.

**Evidence provenance:** three read-only audit agents (260713) over Xlooop-XCP-demo `4881b211`,
x-ai-front `wired/`, MB-P `aba9fe22` (origin/main). Every row cites file:line. Repo/branch/deploy identity:
Xlooop-XCP-demo main `4881b211` · prod API deployed `525ae4f5`-era + flag-off increments · prod DB schema
head 69 · MB-P main `aba9fe22` · x-ai-front deployed `11edd9f`-era · x-backend seeded-empty.

**One-line verdict:** authority is mechanical and server-side, context assembly is real and role-scoped,
the lineage substrate is wired — but **skill resolution does not exist as a runtime concept**, the
enforcement layers are dormant behind default-off flags, there are **zero heartbeat tables**, the catalog
tables are empty, and IP redaction is per-route ad-hoc with six concrete payload vectors. "A runtime built
inert."

---

## Matrix A — Role/skill invocation

| Action path | Role resolved? | Skills resolved? | Entitlement checked? | Context applied? | Receipt? | Closing attestation? | Status |
|---|---|---|---|---|---|---|---|
| 12+ governed-write sites (`operational-spine.ts`, `mcp-gateway.ts`, `customer.ts`, `developer-access.ts`, `sign-offs.ts`, `events.ts`, `template-policy-registry.ts`, `model-runtimes.ts`, `feedback.ts`, `workspace-gates.ts`…) | ✅ mechanical, server-side (`lib/spine-authority.ts:67` reads JWT auth; `lib/permissions.ts:29` legacy `canWrite`) | ❌ no runtime concept | 🟡 wired fail-closed (`dal/principal-hydration.ts:27` — missing entitlement ⇒ DENY) but `ENTITLEMENT_ENFORCEMENT` OFF (`wrangler.toml:168` "deliberately NOT flipped") | ✅ G9 role-scoped, flag ON (`wrangler.toml:181`) | 🟡 success = `operation_events`/`audit_logs`; **denials console-only** (`spine-authority.ts:76-78`, no table) | ❌ | PARTIAL |
| Chat (customer + cockpit) | ✅ (`role-scoped-context.ts:35-39` — never body-supplied) | ❌ | 🟡 same | ✅ G9 + W5 graph-budget (`CHAT_GRAPH_CONTEXT_ENABLED` ON); auditLine (`ContextAuditLine`) but **no context hash**; L1 trace flag OFF | 🟡 `grounded_on` persisted (`dal/chat-store.ts:87-101`) | ❌ | PARTIAL |
| Crons / system agents | system actors (n/a) | ❌ ad-hoc `agent_id` strings; registry = `docs/contracts/agent-roles.yml` (a FILE by design, HR-NO-PARALLEL-MODEL-1) resolved post-hoc via `AGENT_ROLE_REGISTRY` (`cockpit-chat.ts:273-277`) | n/a | n/a | ✅ events | ❌ | PARTIAL |

**Mission-metric readings today:** skill-resolution coverage **0%** · resolution receipts **0** ·
closing attestations **0** · denial receipts **0** (log-only).

**Defect found & fixed in this wave (F5):** `crons/review-schedule.ts` stamped the unregistered identity
`agent_review_scheduler`; the parity gate scanned only `operations-queue-consumer.ts`. Fixed: id renamed to
`xlooop:review-scheduler`, registered in `agent-roles.yml`, and `verify-agent-roles-parity.mjs` now scans
`services/ + crons/ + routes/ + lib/` (adversarially proven to bite).

## Matrix B — MB-P physical runtime dependencies

| Dependency | Local path/tool | Runtime caller | Backend replacement | Severity | Removal phase |
|---|---|---|---|---|---|
| /WIP/MB-P folder reads | — | **NONE in Worker `src/`** (verified: zero references; only operator `scripts/*.mjs` bridge producers with env-overridable `MBP_ROOT`, wrangler comments, one mock fixture, and the *guard* `verify-customer-ip-boundary.mjs`) | already independent | **LOW (customer runtime)** | W7 gate locks it |
| launchd bridge producers | `_sys/launchd/` plists (B1 livestream-push, B2 projection-cron, B5 uptime-probe, B6 pilot-telemetry, B9 federation-freshness…) | MB-P tenant operations only | W9 ingest-side heartbeats + bridge repair | **TOTAL (MB-P tenant)** | W9 + MB-P-side ⚙ |
| mb-p-gateway MCP (`harness_session_start`, attestations) | `_sys/xcp-system/mcp-gateway/server.py` | authoring/dev sessions | W2/W3 backend resolver+receipts adopt its contract shapes | authoring-only | n/a (stays) |
| Local graph (JSON index + SQLite FTS + jump shards) | `graph_query_planner.py`, ECOSYSTEM_GRAPH_ACCESS_MATRIX | MB-P sessions | mig-029/069 graph + lane policies (W5-class) | authoring-only | n/a (stays) |
| Local memory (MIDDLE_MEMORY, Localbrain) | red-class `excluded_planes` (BRIDGE_REGISTRY:252-264: derived-knowledge-graph 27k nodes, localbrain-memory, personal-raw) | never leaves MB-P | none (by design) | forbidden to bridge | never |
| Git hooks as policy | `make install-hooks` chain | MB-P dev commits | product ci-local gates | authoring-only | n/a (stays) |

**Bridge health at audit time (BRIDGE_REGISTRY 13 rows):** B2 **broken** · B10 no-op · B4/B9/PRODUCT-GRAPH
stale · Sentinel real alarms: **C2B 39.3h vs 3h SLO**, **B6 631h**; B1 flagged low-confidence
(`freshness_confidence=producer-mtime-proxy`). The Sentinel's own v1 ask = the ingest-side manifest this
repo's `lib/bridge-parity.ts` kernel implements (unrouted — W9).

## Matrix C — Architecture asset coverage

| Asset class | Registry | Graph tier | Owner | Versioned | Discoverable | Runtime-used |
|---|---|---|---|---|---|---|
| Workspace roles/entitlements/modes | `workspace_members` + `customer_entitlements` + mig-052 prefs | n/a | platform | n/a | ✅ | ✅ enforced (legacy axis) |
| Agent roles/skills (product) | `docs/contracts/agent-roles.yml` (4 agents / 5 skills after F5) + in-memory `AGENT_ROLE_REGISTRY` | n/a | platform | git | ✅ file | 🟡 lineage labels only |
| Skills (MB-P, 223) | `skills-index.yaml` v0.7.0 | MB-P graph | operator | git | MB-P only | ❌ not in product |
| Roles (MB-P, 23) | `SESSION_ROLE_MANIFEST.yml` (entry_skill + closing_skills contract) | MB-P | operator | git | MB-P only | ❌ not in product |
| Packs/templates | mig-035 (`template_definitions/_versions`, `tenant_template_bindings`, `effective_template_snapshots`) | n/a | platform | immutable-capable (content_sha256, UNIQUE) | ✅ schema | ❌ **0 rows**; read SQL live (`template-policy-store.ts` layered resolution) |
| Policies | mig-035 `policy_definitions/_decisions` + `services/policy-engine.ts` kernel | n/a | platform | code | ✅ | 🟡 shadow-only (`lib/policy-shadow.ts`, flag OFF), tables 0 rows |
| Graph | mig-029 (+069 goal layer), `graph_snapshots.graph_hash` | cache-of-truth (no lanes/planner; edge-budget selector in `chat-graph-context.ts`) | platform | ✅ hash | ✅ | ✅ operator-scoped feeder cron |
| Memory/learning | mig-036 | n/a | platform | ✅ | ✅ | 🟡 `user_learning_signals` + `tenant_learning_promotions` runtime-written; profiles computed, never inserted |
| Lineage spine | migs 023/030/031/034/057/058 + `v_artefact_lineage` | feeds graph | platform | ✅ | ✅ | ✅ write paths fire — but **operator/MCP-fed** (driver gap, not schema gap) |
| Heartbeats | **none** | — | — | — | ❌ | 🟡 cron+Sentry rail (`index.ts:305-359`), deploy-receipt FILES, snapshot freshness — no tables/SLOs/rollups |

## Matrix D — Customer bootstrap (fresh tenant)

| Capability | Fresh tenant today | Required pack | Backend support | Gap |
|---|---|---|---|---|
| Workspace + members + authority axes | ✅ (`customer-provisioning-store.ts:80-209`, idempotent txn) | — | ✅ | — |
| Projects | 1 bare `proj_<slug>_default` | starter project | ✅ | pack content |
| Day-1 guidance | roadmap events + welcome draft (`buildDay1Roadmap`, ctx_v1 resolver flag-gated) | first-use intent | ✅ | — |
| Domains | flag-OFF scaffold (2 structure-only archetypes, `domain-archetypes.ts`) | domain skeletons | ✅ built | flip ⚙ + mission's 3rd archetype |
| Roles beyond membership | ❌ | role definitions | ❌ (W2/W3) | total |
| Skills | ❌ | 3–6 per pack | ❌ (W2/W3) | total |
| Policy pack | ❌ | policy classes | kernel exists, catalog empty | total |
| Review cadence | ❌ (cron flag OFF; columns exist mig-069) | cadence defaults | ✅ built | flip ⚙ + pack defaults |

## Matrix E — Heartbeat coverage

| Scope | Producer today | Store | SLO | Alert | Customer-safe status | Gap |
|---|---|---|---|---|---|---|
| Platform | cron dispatcher + `decideCronReport` + Sentry flush (`index.ts:305-359`); deploy receipts (build-SHA-verified FILES) | none | none | Sentry | ❌ | tables/SLO/rollup (W9) |
| Tenant/workspace | ❌ | — | — | — | ❌ | everything (W9) |
| Bridge/integration | MB-P Sentinel (producer-mtime proxy) + `lib/bridge-parity.ts` ingest-age kernel (**unrouted**) | file report | per-plane thresholds (registry) | Sentinel print | ❌ | route + ingest last-seen + emission (W9) |
| Active run/tool | `tool_events` rows | mig-057 | none | none | ❌ | liveness semantics |
| Review cadence | `crons/review-schedule.ts` (flag OFF) | operation_events | cadence | dispatcher | 🟡 needs_review events when on | flip ⚙ + rollup |

**Anti-model confirmed:** per-human-user heartbeats rejected (mission concurs) — scopes are
platform/tenant/bridge/run/review; user activity stays in events/sessions.

---

## IP-leakage vectors (payload-verified; remediation = W8)

1. **Events field-level:** rows ship `agent_id`, `source_tool`, `request_id`, `instrument_kind`,
   `authority_source`, `permission_scope` to every role passing row-visibility — only
   `authorized_by_user_id` is redacted (`event-store.ts:76-80`); row filter (`visibility.ts`) fences
   `client` well but field stripping is absent.
2. **Raw engine internals to `viewer`:** goals return raw `derivation` JSON + `goal_metric_contract`
   (`synthetic-domains.ts:589-605`); propagation-rules raw `trigger/action` (`:723-735`);
   recommendations expose `pattern_fingerprint`, `signal_contribution_breakdown`,
   `composite_confidence`, `detector_config_version_id` (`:868-874,997-1027`) — `client` 403'd,
   **`viewer` not**, no sanitizer.
3. **`/session` provisioning mechanics:** `operator_bootstrapped`, `auto_provisioned_from*`,
   `auto_provision_skipped_reason` (`session.ts:252-276`) reach any authenticated caller.
4. **Chat payload engine names:** `model`/`generated_by` in `customer-chat.ts:248-256` (UI drops them;
   payload carries them; audit-export elsewhere deliberately hides vendor names — asymmetry).
5. **Client bundle internals:** `mbp_ecosystem_operator` + identity-axis vocabulary ship in
   `index.html:3014,727-735`, unhidden by the client-side-only `?admin=1`/localStorage flag
   (`index.html:6811-6816`) — presentation gating, not authority.
6. **Counter-pattern to generalize:** `toTenantSafeSyntheticDomain` fail-closed allow-list
   (`synthetic-domains.ts:99-109`, HR-IP-BOUNDARY-1) — the model for the W8 shared serializer.
7. **New wired UI has NO egress redaction layer** — `wired/live-data.js` maps raw API JSON to state;
   the API is (and must be treated as) the sole IP boundary.

Positive stance already in place: 5-class `data_class` taxonomy (`docs/security/DATA_CLASSIFICATION.md`,
`response-envelope.ts:9`) + 4-tier visibility ladder + fail-closed principal redaction + operator-gated
MB-P projection + client-egress neutralize in G9 (`role-scoped-context.ts:47-52`, client ⇒ empty bundle).

## Flag/dormancy ledger (activation debt)

| Capability | Flag | State | Effect off |
|---|---|---|---|
| Entitlement authority axis | `ENTITLEMENT_ENFORCEMENT` | OFF (deliberate) | legacy `canWrite(role)` |
| Policy engine | `POLICY_ENGINE_ENABLED` | OFF | kernel pure; shadow only |
| Review scheduler | `REVIEW_SCHEDULER_ENABLED` | OFF | cron zero-IO skip |
| Domain scaffold | `DOMAIN_SCAFFOLD_ENABLED` | OFF | 1-bare-project provisioning |
| Assembly trace (L1) | `CHAT_ASSEMBLY_TRACE_ENABLED` | OFF | `grounded_on.assembly` null |
| Role-scoped context (G9) | `CHAT_ROLE_SCOPED_CONTEXT_ENABLED` | **ON** | — |
| Graph chat context (W5) | `CHAT_GRAPH_CONTEXT_ENABLED` | **ON** | — |
| Bridge parity heartbeat | — | **unrouted** | kernel only |

## Session retrospective (compressed; full detail in the OAR plan)

9 commits landed 260713 (6 Xlooop + 3 MB-P), 71 new unit tests, ci-local 91→92 gates, 0 prod mutations —
enforcement scaffolding built inert. Failures identified: completion-language inflation (F1), prompt-level
role/skill selection in agent sessions (F2), `--no-verify` pushes from a worktree false-positive (F3,
hygiene fixed this wave), missing frontend egress layer (F4→W8), the F5 defect (fixed this wave), dropped
data_class badge (F6→W11), client-side admin flag (F7→W8), stale HR-count labels (F8), stranded ADR branch
(F9→W1).

## Go/No-Go posture

**No-Go on the mission's final claim** — by its own metric table: skill resolution 0%, receipts 0,
attestations 0, heartbeat tables 0, clean-tenant journey untested. **Go on the OAR waves** (W0 this doc →
W1 ADRs → W2 evidence-plane migration + shadow resolver → W3 publisher → …): every precondition verified,
no canonical-registry conflict after the W2 design correction (catalog = mig-035 reuse, NOT new tables).
