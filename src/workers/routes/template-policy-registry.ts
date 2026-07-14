// template-policy-registry.ts · customer-safe governance/template projection API.
//
// Backend = source of truth for customer operational projections. This route
// returns effective redacted templates, status, identity binding, approvals, and
// snapshots only. It never exposes raw MB-P governance files, private graph/IP,
// internal scoring, agent routing, secrets, or broad search-all-memory.

import { Hono } from 'hono';
import { authorizeGovernedWrite } from '../lib/spine-authority';
import { errorEnvelope } from '../middleware/error';
import { withDataClass } from '../lib/response-envelope';
import type { AuthEnv, AuthVariables } from '../middleware/auth';
import type { DalAdapter } from '../dal/DalAdapter';
import type {
  AuthContext,
  LearningSignalClassification,
  LearningSignalKind,
  LearningPromotionState,
  LearningSignalSourceKind,
  TemplateAdminApprovalInput,
  TemplatePolicyListOpts,
} from '../dal/types';
import {
  TEMPLATE_POLICY_FORBIDDEN_OVERRIDE_KEYS,
  TEMPLATE_POLICY_INHERITANCE_ORDER,
} from '../dal/template-policy-store';

export interface TemplatePolicyEnv extends AuthEnv {
  DATABASE_URL: string;
}

export interface TemplatePolicyVariables extends AuthVariables {
  dal: DalAdapter;
}

export const templatePolicyRegistryRoute = new Hono<{
  Bindings: TemplatePolicyEnv;
  Variables: TemplatePolicyVariables;
}>();

const FORBIDDEN_SURFACES = [
  'raw_graph',
  'full_tenant_memory',
  'xlooop_internal_templates',
  'governance_scoring',
  'agent_routing',
  'private_graph_schema',
  'secrets',
  'search_all_memory',
] as const;

const CUSTOMER_SAFE_CAPABILITIES = [
  'effective_templates',
  'version_hashes',
  'source_refs',
  'approval_refs',
  'audit_receipts',
  'whoami_identity_binding',
  'effective_personalization_profile',
  'private_learning_signals',
  'approved_tenant_learning_promotions',
] as const;

const LEARNING_SIGNAL_KINDS = new Set<LearningSignalKind>([
  'preference',
  'personal_rule',
  'personal_skill',
  'workflow_default',
  'correction',
  'tool_usage',
  'role_fit',
]);

const LEARNING_SIGNAL_SOURCE_KINDS = new Set<LearningSignalSourceKind>([
  'explicit_user_action',
  'agent_observation',
  'tool_event',
  'evidence_feedback',
  'approval_feedback',
  'onboarding',
]);

const LEARNING_CLASSIFICATIONS = new Set<LearningSignalClassification>([
  'user_private',
  'tenant_share_candidate',
  'tenant_shared',
  'platform_private',
]);

const LEARNING_PROMOTION_STATES = new Set<LearningPromotionState>([
  'private',
  'candidate',
  'approved_shared',
  'rejected',
  'archived',
]);

const TENANT_PROMOTION_STATUSES = new Set(['requested', 'approved', 'rejected', 'cancelled'] as const);

function jsonError(ctx: any, status: 400 | 403, code: string, error: string) {
  ctx.status(status);
  return ctx.json({ error, code, request_id: ctx.get('request_id') });
}

async function jsonBody(ctx: any): Promise<Record<string, unknown> | null> {
  const body = await ctx.req.json().catch(() => null);
  return body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null;
}

// P5(b): the inline canAdminMutate predicate (deny service principals · owner/operator/is_admin) is now the
// one-core governed gate with the SAME legacy shape flag-off (denyServicePrincipals + adminOverride reproduce
// it byte-identically); flag-on = entitlement + operator-mode, with the platform-admin overlay preserved.
async function canAdminMutateGoverned(ctx: Parameters<typeof authorizeGovernedWrite>[0]): Promise<boolean> {
  return (await authorizeGovernedWrite(ctx, 'policy:write', { adminOverride: true, denyServicePrincipals: true })).allowed;
}

function containsForbiddenOverride(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((item) => containsForbiddenOverride(item));
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if ((TEMPLATE_POLICY_FORBIDDEN_OVERRIDE_KEYS as readonly string[]).includes(key)) return true;
    if (containsForbiddenOverride(nested)) return true;
  }
  return false;
}

type LearningPayloadResult =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; response: Response };

function requireLearningPayload(ctx: any, body: Record<string, unknown>): LearningPayloadResult {
  const payload = body.signal_json ?? body.promotion_payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, response: jsonError(ctx, 400, 'VALIDATION_ERROR', 'learning payload must be a JSON object') };
  }
  if (containsForbiddenOverride(payload)) {
    return { ok: false, response: jsonError(ctx, 400, 'VALIDATION_ERROR', 'learning payload cannot contain governance/security override keys') };
  }
  return { ok: true, payload: payload as Record<string, unknown> };
}

function whoamiEnvelope(auth: AuthContext) {
  const authMethod = auth.auth_method || (auth.service_principal ? 'service_principal' : 'clerk_jwt');
  const clientId = auth.client_id || auth.service_principal || 'clerk_user';
  const scopes = auth.service_principal === 'canary_read'
    ? ['read:status', 'read:effective_templates', 'read:mcp_allowlist']
    : [
        'read:status',
        'read:effective_templates',
        'read:personalization',
        'read:packets',
        'read:evidence',
        'read:approvals',
        'read:metrics',
        'write:learning_signals',
        ...(auth.role === 'owner' || auth.role === 'operator' ? ['write:canary_metadata'] : []),
        ...(auth.role === 'owner' || auth.role === 'operator' ? ['promote:tenant_learning'] : []),
      ];
  return {
    schema_id: 'xlooop.identity_whoami.v1',
    identity: {
      user_id: auth.user_id,
      tenant_id: auth.workspace_id,
      membership_ref: auth.workspace_id ? `${authMethod}:${auth.workspace_id}:${auth.user_id}` : null,
      membership_resolution: 'clerk_org_membership_and_backend_rbac',
      role: auth.role,
      scopes,
      client_id: clientId,
      token_expires_at: auth.token_expires_at ?? null,
      auth_method: authMethod,
      service_principal: auth.service_principal ?? null,
    },
    forbidden_surfaces: FORBIDDEN_SURFACES,
  };
}

function listOpts(ctx: any): TemplatePolicyListOpts {
  const url = new URL(ctx.req.url);
  const limitRaw = url.searchParams.get('limit');
  const template_id = url.searchParams.get('template_id') || undefined;
  const template_key = url.searchParams.get('template_key') || undefined;
  const user_id = url.searchParams.get('user_id') || undefined;
  return {
    limit: limitRaw ? Math.max(1, parseInt(limitRaw, 10) || 50) : 50,
    ...(template_id ? { template_id } : {}),
    ...(template_key ? { template_key } : {}),
    ...(user_id ? { user_id } : {}),
  };
}

templatePolicyRegistryRoute.get('/whoami', (ctx) => {
  return ctx.json(whoamiEnvelope(ctx.get('auth')));
});

templatePolicyRegistryRoute.get('/template-policy/status', (ctx) => {
  return ctx.json({
    schema_id: 'xlooop.template_policy_registry_status.v1',
    status: 'ready',
    source_of_truth: {
      governance: 'private_mbp_git',
      customer_operational_projection: 'xlooop_backend_postgres',
      raw_governance_files_exposed_to_customer_api: false,
    },
    customer_safe_capabilities: CUSTOMER_SAFE_CAPABILITIES,
    inheritance_order: TEMPLATE_POLICY_INHERITANCE_ORDER,
    forbidden_overlay_keys: TEMPLATE_POLICY_FORBIDDEN_OVERRIDE_KEYS,
    learning_personalization: {
      schema_id: 'xlooop.learning_personalization_policy.v1',
      levels: ['company_profile', 'role_profile', 'user_private_profile'],
      user_learning_private_by_default: true,
      company_sharing_requires: ['consent_ref', 'admin_or_operator_promotion', 'approval_ref', 'audit_event'],
      allowed_user_learning: ['preferences', 'personal_rules', 'personal_skills', 'learned_defaults', 'role_fit'],
      lower_layers_must_not_weaken: [
        'tenant_isolation',
        'redaction',
        'retention',
        'approvals',
        'tool_permissions',
        'evidence',
        'rca',
        'forbidden_surfaces',
      ],
    },
    forbidden_surfaces: FORBIDDEN_SURFACES,
  });
});

templatePolicyRegistryRoute.get('/template-policy/effective-templates', async (ctx) => {
  try {
    const auth = ctx.get('auth');
    const templates = await ctx.get('dal').resolveEffectiveTemplates(auth.workspace_id, auth.user_id, listOpts(ctx));
    return ctx.json(withDataClass({
      schema_id: 'xlooop.effective_template_projection.v1',
      tenant_id: auth.workspace_id,
      templates,
      inheritance_order: TEMPLATE_POLICY_INHERITANCE_ORDER,
      forbidden_surfaces: FORBIDDEN_SURFACES,
    }, 'template'));
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

templatePolicyRegistryRoute.get('/template-policy/effective-snapshots', async (ctx) => {
  try {
    const auth = ctx.get('auth');
    const snapshots = await ctx.get('dal').listEffectiveTemplateSnapshots(auth.workspace_id, listOpts(ctx));
    return ctx.json(withDataClass({
      schema_id: 'xlooop.effective_template_snapshots.v1',
      tenant_id: auth.workspace_id,
      snapshots,
    }, 'template'));
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

templatePolicyRegistryRoute.post('/template-policy/admin/approvals', async (ctx) => {
  try {
    const auth = ctx.get('auth');
    if (!(await canAdminMutateGoverned(ctx))) {
      return jsonError(ctx, 403, 'FORBIDDEN', 'template/policy mutation requires admin/operator role and cannot use a service-principal token');
    }
    const body = await jsonBody(ctx);
    if (!body) return jsonError(ctx, 400, 'VALIDATION_ERROR', 'request body must be a JSON object');
    if (typeof body.approval_ref !== 'string' || typeof body.action !== 'string') {
      return jsonError(ctx, 400, 'VALIDATION_ERROR', 'approval_ref and action are required');
    }
    if (
      body.rollback_snapshot_id !== undefined &&
      body.rollback_snapshot_id !== null &&
      typeof body.rollback_snapshot_id !== 'string'
    ) {
      return jsonError(ctx, 400, 'VALIDATION_ERROR', 'rollback_snapshot_id must be a string or null when provided');
    }
    const approvalInput: TemplateAdminApprovalInput = {
      approval_ref: body.approval_ref,
      action: body.action,
      status: body.decision === 'rejected' ? 'rejected' : 'approved',
      evidence_ref_id: Array.isArray(body.evidence_refs) && typeof body.evidence_refs[0] === 'string'
        ? body.evidence_refs[0]
        : typeof body.evidence_ref_id === 'string'
          ? body.evidence_ref_id
          : null,
      rollback_snapshot_id: typeof body.rollback_snapshot_id === 'string' ? body.rollback_snapshot_id : null,
    };
    const approval = await ctx.get('dal').createTemplateAdminApproval(auth.workspace_id, auth.user_id, approvalInput);
    ctx.status(201);
    return ctx.json({ schema_id: 'xlooop.template_admin_approval.v1', approval });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

templatePolicyRegistryRoute.get('/template-policy/personalization/effective-profile', async (ctx) => {
  try {
    const auth = ctx.get('auth');
    const url = new URL(ctx.req.url);
    const roleKey = url.searchParams.get('role_key') || undefined;
    const dal = ctx.get('dal');
    const profile = await dal.getEffectivePersonalizationProfile(auth.workspace_id, auth.user_id, roleKey);
    // S1 (260628) · attach the captured company context so the connected Claude Code / Codex / Cursor
    // (which read get_effective_profile) actually KNOW the company — focus, maturity, AI tools, where
    // work lives — instead of the profile being learning-rules only. Closes the write-only-silo bug.
    const company_context = await dal.getCustomerContextProfile(auth.workspace_id);
    return ctx.json({
      schema_id: 'xlooop.effective_personalization_profile_response.v1',
      tenant_id: auth.workspace_id,
      profile,
      company_context,
      forbidden_surfaces: FORBIDDEN_SURFACES,
    });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

templatePolicyRegistryRoute.post('/template-policy/personalization/signals', async (ctx) => {
  try {
    const auth = ctx.get('auth');
    if (auth.service_principal) {
      return jsonError(ctx, 403, 'FORBIDDEN', 'service-principal tokens cannot write personal learning signals');
    }
    const body = await jsonBody(ctx);
    if (!body) return jsonError(ctx, 400, 'VALIDATION_ERROR', 'request body must be a JSON object');
    if (!LEARNING_SIGNAL_KINDS.has(body.signal_kind as LearningSignalKind)) {
      return jsonError(ctx, 400, 'VALIDATION_ERROR', 'invalid learning signal_kind');
    }
    if (!LEARNING_SIGNAL_SOURCE_KINDS.has(body.source_kind as LearningSignalSourceKind)) {
      return jsonError(ctx, 400, 'VALIDATION_ERROR', 'invalid learning source_kind');
    }
    const classification = typeof body.classification === 'string' ? body.classification as LearningSignalClassification : 'user_private';
    if (!LEARNING_CLASSIFICATIONS.has(classification)) {
      return jsonError(ctx, 400, 'VALIDATION_ERROR', 'invalid learning classification');
    }
    if (classification !== 'user_private' && typeof body.consent_ref !== 'string') {
      return jsonError(ctx, 400, 'VALIDATION_ERROR', 'tenant-share learning signals require consent_ref');
    }
    const payloadResult = requireLearningPayload(ctx, body);
    if (!payloadResult.ok) return payloadResult.response;
    const promotionState = typeof body.promotion_state === 'string' ? body.promotion_state as LearningPromotionState : undefined;
    if (promotionState && !LEARNING_PROMOTION_STATES.has(promotionState)) {
      return jsonError(ctx, 400, 'VALIDATION_ERROR', 'invalid learning promotion_state');
    }
    const signal = await ctx.get('dal').createUserLearningSignal(auth.workspace_id, auth.user_id, {
      signal_kind: body.signal_kind as LearningSignalKind,
      source_kind: body.source_kind as LearningSignalSourceKind,
      signal_json: payloadResult.payload,
      classification,
      promotion_state: promotionState,
      consent_ref: typeof body.consent_ref === 'string' ? body.consent_ref : null,
      evidence_ref_id: typeof body.evidence_ref_id === 'string' ? body.evidence_ref_id : null,
    });
    ctx.status(201);
    return ctx.json({
      schema_id: 'xlooop.user_learning_signal.v1',
      signal,
      privacy_model: 'private_by_default_with_explicit_company_promotion',
    });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

templatePolicyRegistryRoute.post('/template-policy/personalization/promotions', async (ctx) => {
  try {
    const auth = ctx.get('auth');
    if (!(await canAdminMutateGoverned(ctx))) {
      return jsonError(ctx, 403, 'FORBIDDEN', 'tenant learning promotion requires admin/operator role and cannot use a service-principal token');
    }
    const body = await jsonBody(ctx);
    if (!body) return jsonError(ctx, 400, 'VALIDATION_ERROR', 'request body must be a JSON object');
    for (const field of ['source_user_id', 'signal_id', 'target_profile_key', 'approval_ref']) {
      if (typeof body[field] !== 'string' || !body[field]) {
        return jsonError(ctx, 400, 'VALIDATION_ERROR', `${field} is required`);
      }
    }
    const payloadResult = requireLearningPayload(ctx, body);
    if (!payloadResult.ok) return payloadResult.response;
    const status = typeof body.status === 'string' ? body.status : undefined;
    if (status && !TENANT_PROMOTION_STATUSES.has(status as never)) {
      return jsonError(ctx, 400, 'VALIDATION_ERROR', 'invalid tenant learning promotion status');
    }
    const promotion = await ctx.get('dal').createTenantLearningPromotion(auth.workspace_id, auth.user_id, {
      source_user_id: body.source_user_id as string,
      signal_id: body.signal_id as string,
      target_profile_key: body.target_profile_key as string,
      promotion_payload: payloadResult.payload,
      approval_ref: body.approval_ref as string,
      evidence_ref_id: typeof body.evidence_ref_id === 'string' ? body.evidence_ref_id : null,
      status: status as 'requested' | 'approved' | 'rejected' | 'cancelled' | undefined,
    });
    ctx.status(201);
    return ctx.json({
      schema_id: 'xlooop.tenant_learning_promotion.v1',
      promotion,
      public_self_serve_authority: false,
    });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

export { whoamiEnvelope };
