# ADR-V3-013 · EvidenceStorePort mirror pattern

**Status:** Accepted 2026-05-06 (audit Day 3 backfill)
**Date:** 2026-05-05 (originating decision in commit `fd8bc45`)
**Decision-makers:** Marat
**Supersedes:** none
**Cross-link:** [ADR-V3-002](ADR-V3-002-dal-adapters.md), [ADR-V3-009](ADR-V3-009-eventbus-topic-registry.md), audit `AUDIT_PHASE_C4_M8_2026-05-05.md` item 2.4

## Context

C.4-A (commit `fd8bc45`) introduced the EvidenceStorePort interface as a cross-repo contract between the substrate (xcp-platform/apps/intent-ai-app-template) and the demo (Xlooop-XCP-demo). The substrate is the source of truth; the demo currently lives outside the pnpm workspace and cannot import the substrate package directly.

Two viable resolutions existed:
1. **Mirror copy** — duplicate the substrate's `types.ts` into the demo's `runtime/evidence-store-port.ts` with a "mirror of substrate · keep in sync" header and rely on a parity validator to detect drift.
2. **pnpm workspace fold** — bring Xlooop-XCP-demo into the xcp-platform pnpm workspace and import via `@xcp/intent-ai-app-template`.

C.4-A chose option 1 because the demo's babel-loaded JSX runtime cannot consume TS-source npm packages without a build pipeline change, and Plan v3 §E (operator) explicitly defers physical fold of x-front and demo until post-W6.

## Decision

The substrate's `services/evidence-store-port/types.ts` is the canonical EvidenceStorePort. The demo carries a mirror at `v3/runtime/evidence-store-port.ts` with:
- Provenance header ("MIRROR of the substrate's port at: …")
- TODO breadcrumb (`L-260505-PORT-PARITY-VALIDATOR-1`) until the parity validator lands.

**Update protocol:**
1. New methods or row fields land in the substrate FIRST.
2. Mirror is updated in the SAME commit-pair OR before the next demo ship.
3. `node scripts/cross-feed/validate-evidence-store-port-parity.mjs` (xcp-platform) must pass before either side merges to main.
4. Demo's `__contracts__/evidenceStorePort.contract.test.ts` (TypeScript-level) provides compile-time pinning of method set + row shapes.

**Sunset condition:** when Xlooop-XCP-demo joins the pnpm workspace OR `@xcp/intent-ai-app-template` is published to a registry, the mirror is deleted and the demo imports types directly. This ADR becomes obsolete at that point.

## Consequences

**Positive:**
- Demo retains babel-loaded JSX architecture · no toolchain disruption.
- Drift caught at two layers: static-parse validator (cross-feed) + TS contract test (compile-time).
- Pattern is reusable: the same mirror-with-validator approach applies to any future cross-repo port (HTTP envelopes, skill descriptors, etc.).

**Negative:**
- Two copies of the same TypeScript interface file. Real maintenance cost on every port change.
- Validator runs out-of-band by default · easy to forget. Day-4 cross-repo pre-commit hook closes this gap.
- A bad-actor commit could alter the demo's mirror without touching the substrate; the validator catches the drift but only when run.

**Out of scope:**
- The HttpEvidenceStorePort and MockEvidenceStorePort live substrate-side only · no mirror.
- LiveEvidenceStorePort is demo-only (it projects demo's WI store) · no substrate counterpart.

## Verification

- `node scripts/cross-feed/validate-evidence-store-port-parity.mjs` exits 0
- `cd v3/project/v3 && pnpm exec tsc --noEmit __contracts__/evidenceStorePort.contract.test.ts` compiles clean
- Day-4 pre-commit hook runs the validator on any commit touching either file
