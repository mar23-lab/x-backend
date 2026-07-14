-- 044_customer_recoverability_soft_delete.sql · customer-recoverability doctrine — no permanent destruction.
--
-- WHY (commercial-launch safety, 260706): three customer-facing surfaces HARD-DELETED customer work with
-- no recovery path, contradicting the platform's recoverability guarantee (an agent/API call must never be
-- able to permanently destroy a customer's work):
--   * synthetic_domain_roadmap_items  (DELETE — customer planning artifacts gone)
--   * prompt_tags                      (DELETE — operator's saved prompts gone)
--   * user_source_connections          (DELETE on disconnect — overturns R50.3b per operator 260706: sync
--                                        history must be preserved, consistent with the recoverability doctrine)
--
-- This migration adds the soft-delete markers. The stores switch DELETE -> UPDATE SET <marker>=now(), every
-- read filters the marker IS NULL, and a restore path clears it. Rows (and their history) are preserved and
-- recoverable. Companion to operation_events soft-delete (archived_at) + the 042/043 append-only/RLS floor.
--
-- Idempotent + version-guarded (safe to re-run). Apply MANUALLY per the prod-Neon one-at-a-time pattern.

ALTER TABLE synthetic_domain_roadmap_items ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE prompt_tags                    ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE user_source_connections        ADD COLUMN IF NOT EXISTS disconnected_at TIMESTAMPTZ;

-- Partial indexes keep the active-row reads (deleted_at/disconnected_at IS NULL) fast.
CREATE INDEX IF NOT EXISTS idx_sd_roadmap_items_active
  ON synthetic_domain_roadmap_items(roadmap_id) WHERE deleted_at IS NULL;

-- The UNIQUE(roadmap_id, position) index must exclude soft-deleted rows: a deleted row keeps its
-- position, and the delete re-pack moves an active row onto that number. Make uniqueness partial so
-- deleted rows never collide with the re-packed active set.
DROP INDEX IF EXISTS idx_sdri_roadmap_pos;
CREATE UNIQUE INDEX IF NOT EXISTS idx_sdri_roadmap_pos
  ON synthetic_domain_roadmap_items(roadmap_id, "position") WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_prompt_tags_active
  ON prompt_tags(user_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_user_source_connections_active
  ON user_source_connections(user_id) WHERE disconnected_at IS NULL;

INSERT INTO workers_schema_version (version, description)
VALUES (44, 'customer-recoverability soft-delete markers (roadmap_items/prompt_tags deleted_at; user_source_connections disconnected_at)')
ON CONFLICT (version) DO NOTHING;

-- Verify (read-only, run after apply):
--   SELECT column_name FROM information_schema.columns WHERE table_name='synthetic_domain_roadmap_items' AND column_name='deleted_at';
--   SELECT column_name FROM information_schema.columns WHERE table_name='user_source_connections' AND column_name='disconnected_at';
