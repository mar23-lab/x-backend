# ADR-V3-029 — Single Authenticated Intake + Central RBAC Enforcement

- **Status:** Accepted + partially shipped (260629). **Stage 2 REVISED — the intake facade is DROPPED** in favour of shared helper modules + a documented contract (see `docs/engineering/INTAKE_CONTRACT.md`); rationale below. Stage 1 (central RBAC) + the event-validation SSOT are **LIVE in main**. The new `developer` role is **PARKED** per operator (260629).
- **Date:** 2026-06-29
- **Context owner:** enforced-governance program (see `project_enforced_governance_three_planes`). This is the product-side companion to the three governance planes (RLS / event-append-only / agent-attestation).
- **Supersedes / relates:** none. Sits under the just-completed Plane-1 RLS cutover, which is the DB-level isolation floor this design assumes.

## Context

The operator directive: *"user must be authenticated and we must have a single intake format — roles must be respected with the right user permissions."* A grounding pass (3 read-only Explore agents, file:line-cited) established the current state:

### Auth + RBAC today (already strong, partly ad-hoc)
- `workspace_id` is **always** derived from the Clerk JWT `org_id` — **never** from a request body (`auth.ts:137`). This is the load-bearing tenant-safety invariant.
- Four roles: `owner` / `operator` / `viewer` / `client` (`visibility.ts:20-27`), mapped from the Clerk org-role via `clerkRoleToWorkspaceRole()` (`visibility.ts:41-46`).
- Service principals: canary (read/lifecycle, env-token) and **revocable customer tokens** (`xlk_ro_`/`xlk_op_`, DB-backed, SHA256-hashed, `packet_prefix`-write-scoped, TTL'd) — `developer-access.ts:194-282`, `auth.ts:226-266`.
- Central helpers exist: `canWrite()` (`operational-spine.ts:59-61`), `isOperatorContext()` (`synthetic-domains.ts:67-69`), `requireAdmin()` (`middleware/admin.ts`).
- **Gap:** ~8 inline `role !== 'viewer' && role !== 'client'` checks, `operatorIds()` duplicated across 4 files, and canary/token constraints duplicated — **no single permission module**. Authorization is *correct but scattered*, so it can't be audited or extended in one place.

### Intake today (13 divergent paths)
Operator chat (`POST /events`), slash-commands, sign-offs, source connectors, document upload, 2 webhooks (GitHub HMAC / activity bearer), 5 operational-spine writes, authority-consent — across **5 auth patterns** and **4 workspace-resolution rules**, all ultimately writing governed rows but with **no shared validation / audit / idempotency seam**. (Agent-2 map, file:line-cited.)

## Decision

Build **additively**, flag-gated, back-compat — the pattern this codebase already uses — in stages:

| Stage | What | Risk | Gate |
|---|---|---|---|
| **0 (this ADR)** | Decision record + grounded design | none | — |
| **1 — Central RBAC module** | Extract one `src/workers/lib/permissions.ts` — every role→capability check in one auditable place; replace the ~8 inline checks + dedupe `operatorIds()`. **Behavior-preserving** for existing roles + tests. | low | ci-local + RBAC tests prove byte-equivalent authz for existing roles |
| **1b — `developer` role** ⏸️ **PARKED** | A new full-workspace-dev role (see below). | low (additive/inert) | un-park on operator go |
| **2 — REVISED: shared helper modules + documented contract** (facade DROPPED) | `lib/permissions.ts` (RBAC SSOT) + `lib/event-validation.ts` (enum SSOT) + `lib/audit.ts` (audit mirror, pending) + `docs/engineering/INTAKE_CONTRACT.md` (the contract every path obeys). Same governance guarantee, **no SPOF, no new endpoint**. | low (behavior-preserving) | per-helper unit tests + smoke source-checks + the documented anti-corruption boundary |
| **3 — Session-governance role** | Wire the dev role into MB-P `SESSION_ROLE_MANIFEST.yml` (template: `x-front-product` / `xlooop-product`). | low | MB-P commit gauntlet (lease + trailers) |

### The PARKED `developer` role (design preserved for un-pause)
Operator decision 260629: **"Both"** (product RBAC + session role) + **"Full workspace dev"**.
- **Product RBAC:** new `WorkspaceRole = 'developer'`, mapped from Clerk `org:developer`. **Inert until Clerk assigns the role** (additive, zero impact on existing users).
- **Permissions:** operator-level **read-write within its own workspace** — packets / evidence / approvals / sign-offs / tool-events / metrics + events. Add `developer` to `canWrite()` and the spine/events/sign-offs gates (the inline `!viewer && !client` checks already admit it).
- **Explicitly NOT granted (the IP boundary stays owner/operator):** admin, cross-tenant operator overlay (`isOperatorContext` stays `owner||operator`), connector-token minting, authority-consent revoke.
- **Session role:** a new `xlooop-developer` entry in `SESSION_ROLE_MANIFEST.yml` (full-repo writable, `entry_skill: product-engineering-router`, closing `xcp-atomic-closure` + branch-guard).

## Security invariants (preserved across all stages)
1. `workspace_id` only ever from auth — **no intake path may accept a body-supplied tenant** (webhooks excepted via signed config, never caller-controlled).
2. No intake path bypasses the central RBAC check (Stage 2 makes this structural — one gate, not 13).
3. Tenant isolation is now **two-layer**: app-level `WHERE` + DB-level RLS (Plane-1 cutover, live 260629). The intake facade inherits both.
4. Stage 1 must be **provably behavior-preserving** for existing roles (test: each migrated inline check returns identical authz to its central-helper replacement).

## Consequences
- **+** One auditable authorization surface; one validated intake seam → drastically smaller tenant-safety bug surface; the new role (when un-parked) plugs into one place, not 13.
- **−** ~~Stage 2 introduces a new high-traffic endpoint~~ **REVISED:** the facade was DROPPED (multi-auth waterfall + single point of failure for tenant safety). The shared-helper pattern adds no new endpoint and no SPOF — each helper is a behavior-preserving extraction. See `docs/engineering/INTAKE_CONTRACT.md` § *Why not a facade*.
- **Reversibility:** Stage 1/1b/2 are all additive + behavior-preserving (revert = inline the helper back / delete the role) — there is no flag to flip and no facade to fall back from.

## Status / next (260629)
- **Stage 1 (central RBAC module): SHIPPED** — `lib/permissions.ts` is the SSOT for `canWrite` (#805) + `isOperatorRole`/`operatorIds` (#806); inline duplicates removed from 5 routes; behavior-preserving (8-case test, ci-local 54/54).
- **Stage 2 (REVISED → helpers + contract): in progress** — `lib/event-validation.ts` enum SSOT shipped (#807, which also fixed a real `activity-webhook` source-tool drift); `docs/engineering/INTAKE_CONTRACT.md` documents the contract every path obeys. **Remaining:** `lib/audit.ts` (consolidate the sign-off→`operation_events` mirror) + one integration test (deferred behind the `*-route.test.ts` harness flakiness).
- **Stage 1b (`developer` role): PARKED** per operator 260629 — un-parks into `lib/permissions.ts` (one place).
- **Stage 3 (session-governance role):** deferred until the dev role un-parks.
