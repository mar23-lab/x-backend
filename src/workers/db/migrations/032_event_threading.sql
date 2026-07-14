-- 032_event_threading.sql · comments-as-events: the parent_event_id thread pointer (OS-4 P1) · 2026-06-12
--
-- THE MALFUNCTION THIS FIXES: operator-capture.js FIX#3 (2026-06-09) sends parent_event_id on every
-- threaded reply, but operation_events has NO such column — upsertEventRow's explicit INSERT column
-- list silently dropped it, so every threaded reply since 2026-06-09 lost its parent link
-- (unrecoverable; content is append-only and the link existed nowhere else). This adds the pointer.
--
-- MODEL (GitHub-PR-timeline style, ADR ref: OS-4 plan P1): a comment IS an append-only
-- operation_events row whose parent_event_id points at the top-level event it replies to. Flat
-- threads only (a comment's parent is a top-level event). No new table: a comments table would
-- re-implement tenancy/visibility/scoping that operation_events already provides
-- (HR-NO-PARALLEL-MODEL-1) and could not participate in lineage (v_artefact_lineage is event-keyed).
--
-- parent_event_id is an L1 ORGANIZATION pointer (like project_id/intent_id) per ADR-XLOOP-IA-001:
-- re-pointable, never a content edit. No hard FK (mirrors 023's loose coupling: a parent may be
-- archived independently). Partial index because most events are NOT replies.
--
-- Nullable TEXT ADD COLUMN = catalog-only change (no table rewrite, no per-boot hazard).
-- Idempotent + version-guarded (mirrors 023/031). Apply with:
--   psql "$DATABASE_URL" -f src/workers/db/migrations/032_event_threading.sql

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM workers_schema_version WHERE version = 32) THEN

    ALTER TABLE operation_events ADD COLUMN IF NOT EXISTS parent_event_id TEXT;

    CREATE INDEX IF NOT EXISTS idx_operation_events_parent
      ON operation_events(parent_event_id)
      WHERE parent_event_id IS NOT NULL;

    INSERT INTO workers_schema_version (version, description, applied_at)
    VALUES (32, 'operation_events.parent_event_id: comments-as-events thread pointer (L1 org pointer, no hard FK) + partial index; fixes the FIX#3 silent-drop malfunction', now());
  END IF;
END $$;

COMMIT;
