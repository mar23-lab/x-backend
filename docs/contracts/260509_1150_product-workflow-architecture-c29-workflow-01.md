---
id: c29_workflow_01_product_workflow_architecture
title: C29-WORKFLOW-01 Product Workflow Architecture
created_at: "2026-05-09T11:50:00+10:00"
date_key: "260509_1150"
timezone: Australia/Melbourne
owner: Marat Basyrov
status: active_decision
lifecycle_state: sterile_active
graph_required: true
source_files:
  - CURRENT_STATE.md
  - docs/design/target-user-journey-ia.md
  - docs/design/workspace-project-shell-target-ia.md
  - docs/contracts/260509_1112_xfront-graph-contract-mapping-c29-graph-01.md
  - docs/contracts/260509_1102_permission-collaboration-requirements-c29-perm-01.md
  - docs/contracts/260509_1109_storybook-dod-state-matrix-c29-story-01.md
  - docs/contracts/260509_1119_uikit-wrapper-reconciliation-c29-uikit-01.md
  - docs/contracts/260509_1128_xfront-bisync-engine-investigation-c29-bisync-01.md
  - docs/contracts/260509_1137_bisync-contract-skeleton-c29-bisync-02.md
---

# C29-WORKFLOW-01 Product Workflow Architecture

## Executive Verdict

Yes, the current review covers the previous C29 path, but with a new missing lens.

Previous C29 slices answered: what can safely transfer from `x-front` into
Xlooop-XCP-demo without importing unstable code or blending product boundaries?

This decision answers: what user workflow, modular product architecture, and
cross-frontend compatibility model should those transfers serve?

The answer is not enterprise-first, not individual-first, and not capability-first
as the visible UX. The correct product shape is:

**workspace-first entry, role-driven actions, graph-backed governance, and
capability modules underneath.**

The first 30 seconds of the web product must prove:

`Workspace -> project/domain -> intent -> governed triage -> work item -> build/evidence -> sign-off -> learning/XCP substrate`

That chain is the product. UI polish, editor engines, Storybook maturity, and
graph contracts are only useful if they make this chain clearer and safer.

## Role Panel

This review uses the following lenses explicitly, because prior reviews showed
that using the right skills is insufficient if role governance is invisible:

| Role | Lens Applied |
|---|---|
| Chief-of-Staff | Sequencing, owner decision queue, cross-domain clarity |
| CTO | Product/platform boundary, architecture risk, contract sequencing |
| UX | First-30-second comprehension, workspace/project flow, visual hierarchy |
| Product Manager | Use case fit, commercial workflow, enterprise/small-user split |
| Knowledge Architect | Graph, context packs, evidence and learning traceability |
| AI Governed Infrastructure Manager | XCP substrate visibility without admin-dashboard blending |
| DevSecOps | Permissions, sensitivity, sign-off, boundary and evidence safety |
| Lead Engineer | Implementable slices, tests, Storybook contracts, no unstable imports |

## Product Workflow Decision

### 1. Entry Model

The product should start from the actor's workspace context, not from a generic
dashboard greeting and not from an enterprise admin console.

Required workspace classes:

| Workspace Class | Example | UX Meaning |
|---|---|---|
| Owner private | MB-P / Marat | Personal and operator-owned proving workspace |
| Company/product | Xlooop | Commercial product/company delivery workspace |
| Platform producer | xcp-platform | Platform roadmap and substrate visibility, not infrastructure admin UI |
| Client/invited | Client workspace | Permissioned collaboration, review, and sign-off |
| Small team/personal | hobby, family, personal finance | Same governance model, lighter defaults |

The visible workflow must support both individual/small users and enterprise
teams by changing defaults, not by creating separate products.

### 2. Workflow Control Model

Use a hybrid workflow model:

| Layer | Recommendation | Why |
|---|---|---|
| Core navigation | Hardcoded product spine | Prevents fragmented UX and makes value obvious |
| Workspace/project setup | Configurable templates | Supports personal, SMB, agency, enterprise, client variants |
| Permissions/actions | Role-driven | Keeps human-in-loop, sign-off, visibility, and responsibility explicit |
| Evidence/lineage/dependencies | Graph-driven | Gives traceability without forcing graph UI onto every user |
| Capability modules | Contract-driven plugins/widgets | Keeps modules movable without breaking the user flow |

Do not expose the graph as the default user workflow. Use the graph as the
trusted substrate that explains, verifies, and connects the work.

### 3. Canonical Flow

```text
Actor
  -> Workspace
  -> Project or Domain
  -> Intent Inbox
  -> Governed Triage
  -> Work Item
  -> Build / Design / Evidence
  -> Review
  -> Sign-off
  -> Learning / Reuse / XCP Substrate
```

Required user-facing proof points:

| Step | Must Show |
|---|---|
| Actor | who is working, role, permission scope |
| Workspace | MB-P, Xlooop, xcp-platform, client/invited context |
| Project/domain | where the work belongs and who can see it |
| Intent | user/client/business problem, not just a task title |
| Triage | governance status, owner decision, risk, sensitivity |
| Work item | DoR, DoD, acceptance criteria, dependencies |
| Build/evidence | human + agent activity, tests, artefacts, screenshots/logs |
| Review | role panel, reviewer, open risks, claim/evidence status |
| Sign-off | who approved what, when, with expiry or conditions |
| Learning | reusable pattern, XCP backlog candidate, domain lesson |

## UX Recommendations

### What To Build Now

1. Replace the oversized greeting-led first viewport with a workspace/workflow
   gateway focused on active work and the proof chain.
2. Add a compact context bar: actor, workspace, project/domain, role, visibility,
   sensitivity, and next action.
3. Make the first screen show the chain from intent to sign-off as real product
   state, not explanatory marketing copy.
4. Provide workspace switching for `MB-P`, `Xlooop`, `xcp-platform`, and
   `Client / invited`.
5. In Storybook, add a P0 golden-path story that proves the first 30 seconds:
   intent triage, work item, evidence, sign-off, and learning.

### What To Defer

| Area | Defer Until |
|---|---|
| Mobile redesign | web-first workflow is validated |
| x-front editor/runtime absorption | Ilmir's current scope stabilizes and contract proof exists |
| Real bi-sync runtime | synthetic Storybook/state-matrix proof passes |
| Configurable workflow builder | core product spine is proven |
| xcp-platform infrastructure admin | remains in xcp-platform dashboard, not Xlooop-XCP-demo |

### What To Avoid

| Avoid | Reason |
|---|---|
| Direct x-front imports | hidden dependency and stale scope risk |
| Enterprise-only workflow | alienates individuals, small teams, and real MB-P proving use |
| Capability-first UX | users do not buy modules; they buy governed progress |
| Graph-first UX | too abstract; graph should explain and verify, not dominate |
| Mixing XCP admin dashboard into product | violates platform/consumer separation |
| Storybook theatre without product state | visual maturity must prove workflow and contract readiness |

## Cross-Frontend Compatibility Decision

The goal is leverage, not merger.

All three frontend families are React/Vite/Storybook-compatible, but they sit at
different maturity layers:

| Surface | Role |
|---|---|
| Xlooop-XCP-demo | governed delivery/product shell |
| x-front | heavier engine/editor/product implementation with valuable patterns |
| xcp-platform | reusable substrate/control-plane/platform family |

Inter-adoption should happen through contract layers:

| Compatibility Surface | Required Contract |
|---|---|
| Design tokens | token names, theme semantics, density, typography, color roles |
| UI primitives | props/events/state, accessibility, maturity, visual baselines |
| Widgets | public API, dependencies, fixtures, story states, permissions |
| Event bus | typed envelope, source, actor, target, version, failure behavior |
| Evidence | source refs, validity, sensitivity, verification targets |
| Permissions | actor, role, grant time, expiry, scope, revocation |
| Storybook | state matrix, DoD score, fixtures, visual/a11y/interaction gates |
| Graph | typed nodes, edges, lifecycle, evidence, sign-off, agent runs |
| Data access | DAL/API contract, mocks, versioning, migration policy |

Current gaps:

| Gap | Severity | Recommendation |
|---|---:|---|
| No single cross-frontend compatibility matrix | 80 | Add C29-FE-COMPAT-01 before runtime absorption |
| Storybook maturity levels differ by repo | 75 | Standardize state matrix and DoD scoring first |
| Event/evidence/permission fields are not yet portable | 75 | Use graph and permission contracts as the portable layer |
| x-front is engine-heavy and scope is still moving | 85 | Keep investigation-only until owner/Ilmir handoff stabilizes |
| xcp-platform substrate is separate from product shell | 70 | Surface substrate status, do not embed admin operations |
| First viewport does not prove product thesis strongly enough | 90 | Build Storybook P0 golden-path proof next |

## Hidden Risks

| Risk | Score | Why It Matters | Mitigation |
|---|---:|---|---|
| False simplicity | 85 | A clean shell can hide weak intent/evidence/sign-off mechanics | P0 story must show actual workflow state |
| Workflow over-formalization | 70 | Small users will reject enterprise ceremony | Use lighter templates, same contract substrate |
| x-front over-absorption | 85 | Pulls in moving engine complexity before contracts are stable | Absorb patterns, not runtime code |
| Contract drift | 80 | Demo, x-front, and xcp-platform can diverge silently | Cross-frontend matrix + Storybook DoD gates |
| Permission leakage | 90 | MB-P private, client, contractor, and platform contexts differ | Actor/role/sensitivity/expiry must be visible in context bar |
| XCP admin/product blending | 75 | Confuses buyer/user workflow with infrastructure operations | Treat xcp-platform as workspace/domain visibility only |
| Graph context cost | 65 | Full graph can become too heavy for everyday UX and agents | Use shards/context packs, not full graph in UI |

## Required Next Sequence

1. **C29-FE-COMPAT-01:** create a cross-frontend compatibility matrix for
   Xlooop-XCP-demo, x-front, and xcp-platform.
2. **C29-STORY-P0-CHAIN-01:** add Storybook proof for the first-30-second chain:
   workspace -> intent -> triage -> work item -> evidence -> sign-off -> learning.
3. **C29-WEB-GATEWAY-01:** implement the web-first workspace/workflow gateway in
   the current root app.
4. **C29-BISYNC-03:** only after the above, prove bi-sync as synthetic
   Storybook/state-matrix states. No runtime engine import.
5. **C29-XFRONT-ABSORB-OWNER-01:** narrow owner/Ilmir-reviewed absorption backlog
   after x-front current-head stabilizes.

## Stop Conditions

- Stop if implementation requires importing x-front runtime/editor/iframe code.
- Stop if the product shell starts exposing xcp-platform infrastructure
  administration as user workflow.
- Stop if a workspace lacks actor, role, visibility, and sensitivity context.
- Stop if Storybook stories cannot show evidence/sign-off state.
- Stop if a workflow module cannot declare public API, events, state, and
  dependency boundaries.

## Final Recommendation

Proceed, but the next implementation must be a web-first product workflow proof,
not another isolated transfer review.

The useful x-front patterns are real, but the product should not become x-front.
Xlooop-XCP-demo should become the governed delivery workspace that can reuse
x-front and xcp-platform capabilities through contracts, Storybook proof, and
graph-backed traceability.
