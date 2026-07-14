---
id: c30_seed_contracts_golden_path_mbp
title: C30-SEED-CONTRACTS-03 / C30-GOLDEN-PATH-03 MB-P Seed Contracts And Golden Path
created_at: "2026-05-09T14:38:00+10:00"
date_key: "260509_1438"
timezone: "Australia/Melbourne"
status: implemented_current_surface
lifecycle_state: active_reference
owner_role: Product Manager
purpose: Record migration of seed-contract examples and golden-path Storybook evidence from fictional tenant examples to MB-P/XCP owner-intake proof.
graph_required: true
---

# C30 MB-P Seed Contracts And Golden Path

## Verdict

Implemented for the targeted current evidence surfaces.

`src/contracts/seed-contracts.ts` no longer seeds fictional agency/client
examples. The canonical example contract lane is now MB-P owner intake,
governed triage, MB-P proof-chain work, XCP producer-boundary safety, and
owner-approved collaboration.

`src/shared/storybook/golden-path/` now tells the MB-P owner-intake chain rather
than the old fictional tenant/project story.

## Implemented

| Surface | Change |
|---|---|
| `src/contracts/seed-contracts.ts` | rewrote CI/TD/WI/DR/AC examples to MB-P/XCP current proof cases |
| `src/contracts/seed-contracts.ts` | replaced operating-context workspace seeds with `MB-P` and `XCP platform` |
| `src/contracts/seed-contracts.ts` | replaced old demo actors/roles with owner, Chief-of-Staff, Product Manager, UX, Lead Engineer, QA, Knowledge Architect, AI Governed Infrastructure Manager, and DevSecOps |
| `tests/unit/contracts/seed-contracts.test.mjs` | updated seed-contract invariants to the MB-P/XCP context |
| `src/shared/storybook/golden-path/fixtures/goldenPath.fixture.ts` | migrated UC-001 fixture to MB-P owner-intake proof |
| `src/shared/storybook/golden-path/**` | renamed roles and copy from agency/client wording to owner-approved MB-P/XCP wording |

## Remaining Legacy Evidence

The broader repository still contains historical docs/audits and non-current
legacy e2e files that mention the former fictional scenario. Those are retained
as historical evidence until a separate historical-test retirement/migration
slice is approved. They are not current product proof.

## Next

1. `C30-LEGACY-E2E-04`: classify or retire non-current Playwright specs that
   still encode the former fictional scenario.
2. `C30-HISTORICAL-DOCS-04`: ensure historical docs/audits are clearly marked
   as provenance and cannot be mistaken for current product copy.
