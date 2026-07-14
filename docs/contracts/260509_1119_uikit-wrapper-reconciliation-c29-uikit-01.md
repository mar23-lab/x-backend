# C29-UIKIT-01 · uiKit Wrapper Reconciliation

**Created:** 2026-05-09T11:19:00+10:00  
**Date key:** 260509_1119  
**Owner:** Marat Basyrov  
**Scope:** wrapper/status reconciliation only  
**Source x-front HEAD:** `401e6d40a0befc683a7a410f1ed0aee0afd6f492`  
**Decision:** classify current root wrappers; do not import x-front code; do not mutate x-front; do not archive/delete/move.

## Role And Skill Panel

| Role lens | Applied to |
|---|---|
| Chief-of-Staff | sequence control and stale-decision closure |
| CTO | root-current architecture and no direct x-front dependency |
| UX | evidence/media preview usefulness in the web product |
| Product Manager | commercial demo relevance and customer-safe evidence surfaces |
| Knowledge Architect | source lineage and supersession status |
| AI Governed Infrastructure Manager | current-state cleanliness and generated schema visibility |
| DevSecOps | client-safety, a11y, no private-data leakage, no stale runtime policy |
| Lead Engineer | file-level wrapper completeness, tests, Storybook, future implementation risk |

Skills invoked: `component-contract-storybook`, `product-engineering-router`, existing artifact discovery.

## Executive Verdict

**The three Phase 10D wrapper candidates have already been materially absorbed into the current root project.**

The old P10C/P10D decision chain was correct at the time, but it still speaks in obsolete `v2/src/ui/` terms. Current reality is different:

- `Avatar` exists as a root uiKit primitive.
- `XEvidenceImage` exists as a Xlooop-owned evidence wrapper.
- `XEvidencePreview` exists as a Xlooop-owned evidence wrapper.
- All three have Storybook stories, `contract.json`, type-only tests, and root-current schema visibility.

Therefore the active disposition is **already absorbed / keep / improve**, not "future adoption." The x-front sources remain reference evidence only.

## Source Evidence

| Surface | Current root files | x-front evidence | Status |
|---|---|---|---|
| `Avatar` | `src/shared/uiKit/Avatar/{Avatar.jsx,Avatar.stories.tsx,Avatar.test.tsx,contract.json,index.jsx,index.ts}` | `x-front/src/shared/uiKit/Avatar/*` | already_absorbed_keep_improve |
| `XEvidenceImage` | `src/shared/uiKit/XEvidenceImage/{XEvidenceImage.jsx,XEvidenceImage.stories.tsx,XEvidenceImage.test.tsx,contract.json,index.jsx,index.ts}` | `x-front/src/shared/uiKit/Image/*` | already_absorbed_keep_improve |
| `XEvidencePreview` | `src/shared/uiKit/XEvidencePreview/{XEvidencePreview.jsx,XEvidencePreview.stories.tsx,XEvidencePreview.test.tsx,contract.json,index.jsx,index.ts}` | `x-front/src/shared/uiKit/Preview/*` | already_absorbed_keep_improve |

## Candidate Classification

| Candidate | Old recommendation | Current root state | Classification | Rationale | Next action |
|---|---|---|---|---|---|
| `Avatar` | future `XAvatar` / adopt after minor remediation | root `Avatar` primitive exists, 6-file unit exists, contract maturity `production` | already_absorbed_keep_improve | Current product already uses `Avatar`; x-front no longer needed as implementation source | add a11y role/aria implementation later if owner approves runtime polish |
| `XEvidenceImage` | future wrapper around x-front `Image` | root wrapper exists, status model exists, alt is contract-required, states covered | already_absorbed_keep_improve | Current wrapper is Xlooop-owned and independent; direct x-front import would add risk | improve test depth and Storybook interaction/a11y proof later |
| `XEvidencePreview` | future wrapper around x-front `Preview` | root wrapper exists, type/status model exists, title required, states covered | already_absorbed_keep_improve | Current wrapper is Xlooop-owned and independent; direct x-front import not required | improve type/status matrix and interaction/a11y proof later |

## Old Policy Supersession Note

`docs/contracts/ui-library-policy.json` remains useful historical evidence, but its implementation-location fields are now obsolete because they point to `v2/src/ui/`. The active path is root-current:

```text
src/shared/uiKit/Avatar/
src/shared/uiKit/XEvidenceImage/
src/shared/uiKit/XEvidencePreview/
```

Do not use the old policy as authorization to recreate `v2/` or to import x-front components.

## Quality Snapshot

| Metric | Avatar | XEvidenceImage | XEvidencePreview |
|---|---:|---:|---:|
| Runtime file | yes | yes | yes |
| Storybook story | yes | yes | yes |
| `contract.json` | yes | yes | yes |
| Type-only test | yes | yes | yes |
| Barrel files | yes | yes | yes |
| Direct x-front import | no | no | no |
| Current maturity | production | app_integrated | app_integrated |
| Improvement risk | low | low-medium | low-medium |

## Improvement Backlog

| ID | Surface | Recommendation | Priority | Risk | DoD |
|---|---|---|---:|---:|---|
| UIKIT-A11Y-01 | `Avatar` | align implementation with contract a11y note: emit semantic role/aria where identity is conveyed | P2 | 20 | Storybook and type/runtime check show accessible label path |
| UIKIT-SB-01 | `XEvidenceImage` | add Level-4 Storybook proof: play/a11y/client-safety note for loaded/loading/error/empty | P2 | 25 | state matrix and no private-data fixture proof |
| UIKIT-SB-02 | `XEvidencePreview` | add Level-4 Storybook proof for type/status matrix | P2 | 25 | image/pdf/video/doc/unsupported × status coverage documented or generated |
| UIKIT-POLICY-01 | policy docs | update or supersede `ui-library-policy.json` v2 path references in a later policy cleanup slice | P2 | 15 | no active doc claims wrappers live under `v2/src/ui/` |

## Stop Conditions

- Stop if any proposal imports x-front uiKit source directly.
- Stop if any proposal recreates a `v2/src/ui/` implementation path.
- Stop if client-visible fixtures contain MB-P private/internal data.
- Stop if old P10C policy is treated as current implementation authority without C29 supersession.
- Stop if wrapper improvements happen without Storybook contract and test updates.

## Go / No-Go

| Action | Decision |
|---|---|
| Keep current root `Avatar` | GO |
| Keep current root `XEvidenceImage` | GO |
| Keep current root `XEvidencePreview` | GO |
| Import x-front `Avatar`, `Image`, or `Preview` | NO-GO |
| Delete old x-front evidence docs now | NO-GO |
| Runtime polish for wrappers | GO later, after explicit implementation slice |

## Next Step

Proceed to **C29-BISYNC-01** as an investigation-only slice:

- inspect x-front `codeCompiler`, `codebase`, `editorEngine`, and `iFrameEngine` service boundaries;
- identify event/adapter/source-map/performance/security risks;
- do not import engine code or mutate x-front.
