// WorkersDalAdapter.ts · Neon Postgres + Clerk implementation of DalAdapter
//
// Authority: DATABASE_SCHEMA_V1.md · API_CONTRACT_V1.md · AUTH_TENANCY_MODEL.md
//
// Invariants enforced:
//   1. Every query includes WHERE workspace_id = $1 (tenant isolation)
//   2. assertWorkspaceScope() called at the top of every method
//   3. Visibility filter applied via SQL (not in app code)
//   4. Sign-off + event approval_state updated in a single transaction
//
// NOTE: This is the ONLY file allowed to reference Neon directly (per
// BACKEND_ROLE_DEFINITION.md §3 backend-agnostic seam).

import type { DalAdapter } from './DalAdapter';
import { assertWorkspaceScope } from './DalAdapter';
import { makeError } from './shared-helpers';
import type {
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
  ProjectStatus,
  ProjectListOpts,
  ProjectScopeBinding,
  ProjectSourceBinding,
  ProjectSourceBindingInput,
  ProjectSourceBindingPatch,
  ProjectSourceBindingStatus,
  ProjectSourceKind,
  ProjectSourceReadPolicy,
  BoardCard,
  BoardCardListOpts,
  SignOffInput,
  SignOff,
  WorkspaceRole,
  // R40 · entitlement
  EntitlementResult,
  SessionState,
  User,
  UserStatus,
  AccessRequest,
  AccessRequestInput,
  AccessRequestListOpts,
  ReadinessAssessment,
  ReadinessAssessmentInput,
  CustomerAuthorityConsent,
  CustomerAuthorityState,
  CustomerConsentAckInput,
  CustomerInviteAuditInput,
  CustomerInviteAuditReceipt,
  OperatorAuthorityInput,
  RevokeCustomerAuthorityInput,
  PendingCustomerAuthorityApproval,
  PendingCustomerAuthorityListOpts,
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
  NdaAcceptance,
  NdaAcceptanceInput,
  InvestorEntitlement,
  GrantInvestorTier1Input,
  EscalateInvestorTier2Input,
  RevokeInvestorTier2Input,
} from './types';
import {
  DEFAULT_SYNTHETIC_DERIVATIVE_MUTATIONS,
  computeSyntheticDerivationFingerprint,
  normalizeSyntheticSourceDomains,
} from './synthetic-domain-identity';
import {
  getCustomerAuthorityStateRow,
  recordCustomerConsentAckRow,
  recordCustomerInviteAuditRow,
  recordOperatorAuthorityRow,
  revokeCustomerAuthorityRow,
  listPendingCustomerAuthorityApprovalsRow,
} from './customer-authority-store';
import {
  createReadinessAssessmentRow,
  getReadinessAssessmentRow,
  getReadinessAssessmentByEmailRow,
  attachReadinessToWorkspaceByEmailRow,
} from './customer-readiness-store';
import { getCustomerContextProfileRow } from './customer-context-store';
import { provisionCustomerWorkspaceRow } from './customer-provisioning-store';
import { getWorkspaceActivitySummaryRow } from './workspace-activity-store';
import { recordPmfResponseRow, getPmfSummaryRow } from './pmf-store';
import { appendChatExchangeRow, listChatHistoryRow } from './chat-store';
import { getEngagementRollupRow } from './engagement-store';
import { seedStarterTemplateBindingsRow } from './template-policy-store';
import {
  createSyntheticDomainRow,
  listSyntheticDomainsRow,
  getSyntheticDomainRow,
  updateSyntheticDomainBindingRow,
  archiveSyntheticDomainRow,
  refreshSyntheticDomainMembershipRow,
  listSyntheticDomainMembersRow,
} from './synthetic-domain-store';
import {
  createGoalRow,
  listGoalsForDomainRow,
  getGoalRow,
  updateGoalRow,
  recomputeGoalValueRow,
  listGoalProgressRow,
  createPropagationRuleRow,
  listPropagationRulesForDomainRow,
  updatePropagationRuleRow,
  archivePropagationRuleRow,
  listRecommendationsRow,
  getRecommendationRow,
  acceptRecommendationRow,
  rejectRecommendationRow,
  runPropagationTickRow,
} from './propagation-store';
import type { RecommendationWriteScope } from './propagation-store';
export type { RecommendationWriteScope };
import {
  listProjectsRow,
  createProjectRow,
  listChildProjectsRow,
  getProjectRow,
  getProjectForOperatorRow,
  updateProjectScopeRow,
  updateProjectRow,
  listProjectSourceBindingsRow,
  createProjectSourceBindingRow,
  ensureGithubRepoBindingsForOperatorRow,
  updateProjectSourceBindingRow,
  archiveProjectSourceBindingRow,
} from './project-store';
import {
  listEventsRow,
  listEventsForOperatorRow,
  upsertEventRow,
  updateEventStatusForOperatorRow,
  listEventsForProjectScopeRow,
  getEventRow,
  updateEventStatusRow,
  archiveEventRow,
  restoreEventRow,
  listArchivedEventsRow,
  purgeArchivedXlooopEventsRow,
} from './event-store';
import { listSplitEnabledWorkspaceIdsRow, listUnattributedEventsRow, listProjectIdsForWorkspacesRow, reassignEventProjectRow, type UnattributedEventRow } from './reclassify-store';
import {
  getUserRow,
  getUserByEmailRow,
  listUsersRow,
  setUserStatusRow,
} from './user-store';
import { makeWorkspaceMemberFacade } from './workspace-member-facade';
import { makeSessionPreferencesFacade } from './session-preferences-facade';
import { makePlanEntitiesFacade } from './plan-entities-facade';
import { makeModelRuntimesFacade } from './model-runtime-facade';
import {
  operatorOwnsWorkspaceRow,
  workspaceExistsRow,
  createWorkspaceRow,
  listWorkspacesForOperatorRow,
  updateWorkspaceRow,
} from './workspace-store';
import {
  insertInferenceRunRow,
  completeInferenceRunRow,
  bulkInsertInferenceSignalEvalsRow,
  insertInferenceEmissionRow,
  listInferenceEmissionsForRunRow,
  insertRecommendationRejectionRow,
  countRecommendationRejectionsForFingerprintRow,
  upsertCalibrationBucketRow,
} from './inference-store';
import {
  getActiveDetectorConfigRow,
  insertDetectorConfigRow,
} from './detector-store';
import {
  getOperatorLayoutRow,
  putOperatorLayoutRow,
  getLatestLiveStreamSnapshotRow,
  putLiveStreamSnapshotRow,
} from './operations-store';
import { listUnifiedGovernanceRow, materializeGovernanceSnapshotRow } from './unified-store';
import { assembleDataGraphFactsRow, getLatestGraphSnapshotRow, replaceWorkspaceGraphRow, getArtefactLineageRow } from './graph-store';
import type { GraphNode, GraphEdge, DataGraphFacts } from '../graph/data-graph';
import {
  listIntentsForOperatorRow,
  getIntentLineageForOperatorRow,
  createIntentRow,
  updateIntentStatusForOperatorRow,
  repointEventIntentForOperatorRow,
  type RepointEventResult,
  materializeIntentToUnified,
  type IntentRow,
  type IntentLineage,
  type CreateIntentInput,
  updateIntentFieldsForOperatorRow,
  type IntentFieldsPatch,
} from './intent-store';
import {
  listDecisionsForOperatorRow,
  getDecisionForOperatorRow,
  createDecisionRow,
  materializeDecisionToUnified,
  type DecisionRow,
  type DecisionDetail,
  type CreateDecisionInput,
} from './decision-store';
import {
  upsertIntentEnrichmentRow,
  getIntentEnrichmentRow,
  type IntentEnrichmentRow,
  type IntentEnrichmentInput,
} from './enrichment-store';
import {
  recordUsageEventRow,
  aggregateUsageForOperatorRow,
  type UsageEventInput,
  type UsageAggregateRow,
} from './usage-store';
import {
  listPromptTagsForUserRow,
  upsertPromptTagForUserRow,
  bulkUpsertPromptTagsForUserRow,
  deletePromptTagForUserRow,
  type PromptTagRow,
  type UpsertPromptTagInput,
} from './prompt-tags-store';
import {
  getFolderBaselineRow,
  putFolderBaselineRow,
  listFolderBindingsForOperatorRow,
  getFolderBindingMetaRow,
  type PutFolderBaselineInput,
  type FolderBindingSummary,
  type FolderBindingMeta,
} from './folder-snapshot-store';
import type { FolderSnapshot } from '../sources/folder-snapshot-core';
import {
  getProjectProvenanceRow,
  getProjectProvenanceForOperatorRow,
  listBoardCardsRow,
  createSignOffRow,
  listGovernanceAuditLogForOperatorRow,
} from './governance-store';
import {
  createRoadmapRow,
  listWorkspacePlanRow,
  type WorkspacePlanDomain,
  listRoadmapsForDomainRow,
  getRoadmapRow,
  updateRoadmapRow,
  updateRoadmapItemRow,
  deleteRoadmapItemRow,
  restoreRoadmapItemRow,
  reorderRoadmapItemsRow,
} from './roadmap-store';
import { getCharterRow, upsertCharterRow } from './charter-store';
import {
  listUserSourcesRow,
  getUserSourceRow,
  upsertUserSourceRow,
  disconnectUserSourceRow,
  markUserSourceSyncRow,
} from './source-store';
import {
  getInvestorEntitlementRow,
  grantInvestorEntitlementRow,
  getLatestNdaAcceptanceRow,
  recordNdaAcceptanceRow,
  grantInvestorTier1Row,
  escalateInvestorToTier2Row,
  revokeInvestorTier2Row,
} from './investor-store';
import {
  createAccessRequestRow,
  listAccessRequestsRow,
  getAccessRequestRow,
  approveAccessRequestRow,
  rejectAccessRequestRow,
} from './access-store';
import {
  createCustomerTokenRow,
  getCustomerTokenByHashRow,
  touchCustomerTokenRow,
  revokeCustomerTokenRow,
  listCustomerTokensRow,
  type CreateCustomerTokenInput,
  type CustomerApiToken,
} from './customer-token-store';
import { applyOperationalSpineMethods, type OperationalSpineDalMethods } from './operational-spine-methods';
import { applyTemplatePolicyMethods, type TemplatePolicyDalMethods } from './template-policy-methods';
import {
  getSessionRow,
  bootstrapOperatorRow,
} from './session-store';
import type { Sql } from '../db/client';

// R40/R54 · operation-events pagination constants + normalizeEventRow moved to
// ./event-store (Stage 3.1, F10) alongside listEvents/listEventsForOperator/upsertEvent.

export class WorkersDalAdapter implements DalAdapter {
  // `rlsSql` (Plane 1 RLS cutover): optional restricted RLS-subject client; defaults to `sql` → byte-identical. See operational-spine-methods.ts.
  constructor(private readonly sql: Sql, private readonly rlsSql: Sql = sql) {}

  // ============================================================
  // /api/v1/session
  // ============================================================

  // Moved to ./session-store (Stage 3.1, F10 batch5). The DAL thin-delegates; the workspace /
  // workspace_members / projects reads live there.
  async getSession(userId: UserId, workspaceId: WorkspaceId): Promise<SessionContext> {
    return getSessionRow(this.sql, userId, workspaceId);
  }

  // ============================================================
  // /api/v1/events
  // ============================================================

  async listEvents(workspaceId: WorkspaceId, opts: EventListOpts): Promise<EventPage> {
    return listEventsRow(this.rlsSql, workspaceId, opts); // 043 · RLS-subject client (defaults to sql)
  }

  // F2/E3 (260628) · customer self-service soft-delete + restore + recently-deleted read.
  // All tenant-scoped (WHERE workspace_id); SQL lives in ./event-store.
  async archiveEvent(workspaceId: WorkspaceId, eventId: string): Promise<{ updated: number }> {
    return archiveEventRow(this.sql, workspaceId, eventId);
  }
  async restoreEvent(workspaceId: WorkspaceId, eventId: string, actorUserId?: UserId | string | null, requestId?: string | null) {
    return restoreEventRow(this.sql, workspaceId, eventId, actorUserId, requestId);
  }
  async listArchivedEvents(workspaceId: WorkspaceId, sinceDays: number, limit?: number) {
    return listArchivedEventsRow(this.sql, workspaceId, sinceDays, limit);
  }
  async purgeArchivedXlooopEvents(olderThanDays: number): Promise<{ deleted: number }> {
    return purgeArchivedXlooopEventsRow(this.sql, olderThanDays);
  }

  // R54-Stage2 · operator-overlay event list. Lists events across ALL workspaces
  // owned by the operator's identity set so the cockpit chat surfaces the
  // operator's real activity regardless of which of their orgs it landed in.
  // TENANT GUARD: workspace_id = ANY(operator-owned ids) — customer workspaces
  // (other owners) can never appear. Same query shape + filters as listEvents.
  async listEventsForOperator(ownerUserIds: string[], opts: EventListOpts): Promise<EventPage> {
    return listEventsForOperatorRow(this.sql, ownerUserIds, opts);
  }

  // OS-3 UX Wave-2.1 · execution-pipeline status transition (the queue consumer's claim + finalize).
  // upsertEvent is insert-only; this UPDATEs a row scoped to the operator's own workspaces, with an
  // optional atomic `expectedStatus` claim (run-exactly-once). 1:1 delegation; SQL lives in ./event-store.
  async updateEventStatusForOperator(
    ownerUserIds: string[],
    eventId: string,
    patch: EventStatusPatch,
    expectedStatus?: EventStatus | null,
  ): Promise<{ updated: number }> {
    return updateEventStatusForOperatorRow(this.sql, ownerUserIds, eventId, patch, expectedStatus);
  }

  // OS-5 W2 · digest-delivery primitives — 1:1 delegations; SQL lives in ./event-store.
  async getEvent(workspaceId: string, eventId: string) {
    return getEventRow(this.rlsSql, workspaceId, eventId); // 043 · RLS-subject client (see listEvents)
  }

  async updateEventStatus(
    workspaceId: string,
    eventId: string,
    patch: EventStatusPatch,
    expectedStatus?: EventStatus | null,
  ): Promise<{ updated: number }> {
    return updateEventStatusRow(this.sql, workspaceId, eventId, patch, expectedStatus);
  }

  // R55-3b · Operator chat-composer write gate. Returns true ONLY when
  // `workspaceId` is owned by one of the operator's verified identity ids
  // (owner_user_id ∈ ids). Backs the POST /events operator overlay so an orgless
  // operator can write to THEIR OWN workspace and nothing else — the write
  // mirror of listEventsForOperator's read scoping. Fail-closed on empty input.
  async operatorOwnsWorkspace(ownerUserIds: string[], workspaceId: string): Promise<boolean> {
    return operatorOwnsWorkspaceRow(this.sql, ownerUserIds, workspaceId);
  }

  async workspaceExists(workspaceId: string): Promise<boolean> {
    return workspaceExistsRow(this.sql, workspaceId);
  }

  // ============================================================
  // POST /api/v1/events (idempotent upsert)
  // ============================================================

  async upsertEvent(workspaceId: WorkspaceId, event: HarnessFlowEventInput): Promise<UpsertResult> {
    return upsertEventRow(this.sql, workspaceId, event);
  }

  // ============================================================
  // /api/v1/projects
  // ============================================================

  async listProjects(workspaceId: WorkspaceId, opts: ProjectListOpts): Promise<Project[]> {
    return listProjectsRow(this.rlsSql, workspaceId, opts); // 045 · RLS-subject client (defaults to sql)
  }

  // ============================================================
  // R47.3 · project nesting · create + list children
  // ============================================================

  async createProject(
    input: import('./types').ProjectCreateInput,
    actorUserId: UserId,
  ): Promise<Project> {
    return createProjectRow(this.sql, input, actorUserId);
  }

  // R54-Stage3-C · operator creates a top-level workspace they own.
  async createWorkspace(
    input: import('./types').WorkspaceCreateInput,
    ownerUserId: UserId,
  ): Promise<import('./types').WorkspaceRow> {
    return createWorkspaceRow(this.sql, input, ownerUserId);
  }

  async listWorkspacesForOperator(ownerUserIds: UserId[]): Promise<import('./types').WorkspaceRow[]> {
    return listWorkspacesForOperatorRow(this.sql, ownerUserIds);
  }

  // R55-4 · operator edits a workspace they own: rename + merge config
  // (origin/access_mode/...). OWNERSHIP-GUARDED by the WHERE clause — an update
  // to a workspace the operator does not own matches 0 rows → returns null, so
  // this can never touch another tenant's row. config uses jsonb `||` merge so
  // a partial patch never drops other config keys.
  async updateWorkspace(
    id: import('./types').WorkspaceId,
    patch: { name?: string; config?: Record<string, any> },
    ownerUserIds: UserId[],
  ): Promise<import('./types').WorkspaceRow | null> {
    return updateWorkspaceRow(this.sql, id, patch, ownerUserIds);
  }

  async listChildProjects(workspaceId: WorkspaceId, parentProjectId: ProjectId): Promise<Project[]> {
    return listChildProjectsRow(this.rlsSql, workspaceId, parentProjectId); // 045 · RLS-subject client
  }

  // ============================================================
  // R45 · single-project read + scope_binding management + scoped-events read
  // ============================================================

  async getProject(workspaceId: WorkspaceId, projectId: ProjectId): Promise<Project | null> {
    return getProjectRow(this.rlsSql, workspaceId, projectId); // 047-B · RLS-subject client
  }

  // R53-W4.x · operator overlay: resolve an owned project by id across the operator's
  // OWN workspaces (not the JWT workspace), so a project living in a non-active org
  // (mbp-private, x-docs) loads instead of 404ing. Access gated by the route.
  async getProjectForOperator(ownerUserIds: string[], projectId: ProjectId): Promise<Project | null> {
    return getProjectForOperatorRow(this.sql, ownerUserIds, projectId);
  }

  async updateProjectScope(
    workspaceId: WorkspaceId,
    projectId: ProjectId,
    binding: ProjectScopeBinding | null,
    actorUserId: UserId,
  ): Promise<Project> {
    return updateProjectScopeRow(this.sql, workspaceId, projectId, binding, actorUserId);
  }

  // R55-L3 · rename / edit / soft-archive a project. Only provided fields change
  // (COALESCE keeps the current value when the param is null). status='archived'
  // is the soft-delete path (DELETE route). Tenant-scoped by workspaceId; 0 rows
  // (unowned / unknown id) → null so the route can answer 404 without enumerating.
  async updateProject(
    workspaceId: WorkspaceId,
    projectId: ProjectId,
    patch: { name?: string; description?: string | null; status?: ProjectStatus },
    actorUserId: UserId,
  ): Promise<Project | null> {
    return updateProjectRow(this.sql, workspaceId, projectId, patch, actorUserId);
  }

  async listProjectSourceBindings(
    workspaceId: WorkspaceId,
    projectId: ProjectId,
  ): Promise<ProjectSourceBinding[]> {
    return listProjectSourceBindingsRow(this.rlsSql, workspaceId, projectId); // 047 · RLS-subject client
  }

  async createProjectSourceBinding(
    workspaceId: WorkspaceId,
    projectId: ProjectId,
    input: ProjectSourceBindingInput,
    actorUserId: UserId,
  ): Promise<ProjectSourceBinding> {
    return createProjectSourceBindingRow(this.sql, workspaceId, projectId, input, actorUserId);
  }

  async ensureGithubRepoBindingsForOperator(ownerUserIds: UserId[]): Promise<number> {
    return ensureGithubRepoBindingsForOperatorRow(this.sql, ownerUserIds);
  }

  async updateProjectSourceBinding(
    workspaceId: WorkspaceId,
    projectId: ProjectId,
    bindingId: string,
    patch: ProjectSourceBindingPatch,
    actorUserId: UserId,
  ): Promise<ProjectSourceBinding | null> {
    return updateProjectSourceBindingRow(this.sql, workspaceId, projectId, bindingId, patch, actorUserId);
  }

  async archiveProjectSourceBinding(
    workspaceId: WorkspaceId,
    projectId: ProjectId,
    bindingId: string,
    actorUserId: UserId,
  ): Promise<ProjectSourceBinding | null> {
    return archiveProjectSourceBindingRow(this.sql, workspaceId, projectId, bindingId, actorUserId);
  }

  // Moved to ./event-store (Stage 3.1, F10 batch5) alongside the rest of the operation_events
  // family. The DAL thin-delegates; the direct-link + scope_binding-filter event reads + the
  // collectScopeFilterValues helper live there.
  async listEventsForProjectScope(
    workspaceId: WorkspaceId,
    projectId: ProjectId,
    opts: EventListOpts,
  ): Promise<EventPage> {
    return listEventsForProjectScopeRow(this.sql, workspaceId, projectId, opts);
  }

  // ============================================================
  // R52-A1 · /api/v1/projects/:id/provenance
  // ============================================================
  //
  // Source→Project provenance: which sources fed this project, how many
  // events each contributed, and when each last produced one. Powers the
  // provenance chips on project cards (pillar 2 · "projects connected from
  // any source"). OAuth-source tools (github/google_drive/dropbox/gitlab/
  // microsoft_onedrive) are flagged so the UI can foreground them vs the
  // internal tools (codex/claude/harness/mbp/xlooop/operator).
  // Moved to ./governance-store (Stage 3.1, F10 batch5). The DAL thin-delegates; the grouped
  // GROUP BY source_tool provenance read + OAUTH_SOURCE_TOOLS flagging live there.
  async getProjectProvenance(
    workspaceId: WorkspaceId,
    projectId: ProjectId,
  ): Promise<{
    project_id: string;
    total_events: number;
    sources: Array<{ source_tool: string; event_count: number; last_event_at: string | null; is_oauth_source: boolean }>;
  }> {
    return getProjectProvenanceRow(this.sql, workspaceId, projectId);
  }

  // R53-W4 · operator-overlay provenance via scope_binding.
  // The governance projects the operator cockpit shows (xlooop-product, mbp-ops…)
  // claim events by a scope_binding FILTER, not by project_id. This computes
  // provenance over events matching that filter, scoped to the operator's OWN
  // workspaces only (tenant guard). Bounded candidate set (operator's own
  // events) → filtered in JS to avoid dynamic-SQL composition.
  // Moved to ./governance-store (Stage 3.1, F10 batch5). The DAL thin-delegates; the TENANT
  // GUARD (owner-id workspace derivation + owner-scoped operation_events read) + scope_binding
  // matcher + OAUTH_SOURCE_TOOLS flagging live there. Tenant-isolation semantics unchanged.
  async getProjectProvenanceForOperator(
    ownerUserIds: string[],
    projectId: ProjectId,
  ): Promise<{
    project_id: string;
    total_events: number;
    matched_by: 'scope_binding' | 'project_id';
    sources: Array<{ source_tool: string; event_count: number; last_event_at: string | null; is_oauth_source: boolean }>;
  }> {
    return getProjectProvenanceForOperatorRow(this.sql, ownerUserIds, projectId);
  }

  // Self-healing reclassification backstop (cron) · 1:1 delegations to ./reclassify-store (backstop to PR #517).
  listSplitEnabledWorkspaceIds = (): Promise<string[]> => listSplitEnabledWorkspaceIdsRow(this.sql);
  listUnattributedEvents = (workspaceIds: string[], limit: number): Promise<UnattributedEventRow[]> => listUnattributedEventsRow(this.sql, workspaceIds, limit);
  listProjectIdsForWorkspaces = (workspaceIds: string[]): Promise<Set<string>> => listProjectIdsForWorkspacesRow(this.sql, workspaceIds);
  reassignEventProject = (workspaceId: string, eventId: string, projectId: string): Promise<number> => reassignEventProjectRow(this.sql, workspaceId, eventId, projectId);

  // ============================================================
  // /api/v1/board-cards
  // ============================================================

  // Moved to ./governance-store (Stage 3.1, F10 batch5). The DAL thin-delegates; the board_cards
  // SELECT + normalizeBoardCardRow live there.
  async listBoardCards(
    workspaceId: WorkspaceId,
    projectId: ProjectId,
    opts: BoardCardListOpts
  ): Promise<BoardCard[]> {
    return listBoardCardsRow(this.rlsSql, workspaceId, projectId, opts); // 047 · RLS-subject client
  }

  // ============================================================
  // POST /api/v1/sign-offs
  // ============================================================

  // Moved to ./governance-store (Stage 3.1, F10 batch5). The DAL thin-delegates; the cross-tenant
  // guard + sign_offs INSERT / operation_events approval_state UPDATE transaction live there.
  async createSignOff(
    workspaceId: WorkspaceId,
    userId: UserId,
    signOff: SignOffInput,
    requestId?: string | null,
  ): Promise<SignOff> {
    return createSignOffRow(this.sql, workspaceId, userId, signOff, requestId);
  }

  // ============================================================
  // R40 · Entitlement gate
  // ============================================================

  async getSessionEntitlement(
    userId: UserId,
    orgId: WorkspaceId | null,
    email?: string | null
  ): Promise<EntitlementResult> {
    if (!userId) throw makeError('UNAUTHORIZED', 'user_id required', 401);

    // Step 1 · UPSERT the user row (status=pending on first sight).
    // This is the "I just saw a new Clerk user" event capture.
    const userRows = (await this.sql/*sql*/`
      INSERT INTO users (id, email, status)
      VALUES (${userId}, ${email ?? null}, 'pending')
      ON CONFLICT (id) DO UPDATE
        SET email = COALESCE(EXCLUDED.email, users.email),
            updated_at = now()
      RETURNING id, email, status, is_admin, approved_at, approved_by,
                rejection_reason, suspended_at, metadata, created_at, updated_at
    `) as User[];
    const user = userRows[0]!;

    // Step 2 · Hard-stop gates on user.status FIRST (per AUTH_TENANCY §gates)
    if (user.status === 'rejected' || user.status === 'suspended') {
      return {
        state: 'access_denied',
        user: { id: user.id, email: user.email ?? '', role: 'viewer' },
        workspace: null,
        projects: [],
        message: user.status === 'rejected'
          ? (user.rejection_reason || 'Access denied')
          : 'Account suspended',
      };
    }

    // Step 3 · Check if there's an open access_request for this email (R40 Path B)
    let openRequestId: string | undefined = undefined;
    if (email) {
      const reqRows = (await this.sql/*sql*/`
        SELECT id FROM access_requests
        WHERE email = ${email} AND status = 'pending'
        ORDER BY created_at DESC LIMIT 1
      `) as Array<{ id: string }>;
      openRequestId = reqRows[0]?.id;
    }

    // Step 4 · If user status is still pending, return pending_access
    if (user.status === 'pending') {
      const result: EntitlementResult = {
        state: 'pending_access',
        user: { id: user.id, email: user.email ?? '', role: 'viewer' },
        workspace: null,
        projects: [],
        message: openRequestId
          ? 'Access request received; awaiting admin approval.'
          : 'Account exists but is not yet approved by an administrator.',
      };
      if (openRequestId) result.access_request_id = openRequestId;
      return result;
    }

    // Step 5 · status is 'approved' — look up workspace membership.
    //
    // R43.12 (2026-05-27): platform operators may fall back from a missing or
    // mismatched Clerk org to their first active workspace_member. 2026-06-22
    // tenant-hardening narrows that bridge to trusted Xlooop identities only:
    // external customers must use the active Clerk org as the authoritative
    // company tenant. This prevents a wrong active org from opening a different
    // customer workspace just because the user has another DB membership.
    //
    // Operator fallback still handles:
    //   - Multi-org Clerk users whose Clerk session auto-activated the WRONG
    //     org (one not seeded in our DB)
    //   - Operators who created a Clerk org but never added themselves as a
    //     member (so their JWT has no org_id) yet have a DB-seeded membership
    //   - Generally: prefer DB-truth over JWT-truth when they disagree, so
    //     a frontend-side Clerk state hiccup doesn't lock approved users out
    //
    // Pre-R43.12, both cases above returned `authenticated_no_access` with
    // a misleading "ask admin to invite you" message even when the DB had a
    // valid active membership.
    let member: {
      role: WorkspaceRole;
      member_status: string;
      ws_id: string;
      ws_name: string;
      ws_slug: string | null;
    } | undefined;
    let resolvedOrgId: WorkspaceId | null = orgId;
    const effectiveEmail = String(user.email ?? email ?? '').trim().toLowerCase();
    const trustedPlatformUser = effectiveEmail === 'marat@xlooop.com' || effectiveEmail.endsWith('@xlooop.com');

    if (orgId) {
      const memberRows = (await this.sql/*sql*/`
        SELECT wm.role, wm.status AS member_status,
               w.id AS ws_id, w.name AS ws_name, w.slug AS ws_slug
        FROM workspace_members wm
        JOIN workspaces w ON w.id = wm.workspace_id
        WHERE wm.workspace_id = ${orgId} AND wm.user_id = ${userId} AND wm.status = 'active'
        LIMIT 1
      `) as Array<{
        role: WorkspaceRole;
        member_status: string;
        ws_id: string;
        ws_name: string;
        ws_slug: string | null;
      }>;
      member = memberRows[0];
    }

    // Fallback: no member match for the JWT orgId (or orgId was null).
    // Pick the user's first active workspace_member only for trusted platform
    // identities. External customers fail closed and must activate their Clerk
    // company org.
    if (!member && trustedPlatformUser) {
      const fallbackRows = (await this.sql/*sql*/`
        SELECT wm.role, wm.status AS member_status,
               w.id AS ws_id, w.name AS ws_name, w.slug AS ws_slug
        FROM workspace_members wm
        JOIN workspaces w ON w.id = wm.workspace_id
        WHERE wm.user_id = ${userId} AND wm.status = 'active'
        ORDER BY wm.activated_at ASC NULLS LAST, wm.workspace_id ASC
        LIMIT 1
      `) as Array<{
        role: WorkspaceRole;
        member_status: string;
        ws_id: string;
        ws_name: string;
        ws_slug: string | null;
      }>;
      member = fallbackRows[0];
      if (member) resolvedOrgId = member.ws_id as WorkspaceId;
    }

    if (!member) {
      return {
        state: 'authenticated_no_access',
        user: { id: user.id, email: user.email ?? '', role: 'viewer' },
        workspace: null,
        projects: [],
        message: orgId
          ? 'You are not an active member of the selected company workspace. Contact admin.'
          : 'Approved but no company organization is active in Clerk. Select or accept your company organization and retry.',
      };
    }

    // Step 7 · Full approved workspace — load projects (use the resolved
    // workspace id, which may differ from the JWT orgId after fallback).
    const projectRows = (await this.sql/*sql*/`
      SELECT id, name, status
      FROM projects
      WHERE workspace_id = ${resolvedOrgId} AND status != 'archived'
      ORDER BY created_at DESC
      LIMIT 200
    `) as Array<{ id: string; name: string; status: Project['status'] }>;

    // Q-A (260720) · workspace typing exposure — BEST-EFFORT. Migration 085 is STAGED
    // (operator-applied), so a pre-085 DB lacks workspace_type / relationship_status; the typed read
    // errors (42703) and the catch leaves the R40 workspace shape byte-identical to today. Separate
    // PK lookup (not folded into the membership JOINs above) so those hot queries never change shape
    // and a failure here can never break /session.
    let typing: { workspace_type: string; relationship_status: string } | undefined;
    try {
      const typingRows = (await this.sql/*sql*/`
        SELECT workspace_type, relationship_status FROM workspaces WHERE id = ${member.ws_id} LIMIT 1
      `) as Array<{ workspace_type: string | null; relationship_status: string | null }>;
      const t = typingRows[0];
      if (t && t.workspace_type && t.relationship_status) {
        typing = { workspace_type: String(t.workspace_type), relationship_status: String(t.relationship_status) };
      }
    } catch { /* pre-085 DB — omit the fields (fail-open to today's shape) */ }

    return {
      state: 'approved_workspace',
      user: { id: user.id, email: user.email ?? '', role: member.role },
      workspace: { id: member.ws_id, name: member.ws_name, slug: member.ws_slug, ...(typing ?? {}) },
      projects: projectRows.map(p => ({ id: p.id, name: p.name, status: p.status })),
      message: 'Active workspace.',
    };
  }

  // AI-EXEC-2 · materialize an invited teammate's membership (owner connection — a governed member write).
  async materializeInvitedMembership(
    input: import('./invite-membership-store').MaterializeInvitedMembershipInput,
  ): Promise<import('./invite-membership-store').MaterializeInvitedMembershipResult> {
    const { materializeInvitedMembershipRow } = await import('./invite-membership-store');
    return materializeInvitedMembershipRow(this.sql, input);
  }

  // ============================================================
  // R43.18 · Operator self-bootstrap
  // ============================================================

  // Moved to ./session-store (Stage 3.1, F10 batch5). The DAL thin-delegates; the user/workspace/
  // workspace_member upserts + the inline audit_logs write live there.
  async bootstrapOperator(args: {
    userId: UserId;
    workspaceId: WorkspaceId;
    workspaceName: string;
    workspaceSlug: string;
    email: string | null;
  }): Promise<{ workspace_id: WorkspaceId; workspace_name: string }> {
    return bootstrapOperatorRow(this.sql, args);
  }

  // ---- Access requests (Path B) ----

  async createAccessRequest(input: AccessRequestInput): Promise<AccessRequest> {
    return createAccessRequestRow(this.sql, input);
  }

  async listAccessRequests(opts: AccessRequestListOpts): Promise<AccessRequest[]> {
    return listAccessRequestsRow(this.sql, opts);
  }

  async getAccessRequest(id: string): Promise<AccessRequest | null> {
    return getAccessRequestRow(this.sql, id);
  }

  // ---- Customer API tokens (connector credential · customer-token-store) ----

  async createCustomerToken(input: CreateCustomerTokenInput): Promise<CustomerApiToken> {
    return createCustomerTokenRow(this.sql, input);
  }

  async getCustomerTokenByHash(tokenSha256: string): Promise<CustomerApiToken | null> {
    return getCustomerTokenByHashRow(this.sql, tokenSha256);
  }

  async touchCustomerToken(id: string): Promise<void> {
    return touchCustomerTokenRow(this.sql, id);
  }

  async revokeCustomerToken(
    workspaceId: WorkspaceId,
    id: string,
    revokedBy: UserId,
  ): Promise<CustomerApiToken> {
    return revokeCustomerTokenRow(this.sql, workspaceId, id, revokedBy);
  }

  async listCustomerTokens(workspaceId: WorkspaceId): Promise<CustomerApiToken[]> {
    return listCustomerTokensRow(this.sql, workspaceId);
  }

  async approveAccessRequest(
    requestId: string,
    actorUserId: UserId,
    opts?: { rejection_reason?: never; invited_to_workspace_id?: WorkspaceId }
  ): Promise<AccessRequest> {
    return approveAccessRequestRow(this.sql, requestId, actorUserId, opts);
  }

  async rejectAccessRequest(
    requestId: string,
    actorUserId: UserId,
    reason: string
  ): Promise<AccessRequest> {
    return rejectAccessRequestRow(this.sql, requestId, actorUserId, reason);
  }

  // ---- Customer registration (R55 · 018_customer_registration) ----

  async createReadinessAssessment(input: ReadinessAssessmentInput): Promise<ReadinessAssessment> {
    return createReadinessAssessmentRow(this.sql, input);
  }

  async getReadinessAssessment(accessRequestId: string): Promise<ReadinessAssessment | null> {
    return getReadinessAssessmentRow(this.sql, accessRequestId);
  }

  async getReadinessAssessmentByEmail(email: string): Promise<ReadinessAssessment | null> {
    return getReadinessAssessmentByEmailRow(this.sql, email);
  }

  async attachReadinessToWorkspaceByEmail(email: string, workspaceId: string, userId: string | null): Promise<number> {
    return attachReadinessToWorkspaceByEmailRow(this.sql, email, workspaceId, userId);
  }

  async getCustomerContextProfile(workspaceId: string) {
    return getCustomerContextProfileRow(this.sql, workspaceId);
  }

  async provisionCustomerWorkspace(
    input: import('./customer-provisioning-store').ProvisionCustomerInput,
  ): Promise<import('./customer-provisioning-store').ProvisionCustomerResult> {
    return provisionCustomerWorkspaceRow(this.sql, input);
  }

  async getWorkspaceActivitySummary(
    workspaceId: WorkspaceId,
    sinceIso?: string | null,
  ): Promise<import('./workspace-activity-store').WorkspaceActivitySummary> {
    return getWorkspaceActivitySummaryRow(this.sql, workspaceId, sinceIso);
  }

  async recordPmfResponse(
    input: import('./pmf-store').PmfResponseInput,
  ): Promise<import('./pmf-store').PmfResponse> {
    return recordPmfResponseRow(this.sql, input);
  }

  async getPmfSummary(): Promise<import('./pmf-store').PmfSummary> {
    return getPmfSummaryRow(this.sql);
  }

  async appendChatExchange(
    userId: string,
    scope: import('./chat-store').ChatScopeRef,
    messages: import('./chat-store').ChatMessageInput[],
  ): Promise<void> {
    return appendChatExchangeRow(this.sql, userId, scope, messages);
  }

  async listChatHistory(
    userId: string,
    scope: import('./chat-store').ChatScopeRef,
    limit?: number,
  ): Promise<import('./chat-store').ChatMessageRow[]> {
    return listChatHistoryRow(this.sql, userId, scope, limit);
  }

  async getEngagementRollup(
    windowDays?: number,
  ): Promise<import('./engagement-store').EngagementRollup> {
    return getEngagementRollupRow(this.sql, windowDays);
  }

  async listGovernanceAuditLogForOperator(
    ownerUserIds: string[],
    limit?: number,
  ): Promise<import('./governance-store').GovernanceAuditEntry[]> {
    return listGovernanceAuditLogForOperatorRow(this.sql, ownerUserIds, limit);
  }

  // ---- Customer authority / consent (R55 · IP-boundary hard-gate) ----

  async recordOperatorAuthority(input: OperatorAuthorityInput): Promise<CustomerAuthorityConsent> {
    return recordOperatorAuthorityRow(this.sql, input);
  }

  async recordCustomerConsentAck(input: CustomerConsentAckInput): Promise<CustomerAuthorityConsent> {
    return recordCustomerConsentAckRow(this.sql, input);
  }

  async recordCustomerInviteAudit(input: CustomerInviteAuditInput): Promise<CustomerInviteAuditReceipt> {
    return recordCustomerInviteAuditRow(this.sql, input);
  }

  async getCustomerAuthorityState(workspaceId: WorkspaceId): Promise<CustomerAuthorityState> {
    return getCustomerAuthorityStateRow(this.sql, workspaceId);
  }

  async revokeCustomerAuthority(input: RevokeCustomerAuthorityInput): Promise<CustomerAuthorityConsent> {
    return revokeCustomerAuthorityRow(this.sql, input);
  }

  async listPendingCustomerAuthorityApprovals(
    opts?: PendingCustomerAuthorityListOpts,
  ): Promise<PendingCustomerAuthorityApproval[]> {
    return listPendingCustomerAuthorityApprovalsRow(this.sql, opts ?? {});
  }

  // ---- Users ----

  async getUser(userId: UserId): Promise<User | null> {
    return getUserRow(this.sql, userId);
  }

  async getUserByEmail(email: string): Promise<User | null> {
    return getUserByEmailRow(this.sql, email);
  }

  async listUsers(opts: UserListOpts): Promise<User[]> {
    return listUsersRow(this.sql, opts);
  }

  // Workspace members · composed from a sub-facade (FROZEN_DECOMPOSE: no new methods on
  // this root file — see workspace-member-facade.ts). Thin field delegations satisfy DalAdapter.
  private readonly _members = makeWorkspaceMemberFacade(() => this.sql);
  listWorkspaceMembers: DalAdapter['listWorkspaceMembers'] = (w) => this._members.listWorkspaceMembers(w);
  listWorkspaceMembersForWorkspaces: DalAdapter['listWorkspaceMembersForWorkspaces'] = (ids, owners, cur) => this._members.listWorkspaceMembersForWorkspaces(ids, owners, cur);
  setWorkspaceMemberRole: DalAdapter['setWorkspaceMemberRole'] = (w, u, r, a) => this._members.setWorkspaceMemberRole(w, u, r, a);
  removeWorkspaceMember: DalAdapter['removeWorkspaceMember'] = (w, u, a) => this._members.removeWorkspaceMember(w, u, a); userCanScopeWorkspace: DalAdapter['userCanScopeWorkspace'] = (u, w) => this._members.userCanScopeWorkspace(u, w); userOwnsWorkspace: DalAdapter['userOwnsWorkspace'] = (u, w) => this._members.userOwnsWorkspace(u, w); private readonly _sessionPrefs = makeSessionPreferencesFacade(() => this.sql); readonly plan = makePlanEntitiesFacade(() => this.sql); // G1 plan + G2 source read_policy (dal.plan.*)
  getOperatingMode: DalAdapter['getOperatingMode'] = (u, w) => this._sessionPrefs.getOperatingMode(u, w);
  setOperatingMode: DalAdapter['setOperatingMode'] = (u, w, m, a) => this._sessionPrefs.setOperatingMode(u, w, m, a);
  readonly modelRuntimes = makeModelRuntimesFacade(() => this.sql); // Wave C · model-runtime sub-facade (SQL in ./model-runtime-store)

  async setUserStatus(
    userId: UserId,
    status: UserStatus,
    actorUserId: UserId,
    opts?: { rejection_reason?: string }
  ): Promise<User> {
    return setUserStatusRow(this.sql, userId, status, actorUserId, opts);
  }

  async appendAuditLog(entry: AuditLogInput): Promise<void> {
    await this.sql/*sql*/`
      INSERT INTO audit_logs (actor_user_id, action, target_type, target_id, workspace_id, reason, metadata)
      VALUES (
        ${entry.actor_user_id},
        ${entry.action}::text,
        ${entry.target_type}::text,
        ${entry.target_id},
        ${entry.workspace_id ?? null},
        ${entry.reason ?? null},
        ${JSON.stringify(entry.metadata ?? {})}::jsonb
      )
    `;
  }

  // ============================================================
  // R49' · Synthetic Domains (LEM-v3 PR-1)
  // ============================================================

  async createSyntheticDomain(input: SyntheticDomainCreateInput, actorUserId: UserId): Promise<SyntheticDomain> {
    return createSyntheticDomainRow(this.sql, input, actorUserId);
  }

  async seedStarterTemplateBindings(workspaceId: string, ownerUserId: string): Promise<{ seeded: number; skipped: boolean }> {
    return seedStarterTemplateBindingsRow(this.sql, workspaceId as WorkspaceId, ownerUserId as UserId);
  }

  async listSyntheticDomains(
    opts: SyntheticDomainListOpts,
    callerUserId: UserId,
    isOperator: boolean,
  ): Promise<SyntheticDomain[]> {
    return listSyntheticDomainsRow(this.sql, opts, callerUserId, isOperator);
  }

  async getSyntheticDomain(
    id: SyntheticDomainId,
    callerUserId: UserId,
    callerWorkspaceId: WorkspaceId,
    isOperator: boolean,
  ): Promise<SyntheticDomain | null> {
    return getSyntheticDomainRow(this.sql, id, callerUserId, callerWorkspaceId, isOperator);
  }

  async updateSyntheticDomainBinding(
    id: SyntheticDomainId,
    binding: SyntheticDomainBinding,
    actorUserId: UserId,
  ): Promise<SyntheticDomain> {
    return updateSyntheticDomainBindingRow(this.sql, id, binding, actorUserId);
  }

  async archiveSyntheticDomain(id: SyntheticDomainId, actorUserId: UserId): Promise<SyntheticDomain> {
    return archiveSyntheticDomainRow(this.sql, id, actorUserId);
  }

  async refreshSyntheticDomainMembership(
    id: SyntheticDomainId,
    actorUserId: UserId,
  ): Promise<{ domain_id: SyntheticDomainId; member_count: number }> {
    return refreshSyntheticDomainMembershipRow(this.sql, id, actorUserId);
  }

  async listSyntheticDomainMembers(
    id: SyntheticDomainId,
    callerWorkspaceId: WorkspaceId,
    isOperator: boolean,
  ): Promise<Project[]> {
    return listSyntheticDomainMembersRow(this.sql, id, callerWorkspaceId, isOperator);
  }

  // ============================================================
  // R49' PR-3 · Planning layer · roadmaps + goals
  // ============================================================

  // OS-4 P2 · the workspace Plan aggregate (roadmaps + goals per visible domain, 3 bounded
  // queries). Body + SQL live in ./roadmap-store (listWorkspacePlanRow); thin delegation.
  async getCharter(workspaceId: WorkspaceId): Promise<import('./charter-store').CharterRow | null> {
    return getCharterRow(this.rlsSql, workspaceId); // 089 · RLS-subject client (defaults to sql)
  }

  async upsertCharter(
    workspaceId: WorkspaceId,
    input: import('./charter-store').CharterInput,
    actorUserId: string,
  ): Promise<import('./charter-store').CharterRow> {
    return upsertCharterRow(this.sql, workspaceId, input, actorUserId); // owner connection + audit
  }

  async listWorkspacePlan(workspaceId: WorkspaceId): Promise<{ domains: WorkspacePlanDomain[] }> {
    return listWorkspacePlanRow(this.sql, workspaceId);
  }

  async createRoadmap(input: SyntheticDomainRoadmapCreateInput, actorUserId: UserId): Promise<SyntheticDomainRoadmap> {
    return createRoadmapRow(this.sql, input, actorUserId);
  }

  async listRoadmapsForDomain(domainId: SyntheticDomainId, status?: RoadmapStatus): Promise<SyntheticDomainRoadmap[]> {
    return listRoadmapsForDomainRow(this.sql, domainId, status);
  }

  async getRoadmap(roadmapId: SyntheticDomainRoadmapId): Promise<{ roadmap: SyntheticDomainRoadmap; items: SyntheticDomainRoadmapItem[] } | null> {
    return getRoadmapRow(this.sql, roadmapId);
  }

  async updateRoadmap(
    roadmapId: SyntheticDomainRoadmapId,
    patch: { title?: string; description?: string | null; target_date?: string | null; status?: RoadmapStatus; metadata?: Record<string, any> },
    actorUserId: UserId,
  ): Promise<SyntheticDomainRoadmap> {
    return updateRoadmapRow(this.sql, roadmapId, patch, actorUserId);
  }

  // R49' PR-3 · addRoadmapItem STAYS on the DAL: it is a SHARED helper replicated by
  // synthetic-domain-store + propagation-store (add_roadmap_item recommendation payload).
  // normalizeRoadmapItemRow likewise stays (used here). The rest of the roadmap group moved to
  // ./roadmap-store (Stage 3.1, F10).
  async addRoadmapItem(
    roadmapId: SyntheticDomainRoadmapId,
    input: SyntheticDomainRoadmapItemInput,
    actorUserId: UserId,
  ): Promise<SyntheticDomainRoadmapItem> {
    if (!actorUserId) throw makeError('VALIDATION_ERROR', 'actor required', 400);
    if (!input.title || input.title.length > 200) throw makeError('VALIDATION_ERROR', 'title 1-200 chars required', 400);
    const rRows = await this.sql/*sql*/`
      SELECT id, domain_id, workspace_id FROM synthetic_domain_roadmaps WHERE id = ${roadmapId} LIMIT 1
    ` as Array<{ id: string; domain_id: string; workspace_id: string | null }>;
    if (rRows.length === 0) throw makeError('NOT_FOUND', `roadmap ${roadmapId} not found`, 404);
    const r = rRows[0]!;
    const posRows = await this.sql/*sql*/`
      SELECT COALESCE(MAX(position) + 1, 0) AS next_pos
      FROM synthetic_domain_roadmap_items WHERE roadmap_id = ${roadmapId} AND deleted_at IS NULL
    ` as Array<{ next_pos: number }>;
    const position = posRows[0]?.next_pos ?? 0;
    const newId = input.id && input.id.length > 0
      ? input.id
      : `sdri_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const rows = await this.sql/*sql*/`
      INSERT INTO synthetic_domain_roadmap_items (
        id, roadmap_id, domain_id, position, title, description, status, target_date,
        derived_from_project_id, derived_from_event_id, metadata
      ) VALUES (
        ${newId}, ${roadmapId}, ${r.domain_id}, ${position},
        ${input.title}, ${input.description ?? null}, ${input.status ?? 'planned'},
        ${input.target_date ?? null},
        ${input.derived_from_project_id ?? null},
        ${input.derived_from_event_id ?? null},
        ${JSON.stringify(input.metadata ?? {})}::jsonb
      )
      RETURNING id, roadmap_id, domain_id, position, title, description, status, target_date,
                derived_from_project_id, derived_from_event_id, metadata, created_at, updated_at
    ` as SyntheticDomainRoadmapItem[];
    const item = normalizeRoadmapItemRow(rows[0]!);
    await this.appendAuditLog({
      actor_user_id: actorUserId,
      action: 'sd_roadmap_item_add',
      target_type: 'synthetic_domain_roadmap_item',
      target_id: item.id,
      workspace_id: r.workspace_id,
      metadata: { roadmap_id: roadmapId, position, title: item.title },
    });
    return item;
  }

  async updateRoadmapItem(
    itemId: SyntheticDomainRoadmapItemId,
    patch: { title?: string; description?: string | null; status?: RoadmapItemStatus; target_date?: string | null; metadata?: Record<string, any> },
    actorUserId: UserId,
  ): Promise<SyntheticDomainRoadmapItem> {
    return updateRoadmapItemRow(this.sql, itemId, patch, actorUserId);
  }

  async deleteRoadmapItem(itemId: SyntheticDomainRoadmapItemId, actorUserId: UserId): Promise<void> { return deleteRoadmapItemRow(this.sql, itemId, actorUserId); }
  async restoreRoadmapItem(itemId: SyntheticDomainRoadmapItemId, actorUserId: UserId) { return restoreRoadmapItemRow(this.sql, itemId, actorUserId); }

  async reorderRoadmapItems(
    roadmapId: SyntheticDomainRoadmapId,
    itemIdsInOrder: SyntheticDomainRoadmapItemId[],
    actorUserId: UserId,
  ): Promise<SyntheticDomainRoadmapItem[]> {
    return reorderRoadmapItemsRow(this.sql, roadmapId, itemIdsInOrder, actorUserId);
  }

  // ---- Goals ----

  async createGoal(input: SyntheticDomainGoalCreateInput, actorUserId: UserId): Promise<SyntheticDomainGoal> {
    return createGoalRow(this.sql, input, actorUserId);
  }

  async listGoalsForDomain(domainId: SyntheticDomainId, status?: GoalStatus): Promise<SyntheticDomainGoal[]> {
    return listGoalsForDomainRow(this.sql, domainId, status);
  }

  async getGoal(goalId: SyntheticDomainGoalId): Promise<SyntheticDomainGoal | null> {
    return getGoalRow(this.sql, goalId);
  }

  async updateGoal(
    goalId: SyntheticDomainGoalId,
    patch: { title?: string; description?: string | null; target_value?: number; target_date?: string | null; status?: GoalStatus; metadata?: Record<string, any> },
    actorUserId: UserId,
  ): Promise<SyntheticDomainGoal> {
    return updateGoalRow(this.sql, goalId, patch, actorUserId);
  }

  async recomputeGoalValue(
    goalId: SyntheticDomainGoalId,
    actorUserId: UserId,
    sourceSignalId?: string | null,
  ): Promise<{ goal: SyntheticDomainGoal; value: number }> {
    return recomputeGoalValueRow(this.sql, goalId, actorUserId, sourceSignalId);
  }

  async listGoalProgress(goalId: SyntheticDomainGoalId, limit: number = 100): Promise<SyntheticDomainGoalProgress[]> {
    return listGoalProgressRow(this.sql, goalId, limit);
  }

  // ---- Internal helpers ----

  // R49' · _getDomainOrThrow + _updateDomainCounters moved to ./roadmap-store
  // (getDomainOrThrowRow / updateDomainCountersRow) alongside createRoadmap/updateRoadmap, their
  // only DAL callers. propagation-store keeps its own replicas for the goals/propagation family
  // (Stage 3.1, F10).

  // ============================================================
  // R49' PR-5+6 · Propagation engine
  // ============================================================

  async createPropagationRule(input: PropagationRuleCreateInput, actorUserId: UserId): Promise<SyntheticDomainPropagationRule> {
    return createPropagationRuleRow(this.sql, input, actorUserId);
  }

  async listPropagationRulesForDomain(domainId: SyntheticDomainId, status?: PropagationRuleStatus): Promise<SyntheticDomainPropagationRule[]> {
    return listPropagationRulesForDomainRow(this.sql, domainId, status);
  }

  async updatePropagationRule(
    ruleId: PropagationRuleId,
    patch: { name?: string; description?: string | null; trigger?: PropagationTrigger; action?: PropagationAction; status?: PropagationRuleStatus },
    actorUserId: UserId,
  ): Promise<SyntheticDomainPropagationRule> {
    return updatePropagationRuleRow(this.sql, ruleId, patch, actorUserId);
  }

  async archivePropagationRule(ruleId: PropagationRuleId, actorUserId: UserId): Promise<SyntheticDomainPropagationRule> {
    return archivePropagationRuleRow(this.sql, ruleId, actorUserId);
  }

  async listRecommendations(opts: RecommendationListOpts): Promise<SyntheticDomainRecommendation[]> {
    return listRecommendationsRow(this.sql, opts);
  }

  async getRecommendation(id: RecommendationId): Promise<SyntheticDomainRecommendation | null> {
    return getRecommendationRow(this.sql, id);
  }

  async acceptRecommendation(id: RecommendationId, actorUserId: UserId, note?: string, scope?: RecommendationWriteScope): Promise<SyntheticDomainRecommendation> {
    return acceptRecommendationRow(this.sql, id, actorUserId, note, scope);
  }

  async rejectRecommendation(id: RecommendationId, actorUserId: UserId, note: string, scope?: RecommendationWriteScope): Promise<SyntheticDomainRecommendation> {
    return rejectRecommendationRow(this.sql, id, actorUserId, note, scope);
  }

  async runPropagationTick(actorUserId: UserId): Promise<PropagationTickResult> {
    return runPropagationTickRow(this.sql, actorUserId);
  }

  // ============================================================
  // R50.3b · user_source_connections CRUD
  // ============================================================
  //
  // Schema: src/workers/db/migrations/008_user_source_connections.sql
  // Adapter: src/workers/dal/clerk-oauth-adapter.ts (token retrieval; this
  //   module handles persistence only)
  // Routes: src/workers/routes/sources.ts (operator-facing REST surface)
  //
  // All methods are user-scoped (NOT workspace-scoped) per DalAdapter.ts
  // R50.3b contract block: Clerk OAuth connections belong to the user
  // account, not the workspace. The workspace_id column is stored as null
  // in R50.3b; future tenant-bound provisioning will use it.

  async listUserSources(userId: UserId): Promise<import('./types').UserSourceConnection[]> {
    return listUserSourcesRow(this.sql, userId);
  }

  // R52-B1 · operator layout overlay (pillar 3) ──────────────────────────
  // Moved to ./operations-store (Stage 3.1, F10 batch5). The DAL thin-delegates;
  // the operator_layout SQL (read + ON CONFLICT (user_id) upsert) lives there.
  async getOperatorLayout(
    userId: UserId,
  ): Promise<{ user_id: string; layout: Record<string, unknown>; updated_at: string } | null> {
    return getOperatorLayoutRow(this.sql, userId);
  }

  async putOperatorLayout(
    userId: UserId,
    layout: Record<string, unknown>,
  ): Promise<{ user_id: string; layout: Record<string, unknown>; updated_at: string }> {
    return putOperatorLayoutRow(this.sql, userId, layout);
  }

  // ── R53-W2 · operations-live-stream snapshots (MB-P push → DB → live read) ──
  // Moved to ./operations-store (Stage 3.1, F10 batch5). getLatestLiveStreamSnapshot
  // reads the newest row; putLiveStreamSnapshot is below alongside the investor
  // delegations (kept in source order) — both now thin-delegate.
  async getLatestLiveStreamSnapshot(
    streamId: string = 'mbp-operations-live-stream',
  ): Promise<{ source_mode: string; generated_at: string; valid_until: string | null; rows_count: number; envelope: Record<string, unknown>; ingested_at: string } | null> {
    return getLatestLiveStreamSnapshotRow(this.sql, streamId);
  }

  // Wave 5a · the durable operations_unified read-model (governance plane).
  async listUnifiedGovernance(limit?: number): Promise<import('./unified-store').UnifiedGovernanceRow[]> {
    return listUnifiedGovernanceRow(this.sql, limit);
  }

  async materializeGovernanceSnapshot(rows: Array<Record<string, unknown>>): Promise<number> {
    return materializeGovernanceSnapshotRow(this.sql, rows);
  }

  // Wave 5b · first-class intents (artefact + lineage), scoped to the operator's own workspaces.
  async listIntentsForOperator(
    ownerUserIds: string[],
    scope: { workspace_id?: string | null; project_id?: string | null; domain_id?: string | null },
    limit?: number,
  ): Promise<IntentRow[]> {
    return listIntentsForOperatorRow(this.sql, ownerUserIds, scope, limit);
  }

  async getIntentLineageForOperator(ownerUserIds: string[], intentId: string): Promise<IntentLineage | null> {
    return getIntentLineageForOperatorRow(this.sql, ownerUserIds, intentId);
  }

  async createIntent(input: CreateIntentInput): Promise<IntentRow> {
    const intent = await createIntentRow(this.sql, input);
    // Best-effort mirror into the durable read-model (no-op until migration 022 is applied).
    try { await materializeIntentToUnified(this.sql, intent); } catch (_) { /* additive; never fail the write */ }
    return intent;
  }

  async updateIntentStatusForOperator(
    ownerUserIds: string[],
    intentId: string,
    status: string,
  ): Promise<IntentRow | null> {
    const intent = await updateIntentStatusForOperatorRow(this.sql, ownerUserIds, intentId, status);
    if (intent) { try { await materializeIntentToUnified(this.sql, intent); } catch (_) { /* best-effort */ } }
    return intent;
  }

  // OS-5 W4 · intent title/summary edit; body + SQL + the appended audit receipt live in ./intent-store.
  async updateIntentFieldsForOperator(
    ownerUserIds: string[],
    intentId: string,
    patch: IntentFieldsPatch,
  ): Promise<IntentRow | null> {
    const intent = await updateIntentFieldsForOperatorRow(this.sql, ownerUserIds, intentId, patch);
    if (intent) { try { await materializeIntentToUnified(this.sql, intent); } catch (_) { /* best-effort */ } }
    return intent;
  }

  // OS-4 P3 · attach-event-to-intent (L1 re-point + appended audit receipt). Body + SQL live in
  // ./intent-store (repointEventIntentForOperatorRow); thin delegation.
  async repointEventIntentForOperator(ownerUserIds: string[], intentId: string, eventId: string): Promise<RepointEventResult | null> {
    return repointEventIntentForOperatorRow(this.sql, ownerUserIds, intentId, eventId);
  }

  // ARCH-006 W6 · first-class decisions (bodies + SQL in ./decision-store; thin delegations here).
  async listDecisionsForOperator(
    ownerUserIds: string[],
    scope: { workspace_id?: string | null; project_id?: string | null; event_id?: string | null },
    limit?: number,
  ): Promise<DecisionRow[]> {
    return listDecisionsForOperatorRow(this.sql, ownerUserIds, scope, limit);
  }

  async getDecisionForOperator(ownerUserIds: string[], decisionId: string): Promise<DecisionDetail | null> {
    return getDecisionForOperatorRow(this.sql, ownerUserIds, decisionId);
  }

  async createDecision(input: CreateDecisionInput): Promise<DecisionRow> {
    const decision = await createDecisionRow(this.sql, input);
    // Best-effort mirror into operations_unified (graph `packet` node) — no-op until 022 applied.
    try { await materializeDecisionToUnified(this.sql, decision); } catch (_) { /* additive; never fail the write */ }
    return decision;
  }

  // ARCH-006 W6 · intent pre-enrichment (bodies + SQL in ./enrichment-store; thin delegations here).
  async upsertIntentEnrichment(intentId: string, enrichment: IntentEnrichmentInput): Promise<void> {
    return upsertIntentEnrichmentRow(this.sql, intentId, enrichment);
  }

  async getIntentEnrichmentForIntent(intentId: string): Promise<IntentEnrichmentRow | null> {
    return getIntentEnrichmentRow(this.sql, intentId);
  }

  // W1 · privacy-safe usage telemetry (ids + counts only).
  async recordUsageEvent(input: UsageEventInput): Promise<void> {
    return recordUsageEventRow(this.sql, input);
  }

  async aggregateUsageForOperator(ownerUserIds: string[], kind: string, limit?: number): Promise<UsageAggregateRow[]> {
    return aggregateUsageForOperatorRow(this.sql, ownerUserIds, kind, limit);
  }

  // W2 · durable per-operator prompt tags (global).
  async listPromptTagsForUser(userId: string): Promise<PromptTagRow[]> {
    return listPromptTagsForUserRow(this.sql, userId);
  }

  async upsertPromptTagForUser(input: UpsertPromptTagInput): Promise<PromptTagRow | null> {
    return upsertPromptTagForUserRow(this.sql, input);
  }

  async bulkUpsertPromptTagsForUser(userId: string, tags: Array<{ tag_id?: string; id?: string; label?: string; message?: string }>): Promise<number> {
    return bulkUpsertPromptTagsForUserRow(this.sql, userId, tags);
  }

  async deletePromptTagForUser(userId: string, tagId: string): Promise<boolean> {
    return deletePromptTagForUserRow(this.sql, userId, tagId);
  }

  // W3 · reflection-only folder connector baseline.
  async getFolderBaseline(bindingId: string): Promise<FolderSnapshot> {
    return getFolderBaselineRow(this.sql, bindingId);
  }

  async putFolderBaseline(input: PutFolderBaselineInput): Promise<void> {
    return putFolderBaselineRow(this.sql, input);
  }

  async listFolderBindingsForOperator(workspaceIds: string[]): Promise<FolderBindingSummary[]> {
    return listFolderBindingsForOperatorRow(this.sql, workspaceIds);
  }

  async getFolderBindingMeta(bindingId: string): Promise<FolderBindingMeta | null> {
    return getFolderBindingMetaRow(this.sql, bindingId);
  }

  // ============================================================
  // Track B · investor session foundation (read-only, caller-scoped)
  // ============================================================

  /** The caller's OWN active investor entitlement (revoked rows excluded).
   *  Returns null when the user has no grant. Reads ONLY the caller's row —
   *  WHERE user_id = ${userId} — so it can never leak another user's tier.
   *  Wave R-I.7 Stage C: upgraded to return full InvestorEntitlement type. */
  async getInvestorEntitlement(userId: string): Promise<InvestorEntitlement | null> {
    return getInvestorEntitlementRow(this.sql, userId);
  }

  /** Track B Stage 2 · admin grants an investor entitlement (tier-1 or tier-2).
   *  Inserts a fresh active row; getInvestorEntitlement picks the latest non-revoked,
   *  so a new grant supersedes (tier-2 grant = escalation). ADMIN-ONLY (route-gated).
   *  Returns the granted row. NOTE: utility is gated on the safe-pack export (Stage 3
   *  content) — this is the entitlement skeleton, not data-room access on its own. */
  async grantInvestorEntitlement(
    input: { userId: string; tier: string; workspaceId?: string | null; sectionFilter?: unknown },
    grantedBy: string,
  ): Promise<{ id: string; user_id: string; tier: string; granted_at: string; granted_by: string } | null> {
    return grantInvestorEntitlementRow(this.sql, input, grantedBy);
  }

  /** The caller's latest NDA acceptance (or null). Caller-scoped. */
  async getLatestNdaAcceptance(userId: string): Promise<
    { nda_version: string; accepted_at: string | null; email: string | null; full_name_typed: string | null } | null
  > {
    return getLatestNdaAcceptanceRow(this.sql, userId);
  }

  // R53-W2 · operations-live-stream INSERT moved to ./operations-store (Stage 3.1, F10 batch5).
  async putLiveStreamSnapshot(input: {
    stream_id?: string;
    source_mode?: string;
    generated_at: string;
    valid_until?: string | null;
    rows_count?: number;
    sha256?: string | null;
    envelope: Record<string, unknown>;
  }): Promise<{ id: string; stream_id: string; generated_at: string; rows_count: number }> {
    return putLiveStreamSnapshotRow(this.sql, input);
  }

  async getUserSource(
    userId: UserId,
    id: string,
  ): Promise<import('./types').UserSourceConnection | null> {
    return getUserSourceRow(this.sql, userId, id);
  }

  async upsertUserSource(
    input: import('./types').UserSourceConnectionInput,
  ): Promise<import('./source-store').SourceConnectionWriteReceipt> {
    return upsertUserSourceRow(this.sql, input);
  }

  async disconnectUserSource(userId: UserId, id: string, workspaceId?: WorkspaceId | null): Promise<import('./source-store').SourceDisconnectWriteReceipt> {
    return disconnectUserSourceRow(this.sql, userId, id, workspaceId);
  }

  async markUserSourceSync(
    userId: UserId,
    id: string,
    result: { success: true } | { success: false; error: string },
    workspaceId?: WorkspaceId | null,
  ): Promise<import('./source-store').SourceSyncWriteReceipt> {
    return markUserSourceSyncRow(this.sql, userId, id, result, workspaceId);
  }
  // ============================================================
  // R51-γ · LEM-v4 inference quality framework (impls)
  // Authority: docs/architecture/XLOOOP_SYSTEM_DESIGN_v1.md §16
  //
  // Wave γ ships the read path for the genesis seed only
  // (`getActiveDetectorConfig`). All write paths throw a descriptive
  // error so accidental early use in Wave δ work fails loudly with a
  // pointer to the migration + the wave that will implement them.
  // ============================================================

  // R51-γ/δ-B2 · detector_config read + versioned-append moved to ./detector-store
  // (Stage 3.1, F10). The DAL thin-delegates; the SQL surfaces (SELECT / INSERT INTO
  // detector_config) + both local toIso mappers live in detector-store.ts.
  async getActiveDetectorConfig() {
    return getActiveDetectorConfigRow(this.sql);
  }

  async insertDetectorConfig(input: Parameters<DalAdapter['insertDetectorConfig']>[0]) {
    return insertDetectorConfigRow(this.sql, input);
  }

  async insertInferenceRun(input: Parameters<DalAdapter['insertInferenceRun']>[0]) {
    return insertInferenceRunRow(this.sql, input);
  }

  async completeInferenceRun(input: Parameters<DalAdapter['completeInferenceRun']>[0]) {
    return completeInferenceRunRow(this.sql, input);
  }

  async bulkInsertInferenceSignalEvals(inputs: Parameters<DalAdapter['bulkInsertInferenceSignalEvals']>[0]) {
    return bulkInsertInferenceSignalEvalsRow(this.sql, inputs);
  }

  async insertInferenceEmission(input: Parameters<DalAdapter['insertInferenceEmission']>[0]) {
    return insertInferenceEmissionRow(this.sql, input);
  }

  async listInferenceEmissionsForRun(runId: Parameters<DalAdapter['listInferenceEmissionsForRun']>[0]) {
    return listInferenceEmissionsForRunRow(this.sql, runId);
  }

  async insertRecommendationRejection(input: Parameters<DalAdapter['insertRecommendationRejection']>[0]) {
    return insertRecommendationRejectionRow(this.sql, input);
  }

  async countRecommendationRejectionsForFingerprint(fingerprint: string) {
    return countRecommendationRejectionsForFingerprintRow(this.sql, fingerprint);
  }

  async upsertCalibrationBucket(input: Parameters<DalAdapter['upsertCalibrationBucket']>[0]) {
    return upsertCalibrationBucketRow(this.sql, input);
  }

  // ============================================================
  // Wave R-I.7 Stage C · Investor portal (DR-11/12/13/14)
  // Full implementations deferred to dedicated investor portal session.
  // DalAdapter interface is satisfied; routes call these methods.
  // ============================================================

  async recordNdaAcceptance(input: NdaAcceptanceInput): Promise<NdaAcceptance> {
    return recordNdaAcceptanceRow(this.sql, input);
  }

  async grantInvestorTier1(input: GrantInvestorTier1Input): Promise<InvestorEntitlement> {
    return grantInvestorTier1Row(this.sql, input);
  }

  async escalateInvestorToTier2(input: EscalateInvestorTier2Input): Promise<InvestorEntitlement> {
    return escalateInvestorToTier2Row(this.sql, input);
  }

  async revokeInvestorTier2(input: RevokeInvestorTier2Input): Promise<InvestorEntitlement> {
    return revokeInvestorTier2Row(this.sql, input);
  }

  // ADR-XLOOP-ARCH-003 P2 · data-graph persisted home — thin delegators to graph-store
  async assembleDataGraphFacts(workspaceId: string, opts?: { includeDocuments?: boolean }): Promise<DataGraphFacts> { return assembleDataGraphFactsRow(this.sql, workspaceId, opts); }
  async getLatestGraphSnapshot(workspaceId: string) { return getLatestGraphSnapshotRow(this.sql, workspaceId); }
  async replaceWorkspaceGraph(workspaceId: string, nodes: GraphNode[], edges: GraphEdge[], meta: { graph_hash: string; graph_version: number; node_count: number; edge_count: number }, generatedAtIso: string): Promise<void> { return replaceWorkspaceGraphRow(this.sql, workspaceId, nodes, edges, meta, generatedAtIso); }
  async getArtefactLineage(workspaceId: string, opts?: { nodeId?: string; causeOnly?: boolean }) { return getArtefactLineageRow(this.sql, workspaceId, opts); }
}

export interface WorkersDalAdapter extends OperationalSpineDalMethods, TemplatePolicyDalMethods {} applyOperationalSpineMethods(WorkersDalAdapter); applyTemplatePolicyMethods(WorkersDalAdapter);
// ============================================================
// Helpers
// ============================================================

// R51-δ-B2 helpers mapInferenceRun / mapInferenceEmission moved to ./inference-store
// (Stage 3.1, F10) alongside the 8 inference-audit methods that are their only consumers.

/**
 * R51-γ helper: build a descriptive Error for LEM-v4 DAL methods whose
 * schema is shipped (migration 009/010/011) but whose write-path impl
 * lands in Wave δ (inference engine) or Wave ζ (self-maintenance crons).
 * Callers that accidentally invoke these in Wave γ get a loud, pointer-
 * rich failure rather than silent NoOp.
 */
function NOT_IMPLEMENTED_IN_GAMMA(method: string, futureOwner: string): Error {
  const err = new Error(
    `WorkersDalAdapter.${method}() is not implemented in Wave γ. ` +
      `Schema is present (migrations 009/010); ${futureOwner}.`,
  );
  (err as any).code = 'NOT_IMPLEMENTED_IN_WAVE_GAMMA';
  (err as any).status = 501;
  return err;
}

// R45 · collectScopeFilterValues moved to ./event-store (Stage 3.1, F10 batch5) alongside
// listEventsForProjectScope, its only caller.

// R40 · normalizeEventRow moved to ./event-store (Stage 3.1, F10).

function normalizeProjectRow(row: Project): Project {
  return {
    ...row,
    description: row.description ?? null,
    metadata: row.metadata ?? {},
    scope_binding: row.scope_binding ?? null,
    scope_binding_updated_at: row.scope_binding_updated_at ?? null,
    scope_binding_updated_by: row.scope_binding_updated_by ?? null,
    parent_project_id: row.parent_project_id ?? null,
  };
}

// R47.3/R45/R52 · project CRUD + nesting + scope-binding + source-binding helpers
// (PROJECT_SOURCE_* sets, validateProjectSourceBinding{Input,Patch},
// normalizeProjectSourceBindingRow) moved to ./project-store (Stage 3.1, F10).
// normalizeProjectRow stays above — it is SHARED (kept for the project family + future
// un-extracted methods); ./project-store carries a byte-identical private copy.

// R49' · synthetic domain CRUD/membership helpers moved to ./synthetic-domain-store (Stage 3.1, F10)

// R49 PR-3 · roadmap-item normalizer (kept for addRoadmapItem, which stays on the DAL as a
// shared helper). normalizeRoadmapRow moved to ./roadmap-store with the extracted roadmap group.
function normalizeRoadmapItemRow(i: SyntheticDomainRoadmapItem): SyntheticDomainRoadmapItem {
  return {
    ...i,
    description: i.description ?? null,
    target_date: i.target_date ?? null,
    derived_from_project_id: i.derived_from_project_id ?? null,
    derived_from_event_id: i.derived_from_event_id ?? null,
    metadata: i.metadata ?? {},
  };
}

// R52 · normalizeBoardCardRow moved to ./governance-store (Stage 3.1, F10 batch5) alongside
// listBoardCards, its only caller.
