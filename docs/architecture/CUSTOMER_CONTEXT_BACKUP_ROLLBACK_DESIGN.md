# Customer Context Backup & Rollback — Design (260626)

**Status:** roadmap spec (P1 done, P2/P3 proposed) · **Owner:** product + governance
**Problem:** customers create context (intents, task packets, evidence, approvals, learning
signals); they need durable backup and the ability to **roll back to a previous version**.
Early/test stage wants this **free and customer-controllable** (GitHub).

## Current reality
- Customer data lives in the **Neon Postgres operational spine** (`task_packets`, `evidence`,
  `operation_events`, `customer_api_tokens`, …).
- `operation_events` **content is append-only** (ADR-XLOOP-IA-001) → the spine is already an
  event log, i.e. a logical version history.
- Neon supports **point-in-time-restore (PITR) / branch-from-timestamp**, bounded by
  `history_retention_seconds` (was 6h on prod `flat-truth-23350426`; bump to 7d — see ops note).
- There is **no external backup / git mirror today** — this design adds it.

## Three layers of rollback (defence in depth)
| Layer | Mechanism | Scope | Status |
|---|---|---|---|
| L1 logical | replay the append-only `operation_events` to a prior point | in-product, per tenant | exists (replay path to surface, P2) |
| L2 database | Neon PITR / branch-from-timestamp | whole DB, retention-bounded | exists; **retention 6h→7d (P1)** |
| L3 external | **per-tenant private GitHub mirror** of exported context | customer-controllable, free, portable | **proposed (P3)** |

## L3 — Per-tenant GitHub mirror (the new layer)
**Shape:** one **private** GitHub repo per tenant (e.g. `xlooop-context-<workspace_slug>`).
A scheduled/milestone **export job** reads the tenant's spine **through the existing
tenant-scoped DAL** (never cross-tenant), serialises intents/packets/evidence/approvals to
versioned files (JSON + human MD), then `git commit && push`. Git history = the version trail;
**rollback = `git revert`/checkout** to a prior commit.

**Non-negotiables (each maps to existing canon):**
- **Consent-gated** — only when the customer enables it AND their DPA covers data leaving to
  GitHub. Reuse the existing **Workspace Authority / consent** model (the `authority_v1` consent
  already shown in the Developer Access Center).
- **Redacted** — strip forbidden surfaces before any export. Reuse `verify_external_demo_redaction`
  (no secrets, no raw graph, no cross-company data, no operator tokens).
- **Tenant-isolated** — one repo per tenant; the export job is workspace-scoped (same fail-closed
  DAL as the connector).
- **Server-side auth** — a GitHub App / fine-grained PAT scoped to that tenant's repo, held as a
  worker secret; **never** a client-exposed credential (the connector-token leak lesson).
- **Restore is forward-append, never destructive** — importing a prior GitHub snapshot replays it
  back into the spine as **new append-only events** (consistent with ADR-XLOOP-IA-001); we never
  mutate/overwrite history. "Rollback" = a new state derived from the old snapshot.

**SSOT:** the Neon spine stays authoritative. GitHub is a **versioned projection / backup**, not
the source of truth — same role the graph plays in MB-P (derived index, not SSOT).

## Why GitHub for early customers
Free (private repos), versioned by default, customer can hold/own the repo (portability + trust),
and the ecosystem already proves the "git as versioned context store" pattern (MB-P itself).
Re-evaluate vs object-storage + WORM backup when customers exceed GitHub's practical limits or
need formal retention SLAs.

## Risks / open questions
- Data residency: customer data → GitHub requires explicit DPA coverage + per-tenant consent.
- Redaction correctness is load-bearing — gate every export with the redaction verifier in
  blocking mode (no advisory).
- GitHub API rate limits + large-tenant volume → batch + incremental commits.
- Restore semantics must be reviewed against the append-only IA gate before build.

## Phasing
- **P1 (now):** bump Neon `history_retention_seconds` 21600 → 604800 (7d). Ops-only setting.
- **P2:** surface "restore to timestamp" via existing event replay (in-product).
- **P3:** the per-tenant GitHub mirror (consent + redaction gated), with verifiers
  `verify-customer-backup-redaction` + `verify-tenant-backup-repo-isolation`.

## Verification (when built)
- Export of tenant A never contains tenant B data or any forbidden surface (redaction verifier).
- Restore replays as new append-only events; original history intact (IA gate).
- Backup repo is private + scoped; the PAT cannot reach other tenants' repos.
