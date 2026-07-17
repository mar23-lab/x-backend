-- 082_synthetic_domains_gate_approver.sql · W2 R4 / W4 UI-A7 (audit gap G1) — persist the
-- department sign-off gate approver.
--
-- STAGED-ONLY: authored 2026-07-17, MUST NOT be applied to production without the operator
-- naming it (same discipline as 066/075/081). Numbered 082 after 081 (intent status superset).
--
-- WHY (gap G1): the department sign-off gate's approver is client-state-only today. The design
-- exposes "Assign an approver" (App.dc.html cycleGateApprover), but the handler only mutates
-- `state.gateMeta` via settleWrite (a LOCAL optimistic write) — the adapter never POSTs it, so
-- the approver is LOST ON RELOAD and no backend column stores it. A governance gate that cannot
-- durably bind an owner is a governance-honesty defect (the audit's S7). This adds the storage.
--
-- SHAPE (W2-R4, F3 cleared — 073's packet approval machinery does NOT generalise to domain scope,
-- so a single column is the right first step, not the N-of-M policy table which stays deferred):
--   gate_approver_user_id TEXT NULL  — the assigned approver (soft-validate approver != owner at
--                                       the route edge; NOT a hard FK pre-cutover, matching the
--                                       app-enforced-integrity posture of the lineage core, G8).
--   gate_note             TEXT NULL  — optional operator note shown beside the gate.
--
-- Additive + idempotent + version-guarded. Behaviourally inert until the post-cutover wiring
-- train exposes it via the existing synthetic_domains PATCH and the adapter round-trips gateMeta
-- (currently client-only). No writer emits these until then. Apply MANUALLY per the prod-Neon
-- one-at-a-time pattern; read-verify before + after.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM workers_schema_version WHERE version = 82) THEN

    ALTER TABLE synthetic_domains ADD COLUMN IF NOT EXISTS gate_approver_user_id TEXT NULL;
    ALTER TABLE synthetic_domains ADD COLUMN IF NOT EXISTS gate_note TEXT NULL;

    COMMENT ON COLUMN synthetic_domains.gate_approver_user_id IS
      'Department sign-off gate approver (G1). Soft-validated approver != owner at the route edge; '
      'app-enforced integrity (no hard FK pre-cutover, matching the lineage core). NULL = no gate '
      'approver assigned. Written by the post-cutover gate-assign wiring train, not before.';
    COMMENT ON COLUMN synthetic_domains.gate_note IS
      'Optional operator note shown beside the department sign-off gate. NULL = none.';

    INSERT INTO workers_schema_version (version, description, applied_at)
    VALUES (82, 'W4 UI-A7 (gap G1): synthetic_domains gate_approver_user_id + gate_note (staged; wired post-cutover)', now());
  END IF;
END $$;

COMMIT;
