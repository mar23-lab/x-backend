# C29-BISYNC-02 · Bi-Sync Contract Skeleton

**Created:** 2026-05-09T11:37:00+10:00  
**Date key:** 260509_1137  
**Owner:** Marat Basyrov  
**Scope:** contract skeleton only  
**Decision:** add synthetic TypeScript contracts and compile-time fixtures; no runtime implementation.

## Executive Verdict

**Implemented the safe next step.** The bi-sync lane now has a root-owned
contract skeleton in Xlooop-XCP-demo without importing x-front code or creating
runtime coupling.

This converts the C29-BISYNC-01 finding into a governed product seam:

`source snapshot -> source adapter -> draft -> patch -> render tree -> sandbox message -> editor session -> evidence/sign-off`

## Added Contract Surface

| Contract | Path | Purpose |
|---|---|---|
| `SourceSnapshotContract` | `src/contracts/bisync/source-snapshot.contract.ts` | immutable source bundle/file snapshot with provenance |
| `SourceAdapterContract` | `src/contracts/bisync/source-adapter.contract.ts` | permissioned source ingestion/access seam |
| `CodeDraftContract` | `src/contracts/bisync/code-draft.contract.ts` | editable draft state and checksum lineage |
| `CodePatchContract` | `src/contracts/bisync/code-patch.contract.ts` | structured code/UI patch event |
| `RenderTreeContract` | `src/contracts/bisync/render-tree.contract.ts` | preview-safe render tree; executable payloads forbidden |
| `PreviewSandboxMessageContract` | `src/contracts/bisync/preview-sandbox-message.contract.ts` | typed host/sandbox message boundary and origin policy |
| `EditorSessionContract` | `src/contracts/bisync/editor-session.contract.ts` | editor attach/detach/open-file lifecycle |
| `BiSyncEvidenceContract` | `src/contracts/bisync/bisync-evidence.contract.ts` | round-trip proof, test refs, visual evidence, sign-off |

## Safety Boundaries

| Boundary | Status |
|---|---|
| x-front source import | blocked |
| x-front file mutation | blocked |
| runtime/editor implementation | blocked |
| synthetic fixtures | allowed |
| compile-time contract tests | allowed |
| future mocked UI proof | requires owner review |

## Quality Gates

The skeleton is pinned by `src/__contracts__/bisync.contract.test.ts`.

The test verifies:

- boundary fields exist on source snapshots;
- permissions carry grant and expiry times;
- drafts link to snapshots;
- patches link evidence;
- render trees explicitly forbid executable payloads;
- sandbox messages carry an origin policy;
- editor sessions have a failure path;
- evidence supports sign-off fields.

## Remaining Risks

| Risk | Score | Status |
|---|---:|---|
| Runtime overreach before contracts mature | 80 | controlled by no-runtime decision |
| Security policy still too abstract | 70 | needs future DevSecOps review before sandbox work |
| UX proof not visible yet | 60 | future mocked Storybook/workflow slice required |
| x-front engine drift | 85 | still requires current-head refresh before any implementation |

## Recommended Next Slice

Proceed to **C29-BISYNC-03** only if owner approves:

- create Storybook/state-matrix proof for the synthetic bi-sync lifecycle;
- use mocked data only;
- show user-visible states: idle, loading, changed, synced, conflict, failed,
  signed-off;
- no Monaco, no iframe runtime, no x-front import.

Otherwise, resume the higher-value web-first workflow gateway UX path.
