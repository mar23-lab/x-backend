// types/access.ts · Users, access requests, audit log & entitlement state (DAL split from types.ts)

/* eslint-disable @typescript-eslint/no-explicit-any */

import type { SessionProject, SessionUser, SessionWorkspace } from './event';
import type { UserId, WorkspaceId } from './identity';

// ============================================================
// R40 · Entitlement model (authoritative DB-side access gate)
// ============================================================
//
// Authority: docs/architecture/backend/AUTH_TENANCY_MODEL.md §Entitlement model
//
// Clerk identity is necessary but NOT sufficient for product access. Even a
// valid Clerk JWT must clear an additional check against the Neon `users`
// table (status='approved') and have at least one `workspace_members` row
// with status='active'.

export type UserStatus = 'pending' | 'approved' | 'rejected' | 'suspended';

export interface User {
  id: UserId;
  email: string | null;
  status: UserStatus;
  is_admin: boolean;
  approved_at: string | null;
  approved_by: UserId | null;
  rejection_reason: string | null;
  suspended_at: string | null;
  metadata: Record<string, any>;
  created_at: string;
  updated_at: string;
}

export type WorkspaceMemberRole = 'owner' | 'operator' | 'viewer' | 'client';

// Stage 3 · a real workspace member (workspace_members LEFT JOIN users). `email`/`status`
// are null when the member has no Neon `users` row yet (Clerk is the identity SoR).
export interface WorkspaceMember {
  user_id: UserId;
  workspace_id: WorkspaceId;
  role: WorkspaceMemberRole;
  email: string | null;
  status: UserStatus | null;
  invited_by: UserId | null;
  joined_at: string | null;
}

export type MembershipStatus = 'pending' | 'active' | 'revoked' | 'suspended';

export type AccessRequestStatus = 'pending' | 'approved' | 'rejected' | 'invited' | 'expired';

export interface AccessRequest {
  id: string;
  email: string;
  company_name: string | null;
  reason: string | null;
  source: string | null;
  status: AccessRequestStatus;
  ip_address: string | null;
  user_agent: string | null;
  user_id: UserId | null;
  reviewed_at: string | null;
  reviewed_by: UserId | null;
  rejection_reason: string | null;
  invited_to_workspace_id: WorkspaceId | null;
  metadata: Record<string, any>;
  created_at: string;
  updated_at: string;
}

export interface AccessRequestInput {
  email: string;
  company_name?: string;
  reason?: string;
  source?: string;
  ip_address?: string;
  user_agent?: string;
}

// ── Customer registration (R55 · 018_customer_registration) ────────────────
// Persisted readiness assessment from the x-web readiness funnel (source='x-web-readiness-register').
export type CustomerAccountType = 'personal' | 'company' | 'both';

export interface ReadinessAssessment {
  id: string;
  access_request_id: string;
  user_id: UserId | null;
  workspace_id: WorkspaceId | null;
  email: string;
  account_type: CustomerAccountType;
  also_personal_space: boolean;
  company_name: string | null;
  domain: string | null;
  country: string | null;
  deep_level: number | null;
  readiness_answers: Record<string, unknown>;
  deep_check: Record<string, unknown> | null;
  enrichment: Record<string, unknown> | null;
  consent: Record<string, unknown>;
  source: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface ReadinessAssessmentInput {
  access_request_id: string;
  email: string;
  account_type?: CustomerAccountType;
  also_personal_space?: boolean;
  company_name?: string | null;
  domain?: string | null;
  country?: string | null;
  deep_level?: number | null;
  readiness_answers?: Record<string, unknown>;
  deep_check?: Record<string, unknown> | null;
  enrichment?: Record<string, unknown> | null;
  consent?: Record<string, unknown>;
  source?: string | null;
}

// ── Company Context model (ctx_v1) ─────────────────────────────────────────
// Authority: the post-launch "build the context" reframe (strategy synthesis).
//
// The CompanyContext is the structured, provenance-carrying model of *who the
// customer is* — the input the day-1 setup resolver branches on. It is owned in
// THIS repo (HR-XCP-DEMO-NO-COUPLE: the demo owns the context contract; x-web
// emits it, this repo validates + resolves it). It persists inside the existing
// readiness_assessments JSONB envelope at `readiness_answers.context` — NO new
// table, NO new migration.
//
// Provenance is first-class: every field the resolver *branches on* is wrapped in
// a `Fact<T>` carrying source + confidence + as-of date. Display-only fields stay
// plain. The resolver's CONFIDENCE GATE reads `source` to decide whether a derived
// roadmap step is 'auto' (trusted provenance) or 'confirm' (public-signal/inferred).

/**
 * A single provenance-carrying datum. The `source` records WHERE the value came
 * from (a public OSINT signal vs. something the customer stated vs. data we read
 * from a connected system vs. an operator entry vs. a model inference); the
 * resolver's confidence gate trusts only `stated | connected_data | operator`.
 */
export interface Fact<T> {
  value: T;
  source: 'public_signal' | 'stated' | 'connected_data' | 'operator' | 'inferred';
  confidence: 'low' | 'medium' | 'high';
  /** ISO-8601 date/datetime the value was observed/stated. */
  asOf: string;
  /** Optional human-readable provenance pointer (URL, doc ref, note). */
  evidence?: string;
}

/** The set of real connector providers the resolver may rank. No accounting backend exists. */
export type ContextConnectorProvider =
  | 'github'
  | 'google_drive'
  | 'dropbox'
  | 'gitlab'
  | 'microsoft_onedrive';

/**
 * ctx_v1 company-context model — six bounded contexts. Only the fields the day-1
 * resolver branches on are `Fact<>`-wrapped (provenance matters there). Display-only
 * fields (identity, structure) stay plain.
 */
export interface CompanyContext {
  schema_version: 'ctx_v1';

  /** Who the company is, what regime it operates under, and its cyber posture. */
  company: {
    identity: {
      legalName: string;
      tradingName?: string;
      registryId?: string;
      jurisdiction: string;
    };
    /** Sector drives agent-roster + connector selection → provenance-tracked. */
    sector: Fact<string>;
    /** Lifecycle stage (optional input to roster aggressiveness). */
    stage?: Fact<'startup' | 'growth' | 'mature' | 'transition'>;
    sizeStructure: {
      headcount?: string;
      entityType?: string;
    };
    /** Regulatory regime(s) — gates connector ranking (regulated → document-first). */
    regulatoryRegime?: Fact<string[]>;
    financialShape?: {
      revenueBand?: string;
      /** Days sales outstanding. */
      dso?: string;
    };
    customerConcentration?: {
      /** Percentage of revenue from the top customer(s) — feeds risk register. */
      topPct?: number;
    };
    /** Tools/systems in use (display + connector-ranking heuristic). */
    techStack?: string[];
    cyberPosture?: {
      /** DMARC posture: 'pass' | 'warn' | 'fail' | 'none' (free-form, feeds risk register). */
      dmarc?: string;
      tls?: string;
      disclosedIncident?: boolean;
    };
  };

  /** Where the company is trying to go — drives roster + roadmap aggressiveness. */
  goals: {
    priority90d?: string;
    growthPosture?: Fact<'Grow' | 'Sustain' | 'Transition' | 'Exit'>;
    quantifiedTarget?: Fact<{
      kind: 'revenue' | 'margin' | 'compliance_deadline' | 'concentration';
      value?: string;
      by?: string;
    }>;
  };

  /** How fast value is needed — scales roadmap step count + gating. */
  urgency?: {
    valueHorizon?: Fact<'days' | 'weeks' | 'quarter' | 'exploratory'>;
  };

  /** What the company already does with AI + its data/governance footing. */
  operatingReality?: {
    aiTools?: Fact<Array<{ id: string; depth: 'exploration' | 'pilot' | 'production' }>>;
    dataSources?: string[];
    governanceDocs?: {
      aiPolicy?: boolean;
    };
  };

  /** PII-minimal people layer — booleans for whether key roles are named, NOT names. */
  people?: {
    operator?: {
      role?: string;
      /** Authority gate: 'needs_signoff' makes Action steps require sign-off. */
      authority?: 'full' | 'needs_signoff';
    };
    decisionMakerNamed?: Fact<boolean>;
    reviewerNamed?: Fact<boolean>;
  };

  /** Readiness level (0..5) — a PROJECTION input into the resolver, not the model itself. */
  readiness?: {
    level?: Fact<number>;
  };
}

// ── Day-1 setup resolution (ctx_v1 · resolveDay1Setup output) ───────────────
// The deterministic, pure projection of a CompanyContext into a concrete day-1
// setup. A SUPERSET of buildDay1Roadmap's output (which returns only roadmap
// steps): this adds a sector-aware agent roster, a regime-aware connector ranking,
// and a provenance-aware risk register. ADDITIVE — buildDay1Roadmap stays the live
// default; this resolver is flipped on post-launch after pilot validation.

export interface Day1AgentPick {
  id: string;
  reason: string;
}

export interface Day1ConnectorPick {
  provider: ContextConnectorProvider;
  /** 1-based rank; 1 = connect first. */
  rank: number;
  reason: string;
}

/**
 * A roadmap step with a confidence/authority GATE:
 *  - 'auto'         — driving facts are well-sourced (stated|connected_data|operator); safe to seed live.
 *  - 'confirm'      — driving fact is public_signal-only or inferred; surface as a "confirm this" card.
 *  - 'needs_signoff'— an Action step under an operator whose authority is 'needs_signoff'.
 */
export interface Day1RoadmapStep {
  n: number;
  body: string;
  gate: 'auto' | 'needs_signoff' | 'confirm';
}

export interface Day1Risk {
  risk: string;
  severity: 'low' | 'medium' | 'high';
  /** Which context fact this risk was derived from (provenance for the operator). */
  source: string;
}

export interface Day1Setup {
  agentRoster: Day1AgentPick[];
  connectors: Day1ConnectorPick[];
  roadmap: Day1RoadmapStep[];
  riskRegister: Day1Risk[];
}

// Authority/consent record — UNLOCKS private connectors + team invites
// (CUSTOMER_ECOSYSTEM_ONBOARDING_AND_IP_BOUNDARY_STANDARD). Operator side (DR-11 manual
// approval) + customer side (in-app typed-name ack, DR-12 mechanism). One active row per workspace.
export interface CustomerAuthorityConsent {
  id: string;
  workspace_id: WorkspaceId;
  access_request_id: string | null;
  operator_approved_at: string | null;
  operator_approved_by: UserId | null;
  allowed_modes: string[];
  allowed_apps: string[];
  consent_acked_at: string | null;
  consent_acked_by: UserId | null;
  full_name_typed: string | null;
  scopes_confirmed: Record<string, unknown>;
  consent_version: string;
  ip_address: string | null;
  user_agent: string | null;
  revoked_at: string | null;
  revoked_by: UserId | null;
  revoked_reason: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface CustomerAuthorityState {
  workspace_id: WorkspaceId;
  unlocked: boolean;            // operator_approved AND consent_acked AND not revoked
  operator_approved: boolean;
  consent_acked: boolean;
  allowed_modes: string[];
  allowed_apps: string[];
  consent: CustomerAuthorityConsent | null;
}

export interface CustomerConsentAckInput {
  workspace_id: WorkspaceId;
  user_id: UserId;
  full_name_typed: string;
  access_request_id?: string | null;
  scopes_confirmed?: Record<string, unknown>;
  consent_version?: string;
  ip_address?: string | null;
  user_agent?: string | null;
  // W1b (2026-06-15) · defensible identity bundle on the e-signature record (Electronic
  // Transactions Act best practice). Persisted into the `metadata` jsonb (no schema change).
  email?: string | null;
  company?: string | null;
}

export interface OperatorAuthorityInput {
  workspace_id: WorkspaceId;
  operator_user_id: UserId;
  access_request_id?: string | null;
}

// Lifecycle L1 (2026-06-15) · in-app withdrawal of authority/consent. Sets revoked_at on the
// ACTIVE row (immutable supersede — never hard-deletes). getCustomerAuthorityState filters
// revoked_at IS NULL, so a revoke re-locks connectors + invites for free; a later consent ack
// upserts a NEW active row via the uq_customer_authority_active partial index.
export interface RevokeCustomerAuthorityInput {
  workspace_id: WorkspaceId;
  revoked_by: UserId;
  revoked_reason?: string | null;
  // The typed-name re-attestation captured at revoke time (recorded in the audit_logs metadata,
  // transactionally with the revoke — symmetric with the consent e-signature provenance).
  re_attest_name?: string | null;
}

// Lifecycle L2 (2026-06-15) · the operator approval inbox row — a workspace that has CONSENTED
// (customer side) but is NOT yet operator-approved and NOT revoked. Joins the workspace name +
// owner email so the operator can approve from a queue UI instead of a curl.
export interface PendingCustomerAuthorityApproval {
  workspace_id: WorkspaceId;
  workspace_name: string | null;
  owner_user_id: UserId | null;
  owner_email: string | null;
  consent_acked_by: UserId | null;
  consent_acked_at: string | null;
  full_name_typed: string | null;
  consent_version: string | null;
}

export interface PendingCustomerAuthorityListOpts {
  limit?: number;
  offset?: number;
}

export type AuditAction =
  // Wave R-I.7 Stage C — investor portal (DR-11/12/13/14)
  | 'investor_nda_accept'
  | 'investor_tier1_grant'
  | 'investor_tier2_escalate'
  | 'investor_tier2_revoke'
  | 'investor_deck_download'
  | 'investor_data_room_view'
  | 'user_approve'
  | 'user_reject'
  | 'user_suspend'
  | 'user_unsuspend'
  | 'member_activate'
  | 'member_revoke'
  | 'access_request_approve'
  | 'access_request_reject'
  | 'workspace_create'
  | 'account_upgrade_requested'
  | 'feedback_submitted'
  | 'admin_grant'
  | 'admin_revoke'
  // Lifecycle L1 · customer authority/consent withdrawal (IP-boundary re-lock)
  | 'customer_authority_revoke'
  // R47.3 project nesting
  | 'project_create'
  | 'project_archive'
  // R45 project actions (already used; declared here for completeness)
  | 'project_scope_binding_update'
  | 'project_scope_binding_clear'
  // R49' synthetic domain actions (LEM-v3 PR-1)
  | 'synthetic_domain_create'
  | 'synthetic_domain_update_binding'
  | 'synthetic_domain_update_metadata'
  | 'synthetic_domain_archive'
  | 'synthetic_domain_change_owner'
  | 'synthetic_domain_refresh_membership'
  // R49 PR-3 · planning layer
  | 'sd_roadmap_create'
  | 'sd_roadmap_update'
  | 'sd_roadmap_archive'
  | 'sd_roadmap_item_add'
  | 'sd_roadmap_item_update'
  | 'sd_roadmap_item_delete'
  | 'sd_roadmap_item_restore'
  | 'sd_roadmap_item_reorder'
  | 'sd_goal_create'
  | 'sd_goal_update'
  | 'sd_goal_archive'
  | 'sd_goal_recompute_value'
  // R49 PR-5+6 · propagation engine
  | 'sd_propagation_rule_create'
  | 'sd_propagation_rule_update'
  | 'sd_propagation_rule_archive'
  | 'sd_recommendation_generate'
  | 'sd_recommendation_accept'
  | 'sd_recommendation_reject'
  | 'sd_recommendation_expire'
  | 'sd_propagation_tick'
  // A-W1 (260707) · session/token lifecycle audit (migration 048 widened the DB target_type CHECK)
  | 'customer_token_mint'
  | 'customer_token_revoke'
  // Wave B (260707) · canonical operating-mode change (audited per flip; written with target_type 'session')
  | 'operating_mode_change'
  // Wave C (260708) · model-runtime provider config + audited workspace-default flip (migration 053)
  | 'model_runtime_provider_set'
  | 'model_runtime_provider_delete'
  | 'model_runtime_default_change';

export type AuditTargetType =
  | 'user'
  | 'workspace_member'
  | 'access_request'
  | 'workspace'
  | 'project'
  | 'synthetic_domain'
  | 'synthetic_domain_roadmap'
  | 'synthetic_domain_roadmap_item'
  | 'synthetic_domain_goal'
  | 'synthetic_domain_propagation_rule'
  | 'synthetic_domain_recommendation'
  // A-W1 (260707) · session/token lifecycle audit targets (migration 048 widened the DB CHECK to match).
  | 'api_token'
  | 'session'
  // Wave C (260708) · model-runtime provider config target (migration 053 widened the DB CHECK to match)
  | 'model_runtime_provider';

export interface AuditLogEntry {
  id: number;
  actor_user_id: UserId;
  action: AuditAction;
  target_type: AuditTargetType;
  target_id: string;
  workspace_id: WorkspaceId | null;
  reason: string | null;
  metadata: Record<string, any>;
  occurred_at: string;
}

export interface AuditLogInput {
  actor_user_id: UserId;
  action: AuditAction;
  target_type: AuditTargetType;
  target_id: string;
  workspace_id?: WorkspaceId | null;
  reason?: string | null;
  metadata?: Record<string, any>;
}

// ---- Session state machine (R40) ----

export type SessionState =
  | 'approved_workspace'      // user is approved + has active membership; full SessionContext returned
  | 'authenticated_no_access' // valid JWT but no Neon user OR no membership at all
  | 'pending_access'          // user has open access_request OR users.status='pending'
  | 'access_denied';          // users.status='rejected' or 'suspended'

export interface EntitlementResult {
  state: SessionState;
  user: SessionUser | null;
  workspace: SessionWorkspace | null;
  projects: SessionProject[];
  /** Free-form hint for the frontend to show ("Awaiting admin approval", etc.) */
  message: string;
  /** Surfaced when state is pending_access — gives the request id for status polling */
  access_request_id?: string;
  /**
   * Canonical xcp-platform AuthenticatedPrincipal v1 shape (R41).
   * Populated ONLY when state==='approved_workspace'.
   * Forward-compatible with intent-ai-app-template + future xcp-platform consumers.
   * See `src/workers/dal/principal-adapter.ts` for mapping from R40 → canonical.
   */
  principal?: import('./xcp-identity-contracts').AuthenticatedPrincipal;
}

// ---- Admin list opts ----

export interface AccessRequestListOpts {
  status?: AccessRequestStatus;
  limit?: number;
  before_id?: string;
}

export interface UserListOpts {
  status?: UserStatus;
  limit?: number;
}
