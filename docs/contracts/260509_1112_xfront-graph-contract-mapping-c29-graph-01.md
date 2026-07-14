# C29-GRAPH-01 · x-front Graph Contract Mapping

**Created:** 2026-05-09T11:12:00+10:00  
**Date key:** 260509_1112  
**Owner:** Marat Basyrov  
**Scope:** contract-design/documentation only  
**Source x-front HEAD:** `401e6d40a0befc683a7a410f1ed0aee0afd6f492`  
**Decision:** map patterns, do not copy source, do not implement runtime code in this slice.

## C38 Update · 2026-05-09T19:15+10:00

**C38-GRAPH-CONTRACT-PARITY-03 verdict: preserve the C29 decision and make it stricter.**

After PR #64, Xlooop-XCP-demo consumes `@xcp/event-contracts` v0.2.0 as a
generated mirror. That closes the event-topic authority gap, but it does not
make x-front's graph base equivalent to the XCP/Xlooop product graph contract.

Latest x-front evidence:

- `origin/main`: `401e6d40a0befc683a7a410f1ed0aee0afd6f492`
- `origin/AST-Proxy-2`: `995d0b23a5b0d9c4d139c441d06f1d2ade8e3794`
- branch divergence: `58 81` for `origin/main...origin/AST-Proxy-2`
- inspected contract path: `x-front/src/shared/contracts/graph/base.ts`

x-front's current `BaseNodeContract` is useful because it already models:

- `id`, `type`, `tenantId`, `schemaVersion`
- `lifecycleState`
- `graphLayer`
- `createdAt`, `updatedAt`
- typed `data`

x-front's current `EdgeContract` is useful because it already models:

- `id`, `type`, `sourceId`, `targetId`
- `tenantId`, `schemaVersion`, `graphLayer`
- `createdAt`, `updatedAt`, optional `metadata`

The gap remains material: x-front does not yet carry the first-class authority,
permission, source, evidence, confidence, sign-off, and agent-run fields that
Xlooop needs to prove the MB-P operational chain.

## Executive Verdict

**Adopt the contract idea, not the x-front file.**

x-front now has a useful minimal graph primitive:

- `BaseNodeContract<TType, TData>`
- `EdgeContract`
- `GraphLayer = super | middle | local | sub | subsub`
- `LifecycleState = draft | active | archived | deleted`

That is directionally aligned with MB-P/XCP graph thinking, but too thin for
Xlooop-XCP-demo's product use case. Xlooop-XCP-demo needs a product graph
contract that proves:

`workspace -> project -> intent/work item -> evidence -> decision/sign-off -> learning`

with collaborator boundaries, permission grant/expiry, visibility, sensitivity,
evidence lineage, and human/agent execution history. x-front's base contract is
a good vocabulary seed, not a sufficient product contract.

## Current Demo Contract Surface

| Surface | Current useful fields | Missing for product graph |
|---|---|---|
| `src/entities/actor/model.ts` | actor/session/membership, role, workspace, project, `expires_at` | actor kind, sensitivity boundary, permission scope, granted_at, granted_by, revoked_at |
| `src/entities/workspace/model.ts` | workspace kind, owner, identity TTL, members, compliance defaults | tenant/org boundary, default visibility/sensitivity, external collaborator policy |
| `src/entities/project/model.ts` | workspace, stage, visibility, owner, client_id | lifecycle state, sensitivity, source/evidence refs, graph layer |
| `src/entities/work_item/model.ts` | status, slices, maturity, visibility | graph identity, AC/evidence/decision refs as typed edges, actor-run history |
| `src/entities/evidence/model.ts` | artifact kind, validity, source, automation | source ref contract, verifies edge, stale/contradicted validity, checksum/commit |
| `src/entities/decision_record/model.ts` | decision type/outcome, lineage, decided_by/at, evidence_bundle | sign-off actor contract, approval authority, edge integrity |
| `src/runtime/event-envelope.ts` | workspace/project/actor, correlation, visibility, payload | graph edge emission contract, permission snapshot, source refs |

## Field Mapping

| x-front field / type | Adopt? | Xlooop-XCP-demo target | Notes |
|---|---|---|---|
| `id` | yes | `node_id` / `edge_id` | Use stable typed prefixes, e.g. `workspace:<id>`, `work_item:<id>`, `edge:<id>`. |
| `type` | yes | `node_type` / `edge_type` | Must be registered in a node/edge vocabulary before broad use. |
| `tenantId` | yes, renamed or paired | `tenant_id` plus `workspace_id` | Demo currently centers workspace/project; product contract needs tenant/org boundary too. |
| `schemaVersion` | yes | `schema_version` | Required for future migration and xcp-platform extraction. |
| `lifecycleState` | yes, extended | `lifecycle_state` | Keep `draft`, `active`, `archived`; avoid `deleted` as ordinary product state, prefer soft-deleted audit state. |
| `graphLayer` | yes | `graph_layer` | Useful for context-budget and jump-index alignment. |
| `createdAt`, `updatedAt` | yes | `created_at`, `updated_at` | Use timezone-aware ISO; display operator local time in reports. |
| `data` | partial | typed `payload` or domain fields | Product nodes should expose common governance fields at top level, not bury them in data. |
| `sourceId`, `targetId` | yes | `from_node_id`, `to_node_id` | Edge integrity tests required before runtime use. |
| `metadata` | partial | `edge_metadata` | Allowed, but critical governance cannot hide only in metadata. |

## Required Product Graph Contract Fields

These fields are missing from x-front's minimal base and should be present in
the Xlooop-XCP-demo product graph contract before implementation.

| Field | Required on | Why |
|---|---|---|
| `tenant_id` | node, edge, event | enterprise/customer boundary |
| `workspace_id` | node, edge, event | MB-P/Xlooop/client workspace routing |
| `project_id` | project-scoped nodes/edges/events | project-level visibility and lineage |
| `owner_actor_id` | node | explicit accountability |
| `created_by_actor_id` | node, edge, event | auditability |
| `updated_by_actor_id` | node, edge, event | auditability |
| `visibility` | node, edge, evidence | private/workspace/project/client/public projection |
| `sensitivity` | node, edge, evidence | public/internal/confidential/restricted boundary |
| `permission_scope` | node/edge where applicable | collaborator action boundaries |
| `permission_granted_at` | permission edges/events | explicit grant timestamp |
| `permission_expires_at` | permission edges/events | time-bounded access |
| `source_refs` | evidence/decision/work nodes | proof and reproducibility |
| `evidence_refs` | decision/work/signoff nodes | claim and approval support |
| `actor_run_refs` | generated/agent-assisted nodes | human + agent execution history |
| `confidence` | evidence/derived nodes | prevents treating draft/generated outputs as verified |
| `contract_version` | node/edge/event | compatibility and migration |

## C38 Parity Matrix

| Contract area | x-front baseline | Xlooop/XCP target | C38 decision |
|---|---|---|---|
| Tenant boundary | `tenantId` | `tenant_id` plus `workspace_id` and project scope | adopt and extend |
| Graph tiering | `GraphLayer = super/middle/local/sub/subsub` | same concept for lean/jump/full context control | adopt vocabulary |
| Lifecycle | `draft/active/archived/deleted` | richer lifecycle with owner-review, evidence, sign-off, sterile/quarantine states where applicable | adapt, do not reduce |
| Domain payload | generic `data` | common governance fields top-level, domain payload typed separately | adapt |
| Permission | absent | permission grant node/edge with scope, granted_at, expires_at, revoked_at | add, blocking before external collaboration |
| Visibility/sensitivity | absent | top-level visibility and sensitivity on node/edge/evidence | add, blocking before client use |
| Source/evidence refs | absent | first-class `source_refs`, `evidence_refs`, checksum/commit/version where useful | add |
| Decision/sign-off | absent | `decision_record`, `approved_by`, `signed_by`, authority scope | add |
| Agent/human execution | absent | `agent_run_refs`, `tool_invocation_refs`, human actor history | add |
| Edge vocabulary | free string with MB-P vocabulary note | typed edge contract plus vocabulary verifier | add verifier before runtime use |
| Metadata | optional catch-all | allowed only for noncritical details | keep constrained |

## C38 Product Contract Recommendation

Create the future Xlooop/XCP graph contract as a product contract layer, not as
a direct x-front import:

```text
src/contracts/graph/
  base-node.contract.ts      # XCP/Xlooop governance base
  edge.contract.ts           # typed relationship contract
  source-ref.contract.ts     # local_file/github/url/manual refs
  permission.contract.ts     # grant, expiry, revocation, authority
  actor-run.contract.ts      # human/agent/tool execution history
  lifecycle.contract.ts      # product lifecycle + sterility bridge
  graph-layer.contract.ts    # imports/adapts x-front GraphLayer vocabulary
  index.ts
```

Do not implement this by copying `x-front/src/shared/contracts/graph/base.ts`.
Use x-front as reference evidence and keep Ilmir's repo untouched.

## MVP Node Types

Do not model every possible node yet. Start with the minimum set needed to prove
the product thesis.

| Node type | Layer | Current source | Initial status |
|---|---|---|---|
| `workspace` | `super` | `src/entities/workspace/model.ts` | extend_contract_required |
| `project` | `middle` | `src/entities/project/model.ts` | extend_contract_required |
| `actor` | `super` | `src/entities/actor/model.ts` | extend_contract_required |
| `permission` | `local` | actor/session/membership fields | missing_contract |
| `intent` | `middle` | product workflow/data fixtures | missing_contract |
| `work_item` | `local` | `src/entities/work_item/model.ts` | extend_contract_required |
| `acceptance_criteria` | `local` | `src/entities/ac/model.ts` | extend_contract_required |
| `decision_record` | `local` | `src/entities/decision_record/model.ts` | extend_contract_required |
| `evidence_artifact` | `local` | `src/entities/evidence/model.ts` | extend_contract_required |
| `agent_run` | `sub` | event/runtime evidence only | missing_contract |
| `ui_component` | `local` | widget `contract.json` + uiKit contracts | extend_contract_required |
| `api_contract` | `local` | `src/contracts`, runtime/event/DAL contracts | extend_contract_required |

## MVP Edge Types

| Edge type | From | To | Required evidence |
|---|---|---|---|
| `belongs_to` | project/node | workspace/project | structural integrity |
| `owns` | actor/workspace | workspace/project/node | owner accountability |
| `has_permission` | actor | workspace/project/node/action | grant timestamp, expiry, scope |
| `captures_intent` | work_item | intent | source/user input |
| `implements` | work_item/ui_component/api_contract | requirement/intent | contract or task evidence |
| `has_acceptance_criteria` | work_item | acceptance_criteria | AC source |
| `evidenced_by` | work_item/decision/signoff | evidence_artifact | evidence source ref |
| `decided_by` | decision_record | actor | actor authority |
| `approved_by` | signoff/decision | actor | approval event |
| `generated_by` | node/evidence | agent_run | prompt/model/tool trace |
| `supersedes` | node/artifact | node/artifact | successor proof |

## Architecture Recommendation

Create a future `src/contracts/graph/` layer only after this mapping is
reviewed. It should contain TypeScript contracts and schema tests, not app
runtime logic.

Recommended future files:

```text
src/contracts/graph/
  base-node.contract.ts
  edge.contract.ts
  source-ref.contract.ts
  permission.contract.ts
  actor-run.contract.ts
  lifecycle.contract.ts
  index.ts
```

This remains compatible with Feature-Sliced Design because `entities/*` keep
domain models while `src/contracts/graph/` owns cross-entity contract primitives.

## Acceptance Criteria For Future Implementation

Before any code implementation:

1. Node and edge vocabulary is reviewed.
2. Permission fields include explicit grant time and expiry.
3. Visibility and sensitivity are top-level fields.
4. Evidence/source refs are first-class, not metadata-only.
5. Agent run trace is modeled for AI-assisted outputs.
6. Edge integrity tests exist before UI consumes graph nodes.
7. No x-front source file is copied.
8. x-front HEAD is rechecked if it changes from `401e6d4`.
9. `origin/AST-Proxy-2` is treated as evidence/replay input only while it remains
   divergent; no wholesale branch merge.
10. Contract tests reject nodes without actor/workspace/project authority where
    the node type requires it.
11. Contract tests reject permission grants without grant time and expiry or
    explicit non-expiring owner/system rationale.
12. Contract tests reject client-visible evidence without sensitivity and source
    reference metadata.

## Go / No-Go

| Action | Decision |
|---|---|
| Use x-front graph vocabulary as design input | GO |
| Copy `src/shared/contracts/graph/base.ts` | NO-GO |
| Add runtime graph code now | NO-GO |
| Create TypeScript contract skeleton in a later slice | GO after owner/PR review |
| Proceed to permission/collaboration requirements | GO after this mapping lands |
| Treat x-front base contract as the XCP product contract | NO-GO |
| Use x-front AST-Proxy-2 as direct merge source | NO-GO |

## Next Step

After this mapping lands, proceed to **C29-PERM-01**:

- compare x-front role/member/workspace settings with current demo actor,
  session, membership, signed URL, and GitHub collaborator assumptions;
- define permission grant, expiry, scope, revocation, and actor-kind matrix;
- still no direct x-front import.

After C38, the updated next step is **C39-GRAPH-CONTRACT-SKELETON-01**:

- add the Xlooop/XCP product graph contract skeleton and contract tests in
  Xlooop-XCP-demo;
- keep x-front read-only;
- include `GraphLayer` compatibility, but require XCP authority, permission,
  evidence, and lifecycle fields before any runtime graph UI depends on it.
