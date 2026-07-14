---
id: c29_fe_compat_01_cross_frontend_compatibility
title: C29-FE-COMPAT-01 Cross-Frontend Compatibility Matrix
created_at: "2026-05-09T11:59:00+10:00"
date_key: "260509_1159"
timezone: Australia/Melbourne
owner: Marat Basyrov
status: active_decision
lifecycle_state: sterile_active
graph_required: true
scope: docs_contracts_only
runtime_change_authorized: false
xfront_import_authorized: false
xfront_mutation_authorized: false
xcp_platform_mutation_authorized: false
archive_delete_move_authorized: false
source_files:
  - CURRENT_STATE.md
  - src/shared/storybook/docs/Cross-feed.mdx
  - docs/_archive/audits/storybook-xfront-reuse-assessment.md
  - docs/contracts/260509_1150_product-workflow-architecture-c29-workflow-01.md
  - docs/contracts/260509_1109_storybook-dod-state-matrix-c29-story-01.md
  - /Users/maratbasyrov/WIP/Xlooop/x-front/package.json
  - /Users/maratbasyrov/WIP/Xlooop/x-front/.storybook/main.ts
  - /Users/maratbasyrov/WIP/Xlooop/x-front/.storybook/preview.tsx
  - /Users/maratbasyrov/WIP/xcp-platform/package.json
  - /Users/maratbasyrov/WIP/xcp-platform/docs/adrs/ADR-XCP-006-control-plane-rebuild-storybook-tiers.md
  - /Users/maratbasyrov/WIP/xcp-platform/packages/xcp-design-system/apps/storybook/.storybook/main.ts
  - /Users/maratbasyrov/WIP/xcp-platform/packages/xcp-design-system/docs/integration/XLOOP_INTEGRATION.md
---

# C29-FE-COMPAT-01 Cross-Frontend Compatibility Matrix

## Executive Verdict

The three frontend families are compatible enough for high-leverage reuse, but
not compatible enough for direct merging.

| Frontend | Product Role | Compatibility Verdict |
|---|---|---|
| Xlooop-XCP-demo | governed delivery workspace and current commercial product shell | canonical consumer/product UX |
| x-front | Ilmir-active engine/editor implementation and richer Storybook corpus | pattern/reference source only until scoped absorption |
| xcp-platform | XCP producer substrate, design system, control-plane/admin frontend | contract/source-of-platform-capability, not user-workflow UI |

The safe strategy is:

**shared contracts, shared standards, compatible Storybook/state matrices, and
adapter seams; no source blending.**

C29-FE-COMPAT-01 is the missing bridge between the earlier x-front absorption
slices and the next product implementation work. It answers what is portable,
what is not portable, and what must be proven before any runtime transfer.

## Role And Skill Panel

| Role | Applied Lens |
|---|---|
| Chief-of-Staff | dependency ordering and no-overlap execution |
| CTO | source ownership, platform/consumer boundary, architecture risk |
| UX | workflow continuity and non-fragmented user experience |
| Product Manager | personal/small/business/enterprise/customer fit |
| Knowledge Architect | contract, graph, Storybook, evidence discoverability |
| AI Governed Infrastructure Manager | xcp-platform substrate/control-plane separation |
| DevSecOps | permission, visibility, sensitivity, client-safe surfaces |
| Lead Engineer | implementation sequencing, tests, contracts, migration safety |

Skills/procedures used: `product-engineering-router`, `xlooop-design-review`,
`frontend-architecture-review`, `integration-boundary-contracts`,
`component-contract-storybook`, `delivery-readiness-gates`, and existing
artefact discovery.

## Evidence Snapshot

| Metric | Xlooop-XCP-demo | x-front | xcp-platform |
|---|---:|---:|---:|
| React | 18.3.1 | 18.3.1 | 18.0/18.2 family |
| Vite | 6.2.0 | 6.2.1 | 5.x/6.x by app/package |
| Storybook | 8.6.12 | 8.6.12 | xcp-design-system Storybook 8 family |
| Current stories observed | 35 under `src/` | 107 under `src/` | design-system storybook pages/foundations/features |
| Current contract files observed | 17 `contract.json` plus TS contracts | graph/service contracts, no demo-compatible `contract.json` convention | event contracts, adapter docs, design-system primitives |
| Product posture | delivery shell | editor/engine app | platform producer/control plane |

The stack alignment is real. The product-boundary mismatch is also real.

## Compatibility Matrix

Scores are `0-100`: `>=85` directly compatible, `70-84` compatible with
adapter/check, `50-69` reference-only or needs design, `<50` not portable.

| Surface | Demo | x-front | xcp-platform | Score | Decision | Required Gate |
|---|---|---|---|---:|---|---|
| React runtime | React 18.3.1 | React 18.3.1 | React 18.0/18.2 | 88 | compatible | prevent duplicate React identity in bundles |
| Vite build family | Vite 6.2 | Vite 6.2 | Vite 5/6 mixed | 78 | adapter/check | per-app build commands; no config copy-paste |
| Storybook version | 8.6.12 | 8.6.12 | Storybook 8 | 88 | compatible | shared maturity taxonomy, repo-local configs |
| Storybook story strategy | narrow curated current product stories | broad app-wide corpus | tiered design-system/control-plane stories | 62 | reference/adapt | C29-STORY-P0-CHAIN-01 and DoD scorecard |
| Storybook providers | minimal stubs + bundle injection | global providers, MSW, theme, error boundary | design-system taxonomy, tiering, pages | 58 | reference/adapt | no provider strategy copy; define per-story portability rules |
| Design tokens | root CSS vars and story decorator | theme tokens and document-level attrs | design-system tokens/foundations | 72 | adapter/check | token semantic mapping, no palette merge |
| UI primitives | small current uiKit with contracts/tests | large MUI/custom uiKit corpus | public/private design-system tiers | 65 | selective rebuild | wrapper contract + Storybook state matrix |
| Widget contracts | demo `contract.json` per mode/widget | richer stories, fewer compatible contract files | adapter/state surface docs | 68 | reference/adapt | public API/events/state/deps matrix |
| Event bus | demo topic registry/event bus | x-front event engine topics | `@xcp/event-contracts` | 72 | namespace/adapt | `xcp:*` + `xfront:*` namespaces and parity validator |
| Evidence/lineage | evidence port, sign-off, client review | editor/activity/log inspiration | evidence-store port and HTTP surface | 82 | compatible with adapter | evidence source refs + validity + sensitivity |
| Permissions | actor/session/reducer gates, signed URLs | role/settings/member surfaces | visibility tags/control-plane policy concepts | 76 | adapter/check | grant time, expiry, scope, revocation contract |
| Graph contracts | product-domain graph contract target | minimal BaseNode/Edge/GraphLayer | graph/control-plane/export models | 70 | map/adapt | typed node/edge contract with product fields |
| Data access | fixture + local runtime ports | app stores/services/editor state | DAL/adapter/event packages | 74 | adapter/check | no shared store; consume through ports/adapters |
| Bi-sync/code UI | contract skeleton only | codeCompiler/editor/iFrame engines | not product UI, substrate adjacent | 45 | not portable now | synthetic Storybook proof before runtime |
| XCP admin/control plane | substrate mode only | not source of admin UI | owns admin/operator dashboard | 35 | do not blend | product may show domain status, not admin operations |
| Client/invited workflow | signed URL/client review | role/member concepts | visibility/security policy concepts | 78 | adapter/check | client-safe projection and approval trace |

## Portable Contracts

These are the only safe long-term compatibility surfaces:

| Contract Surface | Canonical Direction | Rule |
|---|---|---|
| Product workflow | Demo owns visible user workflow | x-front and xcp-platform feed patterns, not routes |
| Storybook maturity | Demo adopts shared DoD/state matrix | no broad x-front story glob |
| Event contracts | xcp-platform owns generic event package; demo maps product topics | no flat topic union |
| Evidence store | xcp-platform owns reusable port; demo maps local/product evidence | no raw DB coupling |
| Permission model | demo product contract must include actor, role, scope, grant time, expiry | GitHub access remains external authority |
| Graph node/edge contract | demo defines product MVP nodes; x-front minimal base informs language | do not copy minimal graph file as product contract |
| UI primitives | rebuild or wrap into demo uiKit contracts | no direct MUI/runtime import |
| Design tokens | semantic token mapping | no theme/provider wholesale merge |
| Bi-sync | typed port/sandbox contract first | no Monaco/iframe/codeCompiler runtime import |

## Non-Portable Surfaces

| Surface | Why Not Portable | Decision |
|---|---|---|
| x-front Storybook global provider chain | too app-specific; Redux/MSW/theme/error-boundary strategy does not fit current demo portability model | reference only |
| x-front editor/compiler/iFrame runtime | high coupling, Ilmir-active scope, security/performance risk | defer |
| x-front MUI-heavy UI | would introduce design-system drift and dependency weight | reject as direct import |
| xcp-platform control-plane/admin UI | different audience: AI infrastructure manager/admin, not cross-org product user | separate product/domain visibility only |
| xcp-platform design-research HTML artefacts | useful inspiration, not canonical runtime contract | near-zero-risk reference once indexed |
| app-level Vite/Storybook config copying | each app has different build/runtime assumptions | compare settings, do not copy |

## Required Standard Contract For Inter-Adoption

Any component, widget, workflow module, or platform capability proposed for
cross-frontend reuse must declare:

| Field | Required |
|---|---|
| `source_frontend` | `xlooop-xcp-demo`, `x-front`, or `xcp-platform` |
| `target_frontend` | target repo/surface |
| `product_role` | user workflow, engine/editor, substrate, admin/control-plane, design-system |
| `public_api` | props, methods, slots, config |
| `events` | emitted/consumed topics with namespace |
| `state` | owned state, input state, output state |
| `permissions` | actor kinds, role/scope, grant time, expiry, revocation |
| `evidence` | tests, Storybook states, screenshots/logs, source refs |
| `data_boundary` | fixture, port, DAL, adapter, HTTP |
| `runtime_dependencies` | React, browser APIs, external packages, global providers |
| `storybook_maturity` | level 0-5 per C29-STORY-01 |
| `compatibility_score` | 0-100 |
| `decision` | direct, adapt, rebuild, reference, defer, reject |
| `stop_conditions` | conditions that block transfer |

## Implementation Recommendations

### Build Now

| Item | Reason | Output |
|---|---|---|
| C29-STORY-P0-CHAIN-01 | proves first-30-second workflow before more transfer work | Storybook golden-path proof |
| Storybook DoD scorecard | makes maturity comparable across current product surfaces | generated report/check |
| Cross-frontend contract template | prevents future vague transfer proposals | reusable YAML/schema rows |
| Event namespace decision | prevents flat topic chaos | `xcp:*`, `xlooop:*`, `xfront:*` mapping |
| Permission grant/expiry field adoption | needed for collaborators, clients, agents | product contract fields |

### Defer

| Item | Defer Until |
|---|---|
| x-front codeCompiler/editor/iFrame runtime | C29-BISYNC-03 synthetic Storybook proof passes and Ilmir scope stabilizes |
| xcp-platform control-plane UI consumption | Xlooop product needs an admin/operator embedded view and boundary is approved |
| full design-system package extraction | product workflow proof and Storybook DoD scorecard pass |
| mobile compatibility | web-first workflow is validated |

### Avoid

| Item | Reason |
|---|---|
| direct x-front source import | hidden coupling and moving target |
| direct xcp-platform admin dashboard embed | product/platform boundary violation |
| cross-repo shared store | destroys bounded contexts |
| broad Storybook globs across repos | turns Storybook into landfill |
| one visual theme merge | masks product-role differences |

## Hidden Risks

| Risk | Score | Mitigation |
|---|---:|---|
| Matching package versions create false confidence | 85 | require product-role and contract compatibility, not package alignment alone |
| Storybook richness from x-front imports architecture debt | 80 | use state matrices and DoD, not sources/providers |
| xcp-platform control plane leaks into user workflow | 75 | show platform as workspace/domain status only |
| Permission semantics diverge between GitHub, x-front, demo, and XCP | 90 | actor/role/grant/expiry/revocation contract before sharing |
| Event topic drift | 80 | namespaced event registry and parity check |
| Duplicate component libraries | 75 | every candidate must be already absorbed / rebuild / reject / defer |
| Cross-repo docs go stale | 70 | require current-head evidence and date_key on compatibility decisions |

## Go / No-Go

| Action | Decision |
|---|---|
| Use x-front as current-head reference evidence | GO |
| Use xcp-platform as producer contract reference | GO |
| Define shared compatibility contract and scoring | GO |
| Import x-front Storybook/component/runtime source | NO-GO |
| Embed xcp-platform admin/control-plane in demo product shell | NO-GO |
| Start C29-STORY-P0-CHAIN-01 after this lands | GO |

## Next Slice

Proceed to **C29-STORY-P0-CHAIN-01**:

- add or update Storybook proof for the first-30-second product chain;
- show `MB-P`, `Xlooop`, `xcp-platform`, and `Client / invited` workspaces;
- make actor/role/visibility/sensitivity visible;
- prove intent -> triage -> work item -> evidence -> sign-off -> learning;
- keep xcp-platform as substrate/domain status, not admin UI;
- do not import x-front code.
