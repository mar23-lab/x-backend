-- 056_session_mode_operator_backfill.sql · OA-cutover-stage (260708) · STAGED, NOT APPLIED.
--
-- GATE 1 — the watch-default lockout (flagged by the frontend team, verified). When ENTITLEMENT_ENFORCEMENT
-- is flipped 'on', authority requires operator MODE (canActOnSpine: mode !== 'operator' ⇒ deny). The current
-- mode is read server-side from user_session_preferences.operating_mode, which DEFAULTS to 'watch' when no row
-- exists. user_session_preferences is EMPTY in prod (0 rows) → post-flip EVERY governed write would be denied
-- for EVERY user, including owners — a 100% lockout on the MODE axis (the twin of the empty-entitlement lockout
-- that 055 fixed on the ENTITLEMENT axis).
--
-- FIX (no-lockout): seed operating_mode='operator' for each ACTIVE owner/operator membership, so the flip is
-- behaviour-preserving — the members who can write today keep writing. viewer/client are intentionally NOT
-- seeded (they stay 'watch'; they cannot write on either axis regardless). Tightening a member back to
-- watch/test is a later per-session choice / curation.
--
-- Idempotent (ON CONFLICT DO NOTHING — never clobbers a user's own explicit mode). Requires migration 052
-- (user_session_preferences). Prod pre-checked: 11 active members, all owner/operator. Apply WITH the flip
-- (056 seed → staging-verify a governed write succeeds for an owner → set ENTITLEMENT_ENFORCEMENT=on).
-- OPERATOR-NAMED; validate against a throwaway local Postgres first.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM workers_schema_version WHERE version = 56) THEN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'user_session_preferences') THEN

      INSERT INTO user_session_preferences (user_id, workspace_id, operating_mode, updated_at)
      SELECT wm.user_id, wm.workspace_id, 'operator', now()
      FROM workspace_members wm
      WHERE wm.status = 'active' AND wm.role IN ('owner', 'operator')
      ON CONFLICT (user_id, workspace_id) DO NOTHING;

    END IF;

    INSERT INTO workers_schema_version (version, description, applied_at)
    VALUES (56, 'seed operating_mode=operator for active owner/operator members — no-lockout MODE axis for the ENTITLEMENT_ENFORCEMENT flip (gate 1)', now());
  END IF;
END $$;

COMMIT;

-- Verify (read-only, after apply — MUST hold before flipping ENTITLEMENT_ENFORCEMENT=on):
--   SELECT count(*) FROM user_session_preferences WHERE operating_mode='operator';   -- expect = active owner/operator members (11)
--   SELECT count(*) FROM workspace_members WHERE status='active' AND role IN ('owner','operator');  -- must equal the above
