-- 102_project_chat_threads.sql
--
-- Promote conversational memory from one implicit thread per user/scope to an explicit
-- project-scoped ChatThread aggregate. Existing deterministic threads remain the legacy/default
-- thread, so no history is moved or discarded. New threads use opaque server-generated ids.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM workers_schema_version WHERE version = 102) THEN
    ALTER TABLE public.chat_threads
      ADD COLUMN IF NOT EXISTS title text,
      ADD COLUMN IF NOT EXISTS title_source text,
      ADD COLUMN IF NOT EXISTS status text,
      ADD COLUMN IF NOT EXISTS archived_at timestamptz,
      ADD COLUMN IF NOT EXISTS last_message_at timestamptz;

    UPDATE public.chat_threads
       SET title = COALESCE(NULLIF(btrim(title), ''), 'Conversation'),
           title_source = COALESCE(NULLIF(title_source, ''), 'legacy'),
           status = COALESCE(NULLIF(status, ''), 'active'),
           last_message_at = COALESCE(
             last_message_at,
             (SELECT max(m.created_at) FROM public.chat_messages m WHERE m.thread_id = chat_threads.id),
             updated_at,
             created_at
           );

    ALTER TABLE public.chat_threads
      ALTER COLUMN title SET DEFAULT 'New chat',
      ALTER COLUMN title SET NOT NULL,
      ALTER COLUMN title_source SET DEFAULT 'default',
      ALTER COLUMN title_source SET NOT NULL,
      ALTER COLUMN status SET DEFAULT 'active',
      ALTER COLUMN status SET NOT NULL;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chat_threads_title_length_check') THEN
      ALTER TABLE public.chat_threads
        ADD CONSTRAINT chat_threads_title_length_check CHECK (char_length(title) BETWEEN 1 AND 120);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chat_threads_title_source_check') THEN
      ALTER TABLE public.chat_threads
        ADD CONSTRAINT chat_threads_title_source_check CHECK (title_source IN ('default', 'auto', 'manual', 'legacy'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chat_threads_status_check') THEN
      ALTER TABLE public.chat_threads
        ADD CONSTRAINT chat_threads_status_check CHECK (status IN ('active', 'archived'));
    END IF;

    CREATE INDEX IF NOT EXISTS idx_chat_threads_project_recent
      ON public.chat_threads (workspace_id, project_id, user_id, status, last_message_at DESC, updated_at DESC);

    INSERT INTO workers_schema_version (version, description, applied_at)
    VALUES (
      102,
      'project-scoped multi-chat threads with title, lifecycle, and recent-activity ordering',
      now()
    );
  END IF;
END $$;

COMMIT;
