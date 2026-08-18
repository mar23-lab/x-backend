import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { intakeRoute } from '../routes/intake';
import { WorkersDalAdapter } from '../dal/WorkersDalAdapter';
import { neonClient } from '../db/client';

const AUTH = { user_id: 'user_a', workspace_id: 'tenant_a', role: 'owner' };

function appFor(opts: { enabled?: boolean; packets?: any[]; approvals?: any[]; projects?: any[]; documents?: any[]; auth?: Record<string, unknown>; createError?: Error } = {}) {
  const calls: Array<Record<string, unknown>> = [];
  const dal = {
    listTaskPackets: async (workspace_id: string) => { calls.push({ method: 'listTaskPackets', workspace_id }); return opts.packets ?? []; },
    listApprovalRequests: async (workspace_id: string) => { calls.push({ method: 'listApprovalRequests', workspace_id }); return opts.approvals ?? []; },
    listProjects: async (workspace_id: string) => { calls.push({ method: 'listProjects', workspace_id }); return opts.projects ?? []; },
    listDocumentsByIds: async (workspace_id: string, ids: string[]) => {
      calls.push({ method: 'listDocumentsByIds', workspace_id, ids });
      return opts.documents ?? [];
    },
    createIntakeResolution: async (workspace_id: string, actor_user_id: string, input: any) => {
      calls.push({ method: 'createIntakeResolution', workspace_id, actor_user_id, input });
      if (opts.createError) throw opts.createError;
      return { id: 'inr_1', workspace_id, actor_user_id, version: 1, status: 'pending', consumed_at: null, created_at: '2026-07-15T00:00:00Z', ...input };
    },
    executeIntakeResolution: async (
      workspace_id: string,
      actor_user_id: string,
      id: string,
      version: number,
      current_work_version: number,
      client_request_id: string,
      interaction_id: string,
      thread_id: string | null,
      closing: any,
    ) => {
      calls.push({ method: 'executeIntakeResolution', workspace_id, actor_user_id, id, version, current_work_version, client_request_id, interaction_id, thread_id, closing });
      return {
        ok: true,
        resolution: { id },
        receipt: { id: 'ger_1', target_id: 'pkt_1' },
        packet_id: 'pkt_1',
        read_model_watermark: '2026-07-27T00:00:00Z',
      };
    },
  };
  const app = new Hono();
  app.use('*', async (ctx, next) => {
    ctx.set('request_id', 'req_test');
    ctx.set('auth', (opts.auth ?? AUTH) as never);
    ctx.set('dal', dal as never);
    await next();
  });
  app.route('/api/v1', intakeRoute);
  return { app, calls, env: { DATABASE_URL: 'x', SINGLE_INTAKE_ENABLED: opts.enabled ? 'true' : 'false' } };
}

describe('single intake route', () => {
  it('fails closed while the feature is not explicitly enabled', async () => {
    const { app, calls, env } = appFor();
    const res = await app.request('/api/v1/intake/resolve', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'What changed?', client_request_id: 'c1' }) }, env);
    expect(res.status).toBe(404);
    expect(calls).toEqual([]);
  });

  it('derives tenant and actor only from authenticated context', async () => {
    const { app, calls, env } = appFor({ enabled: true });
    const res = await app.request('/api/v1/intake/resolve', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Create a task to verify Gmail sync', client_request_id: 'c2', workspace_id: 'tenant_b', actor_user_id: 'forged' }),
    }, env);
    expect(res.status).toBe(201);
    expect(calls.at(-1)).toMatchObject({ method: 'createIntakeResolution', workspace_id: 'tenant_a', actor_user_id: 'user_a' });
    const input = (calls.at(-1) as any).input;
    expect(input.role_label).toBe('Workspace owner');
    expect(input.prior_work).toMatchObject({ discovery_executed: true, active_work_count: 0, pending_approval_count: 0 });
    expect(input.prior_work.digest_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(input.guardrails).toContain('tenant_and_workspace_scope_required');
    expect(input.interaction_id).toBe('c2');
  });

  it('preserves commercial role labels instead of collapsing operators and admins to viewer', async () => {
    const cases = [
      ['owner', 'Workspace owner'],
      ['operator', 'Workspace operator'],
      ['admin', 'Workspace admin'],
      ['member', 'Workspace member'],
      ['viewer', 'Workspace viewer'],
      ['client', 'Workspace client'],
    ];
    for (const [role, label] of cases) {
      const { app, calls, env } = appFor({ enabled: true, auth: { ...AUTH, role } });
      const res = await app.request('/api/v1/intake/resolve', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: `Create a task as ${role}`, client_request_id: `role-${role}` }),
      }, env);
      expect(res.status).toBe(201);
      expect((calls.at(-1) as any).input.role_label).toBe(label);
    }
  });

  it('binds exact document references into the persisted summary and request digest', async () => {
    const doc = {
      id: 'doc_1', workspace_id: 'tenant_a', project_id: null, filename: 'brief.txt',
      content_type: 'text/plain', size_bytes: 20, extracted_text: 'Pilot scope', uploaded_by: 'user_a',
      uploaded_at: '2026-08-02T00:00:00Z', status: 'recorded', admissibility: 'approved',
      content_hash: 'a'.repeat(64), version: 1, supersedes_id: null,
    };
    const first = appFor({ enabled: true, documents: [doc] });
    const response = await first.app.request('/api/v1/intake/resolve', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: 'What does this document say?', client_request_id: 'doc-context-1',
        context_refs: [{ kind: 'document', id: 'doc_1' }],
      }),
    }, first.env);
    expect(response.status).toBe(201);
    const input = (first.calls.at(-1) as any).input;
    expect(input.context_summary).toEqual({
      reference_count: 1, source_count: 0, evidence_count: 1, document_ids: ['doc_1'],
    });
    expect(input.request_digest).toMatch(/^[a-f0-9]{64}$/);

    const second = appFor({ enabled: true, documents: [{ ...doc, id: 'doc_2' }] });
    await second.app.request('/api/v1/intake/resolve', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: 'What does this document say?', client_request_id: 'doc-context-1',
        context_refs: [{ kind: 'document', id: 'doc_2' }],
      }),
    }, second.env);
    expect((second.calls.at(-1) as any).input.request_digest).not.toBe(input.request_digest);
  });

  it('does not persist a resolution when a selected document is unavailable', async () => {
    const { app, calls, env } = appFor({ enabled: true, documents: [] });
    const response = await app.request('/api/v1/intake/resolve', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: 'Use this document.', client_request_id: 'doc-missing',
        context_refs: [{ kind: 'document', id: 'doc_missing' }],
      }),
    }, env);
    expect(response.status).toBe(409);
    expect(calls.some((call) => call.method === 'createIntakeResolution')).toBe(false);
  });

  it('fails closed when a context kind has no exact grounding loader', async () => {
    const { app, calls, env } = appFor({ enabled: true });
    const response = await app.request('/api/v1/intake/resolve', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: 'Use this source.', client_request_id: 'source-not-grounded',
        context_refs: [{ kind: 'source', id: 'source_1' }],
      }),
    }, env);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: 'VALIDATION_ERROR',
      error: 'single intake currently supports document context references only',
    });
    expect(calls.some((call) => call.method === 'createIntakeResolution')).toBe(false);
  });

  it('preserves the stable request-id conflict code on the wire', async () => {
    const conflict = Object.assign(
      new Error('client_request_id was already used for different intake input'),
      { code: 'INTAKE_REQUEST_ID_CONFLICT', status: 409 },
    );
    const { app, env } = appFor({ enabled: true, createError: conflict });
    const response = await app.request('/api/v1/intake/resolve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'What changed?', client_request_id: 'reused' }),
    }, env);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: 'INTAKE_REQUEST_ID_CONFLICT',
      error: 'client_request_id was already used for different intake input',
    });
  });

  it('emits stage-only failure diagnostics without logging customer input', async () => {
    const conflict = Object.assign(
      new Error('sensitive database detail'),
      { code: 'INTAKE_REQUEST_ID_CONFLICT', status: 409 },
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { app, env } = appFor({ enabled: true, createError: conflict });
      const response = await app.request('/api/v1/intake/resolve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          text: 'PRIVATE CUSTOMER PROMPT MUST NOT APPEAR IN LOGS',
          client_request_id: 'diagnostic-conflict',
        }),
      }, env);
      expect(response.status).toBe(409);
      expect(warn).toHaveBeenCalledTimes(1);
      const event = JSON.parse(String(warn.mock.calls[0]?.[0]));
      expect(event).toEqual({
        evt: 'intake.resolve.failure',
        stage: 'persist_resolution',
        request_id: 'req_test',
        code: 'INTAKE_REQUEST_ID_CONFLICT',
        status: 409,
      });
      expect(String(warn.mock.calls[0]?.[0])).not.toContain('PRIVATE CUSTOMER PROMPT');
      expect(String(warn.mock.calls[0]?.[0])).not.toContain('sensitive database detail');
    } finally {
      warn.mockRestore();
    }
  });

  it('requires immutable resolution and current-work versions to execute', async () => {
    const { app, calls, env } = appFor({ enabled: true });
    const bad = await app.request('/api/v1/intake/inr_1/execute', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }, env);
    expect(bad.status).toBe(400);
    const ok = await app.request('/api/v1/intake/inr_1/execute', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        version: 1,
        current_work_version: 3,
        client_request_id: 'exec_1',
        interaction_id: 'interaction_1',
        thread_id: 'thr_project_thread_1',
      }),
    }, env);
    expect(ok.status).toBe(200);
    expect(calls.at(-1)).toMatchObject({
      method: 'executeIntakeResolution', workspace_id: 'tenant_a', actor_user_id: 'user_a', id: 'inr_1',
      version: 1, current_work_version: 3, client_request_id: 'exec_1',
      interaction_id: 'interaction_1',
      thread_id: 'thr_project_thread_1',
      closing: { role_key: 'role.workspace.owner', closing_skill: 'skill.governed-execution-closeout', outcome: 'attested' },
    });
    expect((calls.at(-1) as any).closing.content_sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects a non-canonical conversation thread before execution', async () => {
    const { app, calls, env } = appFor({ enabled: true });
    const response = await app.request('/api/v1/intake/inr_1/execute', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        version: 1,
        current_work_version: 3,
        client_request_id: 'exec_bad_thread',
        interaction_id: 'interaction_bad_thread',
        thread_id: 'local-browser-thread',
      }),
    }, env);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: 'VALIDATION_ERROR',
      error: 'thread_id must identify a canonical chat thread',
    });
    expect(calls.some((call) => call.method === 'executeIntakeResolution')).toBe(false);
  });

  // W.2 two-tier ruling (260720): execute ADVANCES governed state -> spine-gated (owner/operator).
  // RED control for the role-gap find: viewer/client previously could execute with no role check.
  it('denies viewer and client execution of a governed intake (403, no dal call)', async () => {
    for (const role of ['viewer', 'client']) {
      const { app, calls, env } = appFor({ enabled: true, auth: { ...AUTH, role } });
      const res = await app.request('/api/v1/intake/inr_1/execute', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          current_work_version: 3,
          client_request_id: `exec_${role}`,
          interaction_id: `interaction_${role}`,
        }),
      }, env);
      expect(res.status).toBe(403);
      expect(calls.some((c: any) => c.method === 'executeIntakeResolution')).toBe(false);
    }
  });
});

const runLiveRlsRouteProbe = process.env.XLOOOP_RUN_INTAKE_RLS_LIVE === '1';
const describeLiveRlsRoute = runLiveRlsRouteProbe ? describe : describe.skip;

describeLiveRlsRoute('single-intake live route through RLS', () => {
  it('returns a persisted resolution for a fresh authenticated read request', async () => {
    const appDatabaseUrl = process.env.XLOOOP_RLS_APP_DATABASE_URL;
    const ownerDatabaseUrl = process.env.DATABASE_URL;
    const workspaceId = process.env.XLOOOP_LIVE_WORKSPACE_ID;
    const actorUserId = process.env.XLOOOP_LIVE_ACTOR_USER_ID;
    if (!appDatabaseUrl || !ownerDatabaseUrl || !workspaceId || !actorUserId) {
      throw new Error('live intake route probe requires app/owner DSNs plus workspace and actor ids');
    }

    const ownerSql = neonClient(ownerDatabaseUrl);
    const appSql = neonClient(appDatabaseUrl);
    const clientRequestId = crypto.randomUUID();
    const app = new Hono();
    app.use('*', async (ctx, next) => {
      ctx.set('request_id', 'intake-live-route-probe');
      ctx.set('auth', { user_id: actorUserId, workspace_id: workspaceId, role: 'owner' } as never);
      ctx.set('sql', ownerSql as never);
      ctx.set('dal', new WorkersDalAdapter(ownerSql, appSql) as never);
      await next();
    });
    app.route('/api/v1', intakeRoute);

    try {
      const response = await app.request('/api/v1/intake/resolve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          text: 'What is currently waiting on me? Answer only; do not change work.',
          client_request_id: clientRequestId,
          project_id: null,
          context_refs: [],
        }),
      }, {
        DATABASE_URL: ownerDatabaseUrl,
        SINGLE_INTAKE_ENABLED: 'true',
        ENTITLEMENT_ENFORCEMENT: 'on',
      });
      const body = await response.clone().json() as { resolution?: { client_request_id?: string }; error?: unknown; code?: string };
      expect({ status: response.status, body }).toMatchObject({
        status: 201,
        body: { resolution: { client_request_id: clientRequestId } },
      });
    } finally {
      await ownerSql`
        DELETE FROM intake_resolutions
         WHERE workspace_id = ${workspaceId}
           AND actor_user_id = ${actorUserId}
           AND client_request_id = ${clientRequestId}
      `;
    }
  });
});
