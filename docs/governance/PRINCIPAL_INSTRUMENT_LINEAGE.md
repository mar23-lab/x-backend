# Principal-Instrument Actor Lineage (A-W4/P6 · SSOT · 2026-07-07)

**The doctrine** (matches the new-UI actor model verbatim): *when AI acts under a human's authority, the
audit record carries principal + instrument — "Claude · acting for Andrey", never just "by Andrey".*
This is the enterprise AI-governance differentiator: every governed write can answer **who authorized it,
what executed it, under what authority, and which request caused it**.

Code SSOT: `src/workers/lib/actor-lineage.ts` (enums + `lineageFor()`/`systemLineage()`).
Schema: migration `050_principal_instrument_lineage.sql` (4 nullable columns on `operation_events`).
Drift frozen by `verify:principal-instrument-lineage`.

## Fields (operation_events, all nullable — new writes only, no backfill)

| Field | Meaning |
|---|---|
| `authorized_by_user_id` | The **human principal** who authorized the write. NULL only for pure system-policy writes (scheduled digests/sweeps) — and for pre-050 rows, which honestly read "lineage not recorded". |
| `instrument_kind` | **What kind of actor executed** — the new UI's ACTOR_KIND enum verbatim: `human` \| `agent` \| `system` \| `external`. An API token is **not** a kind (it is an authority source); cron/engines map to `system`. |
| `authority_source` | Under what authority: `role` (workspace role permitted it) \| `explicit_approval` (a recorded sign-off) \| `token_scope` (scoped API token grant) \| `system_policy` (standing platform policy) \| `operator_identity` (MBP platform-operator overlay). |
| `request_id` | HTTP correlation id (`ctx.get('request_id')`). **Not** the UI's chat `turn` (see below). |

`agent_id` (pre-existing) remains the **instrument ID** — unchanged semantics. `source_tool` remains the
emitting surface. Together: `agent_id` says *which* instrument, `instrument_kind` says *what kind*,
`authorized_by_user_id` says *for whom*, `authority_source` says *by what right*.

## Examples

| Scenario | authorized_by | instrument_kind | agent_id | authority_source |
|---|---|---|---|---|
| Operator uploads a document | the uploader | `human` | — | `role` |
| Operator records a sign-off | the approver | `human` | `xlooop:operator-action` | `role` |
| Claude acts via a customer connector token | the token's bound identity | `agent` | e.g. `claude` | `token_scope` |
| Scheduled digest sweep emits a proposal | NULL | `system` | `xlooop:digest-agent` | `system_policy` |
| Client/guest action (future) | the inviter/owner per consent | `external` | — | `explicit_approval` |

## New-UI alignment (frictionless later adoption — reference only, UI not implemented)

| New-UI concept (verbatim) | Backend counterpart |
|---|---|
| `ACTOR_KIND = human \| agent \| system \| external` (avatar silhouettes) | `instrument_kind` — same strings, same casing |
| event `actor` (who executed: `you`/`claude`/`readiness`…) | `agent_id` (instrument id) |
| "principal + instrument ('Claude · acting for Andrey')" | `authorized_by_user_id` + `agent_id`/`instrument_kind` |
| Owner/accountability ring (orthogonal to kind) | derivable: `authorized_by_user_id` = the accountable party |
| `turn` (chat-turn grouping; "By request" lens groups events by turn) | **DEFERRED** — a chat-side concept minted by the composer; `request_id` here is HTTP correlation, a different axis. When cockpit-chat wiring lands, `turn` becomes its own field; do NOT overload `request_id`. |

## Customer-safe redaction  ·  IMPLEMENTED (A-W4.1, 260707)
`authorized_by_user_id` is an internal user id — it redacts exactly like `actor_user_id` in the audit
export: no raw ids to `client`/`viewer`-role or `public_safe` surfaces. `instrument_kind`/`authority_source`
are safe enums; `request_id` is safe (already in error envelopes).

The read model now SELECTs `authorized_by_user_id` and every customer-facing event projection runs each row
through `redactPrincipalForRole(row, role)` (`src/workers/dal/event-store.ts`). It is **fail-closed**: the
principal is exposed only to an explicit accountable allow-list (`owner`/`operator` — the ACTUAL runtime auth
roles are `owner|operator|viewer|client`, and Clerk currently maps `org:admin→operator`, so the effective
accountable set today is `{operator}`); every other role — `client`, `viewer`, and any unknown/absent role —
is nulled, so a new or mis-plumbed role can never silently leak an id. Low-trust callers still receive the
SAFE lineage (WHAT/HOW), just not WHO. Frozen by `scripts/verify-principal-redaction.mjs` (t1 column exposed ·
t2 no bare projection escapes redaction · t3 helper stays fail-closed) +
`src/workers/__tests__/principal-redaction.test.ts` (behavioral).

> **Customer-facing display grammar (updated-UI alignment, 260707):** the customer surface renders the
> instrument as the platform label **"Xlooop"**, never a model/vendor name — on-behalf-of reads
> **"Andrey · via Xlooop"** (human-first, platform-not-model), superseding the earlier "Claude · acting for
> Andrey" phrasing. This is a projection/label rule; the stored `agent_id`/`instrument_kind` fields are
> unchanged. Vendor/model names appear ONLY in the Settings model-picker.

## Relation to MB-P (Program B — no direct integration)
MB-P's intent→packet→event→tool spine uses the same principal/instrument split. Xlooop's
`authorized_by_user_id`=principal and `agent_id`+`instrument_kind`=instrument are the join keys for the
future lineage bridge (B-W3). Nothing here calls MB-P.

## Rollback / ops
Forward-only: columns are nullable and additive; rollback = stop populating (no reads depend on presence —
`upsertEventRow` falls back to the legacy column set if 050 is absent, so deploy/apply ordering can never
break event ingestion). Read-surface expansion (listEvents/HarnessFlowEvent SELECT) deliberately lands
AFTER 050 is applied to prod (a SELECT of absent columns would break the event stream).

## Instrumented paths (pass 1)
`documents.ts` upload mirror · `sign-offs.ts` sign-off mirror · `projects.ts` archive mirror — all via
`lineageFor(auth)` + `request_id`. Remaining `upsertEvent` call sites (workspaces/sources/webhooks/services)
adopt incrementally; scheduled services use `systemLineage()`.
