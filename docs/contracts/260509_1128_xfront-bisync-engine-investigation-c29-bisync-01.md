# C29-BISYNC-01 · x-front Code/UI Bi-Sync Engine Investigation

**Created:** 2026-05-09T11:28:00+10:00  
**Date key:** 260509_1128  
**Owner:** Marat Basyrov  
**Scope:** investigation and contract design only  
**Source x-front HEAD:** `401e6d40a0befc683a7a410f1ed0aee0afd6f492`  
**Demo base HEAD:** `7c541cf25c0ea278286552a26aa39688c8ba16e0`  
**Decision:** learn from the engine pattern; do not import engine code; do not mutate x-front.

## Executive Verdict

**NO-GO for absorption. GO for contract extraction and future adapter design.**

x-front has a valuable bidirectional code/UI engine, but it is not a drop-in
feature for Xlooop-XCP-demo. The surface is large, coupled, and security
sensitive:

| Area | Current x-front files inspected | Test files found | Absorption risk |
|---|---:|---:|---:|
| `codeCompiler` | 279 | 15 | 95 |
| `codebase` | 150 | 19 | 85 |
| `editorEngine` | 100 | 1 | 90 |
| `iFrameEngine` | 61 | 3 | 85 |
| **Total** | **590** | **38** | **high** |

The current root Xlooop-XCP-demo has **0 current source files** named
`codeCompiler`, `codebase`, `editorEngine`, or `iFrameEngine`. That is good:
the demo is not accidentally coupled to x-front's runtime. It also means any
future bi-sync capability must be introduced through explicit contracts,
fixtures, gates, and adapter seams.

## Role Panel

| Role | Lens applied |
|---|---|
| Chief-of-Staff | sequencing and no-go boundaries |
| CTO | product/platform architecture fit |
| Lead Engineer | coupling, tests, implementation risk |
| Frontend Architect | FSD, app/runtime separation |
| Integration Boundary Architect | EventBus, iframe, source, compiler contracts |
| DevSecOps Lead | sandbox, postMessage, permissions, unsafe execution |
| AI Governed Infrastructure Manager | graph/contract/XCP platform promotion path |
| Product Manager | commercial fit and user-visible value |

## Evidence Base

| Evidence | Finding |
|---|---|
| x-front `src/shared/services/codeCompiler/README.md` | compiler is a formal AST/codegen/store-patch orchestration surface, not a UI helper |
| x-front `src/shared/services/codebase/README.md` | codebase manages source adapters, GitHub/StackBlitz snapshots, lifecycle, draft commits, editor attach |
| x-front `src/shared/services/editorEngine/core/contracts.ts` | editor engine depends on compiler, store adapter, repository, resolver/mutation/binding services |
| x-front `src/shared/services/iFrameEngine/bridge/IFrameBridgeService.ts` | host/sandbox postMessage boundary uses wildcard targetOrigin with source filtering rationale |
| x-front `src/shared/services/iFrameEngine/sync/README.md` | iframe sync is a transport for render tree and patch payloads, not a tree builder |
| x-front `docs/frontend-audit/19-pilot-sdk-packaging.md` | iFrameEngine is Lane B; editorEngine/codeCompiler are Lane C/R2 gated |
| x-front `docs/frontend-audit/21-bundle-size-investigation.md` | Monaco/codeCompiler/codebase are heavy R2-feature chunks and should be lazy/optional |
| x-front `qa/IFRAME_FOCUS_MEASUREMENT_SPEC.md` | focus/selection/hover ordering has known race/priority complexity |
| demo `src/` scan | no current engine runtime with these names exists in root project |

## What Should Transfer

| Pattern | Transfer decision | Why |
|---|---|---|
| Text lane vs patch lane distinction | transfer as contract vocabulary | maps well to intent/work-item/evidence changes vs UI/code deltas |
| Source adapter model | transfer as future interface | needed for GitHub, local file, generated bundle, and customer repo ingestion |
| Render tree and render patch vocabulary | transfer as contract candidate | useful for future governed preview/proof UI |
| Host-to-sandbox bridge lifecycle | transfer as risk model and test matrix | iframe/sandbox will matter for live previews, but must be permissioned |
| Editor read/write/focus facades | transfer as design pattern | good separation; current implementation is too x-front-specific |
| Cold-start/lifecycle status model | transfer as operational pattern | useful for project bootstrap/proof workflows |
| Storybook/QA evidence around bidirectional editing | transfer as DoD expectation | future implementation must include state matrix and interaction tests |

## What Must Not Transfer Yet

| Surface | Decision | Reason |
|---|---|---|
| Direct `codeCompiler` import/copy | no-go | high coupling, Ilmir-owned active engine, R2/AST dependency |
| Direct `editorEngine` import/copy | no-go | depends on compiler/store/repository internals and legacy facades |
| Direct `iFrameEngine` import/copy | no-go | sandbox/postMessage/security and render-tree coupling |
| Direct `codebase` import/copy | no-go | source/StackBlitz/GitHub/editor lifecycle is product-specific and heavy |
| Monaco/editor runtime absorption | no-go | bundle/performance and R2-gated lazy loading concerns |
| Using x-front docs as current demo architecture | no-go | useful evidence only; demo must own its contracts |

## Candidate Product Contracts

Future Xlooop-XCP-demo should introduce contract-first surfaces before runtime:

| Contract | Purpose | Required before implementation |
|---|---|---|
| `SourceSnapshotContract` | immutable source bundle/file snapshot with provenance | checksum, source type, visibility, sensitivity |
| `SourceAdapterContract` | GitHub/local/generated/customer source ingestion seam | permission policy, fetch errors, stale handling |
| `CodeDraftContract` | editable draft state and commit metadata | author, timestamp, source snapshot ref |
| `CodePatchContract` | structured patch from UI/code lane | op, path, node/ref, actor, evidence |
| `RenderTreeContract` | preview-safe tree projected from source/domain state | no executable functions, sensitivity filtering |
| `PreviewSandboxMessageContract` | host/sandbox messages | typed payloads, request id, origin/source policy |
| `EditorSessionContract` | editor attach/detach/open file lifecycle | status, active file, failure reason |
| `BiSyncEvidenceContract` | proof of code/UI round-trip | before/after source, visual proof, test run, sign-off |

## Architecture Recommendation

Do not make bi-sync a default product dependency. Treat it as an optional
capability lane:

```text
src/contracts/bisync/
  source-snapshot.contract.ts
  source-adapter.contract.ts
  code-draft.contract.ts
  code-patch.contract.ts
  render-tree.contract.ts
  preview-sandbox-message.contract.ts
  editor-session.contract.ts
  bisync-evidence.contract.ts

src/features/bisync-readiness/
  contract validation only at first
```

Runtime implementation should wait until contracts and fixtures exist. The
first implementation candidate should be a mocked local fixture, not x-front
engine code.

## Risk Register

| Risk | Score | Evidence | De-risking action |
|---|---:|---|---|
| R2/Ilmir engine drift | 95 | x-front audit classifies codeCompiler/editorEngine as gated/high risk | require current-head refresh and owner/Ilmir sign-off before implementation |
| Security sandbox leakage | 90 | iframe bridge uses postMessage and sandbox messaging | define message contract, origin policy, payload sanitizer, no raw secrets |
| Bundle/performance regression | 80 | x-front bundle audit shows Monaco/codeCompiler/codebase chunk pressure | keep bi-sync optional/lazy; set separate budget |
| Contract mismatch with demo graph | 75 | demo has graph/product contracts but no bi-sync runtime | contract-first bridge with typed evidence edges |
| UX complexity | 70 | x-front is editor-heavy; demo is governed delivery workspace | expose only user-relevant proof chain, not raw engine controls |
| Test insufficiency on editorEngine/iFrameEngine | 70 | only 1 editorEngine and 3 iFrameEngine test files found in scanned surface | require fixture/state matrix before porting |

## Required Gates Before Any Future Implementation

1. Current x-front HEAD is rechecked and Ilmir scope is not in conflict.
2. Bi-sync contract files and fixture examples are reviewed.
3. No private MB-P data or customer source can enter preview/sandbox fixtures.
4. postMessage/origin/source filtering policy is explicit.
5. Bundle budget separates product shell from optional editor/preview lane.
6. Contract tests cover source snapshot, patch, render tree, sandbox message,
   editor session, and evidence contract.
7. Storybook state matrix shows idle, loading, changed, synced, conflict,
   failed, and signed-off states.
8. First runtime proof uses mocked fixtures only.

## Go / No-Go

| Action | Decision |
|---|---|
| Learn from x-front code/UI bi-sync architecture | GO |
| Create future bi-sync contract skeleton | GO after owner review |
| Import x-front engine code now | NO-GO |
| Mutate x-front | NO-GO |
| Add runtime code in this slice | NO-GO |
| Treat bi-sync as current product default | NO-GO |
| Treat bi-sync as optional commercial capability lane | GO |

## Recommended Next Slice

Proceed to **C29-BISYNC-02** as a contract-skeleton-only slice:

- create `src/contracts/bisync/` TypeScript contract skeletons;
- add schema/fixture tests only;
- add no runtime code;
- do not import or mutate x-front;
- keep all sample data synthetic.

After that, return to the higher-value product plan: web-first workflow
gateway UX proof (`Client intent -> governed triage -> work item ->
build/evidence -> sign-off -> learning/XCP substrate`).
