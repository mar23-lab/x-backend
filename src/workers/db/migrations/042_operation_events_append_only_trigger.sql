-- 042_operation_events_append_only_trigger.sql
-- P1 backend-completeness hardening (260703) — DB-enforce the ADR-XLOOP-IA-001 append-only
-- invariant that today is app-layer-only convention.
--
-- WHY (docs/frontend-migration/22_BACKEND_COMPLETENESS.md §3, §5 P1): event-store.ts's own
-- header comment states the invariant plainly — "operation_events CONTENT columns
-- (summary/body/...) are APPEND-ONLY and must NEVER be UPDATEd" — but nothing at the DB level
-- enforces it. The operational-spine tables (task_packets, evidence_items, approval_requests,
-- tool_events, metric_deltas) already got a same-workspace BEFORE-trigger + RLS in migration
-- 034; operation_events, the append-only SSOT they derive lineage from, had no equivalent
-- DB-level guard. A rogue writer, a future raw-SQL bypass, or a bug in a new DAL method could
-- silently mutate historical event content with no error and no trace — undermining the audit
-- trail's core guarantee (any consumer trusting "this row never changed" would be wrong).
--
-- WHAT COLUMNS ARE ALLOWED TO CHANGE (grounded — every real UPDATE in the codebase enumerated
-- via `grep -rn "UPDATE operation_events" src/workers/dal` before writing this trigger, not
-- guessed): status/approval_state/next_action (event-store.ts updateEventStatusRow +
-- updateEventStatusForOperatorRow — the status-transition primitive), archived_at
-- (archiveEventRow/restoreEventRow), project_id (reclassify-store.ts, the "move an
-- all-activity event into its real project" reclassify flow), intent_id (intent-store.ts,
-- linking an event to an intent post-hoc). Everything else — summary, body, evidence_link,
-- occurred_at, source_tool, agent_id, visibility, permission_scope, risk, workspace_id,
-- ingested_at, id — is content/identity and must never change on an existing row.
--
-- APPROACH: an ALLOW-LIST (not a block-list) BEFORE UPDATE trigger — any column NOT in the
-- allow-list defaults to protected. This means a FUTURE new column is append-only by default
-- unless a developer deliberately adds it to the allow-list here, matching the "content is
-- immutable unless proven otherwise" posture of the invariant (safer than a block-list, which
-- silently permits new columns to be mutated until someone remembers to add them to the block).
--
-- IMPORTANT — THIS FILE IS NOT APPLIED TO PRODUCTION BY THIS commit. Per the project's DB-
-- migration authorization rule (prod Neon changes are an explicit-operator-authorization
-- class), this migration is written, reviewed-in-source, and left for the operator to apply
-- via the standard one-at-a-time verified process (Neon MCP run_sql_transaction, read-verify
-- before+after) — the version-guard below makes it safe to apply once, idempotently, whenever
-- that happens.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM workers_schema_version WHERE version = 42) THEN
    RAISE NOTICE 'migration 42 already applied - skipping';
    RETURN;
  END IF;

  -- Function body is intentionally NOT inside the DO block (functions can't be created in a
  -- plpgsql DO block's own transaction the same way) — see CREATE OR REPLACE FUNCTION below,
  -- which runs unconditionally but is itself idempotent (CREATE OR REPLACE); the trigger
  -- attach + version-row insert are what the guard above actually protects against re-running.

  INSERT INTO workers_schema_version (version, applied_at, description)
  VALUES (
    42,
    now(),
    'P1 · operation_events append-only DB enforcement: BEFORE UPDATE trigger blocks any change to content/identity columns (summary, body, evidence_link, occurred_at, source_tool, agent_id, visibility, permission_scope, risk, workspace_id, ingested_at, id); allow-lists the 6 columns real DAL code legitimately updates (status, approval_state, next_action, archived_at, project_id, intent_id). Closes the gap flagged in docs/frontend-migration/22_BACKEND_COMPLETENESS.md §3/§5-P1 — the spine tables already had this class of guard (migration 034), operation_events (their append-only SSOT) did not.'
  );
END $$;

CREATE OR REPLACE FUNCTION xlooop_assert_operation_events_append_only()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id                IS DISTINCT FROM OLD.id
     OR NEW.workspace_id    IS DISTINCT FROM OLD.workspace_id
     OR NEW.source_tool     IS DISTINCT FROM OLD.source_tool
     OR NEW.agent_id        IS DISTINCT FROM OLD.agent_id
     OR NEW.summary         IS DISTINCT FROM OLD.summary
     OR NEW.body            IS DISTINCT FROM OLD.body
     OR NEW.evidence_link   IS DISTINCT FROM OLD.evidence_link
     OR NEW.visibility      IS DISTINCT FROM OLD.visibility
     OR NEW.permission_scope IS DISTINCT FROM OLD.permission_scope
     OR NEW.risk            IS DISTINCT FROM OLD.risk
     OR NEW.occurred_at     IS DISTINCT FROM OLD.occurred_at
     OR NEW.ingested_at     IS DISTINCT FROM OLD.ingested_at
  THEN
    RAISE EXCEPTION
      'operation_events is append-only (ADR-XLOOP-IA-001): content/identity columns cannot be updated on event %. Only status, approval_state, next_action, archived_at, project_id, intent_id may change on an existing row — insert a new event for new content.',
      OLD.id
      USING ERRCODE = '23514'; -- check_violation, mirrors a CHECK-constraint failure class
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_operation_events_append_only ON operation_events;
CREATE TRIGGER trg_operation_events_append_only
BEFORE UPDATE ON operation_events
FOR EACH ROW EXECUTE FUNCTION xlooop_assert_operation_events_append_only();
