// src/workers/crons/types.ts
//
// R51-ζ-1 · Shared types for self-maintenance cron loops.
//
// Authority: docs/architecture/XLOOOP_SYSTEM_DESIGN_v1.md §16.5 (six
// self-maintenance loops) + §16.4 (audit substrate; loops write to
// inference_runs with kind='self_maintenance').

import type { DalAdapter } from '../dal/DalAdapter';
import type { GoalReviewDueRow } from '../dal/propagation-store';
import type { ProjectionOutboxGateway, ProjectionQueueBinding } from '../services/tenant-projection-queue';
import type { GovernedModelLineageFactory } from '../lib/model-execution-lineage';
import type { CustomerCensusObservationInsert } from '../dal/customer-census-store';
import type {
  LearningSignalForMaterialization,
  UserPersonalizationProfileUpsert,
} from '../dal/personalization-materialize-store';

/**
 * Y-wave MATERIALIZE (ADR-XB-012) · personalization materializer data gateway. Injected into the cron
 * context (like `census`). Owner-connected reads/writes bound from personalization-materialize-store.ts.
 */
export interface PersonalizationMaterializeGateway {
  /** Bounded read of active learning signals across workspaces (limit+1 for truncation detection). */
  listActiveSignals(limit: number): Promise<LearningSignalForMaterialization[]>;
  /** Owner-connected UPSERT of one user's folded profile (full-rebuild-from-signals). */
  upsertProfile(row: UserPersonalizationProfileUpsert): Promise<void>;
}

/**
 * A10 review-scheduler data gateway. Injected into the cron context (like `env.AI`) rather than added to
 * the DalAdapter — WorkersDalAdapter's LOC ceiling is FROZEN (S-R1), so new goal-review reads/writes are
 * bound directly from the store functions in the dispatcher instead of routed through the adapter facade.
 */
export interface ReviewScheduleGateway {
  /** Cross-workspace, bounded read of ACTIVE goals whose review_due has passed (<= nowDateIso). */
  listDue(nowDateIso: string, limit: number): Promise<GoalReviewDueRow[]>;
  /** Advance a goal's review_due to the next cadence slot (idempotent). */
  bumpReviewDue(goalId: string, nextReviewDue: string): Promise<void>;
}

/**
 * J-E TASK 2 (260719) · customer sterility census data gateway. Injected into the cron context (like
 * reviewSchedule) rather than added to the FROZEN WorkersDalAdapter facade (S-R1). Only customerCensusCron
 * (chained into the 05:00 slot) reads it, and only when CUSTOMER_CENSUS_ENABLED is on. The graph facts
 * themselves come from the EXISTING dal.assembleDataGraphFacts — this gateway carries only the census-specific
 * enumeration/read/write the frozen adapter must not grow.
 */
export interface CustomerCensusGateway {
  /** Bounded, deterministic enumeration of workspace ids to observe. */
  listWorkspaceIds(limit: number): Promise<string[]>;
  /** Count of governed intake_resolutions (mig 079) for a workspace. */
  countIntakeResolutions(workspaceId: string): Promise<number>;
  /** Persist one workspace's census observation (customer-safe: counts + hashes only; mig 083). */
  recordObservation(row: CustomerCensusObservationInsert): Promise<void>;
}

/**
 * Inputs to every cron loop. Each handler is a pure function of
 * { dal, now, cronExpression } so it can be unit-tested in isolation.
 *
 * `env` is an OPTIONAL, additive carrier for the few worker bindings/vars a
 * loop may need (e.g. the self-driving digest sweep chained into weight_retune
 * reads the Workers-AI binding + its feature flag + the operator identity set).
 * Existing handlers ignore it, so this stays backward-compatible.
 */
export interface CronHandlerContext {
  readonly dal: DalAdapter;
  readonly now: () => Date;
  readonly cronExpression: string;
  readonly env?: {
    AI?: import('../services/agent-digest').AiRunner;
    DIGEST_SWEEP_ENABLED?: string;
    MBP_OWNER_USER_ID?: string;
    MBP_OWNER_LINKED_USER_IDS?: string;
    // Self-healing reclassification backstop (crons/reclassify-unattributed.ts).
    // Default OFF: only the exact string "true" (case-insensitive) enables it.
    RECLASSIFY_CRON_ENABLED?: string;
    // OS-3 UX Wave-2.1 · execution-pipeline executor (services/operations-queue-consumer.ts),
    // chained into the hourly reclassify slot. Default OFF (inert): only the exact string
    // "enabled" (case-insensitive) activates the queue drain. Anything else = disabled.
    EXECUTOR_MODE?: string;
    // F3 (260628) · customer self-service rollback purge (crons/purge-deleted.ts), chained into the
    // daily threshold_retune slot. Default OFF: only the exact string "true" (case-insensitive)
    // enables the destructive hard-purge. Deliberately SEPARATE from CUSTOMER_SELF_SERVICE_ENABLED
    // so the operator enables soft-delete/restore FIRST (verify recovery), then the purge.
    PURGE_DELETED_ENABLED?: string;
    // A10 (260713) · review-scheduler cron (crons/review-schedule.ts), chained into the daily
    // calibration_retrain slot. Default OFF (inert): only the exact string "true" (case-insensitive)
    // enables it — flag-off performs ZERO DB reads/writes. Reads goals with review_due<=now, emits a
    // needs_review operation_event per due goal, and bumps review_due by the cadence.
    REVIEW_SCHEDULER_ENABLED?: string;
    // Default OFF. The binding is deliberately optional until an operator-approved non-production
    // queue resource exists; enabled-without-binding fails visibly rather than dropping work.
    TENANT_PROJECTION_QUEUE_ENABLED?: string;
    TENANT_PROJECTION_QUEUE?: ProjectionQueueBinding;
    // Y-wave MATERIALIZE (ADR-XB-012) · personalization materializer (crons/personalization-materialize.ts),
    // chained into the daily calibration_retrain slot. Default OFF (inert): only the exact string "true"
    // (case-insensitive) enables it — flag-off performs ZERO DB reads/writes.
    PERSONALIZATION_MATERIALIZE_ENABLED?: string;
    // J-E TASK 2 (260719) · customer sterility census (crons/customer-census.ts), chained into the daily
    // 05:00 slot. BORN-OFF: only the exact string "true" (case-insensitive) enables it — flag-off performs
    // ZERO DB reads/writes (byte-inert). OBSERVE-only; it never remediates.
    CUSTOMER_CENSUS_ENABLED?: string;
    // Whether document nodes (mig 051) are tracked in the data graph. The census counts documents toward
    // population only when this is on (same flag customer-lineage.ts honours); off ⇒ documents=0.
    GRAPH_DOCUMENT_NODES_ENABLED?: string;
    CONTEXT_PACKET_PERSISTENCE_ENABLED?: string;
    ROLE_SKILL_CATALOG_ENABLED?: string;
    RESOLUTION_RECEIPT_SIGNING_SECRET?: string;
    RESOLUTION_RECEIPT_SIGNING_KEY_ID?: string;
    XLOOOP_DEPLOY_SHA?: string;
  };
  // A10 (260713) · review-scheduler data gateway (bound from store functions in the dispatcher). Optional
  // + additive: existing loops ignore it. Only reviewScheduleCron reads it, and only when its flag is on.
  readonly reviewSchedule?: ReviewScheduleGateway;
  // J-E TASK 2 (260719) · customer census data gateway (bound from store functions in the dispatcher).
  // Optional + additive: only customerCensusCron reads it, and only when CUSTOMER_CENSUS_ENABLED is on.
  readonly census?: CustomerCensusGateway;
  // Y-wave MATERIALIZE (ADR-XB-012) · personalization materializer gateway (bound from store functions in
  // the dispatcher). Optional + additive: only personalizationMaterializeCron reads it, and only when
  // PERSONALIZATION_MATERIALIZE_ENABLED is on.
  readonly personalization?: PersonalizationMaterializeGateway;
  /** Cross-tenant dispatcher control plane. Messages contain only opaque outbox/workspace ids; the
   * consumer re-binds every read/write to both values before projecting one tenant. */
  readonly projectionOutbox?: ProjectionOutboxGateway;
  /** Present only when strict context/model lineage is enabled by the dispatcher. */
  readonly modelLineageFactory?: GovernedModelLineageFactory;
  readonly modelLineageRequired?: boolean;
}

/**
 * Per-loop result. Surfaced for telemetry + tests. Always includes the
 * `inference_runs.run_id` written by the loop (with kind='self_maintenance'
 * per §16.5) so the operator can trace the action back to a row.
 */
export interface CronHandlerResult {
  readonly loop_name: string;
  readonly run_id: string;
  readonly actions_taken: number;
  readonly cost_ms: number;
  // 'degraded' = the run finished but ≥1 unit (e.g. a single workspace) failed; partial success
  // must not masquerade as a clean 'completed' (ARCH-006 audit, graph-rebuild silent-failure fix).
  readonly status: 'completed' | 'failed' | 'skipped' | 'degraded';
  readonly notes?: string;
  readonly error?: string;
  readonly metadata?: Record<string, unknown>;
}

export type CronHandler = (ctx: CronHandlerContext) => Promise<CronHandlerResult>;

/**
 * Registry entry: maps a cron expression to its handler. The dispatcher
 * in scheduledHandler() looks up by event.cron string.
 */
export interface CronRegistryEntry {
  readonly cron: string;
  readonly loop_name: string;
  readonly handler: CronHandler;
  readonly description: string;
}
