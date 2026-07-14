-- 061_feedback.sql · T6 (260710) · Test-mode feedback persistence — STAGED until operator applies.
--
-- WHY: FeedbackAnnotations (the Test-mode capture channel, xcp-mode-core.js gates it on mode==='test')
-- stores annotations ONLY in localStorage (xlooop.feedback.queue.v1) — feedback never reaches the operator.
-- Operator scope (260710): improve the widget and use it as the Test-mode channel. This is the persistence
-- half: a tenant-scoped feedback table the widget submits to (flag FEEDBACK_PERSISTENCE_ENABLED, default
-- OFF) and the operator reads.
--
-- RLS second layer per the 043/053/059 house recipe (xlooop_rls_workspace_id(), guarded by pg_proc check).
-- Validate against a throwaway local Postgres before commit; prod apply is OPERATOR-NAMED.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM workers_schema_version WHERE version = 61) THEN

    CREATE TABLE IF NOT EXISTS feedback (
      id            TEXT PRIMARY KEY,
      workspace_id  TEXT NOT NULL,
      user_id       TEXT NOT NULL,
      body          TEXT NOT NULL CHECK (char_length(body) <= 2000),
      target_label  TEXT,                          -- the clicked element's label/testid (widget-supplied)
      page          TEXT,                          -- the page/route the annotation was made on
      mode          TEXT NOT NULL DEFAULT 'test',  -- the operating mode at capture time
      status        TEXT NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open', 'acknowledged', 'resolved', 'dismissed')),
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS feedback_ws_created_idx ON feedback (workspace_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS feedback_ws_user_day_idx ON feedback (workspace_id, user_id, created_at);

    IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'xlooop_rls_workspace_id') THEN
      ALTER TABLE feedback ENABLE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS feedback_workspace_policy ON feedback;
      CREATE POLICY feedback_workspace_policy ON feedback
        USING (workspace_id = xlooop_rls_workspace_id())
        WITH CHECK (workspace_id = xlooop_rls_workspace_id());
    END IF;

    INSERT INTO workers_schema_version (version, description, applied_at)
    VALUES (61, 'T6 feedback: tenant-scoped Test-mode feedback persistence (widget -> operator)', now());
  END IF;
END $$;

COMMIT;

-- Verify (read-only, after apply):
--   SELECT count(*) FROM information_schema.tables WHERE table_name='feedback';
