-- 099_chat_answer_audit_idempotency.sql · staged commercial chat audit identity.
--
-- One customer chat interaction can be retried by clients or providers. The assistant answer and its
-- append-only audit event must therefore converge on one identity before the commercial API returns a
-- success receipt. This partial unique index contains no prompt/answer content and is tenant + actor
-- scoped, so one user's client request id cannot collide with another user's interaction.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM workers_schema_version WHERE version = 99) THEN
    CREATE UNIQUE INDEX IF NOT EXISTS audit_logs_customer_chat_answer_key
      ON audit_logs(workspace_id, actor_user_id, action, target_type, target_id)
      WHERE action = 'customer_chat_answer' AND target_type = 'session';

    INSERT INTO workers_schema_version (version, description, applied_at)
    VALUES (
      99,
      'Idempotent tenant- and actor-scoped customer chat answer audit identity',
      now()
    );
  END IF;
END $$;

COMMIT;
