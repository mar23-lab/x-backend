-- 086_mirror_rehoming.sql · X-EXEC-3 (260720) · APPLIED TO PROD 260720 via Neon MCP (session 260720).
-- Mirror re-homing: the five MB-P projection-mirror workspaces (x-biz, xcp-platform, x-docs,
-- x-front, xlooop — seeded by scripts/seed-legitimate-mbp-catalog.mjs, typed `mirror` in mig 085)
-- each held that repo's github-activity history (1,232 events total, all source_tool=github, a
-- Mar-Jun backfill; ingestion stopped mid-June; owner-only members; ZERO summary-overlap with the
-- company workspace or each other — verified disjoint before applying). This consolidates each
-- repo's history into the Xlooop company workspace (org_3EG82) under one repo-scoped project, turns
-- the repos into Index-tier Resources (project_source_bindings, read_policy=metadata_only), and
-- soft-archives the mirror workspaces. Provenance rides at the project level: each moved event's
-- project_id = xlooop-repo-<slug>, whose metadata records rehomed_from.
--
-- APPEND-ONLY TRIGGER LIFT (dev-mode governed migration): operation_events.workspace_id is protected
-- by the mig-042 append-only trigger (ADR-XLOOOP-IA-001). Moving events legitimately requires a
-- one-time governed lift: DISABLE TRIGGER -> UPDATE -> re-ENABLE, all inside this transaction, so the
-- invariant is never observably off to any concurrent reader and is fully restored at COMMIT. This
-- migration ALSO redefines the trigger function to correct the ADR id spelling in its error message:
-- the message previously carried a two-o misspelling of the brand; corrected here to the three-o
-- ADR-XLOOOP-IA-001 (brand is Xlooop).
--
-- REVERSIBLE: un-archive the mirrors + move the events back (same trigger-lift) + drop the 5
-- xlooop-repo-* projects/bindings. Verified on a throwaway Neon branch before the prod apply
-- (mirror_events_left 0, company 2198->3430, events_under_repo_projects 1232, bindings 5,
-- mirrors_archived 5, trigger re-enabled and rejecting tampering with the corrected message).
--
-- Apply MANUALLY (operator-applied, per repo policy) — ALREADY APPLIED to prod 260720:
--   -- via Neon MCP on project flat-truth-23350426 after review (the sanctioned path used here).

BEGIN;

INSERT INTO projects (id, workspace_id, name, status, description, metadata) VALUES
  ('xlooop-repo-x-biz','org_3EG82VEzc8t3t65XSZ0YDlcaDMI','x-biz — repository','active','Repo history re-homed from mirror workspace x-biz (X-EXEC-3 mig 086, 260720)','{"rehomed_from":"x-biz","rehome_wave":"X-EXEC-3","rehomed_at":"2026-07-20"}'::jsonb),
  ('xlooop-repo-xcp-platform','org_3EG82VEzc8t3t65XSZ0YDlcaDMI','XCP — repository','active','Repo history re-homed from mirror workspace xcp-platform (X-EXEC-3 mig 086, 260720)','{"rehomed_from":"xcp-platform","rehome_wave":"X-EXEC-3","rehomed_at":"2026-07-20"}'::jsonb),
  ('xlooop-repo-x-docs','org_3EG82VEzc8t3t65XSZ0YDlcaDMI','x-docs — repository','active','Repo history re-homed from mirror workspace x-docs (X-EXEC-3 mig 086, 260720)','{"rehomed_from":"x-docs","rehome_wave":"X-EXEC-3","rehomed_at":"2026-07-20"}'::jsonb),
  ('xlooop-repo-x-front','org_3EG82VEzc8t3t65XSZ0YDlcaDMI','x-front — repository','active','Repo history re-homed from mirror workspace x-front (X-EXEC-3 mig 086, 260720)','{"rehomed_from":"x-front","rehome_wave":"X-EXEC-3","rehomed_at":"2026-07-20"}'::jsonb),
  ('xlooop-repo-xlooop','org_3EG82VEzc8t3t65XSZ0YDlcaDMI','xlooop — repository','active','Repo history re-homed from mirror workspace xlooop (X-EXEC-3 mig 086, 260720)','{"rehomed_from":"xlooop","rehome_wave":"X-EXEC-3","rehomed_at":"2026-07-20"}'::jsonb)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE operation_events DISABLE TRIGGER trg_operation_events_append_only;

UPDATE operation_events SET workspace_id='org_3EG82VEzc8t3t65XSZ0YDlcaDMI', project_id='xlooop-repo-x-biz'        WHERE workspace_id='x-biz';
UPDATE operation_events SET workspace_id='org_3EG82VEzc8t3t65XSZ0YDlcaDMI', project_id='xlooop-repo-xcp-platform' WHERE workspace_id='xcp-platform';
UPDATE operation_events SET workspace_id='org_3EG82VEzc8t3t65XSZ0YDlcaDMI', project_id='xlooop-repo-x-docs'       WHERE workspace_id='x-docs';
UPDATE operation_events SET workspace_id='org_3EG82VEzc8t3t65XSZ0YDlcaDMI', project_id='xlooop-repo-x-front'      WHERE workspace_id='x-front';
UPDATE operation_events SET workspace_id='org_3EG82VEzc8t3t65XSZ0YDlcaDMI', project_id='xlooop-repo-xlooop'       WHERE workspace_id='xlooop';

-- Redefine the guard function with the corrected ADR id spelling (XLOOP -> XLOOOP). Same allow-list.
CREATE OR REPLACE FUNCTION xlooop_assert_operation_events_append_only()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $BODY$
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
      'operation_events is append-only (ADR-XLOOOP-IA-001): content/identity columns cannot be updated on event %. Only status, approval_state, next_action, archived_at, project_id, intent_id may change on an existing row - insert a new event for new content.',
      OLD.id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$BODY$;

ALTER TABLE operation_events ENABLE TRIGGER trg_operation_events_append_only;

INSERT INTO project_source_bindings (id, workspace_id, project_id, source_kind, source_ref, status, read_policy) VALUES
  ('psb-rehome-x-biz','org_3EG82VEzc8t3t65XSZ0YDlcaDMI','xlooop-repo-x-biz','github_repo','{"repo_slug":"x-biz","provider":"github"}'::jsonb,'connected','metadata_only'),
  ('psb-rehome-xcp-platform','org_3EG82VEzc8t3t65XSZ0YDlcaDMI','xlooop-repo-xcp-platform','github_repo','{"repo_slug":"xcp-platform","provider":"github"}'::jsonb,'connected','metadata_only'),
  ('psb-rehome-x-docs','org_3EG82VEzc8t3t65XSZ0YDlcaDMI','xlooop-repo-x-docs','github_repo','{"repo_slug":"x-docs","provider":"github"}'::jsonb,'connected','metadata_only'),
  ('psb-rehome-x-front','org_3EG82VEzc8t3t65XSZ0YDlcaDMI','xlooop-repo-x-front','github_repo','{"repo_slug":"x-front","provider":"github"}'::jsonb,'connected','metadata_only'),
  ('psb-rehome-xlooop','org_3EG82VEzc8t3t65XSZ0YDlcaDMI','xlooop-repo-xlooop','github_repo','{"repo_slug":"xlooop","provider":"github"}'::jsonb,'connected','metadata_only')
ON CONFLICT (id) DO NOTHING;

UPDATE workspaces SET relationship_status='archived', updated_at=now()
  WHERE id IN ('x-biz','xcp-platform','x-docs','x-front','xlooop');

INSERT INTO workers_schema_version (version, applied_at, description)
SELECT 86, now(), 'X-EXEC-3 mirror re-homing: move 1232 github events from 5 mirror workspaces to the Xlooop company workspace under repo-scoped projects (governed append-only trigger-lift); 5 github_repo Resource bindings; archive the 5 mirror workspaces; correct the ADR-XLOOOP-IA-001 spelling in the append-only trigger message.'
WHERE NOT EXISTS (SELECT 1 FROM workers_schema_version WHERE version = 86);

COMMIT;
