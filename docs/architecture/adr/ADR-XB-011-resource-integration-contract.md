# ADR-XB-011 — The Resource Integration Contract (opt-in · tiered · pausable · archive-never-silent-delete)

- **Status:** accepted (ratified by operator decision, 2026-07-20 — Marat Basyrov, session 260720; PART-X plan approval)
- **Date:** 2026-07-20
- **Authority context:** CANONICAL_DOMAIN_MODEL §3 resource scope ("resources BIND, never copy"); mig 016 `project_source_bindings` (source_kind incl. github_repo; status lifecycle); mig 067 `read_policy` → Index/Rely/Operate tiers; ADR-XB-005 (events are not work items); mig 044 recoverability (soft-delete + rollback window); the 260720 census root-cause verification.

## Decision

External tools (GitHub — and later Linear, Jira, Trello, calendars, drives) connect to Xlooop as
**Resources**, under one contract:

1. **Opt-in, always.** Nothing external is ingested until the user connects the resource from the
   Resources pane (`pending_auth → connected`). No auto-discovery ingestion.
2. **Trust tier per resource — the noise control.** The user picks the resource's `read_policy`:
   **Index** (metadata only — findable, never grounds answers) · **Rely** (content may ground
   context) · **Operate** (may drive work proposals). Default = Index. The tier is shown on the
   resource card and in the composer's context preview.
3. **Pause / resume at will.** Pausing stops NEW ingestion immediately; resuming continues. The
   binding status lifecycle carries this; no data is touched by a pause.
4. **Disconnect ARCHIVES — it never silently deletes.** Turning a resource off stops ingestion AND
   archives its previously-synced entries: hidden from rails, EXCLUDED from context assembly,
   restorable on reconnect. Hard removal happens only through the explicit deletion path
   (soft-delete → rollback window → purge), the same recoverability contract as everything else.
   A toggle must never destroy history.
5. **Imported issues/tasks arrive as PROPOSALS, never as work items.** External activity ingests as
   ACTIVITY RECORDS (events) with an ingest receipt; issue-shaped items (GitHub Issues, Jira tickets)
   surface through the proposal promote/reject flow — the user promotes what belongs in their
   planning model. Never auto-created WorkItems; never fabricated intents (ADR-XB-005 + the
   signal-pollution prohibition).
6. **Governance of external activity = receipt + binding, not intent-causes.** An external event's
   lineage obligation is: WHICH resource, WHAT policy tier, WHEN ingested (the ingest receipt).
   Intent-causation is required only of GOVERNED effects (packets/decisions/internal governance
   events). The customer census therefore splits its cause-orphan class:
   `external_activity_without_receipt` (external events lacking a resource binding/receipt — fix by
   binding) vs `governed_effect_without_cause` (governed effects lacking causation — fix by carrying
   causation).

## The customer-zero application (measured, 260720)

mbp-private's 2,047 cause-orphans are MB-P's OWN governance telemetry (governance_events,
session_bundles, skill_invocations, packets, signals) materialized without causation links — their
causes exist upstream in MB-P. Fix: the MB-P projection carries each governance row's causal parent
id so cause-edges materialize as REAL lineage (the UGEC dogfood clause: customer-zero is not exempt).
Plus: the graph/census unified read is capped at 5000 rows and mbp-private sits at 4,212 — the
census must count via SQL and flag truncation explicitly, never silently.

## Consequences

- The user's mental model holds everywhere: "I connect, I choose trust, I can pause, off never
  destroys my history."
- One integration contract for every future provider; connectors differ only in transport.
- The census stays honest at customer scale without ever asking customers' external activity for
  intent-causes.
