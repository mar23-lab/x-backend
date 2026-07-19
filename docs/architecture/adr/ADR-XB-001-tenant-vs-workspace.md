# ADR-XB-001 — Tenant vs Workspace

- **Status:** proposed (awaiting operator ratification — N-UX.0)
- **Date:** 2026-07-20
- **Owner:** marat
- **Relates:** CANONICAL_DOMAIN_MODEL.md §1/§3; external assessment "workspace-as-company / missing tenant boundary" (CONFIRMED by ground truth)

## Context

`workspaces` (mig 001) is today the tenant ROOT: it carries the legal/security boundary,
data isolation (RLS keys on `workspace_id`), entitlements, AND the user-facing operating
container — one table, two concepts. The conflation leaks into copy ("workspace = your
company") and blocks a clean multi-workspace-per-customer future. Both external
assessments flagged it; the ground-truth extraction confirmed no separate
Tenant/Organisation entity exists anywhere in 001→084.

## Decision

Ratify the DEFINITIONS now; defer the structure:

1. **workspace** = the operating context — the container a user works inside
   (projects, domains, plans, chats). UI term: *Workspace*.
2. **tenant** = the legal/security boundary — isolation, retention, entitlements,
   billing identity. UI term: *Organisation*. It is NOT a planning scope.
3. Today, one `workspaces` row plays both roles. The separate `tenant` entity is
   **introduced only when multi-workspace lands** (one tenant : many workspaces).
4. Effective immediately (no schema change): product copy, docs, and contracts stop
   using "workspace" to mean "company/organisation"; the DDD glossary carries both terms.

## Options considered

- **A. Introduce the tenants table now** — rejected: pure structural risk with zero
  current product need (every customer is single-workspace); a migration with no consumer.
- **B. Keep the conflation, fix later** — rejected: the vocabulary keeps leaking into
  copy, contracts, and new migrations; each leak raises the eventual migration cost.
- **C. Ratify definitions now, split structurally at multi-workspace (chosen)** —
  decision-risk only; every new artifact is written against the correct ontology.

## Consequences

- Copy/contract sweeps can cite one authority for the distinction.
- RLS stays keyed on `workspace_id` until the structural split; the split migration
  will re-key isolation to the tenant boundary with its own rollback ledger.
- The UI scope bar (N-UX.1) shows *Workspace*; *Organisation* appears only when the
  tenant entity exists.
