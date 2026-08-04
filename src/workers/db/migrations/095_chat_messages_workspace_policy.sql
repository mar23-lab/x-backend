-- 095_chat_messages_workspace_policy.sql
--
-- APPLIED TO PRODUCTION 2026-08-04. Rollback snapshot: Neon branch br-sweet-pine-a7f72a4x
-- (pre-migration-095-claude-20260804).
--
-- WHY. The chat_messages RLS policy could not be satisfied inside the statement that writes it:
--
--     chat_messages_thread_workspace_policy:
--       EXISTS (SELECT 1 FROM chat_threads t
--               WHERE t.id = chat_messages.thread_id AND t.workspace_id = xlooop_rls_workspace_id())
--
-- `executeIntakeResolutionRow` creates the thread in a SIBLING CTE of the same statement. Every
-- data-modifying CTE reads the statement-start snapshot, so the just-created thread is INVISIBLE to
-- the policy check -> EXISTS false -> WITH CHECK fails -> SQLSTATE 42501.
--
-- PROVEN as xlooop_app (SET ROLE) on a disposable branch copy of production, with a control:
--     A  thread + message in SIBLING CTEs (what the code does)   -> 42501 "new row violates RLS policy"
--     B  thread, then message, as SEPARATE statements (control)  -> 23514 (only the probe's dummy
--                                                                   `role` failed a CHECK: it got
--                                                                   PAST the policy)
--
-- NOTE 42501 means BOTH "permission denied" AND "row-level security policy violation". That ambiguity
-- is why this reads as a grants problem and is not one. Migration 094 (grants) was necessary but NOT
-- sufficient; this is the policy half.
--
-- THE FIX. Give chat_messages its own workspace_id so the policy is SELF-CONTAINED and no statement
-- shape can break it again. The column DEFAULTs to the RLS context, so no application change is
-- required: an INSERT that omits workspace_id inherits the session's workspace and therefore
-- satisfies WITH CHECK by construction.
--
-- VERIFIED ON THE BRANCH BEFORE APPLYING (all three controls):
--     A  same-statement CTE (the production failure)  -> OK
--     B  explicit cross-tenant workspace_id           -> REFUSED (42501 RLS policy violation)
--     D  read isolation: owner sees 192 rows, app role sees 24 for one workspace -> SCOPED
--   Backfill on production: 191 of 191 rows populated, 0 NULL.
--
-- THE CLASS: same-statement CTE snapshot semantics, SECOND independent occurrence in this codebase.
-- The first was strict consent/revoke, where a CTE UPDATE could never match its sibling CTE INSERT.
-- This is the same rule surfacing through an RLS POLICY instead of a WHERE clause. When a statement
-- builds rows across sibling CTEs, check whether an RLS policy on one of them reads another.
--
-- KNOWN NOT-YET-RESOLVED: POST /api/v1/intake/:id/execute STILL returns 500/42501 after 094 and 095.
-- Both migrations are correct and independently proven, so at least one further 42501 source remains
-- in that 16,915-character statement. Do NOT assume this migration was wrong -- reproduce by replaying
-- the ACTUAL statement as xlooop_app rather than by hand-built approximations, which is where this
-- investigation kept losing fidelity.

BEGIN;

ALTER TABLE public.chat_messages ADD COLUMN IF NOT EXISTS workspace_id text;

UPDATE public.chat_messages m
   SET workspace_id = t.workspace_id
  FROM public.chat_threads t
 WHERE t.id = m.thread_id
   AND m.workspace_id IS DISTINCT FROM t.workspace_id;

-- Inherit the RLS context on insert, so callers need no change and WITH CHECK holds by construction.
ALTER TABLE public.chat_messages ALTER COLUMN workspace_id SET DEFAULT xlooop_rls_workspace_id();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
    WHERE c.relname = 'chat_messages' AND p.polname = 'chat_messages_workspace_policy'
  ) THEN
    EXECUTE 'CREATE POLICY chat_messages_workspace_policy ON public.chat_messages
             USING (workspace_id = xlooop_rls_workspace_id())
             WITH CHECK (workspace_id = xlooop_rls_workspace_id())';
  END IF;

  -- Drop the cross-row policy only AFTER the replacement exists, so the table is never unprotected.
  IF EXISTS (
    SELECT 1 FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
    WHERE c.relname = 'chat_messages' AND p.polname = 'chat_messages_thread_workspace_policy'
  ) THEN
    EXECUTE 'DROP POLICY chat_messages_thread_workspace_policy ON public.chat_messages';
  END IF;
END $$;

INSERT INTO workers_schema_version (version, description, applied_at)
VALUES (95, 'chat_messages.workspace_id + self-contained RLS policy (thread-EXISTS policy was unsatisfiable inside the same-statement CTE)', now());

COMMIT;

-- READ-ONLY POSTFLIGHT:
--   SELECT count(*) AS total, count(workspace_id) AS with_ws FROM chat_messages;   -- expect equal
--   SELECT polname FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid
--    WHERE c.relname='chat_messages';                        -- expect chat_messages_workspace_policy only
--   SELECT column_default FROM information_schema.columns
--    WHERE table_name='chat_messages' AND column_name='workspace_id';  -- expect xlooop_rls_workspace_id()
