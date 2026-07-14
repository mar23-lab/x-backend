# C29-STORY-01 · Storybook DoD And State Matrix Adoption

**Created:** 2026-05-09T11:09:00+10:00  
**Date key:** 260509_1109  
**Owner:** Marat Basyrov  
**Scope:** Storybook governance/documentation only  
**Source x-front HEAD:** `401e6d40a0befc683a7a410f1ed0aee0afd6f492`  
**Decision:** adopt DoD and scorecard discipline; do not import x-front Storybook/component code; do not add runtime implementation in this slice.

## Role And Skill Panel

| Role lens | Applied to |
|---|---|
| Chief-of-Staff | sequence control and no-overclaim phase closure |
| CTO | contract-first UI maturity and future platform leverage |
| UX | visible state coverage and web-first demo trust |
| Product Manager | story coverage for commercial journey surfaces |
| Knowledge Architect | Storybook as living product-contract evidence |
| AI Governed Infrastructure Manager | generated scorecard and repeatable review surface |
| DevSecOps | client-safety, sensitivity, and no private-data leakage in stories |
| Lead Engineer | testability, fixtures, CI gates, maintainability |

Skills invoked: `component-contract-storybook`, `product-engineering-router`, existing artifact discovery.

## Executive Verdict

**Adopt the x-front Storybook governance pattern, not its Storybook source.**

x-front has a stronger filesystem-backed DoD loop: generated scorecard, phase closure checklist, scaffolded story/test/mocks/types, interaction tests, and explicit warnings against declaring phases done without filesystem proof. Xlooop-XCP-demo already has a current Storybook contract layer and stronger product-specific golden-path stories, but it still lacks an equivalent generated DoD scorecard and a strict state-matrix gate for new/current surfaces.

This slice makes the adoption target explicit:

`component/widget -> contract.json -> story -> state matrix -> interaction/a11y/client-safety proof -> generated scorecard -> phase closure`

No x-front code is imported. The value transfer is procedural.

## Evidence Summary

| Surface | Evidence | Finding | Transfer decision |
|---|---|---|---|
| x-front DoD scorecard | `x-front/docs/frontend-audit/DOD-SCORECARD.md` | 76/76 green across Atoms, Molecules, Organisms, Widgets | adopt scorecard concept |
| x-front DoD standard | `x-front/docs/frontend-audit/07-definition-of-done.md` | requires state variants, mocks, RTL+axe, interaction tests, responsive checks, no forbidden imports | adapt to demo tiers |
| x-front finalisation | `x-front/docs/frontend-audit/11-storybook-finalisation.md` | explicitly documents failure mode: phases declared done while DoD artifacts were missing | adopt no-overclaim closure gate |
| x-front stories | `x-front/src/**/*.stories.*` | 107 story files, broad component catalogue | reference only; do not import |
| demo stories | `src/**/*.stories.tsx` | 35 story files | current product Storybook surface |
| demo contracts | `src/**/contract.json` | 17 contract files | current contract surface |
| demo play coverage | `rg play` | 13 story files with play checks | good start, not yet generated-scorecard enforced |
| demo Component DoD | `src/shared/storybook/docs/Component-DoD.mdx` | strong tier-1/tier-2 rules and smoke checks | update with C29 adoption addendum |

## Adopted Principles

| Principle | x-front source | Demo adoption |
|---|---|---|
| Filesystem proof beats self-report | phase-closure and finalisation docs | every maturity claim must map to files/checks |
| Generated scorecard | `scripts/dod-scorecard.mjs` in x-front | future demo `storybook-dod-scorecard` task |
| State matrix per component/widget | `Default`, `Loading`, `Empty`, `Error`, `Disabled`, interaction variants | required for new tier-1 atoms and P0 journey/composite surfaces |
| WithViewModel / fixture marker | widget stories carry view-model evidence | demo equivalent: fixture-backed story plus contract source path |
| Interaction tests for interactive UI | `*.interactions.test.tsx` and Storybook play guidance | play checks required for P0 interactive journey surfaces before maturity Level 4 |
| Client-safety proof | implicit via DoD and demo client-safety docs | explicit no internal/private leakage check for client-visible stories |
| Phase closure checklist | `docs/phase-closure-checklist.md` | PR/phase docs must state scorecard status and deferred rows |

## Demo-Specific Maturity Matrix

| Level | Meaning | Required evidence |
|---:|---|---|
| 0 | No story | none; cannot be mature |
| 1 | Visual placeholder | story exists but no fixture/state/contract proof |
| 2 | Basic states | default plus at least one meaningful variant |
| 3 | Fixture and contract backed | story uses governed fixture, contract.json or explicit source contract exists |
| 4 | Interaction/a11y/client-safety ready | play check or interaction proof, a11y note/check, visibility/sensitivity rule |
| 5 | Contract-driven and scorecard-gated | generated scorecard row, golden-path link, CI/check enforcement |

Immediate target:

- Tier-1/uiKit primitives: Level 4 minimum before new product use.
- P0 golden-path journey stories: Level 4 minimum.
- Composite mode widgets: Level 3 minimum, Level 4 when user-action or sign-off/client visibility is involved.
- Client-visible stories: Level 4 minimum with leakage check.

## State Matrix Template

| Surface | Type | Current story | Contract source | Required states | Interaction proof | A11y proof | Client-safety proof | Maturity target |
|---|---|---|---|---|---|---|---|---:|
| `<Name>` | tier-1 / composite / golden-path | `src/.../<Name>.stories.tsx` | `contract.json` or doc source | Default / Loading / Empty / Error / Disabled / Success where applicable | `play()` or explicit no-op rationale | axe/manual note | required if client-visible | 3-5 |

## Priority Adoption Backlog

| ID | Item | Why | Effort | Risk | DoD |
|---|---|---|---:|---:|---|
| SB-DOD-01 | Add demo generated Storybook DoD scorecard | removes self-report risk | M | 25 | generated report covers stories, contracts, play, states, client-safety |
| SB-DOD-02 | Extend `contract.json` schema with maturity/state-matrix fields | makes maturity machine-readable | S | 20 | schema accepts `state_matrix`, `client_safety`, `a11y`, `scorecard_status` |
| SB-DOD-03 | Add Level-4 checks for P0 journey stories | proves the first 30-second product chain | M | 30 | Client intent -> triage -> work item -> evidence -> sign-off -> learning stories have play/client-safety checks |
| SB-DOD-04 | Add closure checklist row to PR/phase docs | prevents "done" without proof | S | 15 | PR template or phase checklist requires scorecard status |
| SB-DOD-05 | Keep x-front Storybook as reference only | prevents source blending | XS | 5 | no x-front story/component import |

## Stop Conditions

- Stop if a proposal imports x-front Storybook or component source directly.
- Stop if a maturity claim lacks filesystem evidence.
- Stop if client-visible stories use MB-P private/internal data without redaction.
- Stop if xcp-platform infrastructure administration surfaces are mixed into Xlooop product Storybook.
- Stop if a new component bypasses the existing tier-1/tier-2 shipping-unit rules.

## Go / No-Go

| Action | Decision |
|---|---|
| Adopt x-front generated DoD scorecard discipline | GO |
| Copy x-front Storybook/component code | NO-GO |
| Add runtime/product source changes now | NO-GO |
| Update current demo Component DoD docs with C29 addendum | GO |
| Proceed to C29-UIKIT-01 after this lands | GO |

## Next Step

Proceed to **C29-UIKIT-01**:

- reconcile `Avatar`, `XEvidenceImage`, and `XEvidencePreview` against the current root uiKit;
- classify already absorbed / keep / improve / reject / re-review;
- require Storybook contract + tests for any future improvement.
