-- 071_context_packets.sql · AR-2.4 / ABS-P4 (260713) · context-assembly evidence plane — STAGED.
--
-- WHY (ADR-ABS-004 Context Assembly + the operator's intent->context->action lineage). AR-2.2 landed the
-- pure context-packet KERNEL (lib/context-packet.ts: buildContextPacket → a customer-safe record of the
-- context an agent was given for one governed action: role/skill capability + role-scoped context COUNTS +
-- redaction + a deterministic fingerprint). But nothing persisted it — the audit noted `context_packets`
-- table = 0 matches. This migration lays the durable table the assembler writes to, so the intent->context
-- half of the spine becomes queryable + auditable instead of ephemeral.
--
-- SHAPE / DOCTRINE (mirrors the mig-070 evidence plane exactly):
--   * DENORMALIZE-BY-VALUE. role_key/mode/fingerprint/content_sha256 stored NOT NULL; the only catalog/
--     evidence link (receipt_ref → role_skill_resolutions) is a NULLABLE FK ... ON DELETE SET NULL, so the
--     assembler can write a packet TODAY against a zero-row resolutions table (same trap-safety as 070's
--     skill_invocation_receipts.resolution_id).
--   * CUSTOMER-SAFE BY CONSTRUCTION. Only COUNTS (event/document/source), coarse capability labels, a
--     customer-safe policy_summary (char_length <= 1000, no internal ids — CONTEXT_PACKET_CONTRACT), a FNV
--     content fingerprint, and an integrity hash. NEVER event/document ids, graph topology, prompts, or
--     skill bodies (docs/contracts/context-packet.v1.json forbidden_fields).
--   * RLS = the 063/070 house recipe: pg_proc-guarded ENABLE + workspace policy via xlooop_rls_workspace_id().
--     Writes owner-connected (the assembler), so only a SELECT grant to xlooop_app (reads may route through
--     the RLS-subject role once a read surface ships; 045/046/070 precedent).
--
-- Additive-only; reversible (DROP TABLE context_packets). Depends on 070 (role_skill_resolutions) applied
-- first for the receipt_ref FK — both are STAGED, applied in order. Validate against a throwaway Neon dev
-- branch before commit; prod apply is OPERATOR-NAMED.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM workers_schema_version WHERE version = 71) THEN

    CREATE TABLE IF NOT EXISTS context_packets (
      id                        TEXT PRIMARY KEY,
      workspace_id              TEXT NOT NULL,              -- value (RLS subject)
      principal_id              TEXT NOT NULL,
      role_key                  TEXT NOT NULL,             -- denormalized capability label
      mode                      TEXT NOT NULL,
      intent_ref                TEXT,                      -- the intent this context served, or NULL
      selected_skills           JSONB NOT NULL DEFAULT '[]'::jsonb,   -- [{key,version}]
      allowed_tools             TEXT[] NOT NULL DEFAULT '{}',
      denied_tools              TEXT[] NOT NULL DEFAULT '{}',
      skill_coverage            TEXT NOT NULL
                                  CHECK (skill_coverage IN ('resolved', 'no_skill_for_action', 'no_catalog')),
      -- role-scoped context SCOPE: COUNTS ONLY, never ids (§168 visibility/admissibility/authority axes)
      event_count               INTEGER NOT NULL DEFAULT 0,
      document_count            INTEGER NOT NULL DEFAULT 0,
      unpromoted_document_count INTEGER NOT NULL DEFAULT 0,
      source_count              INTEGER NOT NULL DEFAULT 0,
      redaction_profile         TEXT NOT NULL,             -- e.g. 'owner-full', 'client-empty'
      client_empty              BOOLEAN NOT NULL DEFAULT false,
      policy_summary            TEXT NOT NULL CHECK (char_length(policy_summary) <= 1000),  -- no internal ids
      context_fingerprint       TEXT NOT NULL CHECK (context_fingerprint ~ '^[a-f0-9]{8}$'),  -- FNV-1a content id
      content_sha256            TEXT NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
      signature_alg             TEXT NOT NULL DEFAULT 'none' CHECK (signature_alg IN ('none', 'HS256')),
      signature                 TEXT,                      -- base64url HMAC when the secret is configured
      receipt_ref               TEXT REFERENCES role_skill_resolutions(id) ON DELETE SET NULL,  -- NULLABLE
      stale_after_s             INTEGER NOT NULL DEFAULT 900,
      generated_at              TIMESTAMPTZ NOT NULL,      -- when the assembler built this packet
      created_at                TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_context_packets_ws
      ON context_packets (workspace_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_context_packets_fingerprint
      ON context_packets (workspace_id, context_fingerprint);  -- dedup / change-detection

    -- RLS second layer (063/070 house recipe: pg_proc-guarded; workspace policy via the GUC reader).
    IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'xlooop_rls_workspace_id') THEN
      ALTER TABLE context_packets ENABLE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS context_packets_workspace_policy ON context_packets;
      CREATE POLICY context_packets_workspace_policy ON context_packets
        USING (workspace_id = xlooop_rls_workspace_id())
        WITH CHECK (workspace_id = xlooop_rls_workspace_id());
    END IF;

    -- Reads may route through the RLS-subject role once a read surface ships; writes stay owner-plane.
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'xlooop_app') THEN
      GRANT SELECT ON context_packets TO xlooop_app;
    END IF;

    INSERT INTO workers_schema_version (version, description, applied_at)
    VALUES (71, 'context-assembly evidence plane: context_packets (customer-safe record of the context an agent was given for one governed action — capability + role-scoped COUNTS + redaction + FNV fingerprint + integrity hash; NULLABLE receipt_ref FK to role_skill_resolutions; RLS workspace policy + xlooop_app SELECT grant) — AR-2.4 / ABS-P4, ADR-ABS-004', now());
  END IF;
END $$;

COMMIT;

-- Verify (read-only, after apply):
--   SELECT count(*) FROM information_schema.tables WHERE table_name = 'context_packets'; -- expect 1
--   SELECT pg_get_constraintdef(oid) FROM pg_constraint
--     WHERE conrelid = 'context_packets'::regclass AND contype = 'c'; -- includes the fingerprint/sha256/coverage CHECKs
--   SELECT privilege_type FROM information_schema.role_table_grants
--     WHERE grantee = 'xlooop_app' AND table_name = 'context_packets'; -- expect exactly SELECT
