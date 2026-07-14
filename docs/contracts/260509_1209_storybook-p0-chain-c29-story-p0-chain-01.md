---
id: c29_story_p0_chain_01
title: C29-STORY-P0-CHAIN-01 Storybook First 30 Seconds Proof
created_at: "2026-05-09T12:09:00+10:00"
date_key: "260509_1209"
timezone: Australia/Melbourne
owner: Marat Basyrov
status: implemented_storybook_proof
lifecycle_state: sterile_active
graph_required: true
scope: storybook_proof
runtime_change_authorized: false
xfront_import_authorized: false
xfront_mutation_authorized: false
xcp_platform_mutation_authorized: false
archive_delete_move_authorized: false
source_files:
  - docs/contracts/260509_1150_product-workflow-architecture-c29-workflow-01.md
  - docs/contracts/260509_1159_cross-frontend-compatibility-c29-fe-compat-01.md
  - src/shared/storybook/golden-path/fixtures/goldenPath.fixture.ts
  - src/shared/storybook/golden-path/flows/First30SecondsProof.stories.tsx
  - scripts/p10d-sb5-storybook-gate.mjs
---

# C29-STORY-P0-CHAIN-01 Storybook First 30 Seconds Proof

## Executive Verdict

Implemented a Storybook proof for the first product viewport.

The story makes the product thesis visible without importing x-front code:

`workspace -> project/domain -> intent -> governed triage -> work item -> build/evidence -> sign-off -> learning/XCP substrate`

This closes the gap identified in C29-WORKFLOW-01 and C29-FE-COMPAT-01:
the product can now show `MB-P`, `Xlooop`, `xcp-platform`, and
`Client / invited` workspaces in one governed entry surface while preserving
the boundary that xcp-platform is represented here as substrate/domain status,
while its full AI governance infrastructure admin UI remains a separate
xcp-platform surface.

## Role And Skill Panel

| Role | Lens Applied |
|---|---|
| Chief-of-Staff | sequence and owner-facing proof clarity |
| CTO | no runtime/source blending, contract-first Storybook proof |
| UX | first-30-second comprehension and workspace flow |
| Product Manager | personal, company, platform, and invited/client workspace fit |
| Knowledge Architect | traceable chain and fixture-backed evidence |
| AI Governed Infrastructure Manager | xcp-platform shown as substrate visibility; full admin operations remain in xcp-platform |
| DevSecOps | visibility/sensitivity/client-safe boundaries |
| Lead Engineer | Storybook play checks, gate integration, no x-front import |

## Implemented Files

| File | Purpose |
|---|---|
| `src/shared/storybook/golden-path/flows/First30SecondsProof.stories.tsx` | new P0 Storybook story for the first-30-second product chain |
| `src/shared/storybook/golden-path/fixtures/goldenPath.fixture.ts` | adds actor and workspace-class fixture data |
| `scripts/p10d-sb5-storybook-gate.mjs` | extends the local Storybook proof gate to include the new C29 story |

## Story Contract

The new story must show:

| Required Surface | Proof |
|---|---|
| actor context | Marat Basyrov, Owner / Product Lead |
| workspace classes | `MB-P`, `Xlooop`, `xcp-platform`, `Client / invited` |
| permission boundary | visibility and sensitivity in the context bar |
| product chain | workspace, intent, governed triage, work item, evidence, sign-off, learning/XCP substrate |
| xcp-platform boundary | substrate/domain status in this product shell; full AI governance infrastructure admin UI remains separate |
| x-front boundary | reference-only; no source import |

The Storybook play check verifies the required text and CTA. The SB5 gate now
captures this story in the screenshot/manifest run.

## Decision

| Action | Decision |
|---|---|
| Add Storybook proof of first 30 seconds | GO, implemented |
| Import x-front code | NO-GO, not done |
| Embed xcp-platform admin/control-plane UI | NO-GO, not done |
| Change current runtime app | NO-GO in this slice |
| Proceed to web gateway implementation | GO after PR merge and owner review |

## Next Slice

Proceed to **C29-WEB-GATEWAY-01**:

- implement the web-first workspace/workflow gateway in the current root app;
- use the Storybook proof as the UI contract;
- keep mobile deferred;
- keep xcp-platform as workspace/domain visibility in this shell while preserving the separate xcp-platform admin surface;
- no x-front runtime import.
