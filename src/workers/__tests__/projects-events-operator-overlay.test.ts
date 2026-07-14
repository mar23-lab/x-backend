// projects-events-operator-overlay.test.ts · R53-W4 (Phase 1)
//
// Route tests for the operator overlay on GET /api/v1/projects/:id/events.
// A project the operator OWNS can live in a workspace that is NOT their active
// Clerk org (e.g. x-docs, mbp-private). The strict path scopes to the JWT
// workspace, so that owned project's events return empty / 404 — the gate that
// blocks the per-project cockpit view. For the VERIFIED platform owner only, the
// overlay lists events by the operator IDENTITY SET via listEventsForOperator
// (resolving the owner's OWN workspaces INSIDE the DAL), filtered to project_id.
// Every other caller keeps the strict workspace-scoped listEventsForProjectScope
// path — no behaviour change.
//
// Mocks the DAL (ctx.set) so the suite never imports WorkersDalAdapter (avoids the
// snakecase-keys CJS/ESM collection issue other adapter-importing suites hit) —
// same pattern as events-operator-write-overlay.test.ts and projects-lifecycle.test.ts.

import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { projectsRoute } from '../routes/projects';

const MBP_OWNER = 'user_op';
const ENV = { MBP_OWNER_USER_ID: MBP_OWNER, MBP_OWNER_LINKED_USER_IDS: '', DATABASE_URL: 'x' };

type OperatorCall = { ids: string[]; opts: Record<string, unknown> };
type ScopeCall = { ws: string; projectId: string; opts: Record<string, unknown> };

const EMPTY_PAGE = { events: [], pagination: { has_more: false, next_before: null } };

function mockDal(operatorCalls: OperatorCall[], scopeCalls: ScopeCall[]) {
  return {
    // operator-overlay path (widens scope to the owner's linked workspaces)
    listEventsForOperator: async (ids: string[], opts: Record<string, unknown>) => {
      operatorCalls.push({ ids, opts });
      return EMPTY_PAGE;
    },
    // strict workspace-scoped path for everyone else
    listEventsForProjectScope: async (ws: string, projectId: string, opts: Record<string, unknown>) => {
      scopeCalls.push({ ws, projectId, opts });
      return EMPTY_PAGE;
    },
  };
}

function appFor(auth: Record<string, unknown>, operatorCalls: OperatorCall[], scopeCalls: ScopeCall[]) {
  const app = new Hono();
  app.use('*', async (ctx, next) => {
    ctx.set('request_id', 'test');
    ctx.set('auth', auth as never);
    ctx.set('dal', mockDal(operatorCalls, scopeCalls) as never);
    await next();
  });
  app.route('/api/v1', projectsRoute);
  return app;
}

function get(auth: Record<string, unknown>, projectId: string, query = '') {
  const operatorCalls: OperatorCall[] = [];
  const scopeCalls: ScopeCall[] = [];
  const app = appFor(auth, operatorCalls, scopeCalls);
  return app
    .request(`/api/v1/projects/${projectId}/events${query}`, { method: 'GET' }, ENV as never)
    .then((res) => ({ res, operatorCalls, scopeCalls }));
}

describe('GET /projects/:id/events · operator overlay (R53-W4 Phase 1)', () => {
  it('operator user_id → listEventsForOperator called with project_id; strict path NOT taken', async () => {
    // operator active org = workspace A, but project x-docs-readme lives in
    // workspace x-docs which the operator OWNS but is not their active org.
    const { res, operatorCalls, scopeCalls } = await get(
      { user_id: MBP_OWNER, role: 'operator', workspace_id: 'aps-pty-ltd' },
      'x-docs-readme',
    );
    expect(res.status).toBe(200);
    expect(operatorCalls).toHaveLength(1);
    expect(operatorCalls[0]!.ids).toEqual([MBP_OWNER]);
    expect(operatorCalls[0]!.opts.project_id).toBe('x-docs-readme');
    expect(scopeCalls).toHaveLength(0); // strict workspace-scoped path bypassed
  });

  it('operator with MBP_OWNER_LINKED_USER_IDS → operator id set widens; project_id preserved', async () => {
    const operatorCalls: OperatorCall[] = [];
    const scopeCalls: ScopeCall[] = [];
    const app = appFor(
      { user_id: MBP_OWNER, role: 'operator', workspace_id: 'aps-pty-ltd' },
      operatorCalls,
      scopeCalls,
    );
    const res = await app.request(
      '/api/v1/projects/mbp-ops/events',
      { method: 'GET' },
      { ...ENV, MBP_OWNER_LINKED_USER_IDS: 'user_op_org, user_op_gov' } as never,
    );
    expect(res.status).toBe(200);
    expect(operatorCalls).toHaveLength(1);
    expect(operatorCalls[0]!.ids).toEqual([MBP_OWNER, 'user_op_org', 'user_op_gov']);
    expect(operatorCalls[0]!.opts.project_id).toBe('mbp-ops');
    expect(scopeCalls).toHaveLength(0);
  });

  it('non-operator user → unchanged workspace-scoped listEventsForProjectScope path', async () => {
    const { res, operatorCalls, scopeCalls } = await get(
      { user_id: 'user_member', role: 'operator', workspace_id: 'aps-pty-ltd' },
      'aps-website',
    );
    expect(res.status).toBe(200);
    expect(scopeCalls).toHaveLength(1);
    expect(scopeCalls[0]!.ws).toBe('aps-pty-ltd');
    expect(scopeCalls[0]!.projectId).toBe('aps-website');
    expect(operatorCalls).toHaveLength(0); // overlay NOT taken for non-operator
  });

  it('client role → 403 even for the operator (role gate unchanged)', async () => {
    const { res, operatorCalls, scopeCalls } = await get(
      { user_id: MBP_OWNER, role: 'client', workspace_id: 'aps-pty-ltd' },
      'x-docs-readme',
    );
    expect(res.status).toBe(403);
    expect(operatorCalls).toHaveLength(0);
    expect(scopeCalls).toHaveLength(0);
  });

  it('operator → limit query param flows through to the overlay opts', async () => {
    const { res, operatorCalls } = await get(
      { user_id: MBP_OWNER, role: 'operator', workspace_id: 'aps-pty-ltd' },
      'x-docs-readme',
      '?limit=25',
    );
    expect(res.status).toBe(200);
    expect(operatorCalls[0]!.opts.limit).toBe(25);
    expect(operatorCalls[0]!.opts.project_id).toBe('x-docs-readme');
  });
});
