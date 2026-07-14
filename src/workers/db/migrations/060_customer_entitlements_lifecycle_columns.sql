-- 060_customer_entitlements_lifecycle_columns.sql · UI-compat gap closure (260708) · STAGED until operator applies.
--
-- WHY: the entitlement reader (dal/entitlement-store.ts toAppEntitlement) already maps AppEntitlement.expires_at
-- and .review_due, but customer_entitlements has NO such columns (migration 018 created it without them), so the
-- reader hard-codes both to null with a "no column yet" note and an explicit "do not fake them" rule. The new
-- cockpit UI's entitlement/authority surface expects these lifecycle fields (when does this grant expire, when is
-- it due for review). This adds them ADDITIVELY (nullable, no default) so the reader can surface real values.
--
-- SAFETY: purely additive nullable columns — zero behavioural change to any existing read/write. The entitlement
-- reader is only consulted on the flag-ON path (ENTITLEMENT_ENFORCEMENT), which is OFF, so this is inert in prod
-- until the operator flips. status is STILL derived from revoked_at (this migration does NOT introduce expiry-based
-- denial — that would be a separate, named enforcement decision). Backfill: none (all existing grants get NULL =
-- "no expiry / no review scheduled", the safe open-ended default).
--
-- Validate against a throwaway local Postgres before commit; prod apply is OPERATOR-NAMED.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM workers_schema_version WHERE version = 60) THEN

    ALTER TABLE customer_entitlements
      ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS review_due TIMESTAMPTZ;

    -- Partial index: only the rows that actually carry a review date (keeps the index tiny; supports a future
    -- "grants due for review" operator sweep without scanning open-ended grants).
    CREATE INDEX IF NOT EXISTS customer_entitlements_review_due_idx
      ON customer_entitlements (review_due)
      WHERE review_due IS NOT NULL;

    INSERT INTO workers_schema_version (version, description, applied_at)
    VALUES (60, 'customer_entitlements lifecycle columns: expires_at + review_due (additive, nullable, no enforcement change)', now());
  END IF;
END $$;

COMMIT;

-- Verify (read-only, after apply):
--   SELECT column_name FROM information_schema.columns
--     WHERE table_name='customer_entitlements' AND column_name IN ('expires_at','review_due');
