-- 093_strict_idempotency_and_atomic_projects.sql
-- Split retry protection from authority-grade idempotency without creating a second store.
--
-- Existing rows remain ordinary_retry_guard records. Strict commands bind an idempotency key to
-- workspace + actor + route + request digest and must persist the replay response in the same SQL
-- statement as the business effect. The partial indexes let ordinary callers retain their historical
-- workspace-wide key namespace while authority commands use the narrower actor/route namespace.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM workers_schema_version WHERE version = 93) THEN
    ALTER TABLE idempotency_keys
      ADD COLUMN IF NOT EXISTS actor_user_id TEXT,
      ADD COLUMN IF NOT EXISTS request_sha256 TEXT,
      ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'ordinary_retry_guard';

    UPDATE idempotency_keys
    SET mode = 'ordinary_retry_guard'
    WHERE mode IS NULL;

    ALTER TABLE idempotency_keys
      DROP CONSTRAINT IF EXISTS idempotency_keys_key;

    CREATE UNIQUE INDEX IF NOT EXISTS idempotency_keys_ordinary_key
      ON idempotency_keys (workspace_id, idempotency_key)
      WHERE mode = 'ordinary_retry_guard';

    CREATE UNIQUE INDEX IF NOT EXISTS idempotency_keys_authority_key
      ON idempotency_keys (workspace_id, actor_user_id, route, idempotency_key)
      WHERE mode = 'authority_strict';

    ALTER TABLE idempotency_keys
      DROP CONSTRAINT IF EXISTS idempotency_keys_mode_check;
    ALTER TABLE idempotency_keys
      ADD CONSTRAINT idempotency_keys_mode_check CHECK (
        (
          mode = 'ordinary_retry_guard'
          AND actor_user_id IS NULL
          AND request_sha256 IS NULL
        )
        OR
        (
          mode = 'authority_strict'
          AND actor_user_id IS NOT NULL
          AND btrim(actor_user_id) <> ''
          AND request_sha256 ~ '^[a-f0-9]{64}$'
        )
      );

    INSERT INTO workers_schema_version (version, description, applied_at)
    VALUES (
      93,
      'Authority-strict idempotency mode with actor, route, request-digest binding; ordinary retry guard preserved',
      now()
    );
  END IF;
END $$;

CREATE OR REPLACE FUNCTION xlooop_assert_authority_complete(
  complete BOOLEAN,
  authority_name TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NOT complete THEN
    RAISE EXCEPTION 'xlooop authority incomplete: %', authority_name
      USING ERRCODE = '23514';
  END IF;
  RETURN TRUE;
END;
$function$;

COMMIT;

-- Verify after apply (read-only):
--   SELECT column_name, is_nullable, column_default
--   FROM information_schema.columns
--   WHERE table_name = 'idempotency_keys'
--     AND column_name IN ('actor_user_id', 'request_sha256', 'mode');
--   SELECT indexname, indexdef
--   FROM pg_indexes
--   WHERE tablename = 'idempotency_keys'
--     AND indexname IN ('idempotency_keys_ordinary_key', 'idempotency_keys_authority_key');
