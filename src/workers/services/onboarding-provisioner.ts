// onboarding-provisioner.ts · orchestrates server-side customer provisioning.
//
// Replaces `npm run onboard-customer`: given an approved access request + the now-existing
// Clerk org/owner ids, it reads the readiness Q&A, builds the day-1 roadmap (scaled to the
// readiness level), and provisions the workspace + members + project + roadmap events via the
// DAL — idempotently, in one transaction. The customer's workspace is visible + useful on first
// login, with NO local psql/CLI step.
//
// A missing readiness assessment is NON-FATAL (base roadmap is used) — provisioning the
// workspace is the priority, mirroring the CLI's best-effort roadmap import.

import { makeError } from '../dal/shared-helpers';
import { envFlagTrue } from '../lib/env-flag';
import { buildDay1Roadmap, buildConnectTasks, type RoadmapStep } from './onboarding-roadmap';
import { buildOnboardingWelcomeDraft, type AiRunner } from './agent-digest';
import { resolveDay1Setup, validateCompanyContext } from '../dal/context-resolver';
import { resolveArchetype, archetypeKeyForAccountType, skeletonToCreateInput } from './domain-archetypes';
import type { SyntheticDomain, SyntheticDomainCreateInput } from '../dal/types/synthetic-domain';
import type { Day1Setup } from '../dal/types/access';
import type {
  AccessRequest,
  ReadinessAssessment,
  HarnessFlowEventInput,
  UpsertResult,
} from '../dal/types';
import type { WorkspaceActivitySummary } from '../dal/workspace-activity-store';
import type { GovernedModelLineageFactory } from '../lib/model-execution-lineage';
import type {
  ProvisionCustomerInput,
  ProvisionCustomerResult,
} from '../dal/customer-provisioning-store';

/** Narrow DAL surface the provisioner needs (the real DalAdapter satisfies it). */
export interface OnboardingProvisionerDal {
  getAccessRequest(id: string): Promise<AccessRequest | null>;
  getReadinessAssessment(accessRequestId: string): Promise<ReadinessAssessment | null>;
  // Part R · Stage C — anonymous-lead → registration linking (Clerk-verified email seam).
  getReadinessAssessmentByEmail(email: string): Promise<ReadinessAssessment | null>;
  attachReadinessToWorkspaceByEmail(email: string, workspaceId: string, userId: string | null): Promise<number>;
  provisionCustomerWorkspace(input: ProvisionCustomerInput): Promise<ProvisionCustomerResult>;
  // Day-1 welcome (best-effort): read the fresh workspace summary + post a PENDING welcome
  // proposal into the approval spine. Both are already implemented by the real DalAdapter.
  getWorkspaceActivitySummary(workspaceId: string, since: string | null): Promise<WorkspaceActivitySummary>;
  upsertEvent(workspaceId: string, event: HarnessFlowEventInput): Promise<UpsertResult>;
  // ABS-P3 · idempotent synthetic-domain create (already implemented by the real DalAdapter). Only
  // called on the flag-gated scaffold path; the interface widens so the provisioner can bind an archetype.
  createSyntheticDomain(input: SyntheticDomainCreateInput, actorUserId: string): Promise<SyntheticDomain>;
}

export interface ProvisionRequest {
  /** The approved access request to provision against (for email + readiness). */
  accessRequestId: string;
  /** Clerk org id (becomes the workspace id) — must exist. */
  clerkOrgId: string;
  /** Clerk user id of the owner — must exist (post invite-accept). */
  ownerClerkId: string;
  /** Optional distinct operator Clerk user id. */
  operatorClerkId?: string | null;
  /** Optional project name override. */
  projectName?: string | null;
  /** Admin (approver) user id, for audit. */
  approvedBy: string;
  /** Optional Workers-AI binding to LLM-enrich the day-1 welcome (absent → deterministic). */
  ai?: AiRunner;
  modelLineageFactory?: GovernedModelLineageFactory;
  modelLineageRequired?: boolean;
}

export interface ProvisionOutcome {
  result: ProvisionCustomerResult;
  readiness: { level: number | null; account_type: string; answers_count: number } | null;
  warnings: string[];
  /** Whether the day-1 governed welcome proposal was drafted into the new workspace. */
  welcome_drafted: boolean;
  /** ABS-P3 · how many honest-empty domain skeletons were scaffolded (0 when DOMAIN_SCAFFOLD_ENABLED is off). */
  domains_scaffolded: number;
}

/**
 * Minimal env surface the provisioner reads. The ONLY flag here gates the ctx_v1
 * resolver wiring (default OFF). When CONTEXT_RESOLVER_ENABLED is anything other
 * than the literal string 'true' (including absent/undefined — the default), the
 * provisioner behaves EXACTLY as before (buildDay1Roadmap is the roadmap source).
 * The full worker Env (AppEnv in index.ts) is structurally a superset of this.
 */
export interface ProvisionerEnv {
  /** Feature flag — ONLY 'true' (string) enables the resolver. Default OFF. */
  CONTEXT_RESOLVER_ENABLED?: string;
  /** ABS-P3 · ONLY 'true' scaffolds an archetype's honest-empty domain skeletons at provisioning. Default OFF. */
  DOMAIN_SCAFFOLD_ENABLED?: string;
}

/**
 * mapSetupToRoadmapSteps — adapter from the ctx_v1 resolver's Day1Setup.roadmap
 * (Day1RoadmapStep[] = { n, body, gate }) to the SAME RoadmapStep[] shape
 * buildDay1Roadmap emits ({ summary, body }), so the downstream operation_events
 * seeding (customer-provisioning-store) is byte-for-byte unchanged in shape.
 *
 * Day1RoadmapStep has no `summary` field (it carries a `gate` + a full-sentence
 * `body` instead), so we derive a concise summary from the body: the first
 * sentence/clause, trimmed of trailing punctuation and capped for the card title.
 * The `gate` is intentionally NOT propagated into the seeded event — the existing
 * seeding has no gate column; preserving the exact downstream contract is the
 * point of this adapter (the resolver only changes the SOURCE of the steps).
 */
export function mapSetupToRoadmapSteps(setup: Day1Setup): RoadmapStep[] {
  return setup.roadmap.map((step) => ({
    summary: deriveSummary(step.body),
    body: step.body,
  }));
}

/** First sentence/clause of a body, trimmed + length-capped, for a card title. */
function deriveSummary(body: string): string {
  const firstSentence = (body.split(/(?<=[.!?])\s/)[0] || body).trim();
  const clause = firstSentence.split(/\s[—–-]\s/)[0].trim();
  const base = (clause || firstSentence).replace(/[.!?]+$/, '').trim();
  return base.length > 80 ? `${base.slice(0, 77).trimEnd()}…` : base;
}

/** URL-safe slug from a display name/email; deterministic so re-runs are idempotent. */
export function slugifyCustomer(s: string): string {
  return (
    (s || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'customer'
  );
}

export async function provisionCustomerFromAccessRequest(
  dal: OnboardingProvisionerDal,
  req: ProvisionRequest,
  env: ProvisionerEnv = {},
): Promise<ProvisionOutcome> {
  const warnings: string[] = [];
  if (!req.clerkOrgId || !req.ownerClerkId) {
    throw makeError('VALIDATION_ERROR', 'clerkOrgId and ownerClerkId are required', 400);
  }

  const ar = await dal.getAccessRequest(req.accessRequestId);
  if (!ar) {
    throw makeError('NOT_FOUND', `access request ${req.accessRequestId} not found`, 404);
  }

  let ra = await dal.getReadinessAssessment(req.accessRequestId);
  // Part R · Stage C (260628) · anonymous-lead → registration linking. The Clerk-org auto-provision
  // path creates a fresh access_request with no readiness of its own; fall back to a prior readiness
  // captured by the SAME email from an anonymous website-funnel lead. SAFE: ar.email is the
  // Clerk-VERIFIED session email at this seam (never a pre-auth email — see the request-access boundary).
  let linkedByEmail = false;
  if (!ra && ar.email) {
    ra = await dal.getReadinessAssessmentByEmail(ar.email);
    if (ra) { linkedByEmail = true; warnings.push('readiness linked by verified email from a prior anonymous funnel lead'); }
  }
  if (!ra) warnings.push('no readiness assessment found — provisioning with the base day-1 roadmap');

  const level = ra && Number.isInteger(ra.deep_level as number) ? (ra.deep_level as number) : null;
  const accountType = (ra && ra.account_type) || 'company';
  const answers = (ra && ra.readiness_answers && typeof ra.readiness_answers === 'object'
    ? (ra.readiness_answers as Record<string, unknown>)
    : {}) as Record<string, unknown>;

  const customerName =
    (ra && ra.company_name) || ar.company_name || (ar.email ? ar.email.split('@')[0] : null) || 'Customer';
  const customerSlug = slugifyCustomer(customerName || ar.email || req.clerkOrgId);
  const projectId = `proj_${customerSlug}_default`;
  const projectName = (req.projectName && req.projectName.trim()) || `${customerName} · Operations`;

  // ── Day-1 roadmap source · ctx_v1 resolver behind a flag (default OFF) ──────
  // DEFAULT (flag unset / not 'true'): byte-identical to today — buildDay1Roadmap.
  // Flag ON ('true') + a VALID readiness_answers.context (validateCompanyContext
  // ok:true): the deterministic ctx_v1 resolver drives the roadmap instead.
  // ANY validation failure, missing context, or thrown error FALLS BACK to
  // buildDay1Roadmap — the resolver can NEVER fail provisioning.
  const useResolver = envFlagTrue(env.CONTEXT_RESOLVER_ENABLED);
  let roadmap: RoadmapStep[] | undefined;
  if (useResolver) {
    try {
      const v = validateCompanyContext((answers as Record<string, unknown>).context);
      if (v.ok) {
        roadmap = mapSetupToRoadmapSteps(resolveDay1Setup(v.context));
      } else {
        warnings.push('context resolver: readiness_answers.context invalid — falling back to base day-1 roadmap');
      }
    } catch (_) {
      warnings.push('context resolver: errored — falling back to base day-1 roadmap');
    }
  }
  roadmap = roadmap ?? buildDay1Roadmap({ level, accountType });
  // Wave C · S5a — append a "Connect <tool>" task per declared integration (where the customer's
  // work lives), reusing the roadmap→operation_events channel. Applies to BOTH roadmap sources.
  roadmap = [...roadmap, ...buildConnectTasks(answers.integrations)];

  const result = await dal.provisionCustomerWorkspace({
    accessRequestId: req.accessRequestId,
    clerkOrgId: req.clerkOrgId,
    customerName,
    customerSlug,
    ownerClerkId: req.ownerClerkId,
    operatorClerkId: req.operatorClerkId ?? null,
    projectName,
    projectId,
    approvedBy: req.approvedBy,
    roadmap,
  });

  // ABS-P3 · DOMAIN-SKELETON SCAFFOLD (flag-gated, default OFF ⇒ byte-identical). The instant the
  // workspace exists, bind an archetype's HONEST-EMPTY domain skeletons so a new tenant gets MB-P-SHAPED
  // structure (domains present, ZERO fabricated goals/metrics) instead of a single bare project. The
  // archetype is chosen from the readiness account type. BEST-EFFORT: never fails provisioning (same
  // non-fatal pattern as the day-1 welcome); idempotent by construction (ON CONFLICT (workspace_id, slug)).
  let domainsScaffolded = 0;
  if (envFlagTrue(env.DOMAIN_SCAFFOLD_ENABLED) && result.workspace_id && req.ownerClerkId) {
    const archetype = resolveArchetype(archetypeKeyForAccountType(accountType));
    if (archetype) {
      for (const skeleton of archetype.domains) {
        try {
          await dal.createSyntheticDomain(
            skeletonToCreateInput(skeleton, result.workspace_id, req.ownerClerkId, archetype.key),
            req.ownerClerkId,
          );
          domainsScaffolded += 1;
        } catch (_) {
          warnings.push(`domain scaffold: could not create '${skeleton.slug}' (non-fatal)`);
        }
      }
    }
  }

  // Part R · Stage C (260628) · if the readiness was linked by a verified email (it belongs to the
  // lead's OLD anonymous access_request), stamp it onto the NEW workspace so getCustomerContextProfile
  // recovers it — the in-txn stamp keys on access_request_id and won't touch the old row. Best-effort.
  if (linkedByEmail && result.workspace_id && ar.email) {
    try {
      await dal.attachReadinessToWorkspaceByEmail(ar.email, result.workspace_id, req.ownerClerkId ?? null);
    } catch (_) {
      warnings.push('could not stamp the email-linked readiness onto the new workspace (non-fatal)');
    }
  }

  // DAY-1 governed welcome (best-effort; the moat visible at minute one). The instant the
  // workspace exists, the agent drafts a PENDING welcome proposal into it so the customer sees
  // a governed agent doing real work immediately — instead of waiting up to ~6 days for the
  // weekly digest sweep. BEST-EFFORT: provisioning is the priority, so any failure here pushes a
  // warning and continues (same non-fatal pattern as a missing readiness assessment). The draft
  // is a PENDING proposal the bell renders + approves via /sign-offs — it NEVER auto-posts.
  let welcomeDrafted = false;
  try {
    const summary = await dal.getWorkspaceActivitySummary(result.workspace_id, null);
    if (req.ai && req.modelLineageRequired && !req.modelLineageFactory) {
      throw new Error('strict model lineage factory is unavailable');
    }
    const governed = req.ai && req.modelLineageFactory
      ? await req.modelLineageFactory({
        workspace_id: result.workspace_id,
        principal_id: 'xlooop:digest-agent',
        role: 'automation',
        mode: 'plan',
        action: 'assistant:onboard',
        intent_ref: `onboarding:${req.accessRequestId}`,
        scope: { event_count: summary.events_total, document_count: 0, unpromoted_document_count: 0, source_count: summary.connected_sources },
        redaction_profile: 'automation-onboarding-summary',
        client_empty: false,
      })
      : null;
    const welcome = await buildOnboardingWelcomeDraft(summary, {
      customerName,
      roadmapCount: roadmap.length,
      ai: req.ai,
      executionObserver: governed?.observer,
    });
    if (governed) await governed.complete();
    const now = new Date().toISOString();
    // Stable, distinct id so it is idempotent and never collides with the weekly digest's
    // `evt_agent_digest_<ws>_<date>` id.
    const eventId = `evt_agent_welcome_${result.workspace_id}`;
    await dal.upsertEvent(result.workspace_id, {
      id: eventId,
      source_tool: 'xlooop',
      agent_id: 'xlooop:digest-agent',
      status: 'needs_review',
      approval_state: 'pending',
      summary: welcome.summary,
      body: welcome.body,
      next_action: 'approve_to_post_digest',
      visibility: 'internal_workspace',
      occurred_at: now,
    });
    welcomeDrafted = true;
  } catch (_) {
    warnings.push('day-1 welcome draft skipped (non-fatal) — the weekly digest will still run');
  }

  return {
    result,
    readiness: ra
      ? { level, account_type: accountType, answers_count: Object.keys(answers).length }
      : null,
    warnings,
    welcome_drafted: welcomeDrafted,
    domains_scaffolded: domainsScaffolded,
  };
}
