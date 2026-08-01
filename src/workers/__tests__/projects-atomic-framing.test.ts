import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { createProjectWithAuthorityRow } from '../dal/project-command-store';
import { projectsRoute } from '../routes/projects';
import type { Sql } from '../db/client';

const AUTH = { user_id: 'user_owner', role: 'owner', workspace_id: 'ws_owner' };
const ENV = { DATABASE_URL: 'unused' };

function projectReceipt(replayed = false) {
  return {
    project: {
      id: 'proj_atomic', workspace_id: 'ws_owner', name: 'Atomic project', status: 'active',
      description: null, metadata: {}, scope_binding: null, scope_binding_updated_at: null,
      scope_binding_updated_by: null, parent_project_id: null,
      created_at: '2026-08-01T00:00:00.000Z', updated_at: '2026-08-01T00:00:00.000Z',
    },
    initial_goal: null,
    source_bindings: [],
    receipt_id: 'project-create:proj_atomic:42',
    operation_event_id: 'evt_atomic',
    audit_event_id: '42',
    projection_outbox_id: 'out_atomic',
    read_model_watermark: '2026-08-01T00:00:00.000Z',
    replayed,
  };
}

function routeApp(dal: Record<string, unknown>) {
  const app = new Hono();
  app.use('*', async (ctx, next) => {
    ctx.set('request_id', 'req_test');
    ctx.set('auth', AUTH as never);
    ctx.set('dal', dal as never);
    await next();
  });
  app.route('/api/v1', projectsRoute);
  return app;
}

describe('POST /projects strict authority route', () => {
  it('fails with 428 before any write when Idempotency-Key is absent', async () => {
    const createProjectWithAuthority = vi.fn();
    const response = await routeApp({ createProjectWithAuthority }).request('/api/v1/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'No key' }),
    }, ENV as never);
    expect(response.status).toBe(428);
    expect(createProjectWithAuthority).not.toHaveBeenCalled();
    expect(await response.json()).toMatchObject({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
  });

  it('sends project, goal, and source framing through one DAL command', async () => {
    const createProjectWithAuthority = vi.fn(async () => projectReceipt(false));
    const getUserSource = vi.fn(async () => ({
      id: 'usc_1', provider: 'github', workspace_id: 'ws_owner',
    }));
    const body = {
      name: ' Atomic project ',
      initial_goal: { title: ' First goal ' },
      source_bindings: [{
        source_kind: 'github_repo',
        user_source_connection_id: 'usc_1',
        source_ref: { label: 'owner/repo' },
        status: 'connected',
        read_policy: 'read_only',
      }],
    };
    const response = await routeApp({ createProjectWithAuthority, getUserSource }).request('/api/v1/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Idempotency-Key': 'project-frame-1' },
      body: JSON.stringify(body),
    }, ENV as never);
    expect(response.status).toBe(201);
    expect(createProjectWithAuthority).toHaveBeenCalledTimes(1);
    const [input, actor, idem] = createProjectWithAuthority.mock.calls[0]!;
    expect(input).toMatchObject({
      workspace_id: 'ws_owner',
      name: 'Atomic project',
      initial_goal: { title: 'First goal' },
      source_bindings: [{ user_source_connection_id: 'usc_1' }],
    });
    expect(actor).toBe('user_owner');
    expect(idem).toMatchObject({ key: 'project-frame-1', route: 'POST /api/v1/projects', request_id: 'req_test' });
    expect(idem.request_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(await response.json()).toMatchObject({ receipt_id: 'project-create:proj_atomic:42', replayed: false });
  });

  it('marks a strict replay without changing the success contract', async () => {
    const createProjectWithAuthority = vi.fn(async () => projectReceipt(true));
    const response = await routeApp({ createProjectWithAuthority }).request('/api/v1/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Idempotency-Key': 'project-frame-2' },
      body: JSON.stringify({ name: 'Atomic replay' }),
    }, ENV as never);
    expect(response.status).toBe(201);
    expect(response.headers.get('Idempotency-Replayed')).toBe('true');
    expect(await response.json()).toMatchObject({ replayed: true });
  });

  it('rejects an OAuth source that is not explicitly workspace-bound', async () => {
    const createProjectWithAuthority = vi.fn();
    const getUserSource = vi.fn(async () => ({ id: 'usc_1', provider: 'github', workspace_id: null }));
    const response = await routeApp({ createProjectWithAuthority, getUserSource }).request('/api/v1/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Idempotency-Key': 'project-frame-3' },
      body: JSON.stringify({
        name: 'Blocked source',
        source_bindings: [{
          source_kind: 'github_repo', user_source_connection_id: 'usc_1', status: 'connected',
        }],
      }),
    }, ENV as never);
    expect(response.status).toBe(409);
    expect(createProjectWithAuthority).not.toHaveBeenCalled();
    expect(await response.json()).toMatchObject({ code: 'SOURCE_WORKSPACE_BINDING_REQUIRED' });
  });
});

function sqlScript(responses: unknown[][], statements: string[]) {
  return ((strings: TemplateStringsArray) => {
    statements.push(strings.join(' '));
    return Promise.resolve(responses.shift() ?? []);
  }) as unknown as Sql;
}

describe('atomic project command store', () => {
  it('requires every authority result and stores the replay response in the same statement', async () => {
    const statements: string[] = [];
    const responseBody = projectReceipt(false);
    const receipt = await createProjectWithAuthorityRow(
      sqlScript([[{ response_body: responseBody }]], statements),
      {
        workspace_id: 'ws_owner', name: 'Atomic project',
        initial_goal: { title: 'First goal' },
        source_bindings: [{ source_kind: 'manual', status: 'disabled_preview' }],
      },
      'user_owner',
      { key: 'atomic-1', request_sha256: 'a'.repeat(64), route: 'POST /api/v1/projects' },
    );
    expect(receipt).toMatchObject({ project: { id: 'proj_atomic' }, replayed: false });
    expect(statements).toHaveLength(1);
    const statement = statements[0]!;
    for (const cte of [
      'existing_replay', 'command_envelope', 'strict_claim', 'project_written',
      'goal_written', 'source_connections_locked', 'source_eligibility', 'sources_written',
      'event_written', 'audit_written',
      'outbox_written', 'authority_result',
    ]) expect(statement).toContain(cte);
    expect(statement).toContain("mode = 'authority_strict'");
    expect(statement).toContain('response_status, response_body, completed_at');
    expect(statement).toContain('xlooop_assert_authority_complete');
    for (const authority of [
      'project_written', 'goal_written', 'sources_written', 'event_written',
      'audit_written', 'outbox_written',
    ]) expect(statement).toContain(`count(*) FROM ${authority}`);
    expect(statement).toContain('source_connections_locked AS MATERIALIZED');
    expect(statement).toContain('FROM user_source_connections connection');
    expect(statement).toContain('FOR SHARE');
    expect(statement).toContain("connection.provider = 'github'");
    expect(statement).toContain("connection.provider = 'google_drive'");
    expect(statement).toContain('connection.workspace_id =');
    expect(statement).toContain('connection.user_id =');
  });

  it('replays a completed matching digest without a second business write', async () => {
    const statements: string[] = [];
    const digest = 'b'.repeat(64);
    const receipt = await createProjectWithAuthorityRow(
      sqlScript([
        [],
        [{ request_sha256: digest, response_status: 201, response_body: projectReceipt(false) }],
      ], statements),
      { workspace_id: 'ws_owner', name: 'Replay project' },
      'user_owner',
      { key: 'atomic-2', request_sha256: digest, route: 'POST /api/v1/projects' },
    );
    expect(receipt.replayed).toBe(true);
    expect(statements).toHaveLength(2);
    expect(statements[1]).toContain('SELECT request_sha256, response_status, response_body');
  });

  it('rejects a reused key whose request digest changed', async () => {
    const statements: string[] = [];
    await expect(createProjectWithAuthorityRow(
      sqlScript([
        [],
        [{ request_sha256: 'c'.repeat(64), response_status: 201, response_body: projectReceipt(false) }],
      ], statements),
      { workspace_id: 'ws_owner', name: 'Changed request' },
      'user_owner',
      { key: 'atomic-3', request_sha256: 'd'.repeat(64), route: 'POST /api/v1/projects' },
    )).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED', status: 409 });
    expect(statements).toHaveLength(2);
  });

  it('cannot report success when the authority statement returns zero rows', async () => {
    const statements: string[] = [];
    const digest = 'e'.repeat(64);
    await expect(createProjectWithAuthorityRow(
      sqlScript([
        [],
        [{ request_sha256: digest, response_status: null, response_body: null }],
        [],
      ], statements),
      { workspace_id: 'ws_owner', name: 'No authority row' },
      'user_owner',
      { key: 'atomic-4', request_sha256: digest, route: 'POST /api/v1/projects' },
    )).rejects.toMatchObject({ code: 'PROJECT_ATOMICITY_FAILED', status: 500 });
    expect(statements).toHaveLength(3);
    expect(statements[2]).toContain('DELETE FROM idempotency_keys');
  });
});
