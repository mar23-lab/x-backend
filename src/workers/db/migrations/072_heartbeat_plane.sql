-- 072_heartbeat_plane.sql · AR-2.5 / OAR Phase-9 (260713) · health control-plane — STAGED.
--
-- WHY (ADR-ABS-010 Health/Heartbeat/Audit + the audit's Matrix E: heartbeat coverage 1/5). OAR wants a
-- dead-man-switched health plane at 5 scopes (platform, tenant, bridge, run, review) so a producer that
-- goes SILENT is detected, not assumed healthy. AR-2.5 landed the pure classifier (lib/heartbeat.ts:
-- classifyHeartbeatStatus — dead-man wins over a self-reported healthy). This migration lays the two
-- durable tables it writes to. Ships EMPTY: per-scope producers are the next step (additive-only).
--
-- SHAPE / DOCTRINE (mirrors mig-070/071):
--   * system_heartbeats: one row per observed beat. scope 5-literal CHECK; workspace_id NULLABLE (platform
--     scope has no tenant — and a NULL workspace_id row is never returned to the RLS-subject role, so
--     platform health stays operator-only by construction). status = the OAR 5-status set. safe_summary is
--     customer-safe (char_length <= 1000, no internal ids); internal_detail is JSONB, internal-only.
--   * health_rollups: one row per (scope, window) fold — worst-of status + per-status counts (lib/heartbeat.ts
--     rollupStatus + tallyStatuses).
--   * RLS = the 063/070/071 house recipe (pg_proc-guarded; workspace policy via xlooop_rls_workspace_id()).
--     Writes owner-connected (the producers), so only a SELECT grant to xlooop_app.
--
-- Additive-only; reversible (DROP the 2 tables). Independent of 070/071 (no cross-FK). Validate against a
-- throwaway Neon dev branch before commit; prod apply is OPERATOR-NAMED.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM workers_schema_version WHERE version = 72) THEN

    CREATE TABLE IF NOT EXISTS system_heartbeats (
      id              TEXT PRIMARY KEY,
      scope           TEXT NOT NULL CHECK (scope IN ('platform', 'tenant', 'bridge', 'run', 'review')),
      workspace_id    TEXT,                          -- NULL for platform scope (operator-only by RLS)
      producer        TEXT NOT NULL,                 -- stable producer id (e.g. 'mbp-projection-bridge')
      sequence        BIGINT NOT NULL DEFAULT 0,     -- monotonic per producer (gap = missed beats)
      observed_at     TIMESTAMPTZ NOT NULL,          -- when the producer last beat
      expires_at      TIMESTAMPTZ NOT NULL,          -- dead-man deadline; now > this = stale
      status          TEXT NOT NULL
                        CHECK (status IN ('healthy', 'degraded', 'stale', 'failed', 'expected_dark')),
      schema_version  TEXT NOT NULL DEFAULT 'v1',
      safe_summary    TEXT NOT NULL CHECK (char_length(safe_summary) <= 1000),  -- customer-safe, no internal ids
      internal_detail JSONB,                         -- internal-only diagnostic (never customer-projected)
      content_sha256  TEXT CHECK (content_sha256 IS NULL OR content_sha256 ~ '^[a-f0-9]{64}$'),
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_system_heartbeats_scope
      ON system_heartbeats (scope, observed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_system_heartbeats_ws
      ON system_heartbeats (workspace_id, observed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_system_heartbeats_producer
      ON system_heartbeats (producer, sequence DESC);

    CREATE TABLE IF NOT EXISTS health_rollups (
      id                  TEXT PRIMARY KEY,
      scope               TEXT NOT NULL CHECK (scope IN ('platform', 'tenant', 'bridge', 'run', 'review')),
      workspace_id        TEXT,
      status              TEXT NOT NULL
                            CHECK (status IN ('healthy', 'degraded', 'stale', 'failed', 'expected_dark')),
      healthy_count       INTEGER NOT NULL DEFAULT 0,
      degraded_count      INTEGER NOT NULL DEFAULT 0,
      stale_count         INTEGER NOT NULL DEFAULT 0,
      failed_count        INTEGER NOT NULL DEFAULT 0,
      expected_dark_count INTEGER NOT NULL DEFAULT 0,
      window_start        TIMESTAMPTZ NOT NULL,
      window_end          TIMESTAMPTZ NOT NULL,
      generated_at        TIMESTAMPTZ NOT NULL,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_health_rollups_scope
      ON health_rollups (scope, generated_at DESC);

    -- RLS second layer (063/070/071 house recipe). NULL workspace_id (platform) never matches the GUC.
    IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'xlooop_rls_workspace_id') THEN
      ALTER TABLE system_heartbeats ENABLE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS system_heartbeats_workspace_policy ON system_heartbeats;
      CREATE POLICY system_heartbeats_workspace_policy ON system_heartbeats
        USING (workspace_id = xlooop_rls_workspace_id())
        WITH CHECK (workspace_id = xlooop_rls_workspace_id());

      ALTER TABLE health_rollups ENABLE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS health_rollups_workspace_policy ON health_rollups;
      CREATE POLICY health_rollups_workspace_policy ON health_rollups
        USING (workspace_id = xlooop_rls_workspace_id())
        WITH CHECK (workspace_id = xlooop_rls_workspace_id());
    END IF;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'xlooop_app') THEN
      GRANT SELECT ON system_heartbeats TO xlooop_app;
      GRANT SELECT ON health_rollups    TO xlooop_app;
    END IF;

    INSERT INTO workers_schema_version (version, description, applied_at)
    VALUES (72, 'health control plane: system_heartbeats (5-scope, dead-man expires_at, 5-status, customer-safe safe_summary + internal_detail JSONB) + health_rollups (worst-of + per-status counts); RLS workspace policy + xlooop_app SELECT — AR-2.5 / OAR Phase-9, ADR-ABS-010', now());
  END IF;
END $$;

COMMIT;

-- Verify (read-only, after apply):
--   SELECT count(*) FROM information_schema.tables WHERE table_name IN ('system_heartbeats','health_rollups'); -- expect 2
--   SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='system_heartbeats'::regclass AND contype='c'; -- scope + status CHECKs
--   SELECT privilege_type FROM information_schema.role_table_grants WHERE grantee='xlooop_app' AND table_name='system_heartbeats'; -- expect exactly SELECT
