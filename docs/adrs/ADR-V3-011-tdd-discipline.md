# ADR-V3-011 · TDD discipline going forward

**Status:** Accepted 2026-05-04 (aspirational · partial enforcement) · T1-F contract-test scaffolding landed in `5fd566b`; pre-commit hook (T3-A) does not yet enforce spec-with-feature pairing. **Honest accounting:** Phase 5, T1-H, T2-A.2/.3, T2-B.1/.2, T3-A/C/D were shipped test-after despite this ADR; the discipline becomes binding from T2-C and Phase 6 onward. Grandfathering of pre-T1 specs preserved per Decision §4.

**2026-05-05 reality check (post-Sprint-4 audit `d16670b`):**
The 2026-05-04 binding date was missed. Sprint 1 M1+M2 (`954b1ad`), Sprint 2 M3+M4 (`d0ebf3a`), M5 (`ad34683`), C.4-A (`fd8bc45`), C.4-B (`d3d3103`), and M8 (`cfd7f3d`/`3f6cee2`) ALL shipped test-after, with zero contract tests for the new EvidenceStorePort interface, zero failing-spec-first commits, and zero ADRs for the load-bearing decisions made (mirror port pattern · UMD-React-shim mount · cross-repo HTTP boundary). See `AUDIT_PHASE_C4_M8_2026-05-05.md` for itemised findings. **New binding date: 2026-05-07** (Day 5 of the audit's 5-day backfill plan). Enforcement gate: pre-commit hook lands Day 5 that fails commits introducing a new feature surface without a co-located failing spec or contract test. No further phases ship without it.

**Date:** 2026-05-03
**Decision-makers:** Marat
**Cross-link:** [ADR-V3-007](ADR-V3-007-foundation-first-sequencing.md), x-front contract test pattern (audit 2026-05-03 → 8/10)

## Context

Audit 2026-05-03 standards scorecard: TDD 3/10. v3 has 6 working Playwright e2e specs and a 27-check smoke-cli — but every one of them was **written after** the implementation it covers. There are zero contract tests, no fixture library, no spec-first commits.

x-front has 6 type-level contract tests in CI (`dal`, `storeShape`, `providerChain`, `mswHandlers`, `rtkQuery`, `eventbus`) that pin shapes pre-implementation; they're load-bearing for refactoring confidence. Score 8/10.

## Decision

**Every feature shipped from T1 onward is spec-first.**

### Discipline rules

1. **Write the failing spec first.** For Phase 5+ features, `tests/e2e/v3-<feature>.spec.ts` lands in the same commit (or earlier commit on the same branch) as the implementation. The spec must fail before implementation begins; the failure mode must be in the commit message body or a follow-up note.

2. **Prefer contract tests for shape pins.** Type-only assertions in `v3/project/v3/__contracts__/<surface>.contract.test.ts` mirror x-front's pattern. Shape changes fail at compile, not at runtime.

3. **Layered test pyramid:**
   - **Contract** (`__contracts__/*.test.ts`) — type-level shape pins; cheapest; runs on every TS edit
   - **Unit** (`*.test.ts`/`*.test.tsx` co-located with source) — pure logic, selector behavior; runs in vitest
   - **Spec** (`tests/e2e/v3-*.spec.ts`) — Playwright e2e; user journey
   - **Smoke** (`scripts/smoke-cli.mjs`) — static structure check; precommit hook (T3-A)

4. **Existing specs grandfathered.** Reverse-loop, lineage failure-trace, demo-presets, fabric, skills-policy, policy-gated-signoff — all written test-after-code in the demo-prototype phase. Do not retro-write. New work picks up the discipline.

5. **Definition of Done (DoD) per feature** = spec passes + contract test passes + smoke-cli green + axe 0 violations + verifier 12/12 + commit on `main`.

6. **Definition of Ready (DoR) per task** = ADR exists OR cross-link to existing ADR + spec exists (failing) + clear stop condition.

### Anti-patterns explicitly rejected

- ❌ "Implement first, write spec when it's working." — was the v3 default; it is no longer acceptable.
- ❌ "Skip contract test, the e2e spec covers it." — e2e tests behavior; shape changes need type-level guards.
- ❌ "Add `it.skip` to a failing spec to unblock the commit." — the failing spec is the *point*. If the spec is wrong, fix the spec; if the implementation is wrong, fix the implementation. Never skip.

## Consequences

**Positive:**
- Refactoring confidence rises. Type-level contract tests catch shape drift instantly.
- Specs become design documents — reading the spec teaches the feature's contract.
- DoR/DoD give Phase 5+ measurable exit gates. Closes the Agile 4/10 gap from the audit.
- x-front migration becomes safer: every imported component arrives with its own contract test (T1-F).

**Negative:**
- First spec for any new feature feels slower than first implementation. Sunk cost recovers on the first refactor.
- Operator (Marat) has to resist "implement first, test later" muscle memory.
- Agent prompts must instruct "write the failing spec, paste failure output, then implement." Token cost ≈ 1.3× per feature.

**Out of scope:**
- Mocks library / fixture library — open question; x-front uses MSW handlers; v3 will likely follow once T1-F lands.
- Visual regression testing — Storybook/Chromatic territory (ADR-V3-012).
- Mutation testing — overkill for current scale.

## Verification

- Every Phase 5+ feature commit message references the spec file path.
- Pre-commit hook (T3-A) refuses commits that touch `pages/`/`widgets/`/`features/`/`entities/` without a corresponding `tests/e2e/v3-*.spec.ts` or `__contracts__/*.test.ts` modification.
- `git log` audit at end of each session: every feature commit pairs with a spec commit.
- smoke-cli: `every entity has a model.test.ts`, `every widget has at least one spec reference`.

### T1-K (2026-05-04) · Widget Contract Matrix discipline gate

Any commit that adds, modifies, or deletes a file under `shared/uiKit/**`,
`shared/storybook/**`, or `widgets/**` MUST invoke the
`xcp-component-contract-storybook` skill as part of the pre-commit review.

The skill's per-component recommendations are tracked in the commit body
(or, if the skill returns no actionable recommendations, an explicit
`xcp-component-contract-storybook: invoked · no-op` attestation in the
trailer). Smoke-cli J11 follow-up will mechanically enforce the
attestation pattern on the affected file globs.

Rationale: T2-A.2 + T2-A.3 shipped contract.json files that were authored
against ADR-V3-012 directly without running the skill review. The
retrospective T1-K audit (`audit/2026-05-04_uikit-contract-matrix-audit.md`)
identified 8 actionable uplifts (K1-K8). Codifying the skill invocation
as a DoD step prevents the same gap on future surfaces.

## References

- x-front `src/__contracts__/` (canonical reference)
- [ADR-V3-007 Foundation-first sequencing](ADR-V3-007-foundation-first-sequencing.md)
- [plan-foundation-2026-05-03.md](../plan-foundation-2026-05-03.md) §2.7 standards scorecard
