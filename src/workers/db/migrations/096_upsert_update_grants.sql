-- 096_upsert_update_grants.sql
--
-- APPLIED TO PRODUCTION 2026-08-04. **THIS IS THE MIGRATION THAT ACTUALLY FIXED THE 500.**
--
--     BEFORE:  POST /api/v1/intake/<id>/execute -> 500 {"code":"42501"}
--     AFTER:   POST /api/v1/intake/<id>/execute -> 200 {"ok":true,"resolution":{...},"receipt":...,
--                                                       "read_model_watermark":...,"packet_id":...}
--     Downstream calls that had been failing now return 200 as well: /packets, /projects/:id/events,
--     /customer-chat/history.
--
-- WHY. `executeIntakeResolutionRow` performs TWO upserts, and an `ON CONFLICT ... DO UPDATE`
-- requires the UPDATE privilege in addition to INSERT:
--
--     chat_threads    ON CONFLICT (id) DO UPDATE SET updated_at = now()
--     chat_messages   ON CONFLICT (thread_id, interaction_id, entry_type)
--                       WHERE interaction_id IS NOT NULL AND entry_type IS NOT NULL
--                     DO UPDATE SET thread_id = EXCLUDED.thread_id
--
-- 094 granted INSERT on both and 095 fixed the chat_messages policy; neither granted UPDATE, so the
-- statement still failed 42501 at the first upsert.
--
-- HOW IT WAS FINALLY FOUND — the method matters more than the fix.
-- Six earlier rounds guessed at the failing object by hand-building small probe statements. Every one
-- of them lost fidelity against an 11,447-character, 13-CTE statement, and four died on my own wrong
-- column names. What worked was REPLAYING THE ACTUAL STATEMENT: extract the tagged-template SQL from
-- intake-store.ts, substitute all 44 parameters, and run it as xlooop_app via SET ROLE on a
-- disposable branch copy of production. Postgres then names the object directly:
--
--     permission denied for table chat_threads     -> GRANT UPDATE -> re-run
--     permission denied for table chat_messages    -> GRANT UPDATE -> re-run
--     SQLSTATE 42601 "query has no destination"    -> NOT a permission error: the statement now runs
--                                                     end to end; the DO-block wrapper simply cannot
--                                                     consume a returning SELECT. Wrapping it in
--                                                     CREATE TEMP TABLE _out AS <stmt> -> SUCCEEDED.
--
-- A grep for `ON CONFLICT.*DO UPDATE` found only ONE of the two upserts, because the second spans
-- three lines. Single-line regexes over multi-line SQL under-report; that miss cost a full round.
--
-- 42501 means BOTH "permission denied" AND "row-level security policy violation". Distinguish them by
-- the message text, not the code: "permission denied for table X" is a GRANT; "new row violates
-- row-level security policy for table X" is a POLICY.
--
-- RECOMMENDED GATE (not built here): every `ON CONFLICT ... DO UPDATE` target must hold UPDATE for
-- the RLS app role. That is statically checkable from the DAL sources plus information_schema, and it
-- would have caught this before deploy.

BEGIN;

GRANT UPDATE ON public.chat_threads  TO xlooop_app;   -- ON CONFLICT (id) DO UPDATE
GRANT UPDATE ON public.chat_messages TO xlooop_app;   -- ON CONFLICT (thread_id, interaction_id, entry_type) DO UPDATE

INSERT INTO workers_schema_version (version, description, applied_at)
VALUES (96, 'UPDATE grants on the two ON CONFLICT DO UPDATE targets (chat_threads, chat_messages) — fixes the live 42501 on intake execute', now());

COMMIT;

-- READ-ONLY POSTFLIGHT — both must include UPDATE:
--   SELECT table_name, string_agg(privilege_type, ',' ORDER BY privilege_type)
--   FROM information_schema.role_table_grants
--   WHERE grantee='xlooop_app' AND table_name IN ('chat_threads','chat_messages')
--   GROUP BY table_name;
