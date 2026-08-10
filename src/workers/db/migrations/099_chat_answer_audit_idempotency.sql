-- 099_chat_answer_audit_idempotency.sql · staged commercial chat audit identity.
--
-- One customer chat interaction can be retried by clients or providers. The assistant answer and its
-- append-only audit event must therefore converge on one identity before the commercial API returns a
-- success receipt. This partial unique index contains no prompt/answer content and is tenant + actor
-- scoped, so one user's client request id cannot collide with another user's interaction.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM audit_logs
    WHERE action = 'customer_chat_answer' AND target_type = 'session'
    GROUP BY workspace_id, actor_user_id, action, target_type, target_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'migration 099 blocked: duplicate customer_chat_answer audit identities exist';
  END IF;
END $$;

-- The audit table can be large. CONCURRENTLY avoids blocking normal reads/writes while the unique
-- identity is established. PostgreSQL forbids this command inside a transaction block.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS audit_logs_customer_chat_answer_key
  ON audit_logs(workspace_id, actor_user_id, action, target_type, target_id)
  WHERE action = 'customer_chat_answer' AND target_type = 'session';

INSERT INTO workers_schema_version (version, description, applied_at)
VALUES (
  99,
  'Idempotent tenant- and actor-scoped customer chat answer audit identity',
  now()
)
ON CONFLICT (version) DO NOTHING;
