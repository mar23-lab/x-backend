-- 100_customer_token_delegation_authority.sql
-- Bind user-delegated connector tokens to the membership that authorized them and persist the
-- least-privilege action scopes granted at consent. Existing credentials migrate read-only; write
-- capabilities require an explicit new consent or credential rotation.

BEGIN;

ALTER TABLE customer_api_tokens
  ADD COLUMN IF NOT EXISTS scopes TEXT[] NOT NULL DEFAULT ARRAY[
    'read:session', 'read:packets', 'read:profiles', 'read:templates',
    'read:status', 'read:evidence', 'read:metrics'
  ]::TEXT[],
  ADD COLUMN IF NOT EXISTS authority_mode TEXT NOT NULL DEFAULT 'tenant_service',
  ADD COLUMN IF NOT EXISTS issuer_membership_activated_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'customer_api_tokens_authority_mode_check'
      AND conrelid = 'customer_api_tokens'::regclass
  ) THEN
    ALTER TABLE customer_api_tokens
      ADD CONSTRAINT customer_api_tokens_authority_mode_check
      CHECK (authority_mode IN ('tenant_service', 'delegated_user'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'customer_api_tokens_delegated_membership_check'
      AND conrelid = 'customer_api_tokens'::regclass
  ) THEN
    ALTER TABLE customer_api_tokens
      ADD CONSTRAINT customer_api_tokens_delegated_membership_check
      CHECK (authority_mode <> 'delegated_user' OR issuer_membership_activated_at IS NOT NULL);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_customer_api_tokens_delegated_issuer
  ON customer_api_tokens (workspace_id, created_by, issuer_membership_activated_at)
  WHERE authority_mode = 'delegated_user' AND revoked_at IS NULL;

INSERT INTO workers_schema_version (version, description, applied_at)
VALUES (100, 'Customer connector scopes and delegated-membership authority binding', now())
ON CONFLICT (version) DO NOTHING;

COMMIT;
