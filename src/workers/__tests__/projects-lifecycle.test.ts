// projects-lifecycle.test.ts · authority-grade project rename and soft archive.

import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { projectsRoute } from '../routes/projects';

const ENV = { MBP_OWNER_USER_ID: 'user_op', DATABASE_URL: 'x' };
const OPERATOR = { user_id: 'user_op', role: 'operator', workspace_id: 'mbp-private' };

function mutationReceipt(kind: 'update' | 'archive', replayed = false) {
  return {
    project: {
      id: 'proj_1', workspace_id: 'mbp-private', name: 'New project name',
      status: kind === 'archive' ? 'archived' : 'active', description: null,
      metadata: {}, scope_binding: null, scope_binding_updated_at: null,
      scope_binding_updated_by: null, parent_project_id: null,
      created_at: '2026-05-01T00:00:00.000Z', updated_at: '2026-08-02T00:00:00.000Z',
    },
    mutation_kind: kind,
    receipt_id: `project-${kind}:proj_1:42`,
    operation_event_id: `evt_project_${kind}`,
    audit_event_id: '42',
    projection_outbox_id: `out_project_${kind}`,
    read_model_watermark: '2026-08-02T00:00:00.000Z',
    replayed,
  };
}

function appFor(auth: Record<string, unknown>, dal: Record<string, unknown>) {
  const app = new Hono();
  app.use('*', async (ctx, next) => {
    ctx.set('request_id', 'req_test');
    ctx.set('auth', auth as never);
    ctx.set('dal', dal as never);
    await next();
  });
  app.route('/api/v1', projectsRoute);
  return app;
}

function request(
  method: 'PATCH' | 'DELETE',
  auth: Record<string, unknown>,
  dal: Record<string, unknown>,
  body?: Record<string, unknown>,
  key = 'project-lifecycle-1',
) {
  return appFor(auth, dal).request('/api/v1/projects/proj_1', {
    method,
    headers: {
      'content-type': 'application/json',
      ...(key ? { 'Idempotency-Key': key } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  }, ENV as never);
}

describe('PATCH /projects/:id authority update', () => {
  it('requires an idempotency key before invoking the DAL', async () => {
    const mutateProjectWithAuthority = vi.fn();
    const response = await request('PATCH', OPERATOR, { mutateProjectWithAuthority }, { name: 'New name' }, '');
    expect(response.status).toBe(428);
    expect(mutateProjectWithAuthority).not.toHaveBeenCalled();
    expect(await response.json()).toMatchObject({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
  });

  it('renames through one authority command and returns every durable reference', async () => {
    const mutateProjectWithAuthority = vi.fn(async () => mutationReceipt('update'));
    const response = await request('PATCH', OPERATOR, { mutateProjectWithAuthority }, { name: ' New project name ' });
    expect(response.status).toBe(200);
    expect(mutateProjectWithAuthority).toHaveBeenCalledTimes(1);
    const [input, actor, idempotency] = mutateProjectWithAuthority.mock.calls[0]!;
    expect(input).toEqual({
      workspace_id: 'mbp-private', project_id: 'proj_1', mutation_kind: 'update',
      patch: { name: 'New project name' },
    });
    expect(actor).toBe('user_op');
    expect(idempotency).toMatchObject({
      key: 'project-lifecycle-1', route: 'PATCH /api/v1/projects/:id', request_id: 'req_test',
    });
    expect(idempotency.request_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(await response.json()).toMatchObject({
      project: { name: 'New project name' },
      receipt_id: 'project-update:proj_1:42',
      operation_event_id: 'evt_project_update',
      audit_event_id: '42',
      projection_outbox_id: 'out_project_update',
      replayed: false,
    });
  });

  it('marks an exact replay without changing the response contract', async () => {
    const mutateProjectWithAuthority = vi.fn(async () => mutationReceipt('update', true));
    const response = await request('PATCH', OPERATOR, { mutateProjectWithAuthority }, { description: 'Updated' });
    expect(response.status).toBe(200);
    expect(response.headers.get('Idempotency-Replayed')).toBe('true');
    expect(await response.json()).toMatchObject({ replayed: true });
  });

  it('rejects empty, invalid, and unauthorized changes before authority execution', async () => {
    for (const [body, auth, status] of [
      [{}, OPERATOR, 400],
      [{ status: 'banana' }, OPERATOR, 400],
      [{ name: 'x' }, { ...OPERATOR, role: 'client' }, 403],
      [{ name: 'x' }, { ...OPERATOR, role: 'member' }, 403],
    ] as const) {
      const mutateProjectWithAuthority = vi.fn();
      const response = await request('PATCH', auth, { mutateProjectWithAuthority }, body);
      expect(response.status).toBe(status);
      expect(mutateProjectWithAuthority).not.toHaveBeenCalled();
    }
  });

  it('preserves a fail-closed missing-target response', async () => {
    const missing = Object.assign(new Error('project proj_1 not found'), { code: 'NOT_FOUND', status: 404 });
    const response = await request('PATCH', OPERATOR, {
      mutateProjectWithAuthority: vi.fn(async () => { throw missing; }),
    }, { name: 'Missing' });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('DELETE /projects/:id authority archive', () => {
  it('requires an idempotency key before invoking the DAL', async () => {
    const mutateProjectWithAuthority = vi.fn();
    const response = await request('DELETE', OPERATOR, { mutateProjectWithAuthority }, undefined, '');
    expect(response.status).toBe(428);
    expect(mutateProjectWithAuthority).not.toHaveBeenCalled();
  });

  it('soft-archives through one authority command', async () => {
    const mutateProjectWithAuthority = vi.fn(async () => mutationReceipt('archive'));
    const response = await request('DELETE', OPERATOR, { mutateProjectWithAuthority });
    expect(response.status).toBe(200);
    const [input, actor, idempotency] = mutateProjectWithAuthority.mock.calls[0]!;
    expect(input).toEqual({
      workspace_id: 'mbp-private', project_id: 'proj_1', mutation_kind: 'archive',
      patch: { status: 'archived' },
    });
    expect(actor).toBe('user_op');
    expect(idempotency).toMatchObject({ key: 'project-lifecycle-1', route: 'DELETE /api/v1/projects/:id' });
    expect(await response.json()).toMatchObject({
      project: { status: 'archived' }, mutation_kind: 'archive',
      receipt_id: 'project-archive:proj_1:42', replayed: false,
    });
  });

  it('rejects unauthorized callers and preserves missing-target errors', async () => {
    const mutateProjectWithAuthority = vi.fn();
    const forbidden = await request('DELETE', { ...OPERATOR, role: 'client' }, { mutateProjectWithAuthority });
    expect(forbidden.status).toBe(403);
    expect(mutateProjectWithAuthority).not.toHaveBeenCalled();

    const missing = Object.assign(new Error('project proj_1 not found'), { code: 'NOT_FOUND', status: 404 });
    const absent = await request('DELETE', OPERATOR, {
      mutateProjectWithAuthority: vi.fn(async () => { throw missing; }),
    });
    expect(absent.status).toBe(404);
  });
});
