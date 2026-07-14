-- 037 · customer_api_tokens
-- ============================================================
-- Generalizes the canary service-token pattern (XLOOOP_CANARY_*_TOKEN_SHA256
-- env, see middleware/auth.ts canaryAuth) into a revocable, workspace-scoped,
-- per-customer credential so customer coding assistants (Claude Code, Codex,
-- Cursor) can call the read-only MCP gateway without a Clerk browser session.
--
-- Authority: docs/customer-onboarding/CLAUDE_CODE_API_ONBOARDING.md
--   step 6  · "scoped Xlooop connector token remains a controlled fallback"
--   step 9  · record actor, tenant, auth method, client id, token hash/JTI
--   step 10 · revoking the connector token must make access fail
--
-- Security invariants encoded here:
--   * we store ONLY the SHA-256 of the token (breach-safe; raw shown once at mint)
--   * mandatory expiry (no infinite-lived tokens)
--   * revoked_at gives the instant kill-switch (the revocation-proof gate)
--   * role is explicit ('viewer' read-only | 'operator' write) and CHECK-bound
--   * packet_prefix scopes operator writes to the customer's own packets
--
-- Additive + idempotent. Applied manually to Neon (see package.json db:migrate:*).
-- ============================================================

CREATE TABLE IF NOT EXISTS customer_api_tokens (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  token_sha256    TEXT NOT NULL UNIQUE CHECK (token_sha256 ~ '^[a-f0-9]{64}$'),
  role            TEXT NOT NULL CHECK (role IN ('viewer', 'operator')),
  label           TEXT NOT NULL CHECK (char_length(label) <= 80),
  packet_prefix   TEXT NOT NULL CHECK (char_length(packet_prefix) <= 64),
  created_by      TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL,
  revoked_at      TIMESTAMPTZ,
  revoked_by      TEXT,
  last_used_at    TIMESTAMPTZ
);

-- Hot path: auth lookup by hash, only live (non-revoked) tokens.
CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_api_tokens_hash_live
  ON customer_api_tokens (token_sha256)
  WHERE revoked_at IS NULL;

-- Admin path: list a workspace's tokens, newest first.
CREATE INDEX IF NOT EXISTS idx_customer_api_tokens_workspace
  ON customer_api_tokens (workspace_id, created_at DESC);
