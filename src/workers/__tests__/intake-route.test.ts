import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { intakeRoute } from '../routes/intake';

const AUTH = { user_id: 'user_a', workspace_id: 'tenant_a', role: 'owner' };

function appFor(opts: { enabled?: boolean; packets?: any[]; approvals?: any[]; auth?: Record<string, unknown> } = {}) {
  const calls: Array<Record<string, unknown>> = [];
  const dal = {
    listTaskPackets: async (workspace_id: string) => { calls.push({ method: 'listTaskPackets', workspace_id }); return opts.packets ?? []; },
    listApprovalRequests: async (workspace_id: string) => { calls.push({ method: 'listApprovalRequests', workspace_id }); return opts.approvals ?? []; },
    createIntakeResolution: async (workspace_id: string, actor_user_id: string, input: any) => {
      calls.push({ method: 'createIntakeResolution', workspace_id, actor_user_id, input });
      return { id: 'inr_1', workspace_id, actor_user_id, version: 1, status: 'pending', consumed_at: null, created_at: '2026-07-15T00:00:00Z', ...input };
    },
    executeIntakeResolution: async (workspace_id: string, actor_user_id: string, id: string, version: number, current_work_version: number, client_request_id: string, closing: any) => {
      calls.push({ method: 'executeIntakeResolution', workspace_id, actor_user_id, id, version, current_work_version, client_request_id, closing });
      return { ok: true, resolution: { id }, receipt: { id: 'ger_1', target_id: 'pkt_1' }, packet_id: 'pkt_1' };
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

  it('requires immutable resolution and current-work versions to execute', async () => {
    const { app, calls, env } = appFor({ enabled: true });
    const bad = await app.request('/api/v1/intake/inr_1/execute', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }, env);
    expect(bad.status).toBe(400);
    const ok = await app.request('/api/v1/intake/inr_1/execute', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ version: 1, current_work_version: 3, client_request_id: 'exec_1' }),
    }, env);
    expect(ok.status).toBe(200);
    expect(calls.at(-1)).toMatchObject({
      method: 'executeIntakeResolution', workspace_id: 'tenant_a', actor_user_id: 'user_a', id: 'inr_1',
      version: 1, current_work_version: 3, client_request_id: 'exec_1',
      closing: { role_key: 'role.workspace.owner', closing_skill: 'skill.governed-execution-closeout', outcome: 'attested' },
    });
    expect((calls.at(-1) as any).closing.content_sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  // W.2 two-tier ruling (260720): execute ADVANCES governed state -> spine-gated (owner/operator).
  // RED control for the role-gap find: viewer/client previously could execute with no role check.
  it('denies viewer and client execution of a governed intake (403, no dal call)', async () => {
    for (const role of ['viewer', 'client']) {
      const { app, calls, env } = appFor({ enabled: true, auth: { ...AUTH, role } });
      const res = await app.request('/api/v1/intake/inr_1/execute', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ version: 1, current_work_version: 3, client_request_id: `exec_${role}` }),
      }, env);
      expect(res.status).toBe(403);
      expect(calls.some((c: any) => c.method === 'executeIntakeResolution')).toBe(false);
    }
  });
});
