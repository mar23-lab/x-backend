# ADR-XB-009 — The Agent Autonomy Matrix (conservative baseline)

- **Status:** accepted (ratified by operator decision, 2026-07-20 — Marat Basyrov, session 260720, AskUserQuestion record: "Ratify conservative baseline")
- **Date:** 2026-07-20
- **Authority context:** ADR-XB-008 (UGEC — the enforcement substrate); `src/workers/lib/permissions.ts` SpineAction union + `canActOnSpine`; mig 052 session modes; mig 055 role-mirror entitlements

## Decision

Every spine action carries an **autonomy class** governing what an AGENT principal (instrument_kind
`agent` or `service`) may do in a customer workspace:

- **AUTO** — the agent may execute without per-action human approval (still fully captured: principal
  + lineage + receipts; still entitlement- and mode-gated once ENTITLEMENT_ENFORCEMENT is on).
- **APPROVAL** — a human sign-off (approval_request / sign_off) must exist before the action lands.
- **FORBIDDEN** — an agent may never execute it, even with approval; these remain human-only.

The operator ratified the **conservative baseline**: loosening later (APPROVAL→AUTO per evidence) is
cheap; tightening after an incident in a customer tenant is expensive.

## The matrix (all 18 SpineActions)

| SpineAction | Class | Rationale |
|---|---|---|
| `tool_event:report` | AUTO | the audit trail itself — blocking it blinds governance |
| `metric_delta:record` | AUTO | telemetry capture; non-state-advancing |
| `event:ingest` | AUTO | activity-record ingestion (events are not work items, ADR-XB-005) |
| `evidence:submit` | AUTO | proof attachment strengthens auditability; never advances state alone |
| `token:read` | AUTO | read-scoped introspection |
| `packet:create` | APPROVAL | opens governed work in a customer tenant |
| `approval:request` | APPROVAL | initiates a human decision loop |
| `approval:decide` | APPROVAL | the decision itself is human-owned; an agent may only relay a recorded human verdict |
| `signoff:decide` | APPROVAL | as above — accountability is human |
| `member:invite` | APPROVAL | changes the tenant's principal set |
| `token:create` | APPROVAL | mints new access |
| `customer_data:export` | APPROVAL | data egress from the tenant |
| `customer_data:execute` | APPROVAL | executes governed intake/lifecycle actions |
| `event:self_service` | APPROVAL | customer-visible self-service mutation |
| `customer_data:delete` | FORBIDDEN | destructive; human-only (soft-delete path; purge is operator-flag-gated besides) |
| `authority:revoke` | FORBIDDEN | an agent must never alter the authority lattice |
| `policy:write` | FORBIDDEN | HR-AGENT-NO-SELF-PATCH twin — agents never modify the rules that govern them |
| `runtime:configure` | FORBIDDEN | runtime/model configuration is operator-owned |

Standing axioms (already enforced by design, restated for completeness): `watch`/`test` session modes
deny ALL 18 actions (`mode_requires_operator`, permissions.ts:137-139); agents never handle secrets;
agents never grant entitlements to themselves (the service-principal exemption in spine-authority.ts:75
is scheduled to DIE at the enforce phase per ADR-XB-008 — agents then hold their OWN entitlements
whose `allowed_actions` must encode this matrix).

## Enforcement path

Phase 1 (now): this matrix is the RATIFIED POLICY; the conformance verifier may report
matrix-violating agent writes as shadow findings. Phase 2 (at the ENTITLEMENT_ENFORCEMENT flip):
agent-principal entitlements are provisioned with `allowed_actions` = the AUTO set only; APPROVAL
actions require a recorded approval reference; FORBIDDEN actions are never granted. Phase 3
(CUSTOMER_API_TOKENS): the agent door opens only after the fence enforces (fence-before-door,
ADR-XB-008 hard ordering).

## Consequences

- Agents remain fully productive on the capture plane (events, evidence, telemetry, lineage) without
  approval friction — the plane whose integrity governance depends on.
- Every state-advancing or customer-visible act carries a human accountability record.
- The matrix is data (entitlement `allowed_actions`), not code — per-tenant tightening is possible;
  loosening beyond the baseline requires a new ADR.
