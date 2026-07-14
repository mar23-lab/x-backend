-- 014_operation_events_domain.sql · R55-W2 · life-domain tagging for operator captures · 2026-05-31
--
-- Wave 2 goal: make the operator's life-domains (Health, Finances, Career, …)
-- fillable and filterable. The chat composer (Wave 1) now persists captures as
-- real operation_events (Plane A, Neon). To let the board scope to a life-domain,
-- each event must carry WHICH domain it belongs to. operation_events (001_init)
-- has no domain column, so add one.
--
-- Why a column and not the synthetic_domain_membership join: the operator tags a
-- note to "Health" directly with no backing project; the membership table links
-- domains to PROJECTS only. A nullable domain_id is the lowest-complexity path and
-- keeps a single source of truth on the event itself. (Membership stays valid for
-- derived cross-cutting domains later.)
--
-- Safe class (identical to 012/013): additive, idempotent, version-gated. Nullable
-- column → all existing rows keep domain_id = NULL (board shows them under "all",
-- unaffected). No backfill, no data movement, no destructive change. Reversible by
-- dropping the column.
--
-- domain_id namespace: the canonical normalized form produced by normalizeDomainId()
-- on the client (e.g. 'mb-p:health' for a life-domain, 'mbp-governance' for a
-- governance domain). Stored verbatim; the board filter compares normalized ids.
--
-- Scope (R55-W2):
--   1. ALTER TABLE operation_events ADD COLUMN domain_id TEXT (nullable)
--   2. Partial index for the domain-scoped board read (domain_id IS NOT NULL)
--   3. Bump workers_schema_version to 14

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM workers_schema_version WHERE version = 14) THEN

    ALTER TABLE operation_events ADD COLUMN IF NOT EXISTS domain_id TEXT;

    -- Hot path: "events in this domain, newest first" for a workspace. Partial
    -- index keeps it small (only domain-tagged rows participate).
    CREATE INDEX IF NOT EXISTS idx_events_domain
      ON operation_events (workspace_id, domain_id, occurred_at DESC)
      WHERE domain_id IS NOT NULL;

    INSERT INTO workers_schema_version (version, applied_at, description)
    VALUES (
      14,
      now(),
      'R55-W2 · operation_events.domain_id · life-domain tagging for operator chat captures'
    );

  END IF;
END
$$;

COMMIT;
