-- 065_idempotency_keys.sql · Migration-adoption wave Y (260711) · STAGED until operator applies.
--
-- WHY (the write-path cutover unlock): the migration ladder (§220-B) forks by verb — reads can shadow,
-- but a WRITE slice cannot reach "wired" until a client retry can't double-write. There was NO
-- request-level idempotency mechanism in the backend (POST /packets, /mcp/tool-events were plain INSERTs;
-- only POST /events de-duped, and only on a caller-supplied ROW id). This table is the substrate: one row
-- per (workspace, Idempotency-Key), storing the first successful response so a retry REPLAYS it instead of
-- re-executing the handler.
--
-- RESERVE-FIRST shape (concurrency-correct): response_status/response_body are NULLABLE. A request first
-- reserves the key (INSERT ... ON CONFLICT DO NOTHING); the winner owns it and executes the handler, then
-- COMPLETEs the row with the response; a concurrent second caller finds the row (reserved but not yet
-- completed) and gets 409 in-progress, or (once completed) the replayed response. A non-2xx handler
-- RELEASEs its reservation so a genuine retry can proceed. Per-workspace scoped + RLS (043/053 recipe).
--
-- Consumer flag: IDEMPOTENCY_ENABLED (default off ⇒ the helper returns the handler directly, byte-identical,
-- no DB touch, no header cost). Degrade-safe: pre-065 schemas fail OPEN to normal execution (the flag being
-- on before the table exists must never 500 a write). created_at index supports a future TTL purge cron
-- (v1 backlog — keys accrue only when flag-on AND a client sends the header, rare until cutover).
-- Validate against a throwaway local Postgres before commit; prod apply is OPERATOR-NAMED.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM workers_schema_version WHERE version = 65) THEN

    CREATE TABLE IF NOT EXISTS idempotency_keys (
      id              BIGSERIAL PRIMARY KEY,
      workspace_id    TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      route           TEXT NOT NULL,
      response_status INTEGER,
      response_body   JSONB,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      completed_at    TIMESTAMPTZ,
      CONSTRAINT idempotency_keys_key UNIQUE (workspace_id, idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS idempotency_keys_created_idx
      ON idempotency_keys (created_at);

    -- RLS second layer (043/053 recipe): the RLS-subject client sees only its GUC workspace.
    IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'xlooop_rls_workspace_id') THEN
      ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS idempotency_keys_workspace_policy ON idempotency_keys;
      CREATE POLICY idempotency_keys_workspace_policy ON idempotency_keys
        USING (workspace_id = xlooop_rls_workspace_id())
        WITH CHECK (workspace_id = xlooop_rls_workspace_id());
    END IF;

    INSERT INTO workers_schema_version (version, description, applied_at)
    VALUES (65, 'Wave-Y idempotency_keys: per-(workspace,Idempotency-Key) reserve/replay store — the write-path cutover unlock (§220-B)', now());
  END IF;
END $$;

COMMIT;

-- Verify (read-only, after apply):
--   SELECT count(*) FROM information_schema.tables WHERE table_name='idempotency_keys';
--   SELECT conname FROM pg_constraint WHERE conname='idempotency_keys_key';
