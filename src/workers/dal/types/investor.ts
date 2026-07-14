// types/investor.ts · Investor portal types — DR-11/12/13/14 (DAL split from types.ts)

/* eslint-disable @typescript-eslint/no-explicit-any */

import type { UserId, WorkspaceId } from './identity';

// ─── Wave R-I.7 Stage C: Investor portal types (DR-11/12/13/14) ────────────────────────
// Authority: migrations/0004_investor_portal_stage_c.sql

export type InvestorTier = 'tier-1' | 'tier-2';
export type InvestorSectionFilterMode = 'all-ready' | 'operator-curated' | 'specific-sections';

export interface InvestorSectionFilter {
  mode: InvestorSectionFilterMode;
  sections?: string[];
}

export interface NdaAcceptance {
  id: string;
  user_id: UserId | null;
  access_request_id: string;
  email: string;
  full_name_typed: string;
  nda_version: string;
  accepted_at: string;
  ip_address: string | null;
  user_agent: string | null;
  metadata: Record<string, any>;
  created_at: string;
}

export interface NdaAcceptanceInput {
  access_request_id: string;
  email: string;
  full_name_typed: string;
  nda_version?: string;
  ip_address?: string | null;
  user_agent?: string | null;
  user_id?: UserId | null;
  metadata?: Record<string, any>;
}

export interface InvestorEntitlement {
  id: string;
  user_id: UserId;
  workspace_id: WorkspaceId | null;
  tier: InvestorTier;
  scope_project_ref: string;
  granted_at: string;
  granted_by: UserId;
  revoked_at: string | null;
  revoked_by: UserId | null;
  revoked_reason: string | null;
  section_filter: InvestorSectionFilter;
  metadata: Record<string, any>;
  created_at: string;
  updated_at: string;
}

export interface GrantInvestorTier1Input {
  /** Optional: link entitlement to an access-request for audit + NDA traceability. */
  access_request_id?: string;
  /** Optional: Clerk user_id of the investor (preferred — paste after they sign up via invite). */
  clerk_user_id?: UserId;
  /** Optional: email if user_id not yet known (used to UPSERT a users row). */
  email?: string;
  /** Admin who granted (required). */
  granted_by: UserId;
}

export interface EscalateInvestorTier2Input {
  user_id: UserId;
  escalated_by: UserId;
  section_filter?: InvestorSectionFilter;
  reason?: string;
}

export interface RevokeInvestorTier2Input {
  user_id: UserId;
  revoked_by: UserId;
  reason?: string;
}
