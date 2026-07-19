# CANONICAL DOMAIN MODEL — Xlooop (N-UX.0 ontology ratification)

```
status: accepted (ratified by operator authorization 2026-07-20)
owner:       marat
date:        2026-07-20
supersedes:  none
home:        x-backend docs/architecture/CANONICAL_DOMAIN_MODEL.md
adr_set:     ADR-XB-001 … ADR-XB-007 (docs/architecture/adr/)
mbp_mirror:  ECOSYSTEM_DDD_GLOSSARY.yml additions (separate review artifact)
source:      N.9.c/d/f/g rulings, plan 260720 (three-plane extraction + two external assessments, converged)
```

**Canonical sentence:** *Xlooop turns an intent into governed work and keeps every human and
agent action traceable to context, evidence, decisions, approvals and outcomes.*

Rules of this document: same-concept-different-name → ONE canonical term.
Same-name-different-concept → the minority side renames (§2). UI vocabulary ≠ internal
vocabulary — adaptive labels (§5) are a feature, not drift. Every term has exactly ONE
authority; every other appearance is a projection.

---

## 1 · Canonical entity table

| Canonical concept | Internal term | Authority (file/table) | MB-P projection | x-backend projection | Default UI term | Notes / renames |
|---|---|---|---|---|---|---|
| Legal/security boundary | `tenant` | ADR-XB-001 (definition) | n/a — MB-P is one tenant (`mbp-private`) | none today; `workspaces` is the root. Introduce when multi-workspace lands | Organisation | Structure DEFERRED; definition RATIFIED now so "workspace = company" stops leaking into copy |
| Operating context | `workspace` | `workspaces` (mig 001) + ADR-XB-001 | `workspace_root` node class | `workspaces` | Workspace | keep |
| Knowledge/capability boundary | `domain` | MB-P `ECOSYSTEM_DOMAIN_REGISTRY.yml`; product rows: `synthetic_domains.kind` (mig 005) | 11 life-domains + bounded contexts | `synthetic_domains` WITH `kind` discriminator | adaptive (§5): Areas / Departments / Domains | Retire hardcoded "Departments" label; deprecate the 011 6-domain seed; ingest MB-P's 11 as `kind=life` |
| Computed view | `lens` | lens-kind `synthetic_domains` rows (binding, mig 005) + `synthetic_domain_recommendations` | (graph lanes) | `synthetic_domains` doubles as this — SPLIT by kind-discriminated rendering | Lens / View | "synthetic domain" RETIRED as customer-facing language; lens = derived + proposals only (ADR-XB-003) |
| Delivery container | `project` | `projects` | project nodes | `projects` | Project | keep; "Workspace — all" moves OUT of the Projects rail to a portfolio selector |
| Durable ask | `intent` | `intents` (mig 023/081) | intake intent (id grammar) | `intents` | Request | Ratified both sides (ADR-ABS-011). `plan_entities.kind='intent'` RENAMED (§2) — kills intent×2 |
| Governed execution unit | `packet` | `task_packets` (mig 034) | FEP = the dev-time analog (distinct, keeps its name) | `task_packets` | Work package | `context_packets` → `context_receipts` (§2) — kills packet×3; coordination/learning packets stay MB-P-internal |
| Immutable occurrence | `event` | `operation_events` | lineage/tool events | `operation_events` | Activity record | Events NEVER carry "done%"; four projections of one spine (ADR-XB-005) |
| Actionable unit | `work_item` | ONE scoped planning model (ADR-XB-002) | `WORK_ITEM_REGISTRY` (aligned) | today split across `plan_entities` (066) / `synthetic_domain_roadmap_items` / `board_cards` — consolidation target | Task | `Objective/Initiative/Milestone/WorkItem/Risk/Proposal/Roadmap` with `scope_ref`; the three stores converge on it |
| Goal | `objective` (scoped) | the one planning model (ADR-XB-002) | `ECOSYSTEM_GOALS` G-* — bridge via mig-069 `source_goal_id` | `synthetic_domain_goals` + `plan_entities.kind='goal'` → MIGRATE to scoped objective | Goal | Kills goal×2. Mig 074's "either authority" resolver is the live codified defect (§2) |
| Proof | `evidence` | `evidence_items` (mig 034) | `evidence/` corpus + FEP evidence | `evidence_items` | Proof | keep; integrity/admissibility hardening = P3 |
| Decision / approval | `decision` + `sign_off` | `decisions` (mig 030) + `sign_offs` | ADRs / DECISIONS_INDEX | `decisions`, `sign_offs`, `approval_requests` | Decision / Approval | keep; `approval_requests` vs `sign_offs` overlap = P2 ruling (flagged, not ruled here) |
| Actor identity | `principal` | mig 050 (principal-instrument) | `actor` / `actor_kind` node classes | principal-instrument (050, staged) | Actor | Activate 050 stamping on new writes (already authored) |
| Authority result | `allowed_actions` (envelope) + `spine_action` (grants) | `src/workers/lib/allowed-actions.ts` / `permissions.ts` | `blocked_actions` (export) | the ×2 name collision on `customer_entitlements` | — (never rendered raw) | `customer_entitlements.allowed_actions` → `granted_spine_actions` (§2) |
| Context given to a run | `context_receipt` | mig 071 (rename at activation) | session context bundle (analog) | `context_packets` → rename | Context used | It IS a receipt, not a work unit; contract in §4 |
| Risk tier | `risk_lane` (8-lane machine scale) | MB-P `_engine_contract_lib` | both `risk_class` + `risk_lane` today (non-injective) | intake `risk` low/med/high → map to lanes | Risk | `risk_class` becomes the DISPLAY bucket DERIVED from lane — one direction, never two independent stamps |
| Pillar | `serves_pillar` (P1–P8) keeps the word | MB-P `PILLARS.md` | `pillar_fit` (3-value) → `quality_dimension` (§2, MB-P-side) | n/a | — | Kills pillar×3; the x-biz axis keeps its own namespace |
| Lifecycle | three CLOSED vocabularies: `sterility_state` (5) · `doc_lifecycle` (5) · `graph_lifecycle` (4) | respective standards | the uncontrolled `lifecycle_state` key gets a closed enum + census verifier | packet/template lifecycles unaffected (already closed per-table) | — | Kills the uncontrolled-vocabulary and "4-state doc defines 5" inconsistencies |
| Source typing | `source_type` — ONE generated enum | intake schema (generator); validator imports the generated list | the 23-vs-31 enum split | event `source_tool` = distinct concept, distinct name (fine) | — | Kills the runtime-vs-spec split |

---

## 2 · SAME-NAME-DIFFERENT-CONCEPT rename register (the dangerous class)

| # | Collision | Ruling | Side that changes | Mechanic |
|---|---|---|---|---|
| R1 | packet ×3 — `task_packets` / `context_packets` / graph node | `context_packets` → **`context_receipts`** (it records what a run knew; it is not a work unit) | x-backend | rename INSIDE the mig-071 activation migration (071 is staged; no live data moves) — ADR-XB-007 |
| R2 | intent ×2 — `intents` (023) vs `plan_entities.kind='intent'` (066), two lifecycles | `intents` is the sole durable-ask authority (ADR-ABS-011). `plan_entities.kind='intent'` → **`plan_item`**, OR the row is promoted to a real intent REF (`promoted_to_intent_id` already exists in 066) | x-backend | ADR-XB-007; absorbed entirely by the ADR-XB-002 consolidation |
| R3 | allowed_actions ×2 — M4 envelope verbs vs `customer_entitlements.allowed_actions` (SpineActions grants) | envelope keeps `allowed_actions`; the entitlement column → **`granted_spine_actions`** | x-backend | column rename + code sweep — ADR-XB-007 |
| R4 | pillar ×3 — 3-value `pillar_fit` vs P1–P8 `serves_pillar` vs x-biz axis | `serves_pillar` P1–P8 keeps the word "pillar"; the 3-value reliability/discoverability/maintainability set → **`quality_dimension`** | MB-P (glossary + emitters) — NOT an x-backend change | mirrored in the DDD-glossary additions; x-biz namespace untouched |
| R5 | goal ×2 — `synthetic_domain_goals` (006/069) vs `plan_entities.kind='goal'` (066), ambiguity CODIFIED: mig 074's trigger resolves `target_id` against "either authority" and raises `'target_id is ambiguous across goal authorities'` | ONE scoped planning model owns `objective`; both stores migrate into it; **mig-069 `source_goal_id` is the designed MB-P bridge** (ECOSYSTEM_GOALS G-* ↔ scoped objective) | x-backend | ADR-XB-002 consolidation migration with rollback + reconciliation ledger; the 074 either-authority resolver retires with it |
| R6 | graph vocabulary ×3 — `data-graph.ts` (8 node types, `evidences`, `governs` deprecated) vs mig-029 CHECK (7 types, `governs`) vs mig-069 CHECK (9 types + 3 goal edges) — live drift, not staleness | **`src/workers/graph/data-graph.ts` is the single authority**; DB CHECK constraints are REGENERATED from it | x-backend | ADR-XB-007 (generator + regenerated constraints) |

---

## 3 · Scoped-planning ownership (who may own plans — per N.9.d + the external §5.1 as ratified)

| Scope | Authoritative for (owns) | Derived / read-mostly | MUST NOT own |
|---|---|---|---|
| **tenant** | isolation, retention posture, entitlements, legal boundary (ADR-XB-001) | — | any planning content; it is a security boundary, not a planning scope |
| **workspace** | charter + portfolio objectives + initiative roll-up (read-mostly); an *unassigned-action inbox* | roll-ups from projects | a workspace todo/task system (no second task store) |
| **department** (= domain rendered `kind=company`; org-unit) | people/standards supplied to projects | task views as roll-ups from projects | executable todos; canonical plans. Split into its own table ONLY when org-units gain budget/capacity fields (operator decision, §6) |
| **domain** (knowledge boundary) | domain objectives + capability roadmap + KNOWLEDGE context — vocabulary, principles, background information live HERE | membership (via binding) | executable todos |
| **project** | **the ONLY scope owning executable work items** + milestones + risks; outcome/acceptance | — | nothing planning-relevant excluded — this is the delivery container |
| **lens** | NOTHING canonical — signals, insights, PROPOSALS with promote/reject (the live recommendations flow) | everything it shows (computed) | a plan store; canonical objectives; any write authority (ADR-XB-003) |
| **chat** | nothing — an interaction surface that REFERENCES scopes | rendered context (via context_receipt) | truth of any kind; plans; decisions (ADR-XB-004) |
| **resource** | its own binding + trust tier (`read_policy` Index/Rely/Operate, 016/067) + freshness + classification | — | copies of itself under scopes — resources BIND, never copy |

The PLAN pane is the SAME component everywhere; only `scope_ref` changes. Per-level plan
copies (fractal planning) are the ratified top NO-GO of both assessments.

---

## 4 · Context-assembly precedence + the context_receipt contract

When a chat or agent run starts in a scope, the backend assembles context in this order
(higher layers constrain lower ones; the plan's compound layers are decomposed here —
decomposition itself PROPOSED):

| # | Layer | Source |
|---|---|---|
| 1 | Platform policy (product invariants) | platform config |
| 2 | Tenant policy (isolation/retention/entitlement constraints) | tenant (ADR-XB-001) |
| 3 | Workspace charter | workspace PLAN (read-mostly) |
| 4 | Portfolio objectives — the "company goals" layer | scoped planning model, workspace scope |
| 5 | Domain knowledge + vocabulary — the "background information" layer | domain scope (schema gap: `synthetic_domains` needs knowledge fields — thin migration) |
| 6 | Project scope: outcome, milestones, acceptance | project PLAN |
| 7 | Bound-resource slices — permission-filtered BEFORE retrieval, trust-tiered per `read_policy` | resource bindings (016/067) |
| 8 | Intent context (the durable ask being served) | `intents` |
| 9 | User preferences | user profile |
| 10 | Session-local conversation state — transient, lowest precedence, never persisted as truth | chat (ADR-XB-004) |

**context_receipt (mig 071, renamed from `context_packets` at activation):** the ordered
bundle is recorded per run — counts-only content, FNV fingerprint, HS256 signature,
`skill_coverage` — so "what did the agent know" is auditable per run. Chats REFERENCE
scopes; they never own truth. Surfaced in the composer as a context-preview chip (N-UX.2).

---

## 5 · Adaptive UI label table (internal `domain`, rendered per workspace character)

| Workspace character | UI label for `domain` |
|---|---|
| personal | Areas |
| company | Departments |
| product | Domains |
| programme | Workstreams |
| client | Disciplines |

Adopted from the external assessment's §4.2 table as ratified in N.9.c (rows 1–3 explicit
in the ruling table; programme/client from the adopted §4.2 set). One internal term, many
labels — the label NEVER leaks into the schema. "Synthetic domain" is retired as
customer-facing language everywhere.

---

## 6 · Open operator decisions (ratification does NOT close these)

| # | Decision | Status |
|---|---|---|
| 1 | Brand ratification — Xlooop / Exloop / XCP naming | P0, blocks public launch |
| 2 | Tenant-vs-workspace ADR sign-off (ADR-XB-001) | proposed herein |
| 3 | First paid use case + ICP (recommendation on record: Governed AI Delivery Control Plane wedge, project-driven orgs 30–300) | open |
| 4 | Autonomy matrix — which agent actions run without approval | open |
| 5 | Retention / residency targets | open (P3 gate input) |
| 6 | Departments (org-units) vs semantic domains as separate first-class objects — recommendation: kind-discriminated on the one table first; split tables only when org-units gain budget/capacity fields | open |

---

*Everything downstream (N-UX.1 frontend fidelity, N-UX.2 staged activations, N-UX.3 the
one-planning-model migration) cites this document. Nothing in it changes runtime behavior
by itself.*
