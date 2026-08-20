-- 103_chat_thread_audit_target.sql
--
-- Migration 102 introduced explicit project chat-thread lifecycle writes. Those writes are
-- intentionally atomic with an audit_logs row, but the existing target_type CHECK was not widened
-- to admit `chat_thread`. Production therefore rejected the audit insert and rolled back every new
-- thread with HTTP 500. Add the missing target without weakening or removing any existing value.

BEGIN;

DO $$
DECLARE cn text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM workers_schema_version WHERE version = 103) THEN
    SELECT conname INTO cn
      FROM pg_constraint
     WHERE conrelid = 'public.audit_logs'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) LIKE '%target_type%'
     LIMIT 1;
    IF cn IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.audit_logs DROP CONSTRAINT %I', cn);
    END IF;

    ALTER TABLE public.audit_logs
      ADD CONSTRAINT audit_logs_target_type_check CHECK (target_type IN (
        'user', 'workspace_member', 'access_request', 'workspace', 'project',
        'synthetic_domain', 'synthetic_domain_roadmap', 'synthetic_domain_roadmap_item',
        'synthetic_domain_goal', 'synthetic_domain_propagation_rule',
        'synthetic_domain_recommendation', 'event', 'packet', 'decision', 'sign_off',
        'api_token', 'session', 'model_runtime_provider', 'chat_thread'
      ));

    INSERT INTO workers_schema_version (version, description, applied_at)
    VALUES (
      103,
      'admit receipt-backed project chat-thread lifecycle rows in the governance audit trail',
      now()
    );
  END IF;
END $$;

COMMIT;
