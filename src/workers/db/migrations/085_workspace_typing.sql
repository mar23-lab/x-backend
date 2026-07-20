-- 085_workspace_typing.sql · STAGED ONLY, never auto-applied.
-- Wave Q-A (260720) · workspace type discriminator + relationship status. The workspaces table (001)
-- has NO type column, so every enumeration treats all rows as tenants — the customer census
-- (crons/customer-census.ts) counts the five MB-P projection MIRRORS (seeded by
-- scripts/seed-legitimate-mbp-catalog.mjs) and the bootstrap org as if they were customers, a live
-- telemetry defect. This migration adds two CHECK-constrained TEXT discriminators and backfills the
-- 10 known prod rows per the ratified PART Q classification (measured 260720). Column defaults
-- ('company' / 'internal_dogfood') mean any workspace created by the existing provisioning paths is
-- classified conservatively with NO code change. OBSERVE-only consumers filter on it; this migration
-- switches NO authority and flips NO flag.
--
-- Apply MANUALLY (operator-applied, per repo policy — migrations are never auto-applied):
--   psql "$DATABASE_URL" -f src/workers/db/migrations/085_workspace_typing.sql
--   -- or via Neon MCP on project flat-truth-23350426 after review.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM workers_schema_version WHERE version = 85) THEN
    ALTER TABLE workspaces
      ADD COLUMN IF NOT EXISTS workspace_type TEXT NOT NULL DEFAULT 'company'
        CHECK (workspace_type IN ('personal','company','mirror','bootstrap','external')),
      ADD COLUMN IF NOT EXISTS relationship_status TEXT NOT NULL DEFAULT 'internal_dogfood'
        CHECK (relationship_status IN (
          'internal_dogfood','customer_zero','external_evaluation','pilot_candidate',
          'pilot_contracted','customer_active','customer_inactive','commercial_partner',
          'technology_partner','vendor','archived'));

    -- Backfill · the 10 prod rows classified in the Q-A census (260720). Explicit per-id UPDATEs:
    -- each is a no-op when the row is absent, so this is safe on any estate (dev/preview/prod).

    -- Operator personal workspace — the customer-zero tenant.
    UPDATE workspaces SET workspace_type = 'personal', relationship_status = 'customer_zero'
      WHERE id = 'mbp-private';

    -- MB-P projection mirrors (seed-legitimate-mbp-catalog.mjs) — NOT tenants.
    UPDATE workspaces SET workspace_type = 'mirror', relationship_status = 'internal_dogfood'
      WHERE id = 'xcp-platform';
    UPDATE workspaces SET workspace_type = 'mirror', relationship_status = 'internal_dogfood'
      WHERE id = 'xlooop';
    UPDATE workspaces SET workspace_type = 'mirror', relationship_status = 'internal_dogfood'
      WHERE id = 'x-biz';
    UPDATE workspaces SET workspace_type = 'mirror', relationship_status = 'internal_dogfood'
      WHERE id = 'x-docs';
    UPDATE workspaces SET workspace_type = 'mirror', relationship_status = 'internal_dogfood'
      WHERE id = 'x-front';

    -- Bootstrap org (operator self-bootstrap artifact) — NOT a tenant.
    UPDATE workspaces SET workspace_type = 'bootstrap', relationship_status = 'internal_dogfood'
      WHERE id = 'org_3EIO8YYcUTtjOQ9d1i7eh8mvBFv';

    -- Company workspace, internal dogfood.
    UPDATE workspaces SET workspace_type = 'company', relationship_status = 'internal_dogfood'
      WHERE id = 'org_3EG82VEzc8t3t65XSZ0YDlcaDMI';

    -- External evaluators (Andrey Petrushko · Honest & Young).
    UPDATE workspaces SET workspace_type = 'external', relationship_status = 'external_evaluation'
      WHERE id = 'org_3EI1DMHEdA0hVvtqxYYuwYTMXgm';
    UPDATE workspaces SET workspace_type = 'external', relationship_status = 'external_evaluation'
      WHERE id = 'org_3EI0xhBsYKWHbLmtjdvNVY6Yqhz';

    INSERT INTO workers_schema_version (version, description, applied_at)
    VALUES (85, 'workspace typing: workspace_type + relationship_status discriminators, 10-row Q-A census backfill; no authority switch', now());
  END IF;
END $$;

COMMIT;

-- Verify (read-only, after apply):
--   SELECT id, workspace_type, relationship_status FROM workspaces ORDER BY id;
--   SELECT count(*) FROM workspaces WHERE workspace_type IN ('mirror','bootstrap');  -- expect 6
--   SELECT version, description FROM workers_schema_version WHERE version = 85;
