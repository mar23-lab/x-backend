# ADR-XB-006 — Zero-Customer (MB-P) Promotion Process

- **Status:** accepted (ratified by operator authorization, 2026-07-20 — Marat Basyrov, session 260720; execution rides the N-UX waves)
- **Date:** 2026-07-20
- **Owner:** marat
- **Relates:** CANONICAL_DOMAIN_MODEL.md; `mbp-private` workspace (customer-0, live)

## Context

MB-P is verified live as customer-0 (`mbp-private`), but NO governed contract exists for
how MB-P usage becomes product capability. Without one, the two failure directions are
(a) MB-P drifts into a private fork with privileged behavior, and (b) real usage evidence
never converts into canonical features. This process is the biggest genuinely-new harvest
from the external audit prompt and the durable answer to "MB-P governance
copied-vs-adapted into product": **adapt via contract, never copy.**

## Decision — the promotion pipeline (every promotion walks all 10 stages)

1. **MB-P usage observed** — raw customer-0 usage, on the same surfaces as any tenant.
2. **Candidate capability named** — a described, bounded capability, not a code drop.
3. **Private-data separation** — MB-P-private content stripped; what remains is shape.
4. **Contract authored** — API/schema contract for the capability, versioned.
5. **Synthetic fixtures authored** — test data invented, never derived from private data.
6. **Security + tenant review** — isolation, RLS, entitlement posture per the invariants.
7. **Canonical implementation** — built in x-backend / x-ai-front as a product feature.
8. **MB-P consumes as a TENANT** — through the same public contracts, no side doors.
9. **External-suitability review** — vocabulary, UX legibility, docs for non-MB-P users.
10. **Metrics-based lifecycle** — retain / change / remove on measured usage, on cadence.

### The 12-axis promotion scorecard (scored at stage 2, re-scored at stage 10)

repeated usage · users/roles affected · business value · evidence quality ·
generalisability · tenant safety · contract clarity · testability · operational cost ·
UX clarity · security risk · external relevance

### FORBIDDEN set (each is a hard stop, not a trade-off)

MB-P must never become: a **private fork**; a **privileged bypass tenant**; a home for
**hard-coded one-off behaviors**; a **source of personal data in fixtures**; or a
**substitute for external validation**.

## Options considered

- **A. No process (status quo)** — rejected: customer-0 is live; every un-contracted
  promotion compounds fork risk.
- **B. Copy MB-P governance artifacts into the product** — rejected: copies drift; the
  measured lesson is adapt-via-contract.
- **C. The 10-stage contract + scorecard + forbidden set (chosen).**

## Consequences

- Every MB-P-inspired feature carries a scorecard and fixture provenance.
- MB-P loses (never had, formally) any right to privileged runtime behavior.
- Stage 9/10 keep the product honest about external users — MB-P satisfaction alone
  never justifies retention.
