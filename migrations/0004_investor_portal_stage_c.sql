-- 0004_investor_portal_stage_c.sql
-- Wave R-I.7 Stage C — Investor portal tier-1 + tier-2 (DR-11/12/13/14 implementation)
--
-- Authority: AUTH_TENANCY_MODEL.md + x-biz/docs/MASTER_OUTSTANDING_ITEMS.md DR-11/12/13/14
-- Operator-approved 2026-05-28 (Wave R-I.7 Stage B operator message).
--
-- Schema additions:
--   1. nda_acceptances        — typed-name signature records, ledger of NDA-acceptance per investor
--   2. investor_entitlements  — Tier-1 (pitch-deck-download only) vs Tier-2 (live data-room view) gate
--                               for access_request → user → entitlement promotion flow
--
-- Tier model:
--   - Tier 0: public (no auth) — request access form on x-web /investors → posts to /api/v1/request-access
--   - Tier 1: operator-approved + NDA accepted — can download pitch deck PDF + view exec summary
--   - Tier 2: operator-escalated — full live data-room view (operations stream + 12 data-room sections,
--                                   READY-status-filtered, scoped to x-biz-investor-readiness project)
--
-- NDA mechanism (operator-confirmed DR-12/DR-13):
--   - Single NDA signed at registration covers BOTH Tier-1 + Tier-2 access
--   - Typed-name acknowledgement (NO click-through tick box; NO DocuSign integration)
--   - NDA template: legal/templates/NDA_v1.docx rendered as HTML
--   - Full audit trail: typed name + IP + user-agent + accepted_at + nda_version

create table if not exists nda_acceptances (
  id            text primary key,                  -- 'nda_<nanoid>'
  user_id       text references users(id),         -- nullable until user provisioned post-approval
  access_request_id text references access_requests(id),
  email         text not null,                     -- denormalised for pre-user-creation acceptance
  full_name_typed text not null,                   -- operator-confirmed: typed full name as signature
  nda_version   text not null default 'NDA_v1',    -- mirrors legal/templates/NDA_v1.docx
  accepted_at   text not null,                     -- ISO 8601 UTC
  ip_address    text,
  user_agent    text,
  metadata      text default '{}',                 -- JSON; e.g. {"tier_intent": "tier-1"} for audit traceability
  created_at    text not null default current_timestamp,

  -- One acceptance per access-request → user pairing (idempotent on re-submission)
  unique(access_request_id, email)
);

create index if not exists idx_nda_acceptances_user on nda_acceptances(user_id);
create index if not exists idx_nda_acceptances_email on nda_acceptances(email);
create index if not exists idx_nda_acceptances_access_request on nda_acceptances(access_request_id);


create table if not exists investor_entitlements (
  id              text primary key,                -- 'inv_ent_<nanoid>'
  user_id         text not null references users(id),
  workspace_id    text references workspaces(id),  -- nullable; entitlement may pre-date workspace creation
  tier            text not null check (tier in ('tier-1', 'tier-2')),
  -- Tier-1: pitch-deck-download only
  -- Tier-2: full live data-room view (operations-stream + 12 sections READY-filtered)

  scope_project_ref text default 'x-biz-investor-readiness',
  -- x-biz-investor-readiness is the canonical investor-portal project per LEVERAGE_EXISTING_FUNCTIONALITY_ASSESSMENT_260528

  granted_at      text not null,
  granted_by      text not null references users(id),  -- operator/admin user who granted
  revoked_at      text,
  revoked_by      text references users(id),
  revoked_reason  text,

  -- Tier-2-specific: which data-room sections are visible (defaults to all READY)
  -- DR-14 operator-confirmed: full + READY-filtered by default
  section_filter_json text default '{"mode": "all-ready"}',
  -- modes: "all-ready" (default) | "operator-curated" (per-investor opt-in) | "specific-sections"

  metadata        text default '{}',
  created_at      text not null default current_timestamp,
  updated_at      text not null default current_timestamp,

  -- One active entitlement per user x project
  unique(user_id, scope_project_ref)
);

create index if not exists idx_investor_entitlements_user on investor_entitlements(user_id);
create index if not exists idx_investor_entitlements_workspace on investor_entitlements(workspace_id);
create index if not exists idx_investor_entitlements_tier on investor_entitlements(tier);


-- New audit_action values surfaced for investor portal flow
-- (string column in audit_logs; no schema change needed — values documented here for TypeScript types)
--   'investor_nda_accept'         · user signed NDA at registration (Tier-1 grant)
--   'investor_tier1_grant'        · operator approves Tier-1 entitlement (pitch deck download)
--   'investor_tier2_escalate'     · operator escalates Tier-1 → Tier-2 (full data-room view)
--   'investor_tier2_revoke'       · operator revokes Tier-2 (down-tier to Tier-1)
--   'investor_deck_download'      · investor downloads pitch deck PDF
--   'investor_data_room_view'     · investor views data-room section (granular per-section log)

-- Schema additions to src/workers/dal/types.ts AuditAction union:
--   add 'investor_nda_accept' | 'investor_tier1_grant' | 'investor_tier2_escalate'
--       | 'investor_tier2_revoke' | 'investor_deck_download' | 'investor_data_room_view'
