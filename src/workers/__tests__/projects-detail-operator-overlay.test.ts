// projects-detail-operator-overlay.test.ts · R53-W4.x
//
// Route tests for the operator overlay on the per-project ROUTES that previously
// 404'd an owned project living outside the JWT workspace:
//   GET /projects/:id · PATCH /projects/:id/scope · PATCH /projects/:id ·
//   DELETE /projects/:id · GET/POST /projects/:id/sources
//
// The bug: a project the operator OWNS (e.g. mbp-life in mbp-private) 404'd because
// the route looked it up under the JWT workspace (the operator's active Clerk org),
// not the project's real workspace — surfacing as the scope-binding panel's
// "project <id> not found" diagnostic + an empty per-project view. The fix:
// resolveOperatorProjectWorkspace() resolves the project's REAL workspace via the
// operator identity set (gated on user_id === MBP_OWNER_USER_ID), then the strict
// DAL call addresses that workspace. Non-owners + a not-found overlay fall through
// to the JWT workspace — no behaviour change for any other caller.
//
// Mocks the DAL (ctx.set) so the suite never imports WorkersDalAdapter (same pattern
// as projects-events-operator-overlay.test.ts).

import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { projectsRoute } from '../routes/projects';

const MBP_OWNER = 'user_op';
const JWT_WS = 'aps-pty-ltd';          // the operator's active Clerk org
const REAL_WS = 'mbp-private';          // where the owned project actually lives
const ENV = { MBP_OWNER_USER_ID: MBP_OWNER, MBP_OWNER_LINKED_USER_IDS: '', DATABASE_URL: 'x' };

type ForOpCall = { ids: string[]; projectId: string };
type GetCall = { ws: string; projectId: string };

function mockDal(forOp: ForOpCall[], gets: GetCall[], opts: { operatorResolvesTo?: string | null } = {}) {
  const resolvesTo = 'operatorResolvesTo' in opts ? opts.operatorResolvesTo : REAL_WS;
  return {
    // the new operator-overlay resolver source — returns the project's REAL workspace
    getProjectForOperator: async (ids: string[], projectId: string) => {
      forOp.push({ ids, projectId });
      return resolvesTo ? { id: projectId, workspace_id: resolvesTo } : null;
    },
    // strict workspace-scoped getter — records which workspace it was asked for
    getProject: async (ws: string, projectId: string) => {
      gets.push({ ws, projectId });
      // 404 only when asked for the WRONG (JWT) workspace — mirrors prod where the
      // project does not exist under the operator's active org.
      return ws === REAL_WS ? { id: projectId, workspace_id: ws, name: 'P', scope_binding: null } : null;
    },
  };
}

function appFor(auth: Record<string, unknown>, forOp: ForOpCall[], gets: GetCall[], opts = {}) {
  const app = new Hono();
  app.use('*', async (ctx, next) => {
    ctx.set('request_id', 'test');
    ctx.set('auth', auth as never);
    ctx.set('dal', mockDal(forOp, gets, opts) as never);
    await next();
  });
  app.route('/api/v1', projectsRoute);
  return app;
}

function getDetail(auth: Record<string, unknown>, projectId: string, opts = {}) {
  const forOp: ForOpCall[] = [];
  const gets: GetCall[] = [];
  const app = appFor(auth, forOp, gets, opts);
  return app
    .request(`/api/v1/projects/${projectId}`, { method: 'GET' }, ENV as never)
    .then((res) => ({ res, forOp, gets }));
}

describe('GET /projects/:id · operator overlay (R53-W4.x)', () => {
  it('operator → resolves the REAL workspace; getProject addresses it; 200 (no 404)', async () => {
    const { res, forOp, gets } = await getDetail(
      { user_id: MBP_OWNER, role: 'operator', workspace_id: JWT_WS },
      'mbp-life',
    );
    expect(res.status).toBe(200);
    expect(forOp).toHaveLength(1);
    expect(forOp[0]!.ids).toEqual([MBP_OWNER]);
    expect(forOp[0]!.projectId).toBe('mbp-life');
    // the strict getter was addressed at the RESOLVED workspace, not the JWT org
    expect(gets[gets.length - 1]!.ws).toBe(REAL_WS);
  });

  it('non-operator → overlay NOT taken; getProject scoped to the JWT workspace', async () => {
    const { res, forOp, gets } = await getDetail(
      { user_id: 'user_member', role: 'operator', workspace_id: JWT_WS },
      'aps-website',
    );
    // member's project genuinely lives in their JWT ws in this mock → 404 here is
    // expected (mock only "exists" in REAL_WS); the POINT is the overlay was skipped.
    expect(forOp).toHaveLength(0);
    expect(gets).toHaveLength(1);
    expect(gets[0]!.ws).toBe(JWT_WS);
    expect(res.status).toBe(404);
  });

  it('operator but overlay finds nothing → falls through to JWT workspace (still 404)', async () => {
    const { res, forOp, gets } = await getDetail(
      { user_id: MBP_OWNER, role: 'operator', workspace_id: JWT_WS },
      'ghost-project',
      { operatorResolvesTo: null },
    );
    expect(forOp).toHaveLength(1);                 // overlay attempted
    expect(gets[gets.length - 1]!.ws).toBe(JWT_WS); // then fell through to JWT ws
    expect(res.status).toBe(404);
  });

  it('client role → 403 even for the operator (role gate unchanged)', async () => {
    const { res, forOp, gets } = await getDetail(
      { user_id: MBP_OWNER, role: 'client', workspace_id: JWT_WS },
      'mbp-life',
    );
    expect(res.status).toBe(403);
    expect(forOp).toHaveLength(0);
    expect(gets).toHaveLength(0);
  });
});
