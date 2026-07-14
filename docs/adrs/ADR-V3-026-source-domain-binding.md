# ADR-V3-026 - Knowledge sources attach to domains (source→domain binding)

**Status:** Accepted
**Date:** 2026-06-13
**Decision-makers:** Marat, Claude session `w1/pr4-sources-domains`
**Supersedes:** none
**Cross-link:** `src/workers/db/migrations/033_project_source_domain_link.sql` · `docs/adrs/ADR-V3-025-w0-three-surface-ia-takeover.md` · `docs/frontend/w1-clarity/README.md` (PR-4) · migration 028 (`synthetic_domains` kind + source_context)

## Context

ADR-V3-025 cross-linked an ADR-V3-026 that was never written (doc debt). It is authored here, describing the source→domain model that W1′-PR4 actually shipped.

The operator's mental model is **knowledge sources → domains**: connect a Google Drive / GitHub / Dropbox / desktop folder, and it feeds a domain (a context-lens). Before W1′, source bindings (`project_source_bindings`, migration 016) attached only to a **project**; the source cards in the UI were proposal-only (a DOM-event "receipt" that persisted nothing). Migration 028 had already established that a Domain is one primitive (`synthetic_domains`) with a `kind` discriminator and that "connect-a-source auto-links by context".

## Decision

A source binding may carry an optional **`domain_id`** — a nullable backref to the `synthetic_domains` lens it feeds.

- **One primitive, one extra column.** `domain_id` is added to the existing `project_source_bindings` aggregate (migration 033), not a new `domain_source_bindings` join table. This follows HR-NO-PARALLEL-MODEL-1 (a relationship on an existing aggregate, not a new aggregate) and matches the 028 precedent (`kind` / `source_domain_id` are discriminator/backref columns on `synthetic_domains`, not new tables).
- **Nullable / additive.** `domain_id IS NULL` is the prior project-only binding, unchanged. No backfill, no L0 mutation.
- **Tenant-safe.** A customer may see which of *their* domains a source feeds; unlike 028's `source_domain_id` (operator construction IP, stripped), `domain_id` carries no IP boundary concern.
- **Real connect path.** `POST /api/v1/projects/:id/sources` accepts `domain_id`; the DAL persists + returns it; the UI "Connect" button (cockpit + Workspace landing) calls the real `XcpApi.createProjectSource`, mapping the display kind to the binding enum (`google_drive→google_drive_folder`, `github→github_repo`, `folder→desktop_folder`, else `manual`).
- **Manual prod apply.** Like 028, migration 033 is applied to prod manually (operator-gated); `verify-prod-migrations` reports it apply-pending until then. Committing the migration does not touch production data.

## Consequences

Positive:
- Sources attach at the domain level — the operator's stated model — without a parallel table.
- The proposal-only fake is replaced with a real, append-safe persistence path.
- Idempotent, additive, reversible (a nullable column + a partial index).

Negative / cost:
- `domain_id` is populated only when a domain/lens is selected; in the sample-data demo it is `null` until selection (honest — no fabricated attachment).
- The full OAuth round-trip (identity → `user_source_connections` → binding) for Drive/GitHub is a separate existing flow (`sources.ts`); PR-4 wires the binding + domain attachment, not a new OAuth UX.

## Non-decisions

- Did NOT add a `domain_source_bindings` join table (rejected: parallel model).
- Did NOT change the OAuth connect flow or the `source_kind` enum.
- Did NOT auto-apply the migration to production.

## Verification

- `verify-prod-migrations` lists 033 (apply-pending).
- `verify-source-binding-tenant-isolation` + `verify-source-domain-project-taxonomy` PASS.
- In-browser (stubbed API): Connect fires `createProjectSource('xlooop-product', { source_kind: 'google_drive_folder', domain_id, status: 'pending_auth', read_policy: 'metadata_only' })`.
- `npm run typecheck` clean; `npm run ci-local` 38/38.

## Re-evaluation triggers

- A source needs to feed **multiple** domains simultaneously (would justify a join table — revisit then).
- The OAuth connect UX is built out (Drive/GitHub redirect round-trip) and needs domain selection in-flow.
