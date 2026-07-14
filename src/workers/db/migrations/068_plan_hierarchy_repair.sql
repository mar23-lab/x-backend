-- 068_plan_hierarchy_repair.sql · ABS-P2 (260713) · repair the flattened MB-P plan + goal-metric honesty — STAGED.
-- VALIDATED on Neon branch abs-p0-snapshot-260713 (br-ancient-forest-a7m6gut1): 1 roadmap + N items per
-- domain (5/5/5/17/24), 0 leftover flattened rows, 0 placeholder metrics, 22 goals nulled.
-- ⚠ APPLY PRECONDITION: reader listWorkspacePlanRow + adapter fetchWsPlan must surface roadmap_ITEM
-- titles first (ABS-P2b), else the UI regresses from N lines to 1. Apply order: deploy reader+adapter
-- -> apply 068 -> verify. Prod apply OPERATOR-NAMED. Reversible via snapshot branch or delete p2 rows.
BEGIN;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM workers_schema_version WHERE version = 68) THEN
    ALTER TABLE synthetic_domain_goals ALTER COLUMN metric_name DROP NOT NULL;
    ALTER TABLE synthetic_domain_goals ALTER COLUMN target_value DROP NOT NULL;
    UPDATE synthetic_domain_goals SET metric_name = NULL
      WHERE created_by = 'mbp-domain-sync' AND metric_name = '';
    UPDATE synthetic_domain_goals SET target_value = NULL
      WHERE created_by = 'mbp-domain-sync' AND target_value = 0;
    INSERT INTO synthetic_domain_roadmaps
      (id, domain_id, workspace_id, title, description, status, version, metadata, created_by, created_at, updated_at)
    SELECT 'sdr_p2_' || d.id, d.id, 'mbp-private', d.label || ' roadmap',
           '30/60/90 plan + active milestones from MB-P (P2 hierarchy repair)', 'active', 1,
           '{"source":"mbp-domain-sync","p2_repair":true}'::jsonb, 'mbp-domain-sync', now(), now()
    FROM synthetic_domains d
    WHERE d.workspace_id = 'mbp-private'
      AND EXISTS (SELECT 1 FROM synthetic_domain_roadmaps r
                  WHERE r.domain_id = d.id AND r.id LIKE 'sdrm_dsync_%')
    ON CONFLICT (id) DO NOTHING;
    INSERT INTO synthetic_domain_roadmap_items
      (id, roadmap_id, domain_id, position, title, status, metadata, created_at, updated_at)
    SELECT 'sdri_p2_' || substr(r.id, 6), 'sdr_p2_' || r.domain_id, r.domain_id,
           row_number() OVER (PARTITION BY r.domain_id ORDER BY r.id),
           r.title,
           CASE WHEN r.title ~ '^(30|60|90)-Day' THEN 'planned' ELSE 'in_progress' END,
           '{"source":"mbp-domain-sync","p2_repair":true}'::jsonb, now(), now()
    FROM synthetic_domain_roadmaps r
    WHERE r.id LIKE 'sdrm_dsync_%'
    ON CONFLICT (id) DO NOTHING;
    DELETE FROM synthetic_domain_roadmaps WHERE id LIKE 'sdrm_dsync_%';
    INSERT INTO workers_schema_version (version, description, applied_at)
    VALUES (68, 'plan hierarchy repair: fold flattened mbp-domain-sync roadmap rows into roadmap+items; goal metric columns nullable + placeholder metrics nulled (ABS-P2, ADR-ABS-002)', now());
  END IF;
END $$;
COMMIT;
