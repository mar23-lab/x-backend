# ADR-XB-008 — The Universal Governed Execution Contract (UGEC)

- **Status:** accepted (ratified by operator authorization, 2026-07-20 — Marat Basyrov, session 260720; execution rides the N-UX waves)
- **Date:** 2026-07-20
- **Authority context:** CANONICAL_DOMAIN_MODEL.md; ADR-XB-001..007; the 260720 enforcement map
  (measured @ `ed4d5aa`); MB-P PILLARS/HARD_RULES (the governance twin)

## Decision

The governed execution model — **intent → context (from graph/roles/skills) → packet → events →
tool invocations including document EDIT and VIEW artefacts → evidence → decision/sign-off — is THE
mandatory path for ANY principal (human, agent, or service) acting in ANY customer workspace on
app.xlooop.com, enforced server-side.** Prompt-side governance is never sufficient. This contract
binds all agents equally — including MB-P as customer-0 (the dogfood clause: no privileged-tenant
exemption; the zero-customer promotion process ADR-XB-006's anti-bypass principle applied to
ourselves).

## The nine invariants

| # | Invariant |
|---|---|
| I1 | No tenant write without principal (human/agent/service) + workspace + trace identity |
| I2 | No agent tool invocation outside a packet whose `allowed_tools` admit it (and `packet_prefix` scope for tokens) |
| I3 | No governed write without a RECORDED authority decision (never evaluated-then-discarded) |
| I4 | Every document EDIT and VIEW is an auditable event |
| I5 | Every LLM/agent run records its context receipt (sources, hashes, filters) |
| I6 | Role/skill resolution receipts on agent actions |
| I7 | No completion claim without evidence linkage |
| I8 | Approvals identify the approver; sign-off states never contradict |
| I9 | The whole chain is queryable as ONE lineage per intent |

## Measured baseline (260720, the honest starting state)

Static conformance scan: **121 write-handler sites, 24 spine-authorize calls (97 uncovered)**;
authority is byte-identical to legacy `canWrite(role)` while `ENTITLEMENT_ENFORCEMENT` is off;
the agent path is inert (`CUSTOMER_API_TOKENS_ENABLED` off); role/skill resolution receipts are
LIVE in shadow (migs 070/071/072 applied); context receipts authored-not-written; the packet
tool-fence was declarative-only until this ADR's companion change; allow-decisions are discarded;
principal stamping covers 4 route sites; doc-VIEW capture covers chat-grounding reads only.

## The seven-gap work-list (ranked; from the enforcement map)

1. Entitlement authority unflippable — `customer_entitlements` empty → **prerequisite-0: the 055
   role-mirror backfill before ANY enforcement flip** (flipping today = total governed-write lockout).
2. Packet tool-fence declarative-only → **closed born-shadow by this ADR's companion**
   (`lib/ugec-fence.ts` + the gateway wiring; `UGEC_FENCE_ENFORCEMENT` flips warn→deny).
3. No per-write packet/context linkage outside the 3 MCP writes → P-C spine-action migration.
4. **Agents exempt by design** (service principals bypass the entitlement path,
   spine-authority.ts:75) → the exemption is REMOVED at the enforce phase; agents receive their own
   entitlements. An agent must never be less governed than a human.
5. Allow-decisions discarded → persist policy decisions (extend the live shadow-resolution write).
6. Principal stamping sparse → extend `lineageFor` to all write paths.
7. doc-VIEW capture narrow → document list + MCP reads → `document_access_log`; view events for
   packets/plan/lineage.

## Rollout doctrine (per-invariant)

**SHADOW** (record violations, block nothing) → **RATCHET** (violation/coverage counts monotone
against committed baselines — `UGEC_CONFORMANCE_BASELINE.json`, the H1/N.6 pattern) → **ENFORCE**
(deny + disabled_reason), each flip flag-gated and operator-ruled. Hard orderings: prerequisite-0
before any `ENTITLEMENT_ENFORCEMENT` flip; **the fence enforced before `CUSTOMER_API_TOKENS_ENABLED`
ever opens the agent door** (never admit agents before the fence bites); coverage measured before
every flip (no false-denies).

## Consequences

- `scripts/verify-ugec-conformance.mjs` is the standing coverage measure (report-only + `--ratchet`);
  its baseline commits with this ADR.
- Self-serve launch gates on the existing hard-stop PLUS UGEC conformance thresholds (set at
  ratification).
- Rejected alternatives: prompt-side rules (unenforceable on third-party agents); flipping all
  flags now (measured lockout + false-denies); absolute-100% coverage targets (Goodhart — rewards
  route deletion over governance; the ratchet is the honest floor).
