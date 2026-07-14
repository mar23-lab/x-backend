// DalAdapter.ts · Backend-agnostic Data Access Layer interface
//
// Authority: ADR-V3-002 (backend-agnostic seam) · API_CONTRACT_V1.md §WorkersDalAdapter mapping
//
// Implementations:
//   - WorkersDalAdapter (Neon Postgres + Clerk) · production
//   - LocalDalAdapter (static JSON / window globals) · static demo
//
// CONTRACT INVARIANTS:
//   1. Every method takes workspaceId as the first parameter (tenant isolation)
//   2. Methods throw ApiError with code='UNAUTHORIZED' if workspaceId is empty/null
//   3. No method may read or write outside the bounds of the passed workspaceId
//   4. Visibility filtering happens INSIDE the adapter (not in route handlers)

import {
  WorkspaceId,
  UserId,
  ProjectId,
  SessionContext,
  EventPage,
  EventListOpts,
  EventStatus,
  EventStatusPatch,
  HarnessFlowEventInput,
  UpsertResult,
  Project,
  ProjectListOpts,
  ProjectScopeBinding,
  BoardCard,
  BoardCardListOpts,
  SignOffInput,
  SignOff,
  EntitlementResult,
  User,
  UserStatus,
  AccessRequest,
  AccessRequestInput,
  ReadinessAssessment,
  ReadinessAssessmentInput,
  CustomerAuthorityConsent,
  CustomerAuthorityState,
  CustomerConsentAckInput,
  OperatorAuthorityInput,
  RevokeCustomerAuthorityInput,
  PendingCustomerAuthorityApproval,
  PendingCustomerAuthorityListOpts,
  AccessRequestStatus,
  AccessRequestListOpts,
  AuditLogInput,
  UserListOpts,
  SyntheticDomain,
  SyntheticDomainId,
  SyntheticDomainCreateInput,
  SyntheticDomainListOpts,
  SyntheticDomainBinding,
  SyntheticDomainRoadmap,
  SyntheticDomainRoadmapId,
  SyntheticDomainRoadmapItem,
  SyntheticDomainRoadmapItemId,
  SyntheticDomainRoadmapCreateInput,
  SyntheticDomainRoadmapItemInput,
  SyntheticDomainGoal,
  SyntheticDomainGoalId,
  SyntheticDomainGoalCreateInput,
  SyntheticDomainGoalProgress,
  RoadmapStatus,
  RoadmapItemStatus,
  GoalStatus,
  SyntheticDomainPropagationRule,
  PropagationRuleId,
  PropagationRuleCreateInput,
  PropagationTrigger,
  PropagationAction,
  PropagationRuleStatus,
  SyntheticDomainRecommendation,
  RecommendationId,
  RecommendationListOpts,
  RecommendationStatus,
  PropagationTickResult,
  // Wave R-I.7 Stage C — investor portal (DR-11/12/13/14)
  NdaAcceptance,
  NdaAcceptanceInput,
  InvestorEntitlement,
  GrantInvestorTier1Input,
  EscalateInvestorTier2Input,
  RevokeInvestorTier2Input,
  TaskPacket,
  TaskPacketInput,
  EvidenceItem,
  EvidenceItemInput,
  ApprovalRequest,
  ApprovalRequestInput,
  ApprovalDecisionInput,
  ToolEvent,
  ToolEventInput,
  MetricDelta,
  MetricDeltaInput,
  CustomerDataLifecycleExecution,
  CustomerDataLifecycleExecutionInput,
  OperationalSpineListOpts,
  EffectiveTemplateSnapshot,
  EffectiveTemplateEnvelope,
  TemplateAdminApproval,
  TemplateAdminApprovalInput,
  TemplatePolicyListOpts,
  UserLearningSignal,
  UserLearningSignalInput,
  EffectivePersonalizationProfile,
  TenantLearningPromotion,
  TenantLearningPromotionInput,
  WorkspaceMember,
  WorkspaceMemberRole,
} from './types';
import type { OperatingMode } from './session-preferences-store';
import type { ModelRuntimesFacade } from './model-runtime-facade';
import type { PlanEntitiesFacade } from './plan-entities-facade';

export interface DalAdapter {
  /** GET /api/v1/session — returns user + workspace + projects context. */
  getSession(userId: UserId, workspaceId: WorkspaceId): Promise<SessionContext>;

  /** GET /api/v1/events — returns paginated events scoped to workspace + visibility filter. */
  listEvents(workspaceId: WorkspaceId, opts: EventListOpts): Promise<EventPage>;

  /** R54-Stage2 · operator-overlay event list. Lists events across ALL
   *  workspaces owned by the operator's identity set (ownerUserIds), so the
   *  cockpit chat surfaces the operator's real activity regardless of which of
   *  their orgs the producer wrote to. Operator-only; everyone else uses
   *  listEvents. TENANT GUARD: scoped to operator-owned workspaces only. */
  listEventsForOperator(ownerUserIds: string[], opts: EventListOpts): Promise<EventPage>;

  /** R55-3b · Operator chat-composer write gate. True ONLY when workspaceId is
   *  owned by the operator's identity set (owner_user_id ∈ ids). Backs the
   *  POST /events operator overlay so an orgless operator writes to their OWN
   *  workspace and nothing else. Fail-closed on empty input. */
  operatorOwnsWorkspace(ownerUserIds: string[], workspaceId: string): Promise<boolean>;

  /** Plain (NON owner-scoped) existence check — for admin contexts (e.g. the customer-approval
   *  inbox) that act across tenants and must reject a typo'd/nonexistent workspace_id. */
  workspaceExists(workspaceId: string): Promise<boolean>;

  /** POST /api/v1/events — idempotent upsert by event id within workspace. */
  upsertEvent(workspaceId: WorkspaceId, event: HarnessFlowEventInput): Promise<UpsertResult>;

  /** OS-3 UX Wave-2.1 · execution-pipeline status transition. UPDATEs a single
   *  operation_events row scoped to the operator's own workspaces. When
   *  expectedStatus is provided, the update is an ATOMIC CLAIM (`AND status =
   *  expectedStatus`) so a queued op is consumed run-exactly-once. upsertEvent is
   *  insert-only and cannot move a row through its lifecycle; this can. Returns
   *  {updated} = rows changed (0 = not found / wrong status / not the operator's).
   *  TENANT GUARD: scoped to operator-owned workspaces only. */
  updateEventStatusForOperator(
    ownerUserIds: string[],
    eventId: string,
    patch: EventStatusPatch,
    expectedStatus?: EventStatus | null,
  ): Promise<{ updated: number }>;

  /** OS-5 W2 · single-event read, tenant-scoped by workspace_id (status-class + identity columns).
   *  The digest-delivery consumer reads the approved proposal with it. */
  getEvent(
    workspaceId: WorkspaceId,
    eventId: string,
  ): Promise<{ id: string; status: string | null; approval_state: string | null; next_action: string | null; summary: string | null; body: string | null; agent_id: string | null } | null>;

  /** OS-5 W2 · workspace-scoped status re-point (ia-001 status-class only) with the same optional
   *  atomic expectedStatus claim as updateEventStatusForOperator. The caller must have ALREADY
   *  verified event_id ∈ workspace_id (e.g. the sign-offs route's tenant guard). */
  updateEventStatus(
    workspaceId: WorkspaceId,
    eventId: string,
    patch: EventStatusPatch,
    expectedStatus?: EventStatus | null,
  ): Promise<{ updated: number }>;

  /** F2 (260628) · customer self-service soft-delete: set archived_at (REVERSIBLE). Tenant-scoped
   *  (WHERE workspace_id) → a foreign/guessed event id returns updated:0. Content untouched (IA-001). */
  archiveEvent(workspaceId: WorkspaceId, eventId: string): Promise<{ updated: number }>;
  /** F2 · restore a soft-deleted event (clear archived_at). Tenant-scoped; reverses archiveEvent. */
  restoreEvent(workspaceId: WorkspaceId, eventId: string): Promise<{ updated: number }>;
  /** E3 (260628) · "recently deleted" — soft-deleted events within the restore window (sinceDays),
   *  newest first. Powers the Profile rollback panel (the countdown is derived in the UI). */
  listArchivedEvents(workspaceId: WorkspaceId, sinceDays: number, limit?: number): Promise<Array<{ id: string; summary: string | null; body: string | null; source_tool: string | null; project_id: string | null; archived_at: string }>>;
  /** F3 (260628) · purge cron: HARD-delete soft-deleted (archived_at) source_tool='xlooop' events
   *  older than `olderThanDays`. NOT workspace-scoped (a global retention sweep); scoped to xlooop
   *  so governance events are never hard-purged. Called only by the flag-gated purge cron. */
  purgeArchivedXlooopEvents(olderThanDays: number): Promise<{ deleted: number }>;

  /** GET /api/v1/projects — returns projects scoped to workspace. */
  listProjects(workspaceId: WorkspaceId, opts: ProjectListOpts): Promise<Project[]>;

  /**
   * R47.3 · POST /api/v1/projects · operator-creates a domain or sub-domain.
   * If parent_project_id is set, validates same-workspace and no cycles.
   */
  createProject(input: import('./types').ProjectCreateInput, actorUserId: UserId): Promise<Project>;

  /**
   * R54-Stage3-C · POST /api/v1/workspaces · operator creates a top-level
   * workspace owned by ownerUserId. id defaults to a slug of name. Idempotent
   * by id (ON CONFLICT updates name/slug/config). Returns the row.
   */
  createWorkspace(input: import('./types').WorkspaceCreateInput, ownerUserId: UserId): Promise<import('./types').WorkspaceRow>;

  /**
   * R54-Stage3-C · GET /api/v1/workspaces · list workspaces owned by the
   * operator identity set (owner_user_id = ANY(ownerUserIds)), newest first.
   */
  listWorkspacesForOperator(ownerUserIds: UserId[]): Promise<import('./types').WorkspaceRow[]>;

  /**
   * R55-4 · PATCH /api/v1/workspaces/:id · operator edits a workspace they own
   * (rename + merge config: origin/access_mode). Ownership-guarded; returns null
   * if the id is not owned by the operator identity set (so it can never touch
   * another tenant's row). config is jsonb-merged (partial patch is safe).
   */
  updateWorkspace(id: import('./types').WorkspaceId, patch: { name?: string; config?: Record<string, any> }, ownerUserIds: UserId[]): Promise<import('./types').WorkspaceRow | null>;

  /** R47.3 · GET /api/v1/projects/:id/children · list direct children. */
  listChildProjects(workspaceId: WorkspaceId, parentProjectId: ProjectId): Promise<Project[]>;

  /**
   * R45 · GET /api/v1/projects/:id · single project including scope_binding.
   * Returns null if not found OR if the caller's workspace doesn't match.
   */
  getProject(workspaceId: WorkspaceId, projectId: ProjectId): Promise<Project | null>;

  /**
   * R45 · PATCH /api/v1/projects/:id/scope · updates scope_binding.
   * Authority: caller must have owner or operator role in the workspace
   * (route layer enforces).
   * `binding` of null clears the binding (project falls back to direct project_id link).
   * Returns the updated Project. Writes scope_binding_updated_at + scope_binding_updated_by.
   */
  updateProjectScope(
    workspaceId: WorkspaceId,
    projectId: ProjectId,
    binding: ProjectScopeBinding | null,
    actorUserId: UserId
  ): Promise<Project>;

  /**
   * R55-L3 · PATCH /api/v1/projects/:id (rename + edit) and DELETE (soft-archive).
   * Updates name / description / status on a project the caller's workspace owns.
   * Only the provided fields change (undefined = leave as-is). DELETE is modeled as
   * a status='archived' patch (REVERSIBLE — mirrors the workspace soft-archive ethos;
   * no destructive row delete). Tenant-scoped by workspaceId in the WHERE clause.
   * Returns the updated Project, or null when the id is not found in this workspace
   * (so the route layer can answer 404 / 403 without leaking other tenants' ids).
   */
  updateProject(
    workspaceId: WorkspaceId,
    projectId: ProjectId,
    patch: { name?: string; description?: string | null; status?: import('./types').ProjectStatus },
    actorUserId: UserId
  ): Promise<Project | null>;

  /**
   * Project source bindings scope a stable project/domain id to metadata-only
   * source refs. OAuth authority remains user-scoped in user_source_connections;
   * these rows never store tokens or raw source content.
   */
  listProjectSourceBindings(
    workspaceId: WorkspaceId,
    projectId: ProjectId,
  ): Promise<import('./types').ProjectSourceBinding[]>;

  createProjectSourceBinding(
    workspaceId: WorkspaceId,
    projectId: ProjectId,
    input: import('./types').ProjectSourceBindingInput,
    actorUserId: UserId,
  ): Promise<import('./types').ProjectSourceBinding>;

  // ARCH-006 W2.1 (D2) — ensure a github_repo source binding for every (workspace, project, repo) the
  // operator's github events reference (backfill + ongoing). Operator-scoped, idempotent, FK-safe.
  // Returns the count of newly-created bindings. Feeds the data-graph's source/feeds lineage edges.
  ensureGithubRepoBindingsForOperator(ownerUserIds: UserId[]): Promise<number>;

  updateProjectSourceBinding(
    workspaceId: WorkspaceId,
    projectId: ProjectId,
    bindingId: string,
    patch: import('./types').ProjectSourceBindingPatch,
    actorUserId: UserId,
  ): Promise<import('./types').ProjectSourceBinding | null>;

  archiveProjectSourceBinding(
    workspaceId: WorkspaceId,
    projectId: ProjectId,
    bindingId: string,
    actorUserId: UserId,
  ): Promise<import('./types').ProjectSourceBinding | null>;

  /**
   * R45 · GET /api/v1/projects/:id/events · events matching project's scope_binding.
   * Computed as union of:
   *   1. operation_events.project_id = projectId (direct link · existing R40 path)
   *   2. operation_events matching scope_binding filters (NEW)
   * Returns deduplicated list ordered by occurred_at DESC.
   */
  listEventsForProjectScope(
    workspaceId: WorkspaceId,
    projectId: ProjectId,
    opts: EventListOpts
  ): Promise<EventPage>;

  /**
   * R52-A1 · GET /api/v1/projects/:id/provenance — which sources fed this
   * project (per source_tool: event_count + last_event_at + is_oauth_source).
   * Powers provenance chips on project cards (pillar 2).
   */
  getProjectProvenance(
    workspaceId: WorkspaceId,
    projectId: ProjectId
  ): Promise<{
    project_id: string;
    total_events: number;
    sources: Array<{ source_tool: string; event_count: number; last_event_at: string | null; is_oauth_source: boolean }>;
  }>;

  /**
   * R52-B1 · operator-controlled layout overlay (pillar 3 · "restructurable
   * in order"). One row per operator; layout is a partial overlay (absent
   * keys ⇒ read-model default). Returns null when the operator has no saved
   * layout yet (cockpit then renders default order).
   */
  getOperatorLayout(userId: UserId): Promise<{ user_id: string; layout: Record<string, unknown>; updated_at: string } | null>;

  /**
   * R52-B1 · upsert the operator's layout overlay. `layout` is stored
   * verbatim as JSONB (the route validates shape before calling). Returns
   * the persisted row.
   */
  putOperatorLayout(userId: UserId, layout: Record<string, unknown>): Promise<{ user_id: string; layout: Record<string, unknown>; updated_at: string }>;

  /** GET /api/v1/board-cards — returns board cards for a project (project belongs to workspace). */
  listBoardCards(
    workspaceId: WorkspaceId,
    projectId: ProjectId,
    opts: BoardCardListOpts
  ): Promise<BoardCard[]>;

  /** POST /api/v1/sign-offs — creates sign-off and updates event approval_state in one transaction. */
  createSignOff(
    workspaceId: WorkspaceId,
    userId: UserId,
    signOff: SignOffInput
  ): Promise<SignOff>;

  /** Backend-first operational spine: task packets scoped to a workspace. */
  createTaskPacket(workspaceId: WorkspaceId, actorUserId: UserId, input: TaskPacketInput): Promise<TaskPacket>;
  listTaskPackets(workspaceId: WorkspaceId, opts?: OperationalSpineListOpts): Promise<TaskPacket[]>;

  /** Customer-safe evidence references; metadata/projection only, no raw graph export. */
  createEvidenceItem(workspaceId: WorkspaceId, actorUserId: UserId, input: EvidenceItemInput): Promise<EvidenceItem>;
  listEvidenceItems(workspaceId: WorkspaceId, opts?: OperationalSpineListOpts): Promise<EvidenceItem[]>;

  /** Approval workflow requests and decisions scoped by workspace. */
  createApprovalRequest(workspaceId: WorkspaceId, actorUserId: UserId, input: ApprovalRequestInput): Promise<ApprovalRequest>;
  decideApprovalRequest(workspaceId: WorkspaceId, approvalId: string, actorUserId: UserId, input: ApprovalDecisionInput): Promise<ApprovalRequest | null>;
  listApprovalRequests(workspaceId: WorkspaceId, opts?: OperationalSpineListOpts): Promise<ApprovalRequest[]>;

  /** MCP/tool gateway audit events scoped by packet/workspace. */
  createToolEvent(workspaceId: WorkspaceId, actorUserId: UserId, input: ToolEventInput, opts?: import('./operational-spine-store').SpineUnificationOpts): Promise<ToolEvent>;
  listToolEvents(workspaceId: WorkspaceId, opts?: OperationalSpineListOpts): Promise<ToolEvent[]>;

  /** Metric deltas linked to evidence and packets for auditable progress claims. */
  createMetricDelta(workspaceId: WorkspaceId, actorUserId: UserId, input: MetricDeltaInput): Promise<MetricDelta>;
  listMetricDeltas(workspaceId: WorkspaceId, opts?: OperationalSpineListOpts): Promise<MetricDelta[]>;

  /** Customer data lifecycle execution receipts. Destructive requests archive scoped packets only after approval. */
  executeCustomerDataLifecycleRequest(
    workspaceId: WorkspaceId,
    actorUserId: UserId,
    input: CustomerDataLifecycleExecutionInput,
  ): Promise<CustomerDataLifecycleExecution>;

  /** Customer-safe effective template snapshots; no raw MB-P files or governance internals. */
  listEffectiveTemplateSnapshots(workspaceId: WorkspaceId, opts?: TemplatePolicyListOpts): Promise<EffectiveTemplateSnapshot[]>;

  /** Resolve effective tenant/user templates via global -> vertical -> tenant -> workspace/project -> user overlay. */
  resolveEffectiveTemplates(workspaceId: WorkspaceId, actorUserId: UserId, opts?: TemplatePolicyListOpts): Promise<EffectiveTemplateEnvelope[]>;

  /** Admin-only audit receipt for template/policy mutation approval and rollback linkage. */
  createTemplateAdminApproval(
    workspaceId: WorkspaceId,
    actorUserId: UserId,
    input: TemplateAdminApprovalInput,
  ): Promise<TemplateAdminApproval>;

  /** Resolve company + user personalization profile. User learning is private by default. */
  getEffectivePersonalizationProfile(
    workspaceId: WorkspaceId,
    actorUserId: UserId,
    roleKey?: string,
  ): Promise<EffectivePersonalizationProfile>;

  /** Record a scoped user-learning signal. Does not promote to company defaults. */
  createUserLearningSignal(
    workspaceId: WorkspaceId,
    actorUserId: UserId,
    input: UserLearningSignalInput,
  ): Promise<UserLearningSignal>;

  /** Admin/operator approval path for promoting a user signal to tenant-level learning. */
  createTenantLearningPromotion(
    workspaceId: WorkspaceId,
    actorUserId: UserId,
    input: TenantLearningPromotionInput,
  ): Promise<TenantLearningPromotion>;

  // ============================================================
  // R40 · Entitlement gate methods
  // ============================================================

  /**
   * Single source of truth for "what can this user see right now?".
   * Idempotently UPSERTs the user row (status=pending on first sight) and
   * returns a SessionState + payload appropriate to the user's entitlement.
   *
   * orgId is taken from the JWT's org_id claim and may be null if the user
   * has no Clerk org context yet (orgless session).
   */
  getSessionEntitlement(
    userId: UserId,
    orgId: WorkspaceId | null,
    email?: string | null
  ): Promise<EntitlementResult>;

  /**
   * R43.18 · Operator self-bootstrap. Idempotently ensures the configured
   * platform operator (MBP_OWNER_USER_ID) is approved with an active workspace
   * member row, so they can land in the workspace on first sign-in WITHOUT a
   * manual seed step.
   *
   * Steps (all ON CONFLICT idempotent):
   *   1. UPSERT users row with status='approved'
   *   2. UPSERT workspaces row with given id/name/slug
   *   3. UPSERT workspace_members(workspace, user) with role='owner', status='active'
   *
   * Returns the resolved workspace metadata so the caller can surface it.
   *
   * Privacy: actor_user_id is set to userId (self-bootstrap). Audit log entries
   * are written so the bootstrap is observable post-hoc.
   */
  bootstrapOperator(args: {
    userId: UserId;
    workspaceId: WorkspaceId;
    workspaceName: string;
    workspaceSlug: string;
    email: string | null;
  }): Promise<{ workspace_id: WorkspaceId; workspace_name: string }>;

  /** POST /api/v1/request-access — public, no auth, idempotent on email. */
  createAccessRequest(input: AccessRequestInput): Promise<AccessRequest>;

  // ---- Admin-only DAL methods (route layer enforces admin check) ----

  /** Returns paginated access_requests; default sort by created_at DESC. */
  listAccessRequests(opts: AccessRequestListOpts): Promise<AccessRequest[]>;

  /** Returns one access_request by id, or null if not found. */
  getAccessRequest(id: string): Promise<AccessRequest | null>;

  /**
   * Approves an access request: marks request status='invited', creates/updates the
   * users row with status='approved'. Does NOT create the workspace_members row —
   * admin still has to attach the user to a specific workspace via the onboard-customer
   * runbook (which does the Clerk org invite + workspace_members insert in one go).
   */
  approveAccessRequest(
    requestId: string,
    actorUserId: UserId,
    opts?: { rejection_reason?: never; invited_to_workspace_id?: WorkspaceId }
  ): Promise<AccessRequest>;

  /** Rejects an access request with a reason. */
  rejectAccessRequest(
    requestId: string,
    actorUserId: UserId,
    reason: string
  ): Promise<AccessRequest>;

  /**
   * R55 · customer registration. Persists the readiness Q&A + account type + enrichment and
   * back-links it to the access request. Idempotent on access_request_id (re-submit updates in
   * place). Called from the public request-access funnel; not an admin action.
   */
  createReadinessAssessment(input: ReadinessAssessmentInput): Promise<ReadinessAssessment>;

  /** Returns the readiness assessment for an access request, or null. */
  getReadinessAssessment(accessRequestId: string): Promise<ReadinessAssessment | null>;
  /** Part R · Stage C · newest readiness by email (Clerk-verified caller only — anonymous-lead linking). */
  getReadinessAssessmentByEmail(email: string): Promise<ReadinessAssessment | null>;
  /** Part R · Stage C · stamp a verified-email lead's NULL-workspace readiness onto a workspace. Returns count. */
  attachReadinessToWorkspaceByEmail(email: string, workspaceId: string, userId: string | null): Promise<number>;
  /** S1 (260628) · the captured customer context projected for AI consumption (cockpit chat + MCP
   *  get_effective_profile). Closes the write-only-silo bug. Returns a generic-fallback profile
   *  (provenance:'none') when no assessment is found. */
  getCustomerContextProfile(workspaceId: string): Promise<import('./customer-context-store').CustomerContextProfile>;

  /**
   * Server-side customer provisioning (replaces the onboard-customer CLI): idempotently
   * creates the workspace + owner/operator members + default project + day-1 roadmap events.
   * Run AFTER the Clerk org + user exist (post invite-accept).
   */
  provisionCustomerWorkspace(
    input: import('./customer-provisioning-store').ProvisionCustomerInput,
  ): Promise<import('./customer-provisioning-store').ProvisionCustomerResult>;

  /**
   * Accumulated-value + activity summary for a workspace — powers the retention-loop value
   * surface, the "since you left" delta (sinceIso), and leading must-have indicators.
   */
  getWorkspaceActivitySummary(
    workspaceId: WorkspaceId,
    sinceIso?: string | null,
  ): Promise<import('./workspace-activity-store').WorkspaceActivitySummary>;

  /** OS-4 P2 · the workspace Plan aggregate — every domain visible from the workspace (own +
   *  cross-workspace lenses) with its roadmaps (+ item-progress rollup) and goals, in 3 bounded
   *  queries. Powers ?screen=plan (the "we don't see roadmaps, goals" fix). Read-only. */
  listWorkspacePlan(
    workspaceId: WorkspaceId,
  ): Promise<{ domains: import('./roadmap-store').WorkspacePlanDomain[] }>;

  /** OS-4 P3 · attach a stray event to an intent — an L1 intent_id re-point + APPENDED audit receipt
   *  (ia-001: pointer change + audit event, same flow; receipt threaded under the event). Operator-only;
   *  null when the intent or event isn't in the operator's workspaces. */
  repointEventIntentForOperator(
    ownerUserIds: string[],
    intentId: string,
    eventId: string,
  ): Promise<import('./intent-store').RepointEventResult | null>;

  /** PMF (Sean Ellis) · record a user's "how would you feel without Xlooop" response (upsert by user). */
  recordPmfResponse(
    input: import('./pmf-store').PmfResponseInput,
  ): Promise<import('./pmf-store').PmfResponse>;

  /** PMF · the very-disappointed % metric + sentiment counts (operator dashboard). */
  getPmfSummary(): Promise<import('./pmf-store').PmfSummary>;

  /** Wave 3 · persist a cockpit-chat exchange to the (operator, scope) thread (cross-browser memory). */
  appendChatExchange(
    userId: string,
    scope: import('./chat-store').ChatScopeRef,
    messages: import('./chat-store').ChatMessageInput[],
  ): Promise<void>;

  /** Wave 3 · load the stored cockpit-chat thread for an (operator, scope), oldest → newest. */
  listChatHistory(
    userId: string,
    scope: import('./chat-store').ChatScopeRef,
    limit?: number,
  ): Promise<import('./chat-store').ChatMessageRow[]>;

  /**
   * DAU / return-rate rollup — the "daily-active use" half of the indispensability launch
   * criterion. Read-only, NO migration: derived from operation_events.occurred_at joined to
   * workspaces.owner_user_id. Operator-facing (gated at the route, like getPmfSummary).
   */
  getEngagementRollup(
    windowDays?: number,
  ): Promise<import('./engagement-store').EngagementRollup>;

  /** Wave 4 · the governance audit trail (sign-offs + the events/packets they act on) across the
   * operator's workspaces, newest first. Operator-facing — makes "who approved what, when" readable. */
  listGovernanceAuditLogForOperator(
    ownerUserIds: string[],
    limit?: number,
  ): Promise<import('./governance-store').GovernanceAuditEntry[]>;

  /**
   * R55 · customer authority/consent (IP-boundary hard-gate). Records the OPERATOR side
   * (manual approval, DR-11). Upserts the active (non-revoked) row for the workspace.
   */
  recordOperatorAuthority(input: OperatorAuthorityInput): Promise<CustomerAuthorityConsent>;

  /** Records the CUSTOMER side (in-app typed-name consent ack). Upserts the active row. */
  recordCustomerConsentAck(input: CustomerConsentAckInput): Promise<CustomerAuthorityConsent>;

  /** Returns the unlock state for a workspace; connectors + team invites gate on `unlocked`. */
  getCustomerAuthorityState(workspaceId: WorkspaceId): Promise<CustomerAuthorityState>;

  /**
   * Lifecycle L1 · withdraws authority/consent — sets revoked_at on the active row (immutable
   * supersede). Re-locks connectors + invites (getCustomerAuthorityState filters revoked rows).
   * Rejects with NOT_FOUND when there is no active row to revoke.
   */
  revokeCustomerAuthority(input: RevokeCustomerAuthorityInput): Promise<CustomerAuthorityConsent>;

  /**
   * Lifecycle L2 · the operator approval inbox — workspaces that consented (customer side) but are
   * not yet operator-approved and not revoked. Cross-workspace (operator/admin scope).
   */
  listPendingCustomerAuthorityApprovals(
    opts?: PendingCustomerAuthorityListOpts,
  ): Promise<PendingCustomerAuthorityApproval[]>;

  /** Returns Neon user by id, or null. */
  getUser(userId: UserId): Promise<User | null>;
  /** Part R · Stage B · Neon user by email (case-insensitive), or null. Marks a lead registered-vs-anonymous. */
  getUserByEmail(email: string): Promise<User | null>;

  /** Returns users by status filter. */
  listUsers(opts: UserListOpts): Promise<User[]>;

  /** Stage 3 · real members of a workspace (workspace_members LEFT JOIN users). */
  listWorkspaceMembers(workspaceId: WorkspaceId): Promise<WorkspaceMember[]>;

  /**
   * BATCH roster read (N+1 fix): members for MANY workspaces in one ownership-scoped query, grouped by
   * workspace_id. A workspace is included only when owned by the caller (owner_user_id ∈ ownerUserIds)
   * or it is currentWorkspaceId — so it can never enumerate another tenant's members.
   */
  listWorkspaceMembersForWorkspaces(
    workspaceIds: WorkspaceId[],
    ownerUserIds: UserId[],
    currentWorkspaceId: WorkspaceId | null,
  ): Promise<Record<string, WorkspaceMember[]>>;

  /**
   * Owner-only: change a member's workspace role. Tenant-scoped + audited; guards
   * against demoting the last remaining owner. Throws NOT_FOUND (404) if the member is
   * not in the workspace, LAST_OWNER (409) if it would orphan the workspace.
   */
  setWorkspaceMemberRole(
    workspaceId: WorkspaceId,
    targetUserId: UserId,
    role: WorkspaceMemberRole,
    actorUserId: UserId,
  ): Promise<WorkspaceMember>;

  /**
   * A1 · Owner-only: SOFT-remove a member from a workspace (backs the cockpit "Remove from workspace"
   * control). Tenant-scoped + audited; soft (removed_at) because workspace_members is no-hard-delete
   * protected. Throws CANNOT_REMOVE_SELF (409), LAST_OWNER (409), or NOT_FOUND (404).
   */
  removeWorkspaceMember(
    workspaceId: WorkspaceId,
    targetUserId: UserId,
    actorUserId: UserId,
  ): Promise<{ user_id: UserId; workspace_id: WorkspaceId; removed_at: string }>;

  /**
   * JA (260714) · operator-workspace-scope AUTHORIZATION read. TRUE iff `userId` OWNS `workspaceId`
   * (workspaces.owner_user_id) OR is an ACTIVE (removed_at IS NULL) member of it. READ-ONLY — the hard
   * predicate behind OPERATOR_WORKSPACE_SCOPE_ENABLED: a FALSE becomes a 403 at the route (never a
   * silent fall-back to the token org), so a customer can never scope a read to a workspace they don't
   * belong to. Mirrors the owner_user_id rule listWorkspaceMembersForWorkspaces already enforces.
   */
  userCanScopeWorkspace(userId: UserId, workspaceId: WorkspaceId): Promise<boolean>;
  /** JB · WRITE-path authz: TRUE only when the caller OWNS the workspace (owner_user_id). Stricter than
   * userCanScopeWorkspace (owner-or-member) so a mere member can't redirect a governed write; FALSE => 403. */
  userOwnsWorkspace(userId: UserId, workspaceId: WorkspaceId): Promise<boolean>;

  /** Wave B · the caller's persisted operating mode for a workspace ('watch' default when unset). */
  getOperatingMode(userId: UserId, workspaceId: WorkspaceId): Promise<OperatingMode>;
  /** Wave B · set the caller's operating mode for a workspace (UPSERT + audited). */
  setOperatingMode(userId: UserId, workspaceId: WorkspaceId, mode: OperatingMode, actorUserId: UserId): Promise<OperatingMode>;

  /** Wave C · model-runtime provider config (encrypted-at-rest credentials, workspace default, session
   *  override). A sub-facade — the crypto lives in the route layer; the store handles only sealed data. */
  readonly modelRuntimes: ModelRuntimesFacade;

  /** Admin-only: set user status (approved | suspended | pending). */
  setUserStatus(
    userId: UserId,
    status: UserStatus,
    actorUserId: UserId,
    opts?: { rejection_reason?: string }
  ): Promise<User>;

  /** Append-only audit log writer. Always succeeds (idempotent on (actor,action,target,timestamp)). */
  appendAuditLog(entry: AuditLogInput): Promise<void>;

  // ============================================================
  // R49' · Synthetic Domains (LEM-v3 PR-1)
  // ============================================================

  /**
   * POST /api/v1/synthetic-domains · operator/owner creates a synthetic domain.
   * Validates binding shape, owner role, workspace scope.
   * If workspace_id is NULL, visibility MUST be 'operator_only' (DB CHECK enforces).
   * On create, also computes initial membership and writes synthetic_domain_membership rows.
   */
  createSyntheticDomain(input: SyntheticDomainCreateInput, actorUserId: UserId): Promise<SyntheticDomain>;

  /**
   * GET /api/v1/synthetic-domains · lists active synthetic domains visible to the caller.
   * Workspace-scoped by default; pass workspace_id=null for cross-workspace listing
   * (operator-only). Adds membership_count to each row if include_membership_count=true.
   */
  listSyntheticDomains(opts: SyntheticDomainListOpts, callerUserId: UserId, isOperator: boolean): Promise<SyntheticDomain[]>;

  /**
   * GET /api/v1/synthetic-domains/:id · returns one domain.
   * Returns null if not found OR if the caller cannot see it (workspace + visibility).
   */
  getSyntheticDomain(id: SyntheticDomainId, callerUserId: UserId, callerWorkspaceId: WorkspaceId, isOperator: boolean): Promise<SyntheticDomain | null>;

  /**
   * PATCH /api/v1/synthetic-domains/:id/binding · updates binding + bumps binding_version.
   * Triggers membership recompute (re-populates synthetic_domain_membership for this domain).
   * Authority: only users matching edit_role (owner/operator/member) may call.
   */
  updateSyntheticDomainBinding(
    id: SyntheticDomainId,
    binding: SyntheticDomainBinding,
    actorUserId: UserId,
  ): Promise<SyntheticDomain>;

  /**
   * PATCH /api/v1/synthetic-domains/:id/archive · marks status='archived'.
   * Membership rows are preserved for audit; binding remains intact (paused, not destroyed).
   */
  archiveSyntheticDomain(id: SyntheticDomainId, actorUserId: UserId): Promise<SyntheticDomain>;

  /**
   * POST /api/v1/synthetic-domains/:id/refresh-membership · recomputes membership.
   * Idempotent; used by ad-hoc UI refresh + by PR-6 propagation worker on its tick.
   * Returns the new member project count.
   */
  refreshSyntheticDomainMembership(id: SyntheticDomainId, actorUserId: UserId): Promise<{ domain_id: SyntheticDomainId; member_count: number }>;

  /**
   * GET /api/v1/synthetic-domains/:id/members · returns the currently materialised
   * member projects for a domain.
   */
  listSyntheticDomainMembers(id: SyntheticDomainId, callerWorkspaceId: WorkspaceId, isOperator: boolean): Promise<Project[]>;

  // ============================================================
  // R49' PR-3 · Planning layer · roadmaps + goals
  // ============================================================

  /** POST /synthetic-domains/:id/roadmaps · operator creates a roadmap. */
  createRoadmap(input: SyntheticDomainRoadmapCreateInput, actorUserId: UserId): Promise<SyntheticDomainRoadmap>;

  /** GET /synthetic-domains/:id/roadmaps · lists roadmaps for a domain. */
  listRoadmapsForDomain(domainId: SyntheticDomainId, status?: RoadmapStatus): Promise<SyntheticDomainRoadmap[]>;

  /** GET /synthetic-domain-roadmaps/:roadmapId · returns single roadmap + items. */
  getRoadmap(roadmapId: SyntheticDomainRoadmapId): Promise<{ roadmap: SyntheticDomainRoadmap; items: SyntheticDomainRoadmapItem[] } | null>;

  /** PATCH /synthetic-domain-roadmaps/:roadmapId · updates title/description/target_date/status. */
  updateRoadmap(
    roadmapId: SyntheticDomainRoadmapId,
    patch: { title?: string; description?: string | null; target_date?: string | null; status?: RoadmapStatus; metadata?: Record<string, any> },
    actorUserId: UserId,
  ): Promise<SyntheticDomainRoadmap>;

  /** POST /synthetic-domain-roadmaps/:roadmapId/items · appends an item at the end. */
  addRoadmapItem(
    roadmapId: SyntheticDomainRoadmapId,
    input: SyntheticDomainRoadmapItemInput,
    actorUserId: UserId,
  ): Promise<SyntheticDomainRoadmapItem>;

  /** PATCH /synthetic-domain-roadmap-items/:itemId · partial update. */
  updateRoadmapItem(
    itemId: SyntheticDomainRoadmapItemId,
    patch: { title?: string; description?: string | null; status?: RoadmapItemStatus; target_date?: string | null; metadata?: Record<string, any> },
    actorUserId: UserId,
  ): Promise<SyntheticDomainRoadmapItem>;

  /** DELETE /synthetic-domain-roadmap-items/:itemId · soft-deletes the item (044, recoverable). */
  deleteRoadmapItem(itemId: SyntheticDomainRoadmapItemId, actorUserId: UserId): Promise<void>;

  /** POST /synthetic-domain-roadmap-items/:itemId/restore · un-deletes a soft-deleted item (044). */
  restoreRoadmapItem(itemId: SyntheticDomainRoadmapItemId, actorUserId: UserId): Promise<SyntheticDomainRoadmapItem>;

  /** POST /synthetic-domain-roadmaps/:roadmapId/reorder · accepts new ordered item-id list. */
  reorderRoadmapItems(
    roadmapId: SyntheticDomainRoadmapId,
    itemIdsInOrder: SyntheticDomainRoadmapItemId[],
    actorUserId: UserId,
  ): Promise<SyntheticDomainRoadmapItem[]>;

  // ---- Goals ----

  /** POST /synthetic-domains/:id/goals · operator creates a goal with derivation rule. */
  createGoal(input: SyntheticDomainGoalCreateInput, actorUserId: UserId): Promise<SyntheticDomainGoal>;

  /** GET /synthetic-domains/:id/goals · lists goals for a domain. */
  listGoalsForDomain(domainId: SyntheticDomainId, status?: GoalStatus): Promise<SyntheticDomainGoal[]>;

  /** GET /synthetic-domain-goals/:goalId · returns single goal. */
  getGoal(goalId: SyntheticDomainGoalId): Promise<SyntheticDomainGoal | null>;

  /** PATCH /synthetic-domain-goals/:goalId · partial update. */
  updateGoal(
    goalId: SyntheticDomainGoalId,
    patch: { title?: string; description?: string | null; target_value?: number; target_date?: string | null; status?: GoalStatus; metadata?: Record<string, any> },
    actorUserId: UserId,
  ): Promise<SyntheticDomainGoal>;

  /**
   * POST /synthetic-domain-goals/:goalId/recompute · re-evaluates the goal's derivation
   * against current data, writes a progress row, updates current_value, and (if
   * current_value >= target_value && status='active') flips status to 'achieved'.
   * Returns the new current_value.
   */
  recomputeGoalValue(goalId: SyntheticDomainGoalId, actorUserId: UserId, sourceSignalId?: string | null): Promise<{ goal: SyntheticDomainGoal; value: number }>;

  /** GET /synthetic-domain-goals/:goalId/progress · last N observations (default 100). */
  listGoalProgress(goalId: SyntheticDomainGoalId, limit?: number): Promise<SyntheticDomainGoalProgress[]>;

  // ============================================================
  // R49' PR-5+6 · Propagation rules + recommendations + worker tick
  // ============================================================

  /** POST /synthetic-domains/:id/propagation-rules · operator creates an if-then rule. */
  createPropagationRule(input: PropagationRuleCreateInput, actorUserId: UserId): Promise<SyntheticDomainPropagationRule>;

  /** GET /synthetic-domains/:id/propagation-rules · lists rules for a domain. */
  listPropagationRulesForDomain(domainId: SyntheticDomainId, status?: PropagationRuleStatus): Promise<SyntheticDomainPropagationRule[]>;

  /** PATCH /synthetic-domain-propagation-rules/:id · update rule (trigger/action/status). */
  updatePropagationRule(
    ruleId: PropagationRuleId,
    patch: { name?: string; description?: string | null; trigger?: PropagationTrigger; action?: PropagationAction; status?: PropagationRuleStatus },
    actorUserId: UserId,
  ): Promise<SyntheticDomainPropagationRule>;

  /** PATCH /synthetic-domain-propagation-rules/:id/archive · status='archived'. */
  archivePropagationRule(ruleId: PropagationRuleId, actorUserId: UserId): Promise<SyntheticDomainPropagationRule>;

  /** GET /synthetic-domains/:id/recommendations · lists recommendations (default status=pending). */
  listRecommendations(opts: RecommendationListOpts): Promise<SyntheticDomainRecommendation[]>;

  /** GET /synthetic-domain-recommendations/:id · single recommendation. */
  getRecommendation(id: RecommendationId): Promise<SyntheticDomainRecommendation | null>;

  /**
   * POST /synthetic-domain-recommendations/:id/accept · marks accepted + applies payload.
   * The accept handler interprets the recommendation kind and applies the action:
   *  - mark_goal_complete → flips the referenced goal to 'achieved'
   *  - add_roadmap_item   → appends the item to the referenced roadmap
   *  - flag_blocker       → no DB mutation; advisory only
   *  - others             → currently no-op; future PRs implement
   */
  acceptRecommendation(id: RecommendationId, actorUserId: UserId, note?: string, scope?: { workspaceIds: string[]; includeCrossWorkspace: boolean }): Promise<SyntheticDomainRecommendation>;

  /** POST /synthetic-domain-recommendations/:id/reject · marks rejected + records note. */
  rejectRecommendation(id: RecommendationId, actorUserId: UserId, note: string, scope?: { workspaceIds: string[]; includeCrossWorkspace: boolean }): Promise<SyntheticDomainRecommendation>;

  /**
   * POST /internal/propagation-tick · single worker tick.
   * Reads new events + active goals, evaluates active rules, writes pending
   * recommendations, expires past-due pending ones. Idempotent on restart.
   * Called by Cloudflare Cron Trigger (scheduled handler) every 60s.
   */
  runPropagationTick(actorUserId: UserId): Promise<PropagationTickResult>;

  // ============================================================
  // R50.3b · Clerk OAuth source connectors · user_source_connections CRUD
  // ============================================================
  //
  // These methods are user-scoped (NOT workspace-scoped) because Clerk-managed
  // OAuth connections belong to the user account, not the workspace. A user
  // who is a member of multiple workspaces sees the same connection set in
  // each one. The workspace_id column on user_source_connections is for
  // future tenant-bound provisioning (e.g. enterprise customer OAuth apps);
  // R50.3b stores `null` here.

  /** GET /api/v1/sources · list all user_source_connections rows for a user. */
  listUserSources(userId: UserId): Promise<import('./types').UserSourceConnection[]>;

  /** Get a single user_source_connection row scoped to user_id (404 if owned by different user). */
  getUserSource(
    userId: UserId,
    id: string,
  ): Promise<import('./types').UserSourceConnection | null>;

  /**
   * Upsert a user_source_connection. Idempotent on (user_id, provider) UNIQUE.
   * Used by:
   *   - POST /api/v1/sources/connect/:provider (after Clerk redirect-back)
   *   - GET /api/v1/sources reconciliation (DB row materialized from Clerk state)
   * Returns the canonical row (with DB-generated id + timestamps).
   */
  upsertUserSource(input: import('./types').UserSourceConnectionInput): Promise<import('./types').UserSourceConnection>;

  /**
   * DELETE /api/v1/sources/:id · disconnect a source.
   * Removes the user_source_connections row; does NOT revoke at Clerk.
   * Operator must visit dashboard.clerk.com → Account → Connections to revoke.
   */
  disconnectUserSource(userId: UserId, id: string): Promise<void>;

  /**
   * POST /api/v1/sources/:id/sync result · update last_sync_at + last_sync_error.
   * Called by R50.3d sync-tick cron; also exposed via manual-sync route.
   * On success: last_sync_at = now(), last_sync_error = null.
   * On failure: last_sync_at unchanged, last_sync_error = message, status = 'error'.
   */
  markUserSourceSync(
    userId: UserId,
    id: string,
    result: { success: true } | { success: false; error: string },
  ): Promise<void>;

  // G1 plan_entities (writes 1–8) + G2 source read_policy (write 25) · composed sub-facade,
  // accessed as dal.plan.<method> (createPlanEntity/listPlanEntities/getPlanEntity/updatePlanEntity/
  // softDeletePlanEntity/setUserSourceReadPolicy). Bodies/SQL in ./plan-entities-facade → ./plan-store
  // + ./source-store; keeps WorkersDalAdapter root ≤ FROZEN_DECOMPOSE ceiling. Routes: plan.ts + sources.ts.
  readonly plan: PlanEntitiesFacade;

  // ============================================================
  // R51-γ · LEM-v4 inference quality framework
  // Authority: docs/architecture/XLOOOP_SYSTEM_DESIGN_v1.md §16
  // Migrations: 009_lem_v4_inference_audit + 010_lem_v4_detector_config_seed
  //
  // Wave γ ships SIGNATURES + the read-only getActiveDetectorConfig impl
  // (needed to verify the genesis seed). Write-side methods (insertInferenceRun,
  // insertInferenceEmission, insertRecommendationRejection, etc.) gain bodies
  // in Wave δ when the inference engine is wired. Until then they throw a
  // descriptive Error at runtime so accidental early use fails loudly.
  // ============================================================

  /**
   * Read the currently-active detector config (one row with
   * deactivated_at IS NULL per the partial unique index on detector_config).
   * Returns null only if the genesis seed (migration 010) hasn't been applied.
   */
  getActiveDetectorConfig(): Promise<import('./types').DetectorConfig | null>;

  /**
   * Append a new versioned detector_config row. Caller is responsible for
   * deactivating the previous active row in the same transaction.
   */
  insertDetectorConfig(
    input: Omit<import('./types').DetectorConfig, 'activated_at' | 'deactivated_at'> & {
      activated_at?: string;
      deactivated_at?: string | null;
    }
  ): Promise<import('./types').DetectorConfig>;

  /** Begin a detector run with status='running'. */
  insertInferenceRun(input: import('./types').InferenceRunInput): Promise<import('./types').InferenceRun>;

  /** Mark a run completed (or failed) with counts + cost_ms. */
  completeInferenceRun(input: import('./types').InferenceRunCompletion): Promise<import('./types').InferenceRun>;

  /** Bulk-insert signal evaluations (one per candidate × signal). */
  bulkInsertInferenceSignalEvals(
    inputs: import('./types').InferenceSignalEvalInput[]
  ): Promise<{ inserted: number }>;

  /** Record an emitted recommendation in the audit trail. */
  insertInferenceEmission(
    input: import('./types').InferenceEmissionInput
  ): Promise<import('./types').InferenceEmission>;

  /** List inference emissions for a run (for the inbox UI in Wave ε). */
  listInferenceEmissionsForRun(
    runId: import('./types').InferenceRunId
  ): Promise<import('./types').InferenceEmission[]>;

  /** Record an operator rejection. Self-maintenance loop 4 may elevate
   *  to permanent_suppress_fingerprint after 3× rejects of same fingerprint. */
  insertRecommendationRejection(
    input: import('./types').RecommendationRejectionInput
  ): Promise<import('./types').RecommendationRejection>;

  /** Count prior rejections for a given pattern_fingerprint (used to
   *  compute reject_count_for_fingerprint + trigger permanent-suppress). */
  countRecommendationRejectionsForFingerprint(
    fingerprint: string
  ): Promise<number>;

  /** Upsert a (pattern_kind, bucket_lower, window_started_at) calibration row. */
  upsertCalibrationBucket(
    input: import('./types').CalibrationBucketUpsertInput
  ): Promise<import('./types').CalibrationBucket>;

  /** R53-W2 · read the newest operations-live-stream snapshot pushed by MB-P.
   *  Returns null when the table is empty (the route then falls back to the
   *  build-time bundle import). envelope = full xlooop.operations_live_stream. */
  getLatestLiveStreamSnapshot(
    streamId?: string
  ): Promise<{ source_mode: string; generated_at: string; valid_until: string | null; rows_count: number; envelope: Record<string, unknown>; ingested_at: string } | null>;

  /** Wave 5a · the durable operations_unified read-model. listUnifiedGovernance reads the materialized
   *  governance plane (newest first) as GovernanceStreamRow-shaped rows; materializeGovernanceSnapshot
   *  upserts envelope rows into it (write-through on ingest + lazy on the chat's fallback). */
  listUnifiedGovernance(limit?: number): Promise<import('./unified-store').UnifiedGovernanceRow[]>;
  materializeGovernanceSnapshot(rows: Array<Record<string, unknown>>): Promise<number>;

  /** Wave 5b · first-class intents (artefact + lineage), scoped to the operator's own workspaces.
   *  listIntentsForOperator lists them (optionally narrowed to a project/domain); getIntentLineage
   *  returns one intent + its child events + derived intents; createIntent / updateIntentStatus write
   *  the lifecycle and best-effort mirror into operations_unified (plane 'synthetic'). */
  listIntentsForOperator(
    ownerUserIds: string[],
    scope: { workspace_id?: string | null; project_id?: string | null; domain_id?: string | null },
    limit?: number,
  ): Promise<import('./intent-store').IntentRow[]>;
  getIntentLineageForOperator(
    ownerUserIds: string[],
    intentId: string,
  ): Promise<import('./intent-store').IntentLineage | null>;
  createIntent(input: import('./intent-store').CreateIntentInput): Promise<import('./intent-store').IntentRow>;
  updateIntentStatusForOperator(
    ownerUserIds: string[],
    intentId: string,
    status: string,
  ): Promise<import('./intent-store').IntentRow | null>;

  /** OS-5 W4 · edit an intent's title/summary (the intents TABLE is mutable; the appended
   *  evt_intent_edited_ receipt is the audit fact). Operator-scoped, fail-closed. */
  updateIntentFieldsForOperator(
    ownerUserIds: string[],
    intentId: string,
    patch: import('./intent-store').IntentFieldsPatch,
  ): Promise<import('./intent-store').IntentRow | null>;

  /** ARCH-006 W6 · first-class DECISIONS (context/criteria/rollback/causation). Operator-scoped, like
   *  intents; createDecision best-effort mirrors to operations_unified (graph `packet` node) + stamps
   *  audit_logs.causation_id (graph caused_by edge). getDecisionForOperator returns the decision + its
   *  sign-offs + audit trail (REUSED, never re-stored). */
  listDecisionsForOperator(
    ownerUserIds: string[],
    scope: { workspace_id?: string | null; project_id?: string | null; event_id?: string | null },
    limit?: number,
  ): Promise<import('./decision-store').DecisionRow[]>;
  getDecisionForOperator(
    ownerUserIds: string[],
    decisionId: string,
  ): Promise<import('./decision-store').DecisionDetail | null>;
  createDecision(input: import('./decision-store').CreateDecisionInput): Promise<import('./decision-store').DecisionRow>;

  /** ARCH-006 W6 · intent pre-enrichment (generated pros/cons/prior_resources/web_sources/recommended_path/
   *  metrics/confidence, keyed 1:1 to intents.id). upsert is idempotent (regeneratable); get → row or null. */
  upsertIntentEnrichment(intentId: string, enrichment: import('./enrichment-store').IntentEnrichmentInput): Promise<void>;
  getIntentEnrichmentForIntent(intentId: string): Promise<import('./enrichment-store').IntentEnrichmentRow | null>;

  /** W1 · privacy-safe usage telemetry (ids + counts only). recordUsageEvent logs one interaction
   *  (best-effort, idempotent); aggregateUsageForOperator reads back {ref_id, clicks, last_used_at}. */
  recordUsageEvent(input: import('./usage-store').UsageEventInput): Promise<void>;
  aggregateUsageForOperator(
    ownerUserIds: string[],
    kind: string,
    limit?: number,
  ): Promise<import('./usage-store').UsageAggregateRow[]>;

  /** W2 · durable per-operator prompt tags (global; the "Ask about X" quick-action chips). list reads
   *  them; upsert is add+edit (deterministic id); bulkUpsert is the localStorage→server migration. */
  listPromptTagsForUser(userId: string): Promise<import('./prompt-tags-store').PromptTagRow[]>;
  upsertPromptTagForUser(input: import('./prompt-tags-store').UpsertPromptTagInput): Promise<import('./prompt-tags-store').PromptTagRow | null>;
  bulkUpsertPromptTagsForUser(userId: string, tags: Array<{ tag_id?: string; id?: string; label?: string; message?: string }>): Promise<number>;
  deletePromptTagForUser(userId: string, tagId: string): Promise<boolean>;

  /** W3 · reflection-only folder connector baseline — the durable snapshot the next sync diffs against.
   *  getFolderBaseline returns [] when none stored (first sync emits every file as "added"). */
  getFolderBaseline(bindingId: string): Promise<import('../sources/folder-snapshot-core').FolderSnapshot>;
  putFolderBaseline(input: import('./folder-snapshot-store').PutFolderBaselineInput): Promise<void>;
  listFolderBindingsForOperator(workspaceIds: string[]): Promise<import('./folder-snapshot-store').FolderBindingSummary[]>;
  /** Phase D · the canonical scope (workspace/project/path) the binding carries, from the baseline. */
  getFolderBindingMeta(bindingId: string): Promise<import('./folder-snapshot-store').FolderBindingMeta | null>;

  /** Wave R-I.7 Stage C · investor portal (DR-11/12/13/14).
   *  Each method enforces: caller = their own row only; zero cross-user leak. */
  recordNdaAcceptance(input: NdaAcceptanceInput): Promise<NdaAcceptance>;
  getInvestorEntitlement(userId: UserId): Promise<InvestorEntitlement | null>;
  grantInvestorTier1(input: GrantInvestorTier1Input): Promise<InvestorEntitlement>;
  escalateInvestorToTier2(input: EscalateInvestorTier2Input): Promise<InvestorEntitlement>;
  revokeInvestorTier2(input: RevokeInvestorTier2Input): Promise<InvestorEntitlement>;
  getLatestNdaAcceptance(
    userId: string
  ): Promise<{ nda_version: string; accepted_at: string | null; email: string | null; full_name_typed: string | null } | null>;
  /** Track B Stage 2 · admin grants an investor entitlement (tier-1/tier-2). Admin-only (route-gated). */
  grantInvestorEntitlement(
    input: { userId: string; tier: string; workspaceId?: string | null; sectionFilter?: unknown },
    grantedBy: string
  ): Promise<{ id: string; user_id: string; tier: string; granted_at: string; granted_by: string } | null>;

  /** R53-W2 · store an operations-live-stream envelope pushed by MB-P via
   *  POST /api/v1/mbp-live-stream/ingest. Append-only; newest generated_at wins. */
  putLiveStreamSnapshot(
    input: {
      stream_id?: string;
      source_mode?: string;
      generated_at: string;
      valid_until?: string | null;
      rows_count?: number;
      sha256?: string | null;
      envelope: Record<string, unknown>;
    }
  ): Promise<{ id: string; stream_id: string; generated_at: string; rows_count: number }>;

  /** R53-W4 · operator-overlay provenance. Computes a project's source
   *  provenance by its scope_binding FILTER (actor_in / source_tool_in /
   *  combine), falling back to project_id equality when the project has no
   *  binding. TENANT GUARD: events are scoped to workspaces owned by
   *  ownerUserId ONLY — customer workspaces (owned by other user_ids) can never
   *  contribute. This is the operator-only path; non-operators keep the
   *  tenant-scoped getProjectProvenance. */
  getProjectProvenanceForOperator(
    ownerUserIds: string[],
    projectId: ProjectId
  ): Promise<{
    project_id: string;
    total_events: number;
    matched_by: 'scope_binding' | 'project_id';
    sources: Array<{ source_tool: string; event_count: number; last_event_at: string | null; is_oauth_source: boolean }>;
  }>;

  // ============================================================
  // Self-healing reclassification backstop (cron) · primitives.
  // Authority: backstop to the going-forward producer (PR #517 ·
  // routes/github-webhook.ts + lib/classify-body-of-work.ts). Consumed ONLY by
  // crons/reclassify-unattributed.ts to re-file the unattributed backlog into
  // the same 8 bodies-of-work projects. All four are scope-guarded + FK-safe.
  // ============================================================

  /** Workspace ids that opted into the 8-project split (have ≥1 project whose
   *  metadata->>'origin' = the split-origin marker). Scopes the whole loop so a
   *  non-split workspace is never touched. */
  listSplitEnabledWorkspaceIds(): Promise<string[]>;

  /** The unattributed backlog (project_id IS NULL OR project_id LIKE
   *  '%-allactivity') within the given split-enabled workspaces, newest first,
   *  bounded by `limit` (capped at 500). Returns [] for an empty workspace set. */
  listUnattributedEvents(
    workspaceIds: string[],
    limit: number,
  ): Promise<import('./reclassify-store').UnattributedEventRow[]>;

  /** The set of project ids that EXIST in the given workspaces — consulted
   *  before each re-file so a missing `${ws}-<slug>` is skipped (FK-safe). */
  listProjectIdsForWorkspaces(workspaceIds: string[]): Promise<Set<string>>;

  /** Re-file ONE event into its classified project. Tenant-scoped; only touches
   *  rows still unattributed at write time (idempotent). Returns rows updated
   *  (0 or 1). Caller has already proven the project exists. */
  reassignEventProject(
    workspaceId: string,
    eventId: string,
    projectId: string,
  ): Promise<number>;

  // ── ADR-XLOOP-ARCH-003 Phase 2 · the data-graph's persisted home (closes C6) ──
  /** Assemble the relational facts for ONE workspace into the buildDataGraph input shape
   *  (incl. the operations_unified ⨝ operation_events facts-JOIN for intent_id). */
  assembleDataGraphFacts(workspaceId: string, opts?: { includeDocuments?: boolean }): Promise<import('../graph/data-graph').DataGraphFacts>;
  /** The latest persisted graph snapshot for a workspace (the drift anchor); null if never built. */
  getLatestGraphSnapshot(workspaceId: string): Promise<import('./graph-store').GraphSnapshotRow | null>;
  /** Drop-and-rebuild the materialized graph for a workspace + append the snapshot (one transaction). */
  replaceWorkspaceGraph(
    workspaceId: string,
    nodes: import('../graph/data-graph').GraphNode[],
    edges: import('../graph/data-graph').GraphEdge[],
    meta: { graph_hash: string; graph_version: number; node_count: number; edge_count: number },
    generatedAtIso: string,
  ): Promise<void>;
  /** Read the v_artefact_lineage spine for a workspace (optionally anchored at a node / cause-edges only). */
  getArtefactLineage(workspaceId: string, opts?: { nodeId?: string; causeOnly?: boolean }): Promise<import('./graph-store').LineageEdgeRow[]>;

  // ---- Customer API tokens (connector credential · migration 037 / customer-token-store) ----
  /** Mint a customer connector token row (caller has already hashed the raw token). */
  createCustomerToken(
    input: import('./customer-token-store').CreateCustomerTokenInput,
  ): Promise<import('./customer-token-store').CustomerApiToken>;
  /** Hot auth path: resolve a live (non-revoked) token by its SHA-256 hash. */
  getCustomerTokenByHash(
    tokenSha256: string,
  ): Promise<import('./customer-token-store').CustomerApiToken | null>;
  /** Heartbeat last_used_at (fire-and-forget; never throw into the request path). */
  touchCustomerToken(id: string): Promise<void>;
  /** Workspace-scoped revoke — instant kill-switch (the revocation-proof gate). */
  revokeCustomerToken(
    workspaceId: WorkspaceId,
    id: string,
    revokedBy: UserId,
  ): Promise<import('./customer-token-store').CustomerApiToken>;
  /** Workspace-scoped list (hashes never leave the store). */
  listCustomerTokens(
    workspaceId: WorkspaceId,
  ): Promise<import('./customer-token-store').CustomerApiToken[]>;
}

/**
 * Helper for adapter implementations to guard tenant isolation.
 * Call at the top of every method.
 */
export function assertWorkspaceScope(workspaceId: WorkspaceId | undefined | null): asserts workspaceId is WorkspaceId {
  if (!workspaceId || typeof workspaceId !== 'string' || !workspaceId.trim()) {
    const err = new Error('workspace_id is required for all DAL operations');
    (err as any).code = 'UNAUTHORIZED';
    (err as any).status = 401;
    throw err;
  }
}
