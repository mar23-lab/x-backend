// template-policy-registry-route.test.ts
//
// Tests the customer-safe template/policy projection contract: customers get
// effective templates and redacted identity only; admin mutation requires a real
// user role and audit/approval input.

import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { templatePolicyRegistryRoute } from '../routes/template-policy-registry';

const OWNER = {
  user_id: 'user_owner',
  workspace_id: 'tenant_a',
  role: 'owner',
  auth_method: 'clerk_jwt',
  client_id: 'clerk_user',
};
const VIEWER = {
  user_id: 'user_viewer',
  workspace_id: 'tenant_a',
  role: 'viewer',
  auth_method: 'clerk_jwt',
  client_id: 'clerk_user',
};
const CANARY = {
  user_id: 'svc_xlooop_canary',
  workspace_id: 'tenant_a',
  role: 'viewer',
  service_principal: 'canary_read',
  auth_method: 'service_principal',
  client_id: 'xlooop-canary-read',
};

type Call = { method: string; ws: string; actor?: string; input?: Record<string, unknown>; opts?: Record<string, unknown> };

function appFor(auth: Record<string, unknown>, calls: Call[]) {
  const dal = {
    resolveEffectiveTemplates: async (ws: string, actor: string, opts: Record<string, unknown>) => {
      calls.push({ method: 'resolveEffectiveTemplates', ws, actor, opts });
      return [{
        template_id: 'tpl_1',
        template_key: 'xcp.customer.intake',
        name: 'Customer Intake',
        category: 'intake',
        binding_scope: 'tenant',
        version_id: 'tplv_1',
        version: '1.0.0',
        content_sha256: 'a'.repeat(64),
        approval_ref: 'approval://unit',
        source_ref: 'xcp-platform/packages/xcp-skills-templates/customer-intake.md',
        source_sha: 'b'.repeat(40),
        lifecycle_state: 'active',
        effective_template: { tone: 'plain', workflow: 'tenant-safe' },
        overlay_applied: false,
        resolution_order: ['global platform default', 'company tenant binding'],
        forbidden_override_keys: ['security', 'secrets', 'raw_graph'],
      }];
    },
    listEffectiveTemplateSnapshots: async (ws: string, opts: Record<string, unknown>) => {
      calls.push({ method: 'listEffectiveTemplateSnapshots', ws, opts });
      return [{
        id: 'ets_1',
        workspace_id: ws,
        template_id: 'tpl_1',
        user_id: null,
        snapshot_hash: 'c'.repeat(64),
        effective_template: { tone: 'plain' },
        source_version_ids: ['tplv_1'],
        evidence_ref_ids: [],
        created_at: '2026-06-20T00:00:00.000Z',
      }];
    },
    createTemplateAdminApproval: async (ws: string, actor: string, input: Record<string, unknown>) => {
      calls.push({ method: 'createTemplateAdminApproval', ws, actor, input });
      return {
        id: 'tap_1',
        workspace_id: ws,
        actor_user_id: actor,
        status: 'approved',
        evidence_ref_id: null,
        rollback_snapshot_id: null,
        created_at: '2026-06-20T00:00:00.000Z',
        decided_at: '2026-06-20T00:00:00.000Z',
        ...input,
      };
    },
    getEffectivePersonalizationProfile: async (ws: string, actor: string, roleKey?: string) => {
      calls.push({ method: 'getEffectivePersonalizationProfile', ws, actor, input: { roleKey } });
      return {
        schema_id: 'xlooop.effective_personalization_profile.v1',
        workspace_id: ws,
        user_id: actor,
        role_key: roleKey || 'member',
        company_profile: {
          rules: { writing_style: 'plain' },
          skills: { default_router: 'customer-onboarding' },
          defaults: { timezone: 'Australia/Melbourne' },
          approval_refs: ['approval://company-learning'],
        },
        user_profile: {
          preferences: { concise: true },
          personal_rules: { morning_digest: true },
          personal_skills: { preferred_skill: 'evidence-review' },
          learned_defaults: { tone: 'direct' },
          source_signal_ids: ['uls_1'],
        },
        effective_profile: {
          rules: { writing_style: 'plain', morning_digest: true },
          skills: { default_router: 'customer-onboarding', preferred_skill: 'evidence-review' },
          defaults: { timezone: 'Australia/Melbourne', tone: 'direct' },
          preferences: { concise: true },
        },
        privacy_model: 'private_by_default_with_explicit_company_promotion',
        forbidden_override_keys: ['security', 'secrets', 'raw_graph'],
      };
    },
    // S1 (260628): GET /effective-profile attaches the captured company context so connected agents know
    // the company. Added after this suite was written; vi mock must expose it or the handler 500s. Null =
    // "no company context captured" (a valid state; the test asserts profile.privacy_model, not this).
    getCustomerContextProfile: async (_ws: string) => null,
    createUserLearningSignal: async (ws: string, actor: string, input: Record<string, unknown>) => {
      calls.push({ method: 'createUserLearningSignal', ws, actor, input });
      return {
        id: 'uls_1',
        workspace_id: ws,
        user_id: actor,
        classification: 'user_private',
        promotion_state: 'private',
        consent_ref: null,
        evidence_ref_id: null,
        created_at: '2026-06-21T00:00:00.000Z',
        updated_at: '2026-06-21T00:00:00.000Z',
        ...input,
      };
    },
    createTenantLearningPromotion: async (ws: string, actor: string, input: Record<string, unknown>) => {
      calls.push({ method: 'createTenantLearningPromotion', ws, actor, input });
      return {
        id: 'tlp_1',
        workspace_id: ws,
        promoted_by_user_id: actor,
        status: 'requested',
        evidence_ref_id: null,
        created_at: '2026-06-21T00:00:00.000Z',
        decided_at: null,
        ...input,
      };
    },
  };
  const app = new Hono();
  app.use('*', async (ctx, next) => {
    ctx.set('request_id', 'test');
    ctx.set('auth', auth as never);
    ctx.set('dal', dal as never);
    await next();
  });
  app.route('/api/v1', templatePolicyRegistryRoute);
  return app;
}

function request(method: string, path: string, auth: Record<string, unknown>, body?: Record<string, unknown>) {
  const calls: Call[] = [];
  const app = appFor(auth, calls);
  return app.request(`/api/v1${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  }).then((res) => ({ res, calls }));
}

describe('template policy registry route', () => {
  it('GET /whoami returns redacted identity and forbidden surfaces', async () => {
    const { res } = await request('GET', '/whoami', VIEWER);
    expect(res.status).toBe(200);
    const body = await res.json() as { identity: { tenant_id: string; client_id: string }; forbidden_surfaces: string[] };
    expect(body.identity).toMatchObject({ tenant_id: 'tenant_a', client_id: 'clerk_user' });
    expect(body.forbidden_surfaces).toContain('private_graph_schema');
  });

  it('GET /template-policy/effective-templates returns tenant-scoped effective projections only', async () => {
    const { res, calls } = await request('GET', '/template-policy/effective-templates?template_key=xcp.customer.intake', VIEWER);
    expect(res.status).toBe(200);
    const body = await res.json() as { templates: Array<{ effective_template: Record<string, unknown>; source_ref: string }> };
    expect(body.templates[0]?.effective_template).toEqual({ tone: 'plain', workflow: 'tenant-safe' });
    expect(body.templates[0]?.source_ref).toContain('xcp-platform/packages/xcp-skills-templates');
    expect(JSON.stringify(body)).not.toContain('/Users/maratbasyrov/WIP/MB-P');
    expect(calls[0]).toMatchObject({ method: 'resolveEffectiveTemplates', ws: 'tenant_a', actor: 'user_viewer' });
  });

  it('GET /template-policy/effective-snapshots is workspace scoped', async () => {
    const { res, calls } = await request('GET', '/template-policy/effective-snapshots', VIEWER);
    expect(res.status).toBe(200);
    const body = await res.json() as { snapshots: Array<{ workspace_id: string }> };
    expect(body.snapshots[0]?.workspace_id).toBe('tenant_a');
    expect(calls[0]).toMatchObject({ method: 'listEffectiveTemplateSnapshots', ws: 'tenant_a' });
  });

  it('POST /template-policy/admin/approvals rejects viewers and service principals', async () => {
    const body = { approval_ref: 'approval://unit', action: 'activate_template' };
    const viewer = await request('POST', '/template-policy/admin/approvals', VIEWER, body);
    const canary = await request('POST', '/template-policy/admin/approvals', CANARY, body);
    expect(viewer.res.status).toBe(403);
    expect(canary.res.status).toBe(403);
    expect(viewer.calls).toEqual([]);
    expect(canary.calls).toEqual([]);
  });

  it('POST /template-policy/admin/approvals records admin approval receipts', async () => {
    const { res, calls } = await request('POST', '/template-policy/admin/approvals', OWNER, {
      approval_ref: 'approval://unit',
      action: 'activate_template',
      rollback_snapshot_id: 'ets_1',
    });
    expect(res.status).toBe(201);
    expect(calls[0]).toMatchObject({
      method: 'createTemplateAdminApproval',
      ws: 'tenant_a',
      actor: 'user_owner',
    });
  });

  it('GET /template-policy/status declares company/user learning policy', async () => {
    const { res } = await request('GET', '/template-policy/status', VIEWER);
    expect(res.status).toBe(200);
    const body = await res.json() as { learning_personalization: { user_learning_private_by_default: boolean; company_sharing_requires: string[] } };
    expect(body.learning_personalization.user_learning_private_by_default).toBe(true);
    expect(body.learning_personalization.company_sharing_requires).toContain('approval_ref');
  });

  it('GET /template-policy/personalization/effective-profile returns company + private user profile', async () => {
    const { res, calls } = await request('GET', '/template-policy/personalization/effective-profile?role_key=analyst', VIEWER);
    expect(res.status).toBe(200);
    const body = await res.json() as { profile: { privacy_model: string; effective_profile: Record<string, unknown> }; forbidden_surfaces: string[] };
    expect(body.profile.privacy_model).toBe('private_by_default_with_explicit_company_promotion');
    expect(body.profile.effective_profile).toMatchObject({
      preferences: { concise: true },
    });
    expect(body.forbidden_surfaces).toContain('search_all_memory');
    expect(calls[0]).toMatchObject({ method: 'getEffectivePersonalizationProfile', ws: 'tenant_a', actor: 'user_viewer' });
  });

  it('POST /template-policy/personalization/signals records private user learning and rejects service principals', async () => {
    const body = {
      signal_kind: 'preference',
      source_kind: 'explicit_user_action',
      signal_json: { tone: 'concise', examples: 'industry-specific' },
    };
    const viewer = await request('POST', '/template-policy/personalization/signals', VIEWER, body);
    const canary = await request('POST', '/template-policy/personalization/signals', CANARY, body);
    expect(viewer.res.status).toBe(201);
    expect(canary.res.status).toBe(403);
    expect(viewer.calls[0]).toMatchObject({ method: 'createUserLearningSignal', actor: 'user_viewer' });
    expect(canary.calls).toEqual([]);
  });

  it('POST /template-policy/personalization/signals rejects forbidden governance override payloads', async () => {
    const { res, calls } = await request('POST', '/template-policy/personalization/signals', VIEWER, {
      signal_kind: 'personal_rule',
      source_kind: 'agent_observation',
      signal_json: { security: { tenant_isolation: 'off' } },
    });
    expect(res.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it('POST /template-policy/personalization/promotions requires owner/operator approval path', async () => {
    const body = {
      source_user_id: 'user_viewer',
      signal_id: 'uls_1',
      target_profile_key: 'tenant-defaults',
      promotion_payload: { shared_defaults: { meeting_summary: 'bullet-first' } },
      approval_ref: 'approval://tenant-learning',
    };
    const viewer = await request('POST', '/template-policy/personalization/promotions', VIEWER, body);
    const owner = await request('POST', '/template-policy/personalization/promotions', OWNER, body);
    expect(viewer.res.status).toBe(403);
    expect(owner.res.status).toBe(201);
    expect(viewer.calls).toEqual([]);
    expect(owner.calls[0]).toMatchObject({ method: 'createTenantLearningPromotion', actor: 'user_owner' });
  });
});
