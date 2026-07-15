// operator-workspace-scope.test.ts · JA (260714) — the operator-scoped read workspace (flag-gated).
//
// PROVES THE SECURITY CONTRACT of OPERATOR_WORKSPACE_SCOPE_ENABLED on BOTH surfaces that diverged
// (current-work projection · customer-chat):
//   (a) flag OFF (default) → the scope is ALWAYS auth.workspace_id even if a workspace_id is supplied
//       (byte-identical to today; the authz helper is never even consulted).
//   (b) flag ON + requested === auth → auth.workspace_id (unchanged).
//   (c) flag ON + requested != auth AND caller owns/member (userCanScopeWorkspace → true) → requested ws.
//   (d) flag ON + requested != auth AND NOT owner/member (→ false) → HARD 403 FORBIDDEN, and NEITHER
//       workspace's events are read (no silent fall-back to the token org).

import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { currentWorkRoute } from '../routes/current-work';
import { customerChatRoute } from '../routes/customer-chat';
import { resolveScopedWorkspace } from '../lib/operator-workspace-scope';

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// current-work · GET /current-work?workspace_id=
// ─────────────────────────────────────────────────────────────────────────────────────────────────
const CW_AUTH = { user_id: 'u_op', workspace_id: 'ws_small', role: 'operator', email: 'o@x.com', service_principal: false } as any;

function cwDal(spy: { eventsFor: string[]; canScopeCalls: Array<[string, string]>; canScope: boolean }) {
  return {
    getSession: async (_u: string, w: string) => ({ projects: [{ id: 'prj_1', name: 'P1' }], workspace: { id: w }, user: { role: 'operator' } }),
    listEvents: async (w: string) => { spy.eventsFor.push(w); return { events: [{ id: 'e1', project_id: 'prj_1', intent_id: 'i', status: 'needs_review', approval_state: 'pending', summary: 's', evidence_link: null }], pagination: { has_more: false, next_before: null } }; },
    countGovernedExecutionReceipts: async () => 0,
    userCanScopeWorkspace: async (u: string, w: string) => { spy.canScopeCalls.push([u, w]); return spy.canScope; },
  } as any;
}

function cwApp(spy: any, env: Record<string, string | undefined>) {
  const a = new Hono();
  a.use('*', async (ctx, next) => {
    ctx.env = env as any;
    ctx.set('auth', CW_AUTH);
    ctx.set('dal', cwDal(spy));
    ctx.set('request_id', 'rq_cw');
    await next();
  });
  a.route('/', currentWorkRoute);
  return a;
}
const mkSpy = () => ({ eventsFor: [] as string[], canScopeCalls: [] as Array<[string, string]>, canScope: true });

describe('current-work · operator-workspace-scope (OPERATOR_WORKSPACE_SCOPE_ENABLED)', () => {
  it('(a) flag OFF: scope is auth.workspace_id even when ?workspace_id is passed (byte-identical)', async () => {
    const spy = mkSpy();
    const res = await cwApp(spy, { CURRENT_WORK_PROJECTION_ENABLED: 'true', OPERATOR_WORKSPACE_SCOPE_ENABLED: undefined })
      .request('/current-work?workspace_id=ws_big');
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.workspace_id).toBe('ws_small');       // the JWT org, never the requested one
    expect(spy.eventsFor).toEqual(['ws_small']);    // events read from the JWT org only
    expect(spy.canScopeCalls).toEqual([]);          // authz helper never consulted when flag off
  });

  it('(b) flag ON + requested === auth: unchanged (auth workspace)', async () => {
    const spy = mkSpy();
    const res = await cwApp(spy, { CURRENT_WORK_PROJECTION_ENABLED: 'true', OPERATOR_WORKSPACE_SCOPE_ENABLED: 'true' })
      .request('/current-work?workspace_id=ws_small');
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.workspace_id).toBe('ws_small');
    expect(spy.eventsFor).toEqual(['ws_small']);
    expect(spy.canScopeCalls).toEqual([]);          // no cross-workspace override → no authz check
  });

  it('(c) flag ON + requested != auth AND owner/member: reads the requested workspace', async () => {
    const spy = mkSpy(); spy.canScope = true;
    const res = await cwApp(spy, { CURRENT_WORK_PROJECTION_ENABLED: 'true', OPERATOR_WORKSPACE_SCOPE_ENABLED: 'true' })
      .request('/current-work?workspace_id=ws_big');
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.workspace_id).toBe('ws_big');
    expect(spy.eventsFor).toEqual(['ws_big']);      // events read from the AUTHORIZED requested org
    expect(spy.canScopeCalls).toEqual([['u_op', 'ws_big']]);
  });

  it('(d) flag ON + requested != auth AND NOT owner/member: 403 FORBIDDEN, no events read', async () => {
    const spy = mkSpy(); spy.canScope = false;
    const res = await cwApp(spy, { CURRENT_WORK_PROJECTION_ENABLED: 'true', OPERATOR_WORKSPACE_SCOPE_ENABLED: 'true' })
      .request('/current-work?workspace_id=ws_big');
    expect(res.status).toBe(403);
    const b = await res.json();
    expect(b.code).toBe('FORBIDDEN');
    expect(spy.eventsFor).toEqual([]);              // NEITHER workspace's events were read
    expect(spy.canScopeCalls).toEqual([['u_op', 'ws_big']]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// customer-chat · POST /api/v1/customer-chat  (body.workspace_id)
// ─────────────────────────────────────────────────────────────────────────────────────────────────
const CH_AUTH = { user_id: 'u_op', workspace_id: 'org_small', email: 'o@x.com', role: 'owner' };
const PROFILE = {
  schema_id: 'xlooop.customer_context_profile.v1',
  company: { name: 'Acme', domain: 'acme.example', country: 'AU' },
  focus_90d: 'ship', growth_posture: 'Grow', maturity_level: 'L4/5', ai_tools_in_use: [],
  customer_concentration: null, cyber_flag: null, notes: null, data_lives_in: [], public_signals: [],
  provenance: 'stated' as const,
};

function chDal(spy: { eventsFor: string[]; ctxFor: string[]; canScopeCalls: Array<[string, string]>; canScope: boolean }) {
  return {
    getSessionEntitlement: async () => ({ state: 'approved_workspace' }),
    listEvents: async (w: string) => { spy.eventsFor.push(w); return { events: [], pagination: { has_more: false, next_before: null } }; },
    listUserSources: async () => [],
    getCustomerContextProfile: async (w: string) => { spy.ctxFor.push(w); return PROFILE; },
    userCanScopeWorkspace: async (u: string, w: string) => { spy.canScopeCalls.push([u, w]); return spy.canScope; },
  } as any;
}

function chApp(spy: any) {
  const app = new Hono();
  app.use('*', async (ctx, next) => {
    ctx.set('request_id', 'rq_ch');
    ctx.set('auth', CH_AUTH as never);
    ctx.set('dal', chDal(spy) as never);
    await next();
  });
  app.route('/api/v1', customerChatRoute);
  return app;
}
const chSpy = () => ({ eventsFor: [] as string[], ctxFor: [] as string[], canScopeCalls: [] as Array<[string, string]>, canScope: true });
function chAsk(app: Hono, body: Record<string, unknown>, env: Record<string, unknown>) {
  return app.request('/api/v1/customer-chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, { CUSTOMER_SAFE_SERIALIZER_ENABLED: 'false', ...env });
}

describe('customer-chat · operator-workspace-scope (OPERATOR_WORKSPACE_SCOPE_ENABLED)', () => {
  it('(a) flag OFF: scope is auth.workspace_id even when body.workspace_id is passed (byte-identical)', async () => {
    const spy = chSpy();
    const res = await chAsk(chApp(spy), { message: 'hi', workspace_id: 'org_big' }, {});
    expect(res.status).toBe(200);
    expect(spy.eventsFor).toEqual(['org_small']);   // the JWT org, never the requested one
    expect(spy.ctxFor).toEqual(['org_small']);
    expect(spy.canScopeCalls).toEqual([]);          // authz helper never consulted when flag off
  });

  it('(b) flag ON + requested === auth: unchanged (auth workspace)', async () => {
    const spy = chSpy();
    const res = await chAsk(chApp(spy), { message: 'hi', workspace_id: 'org_small' }, { OPERATOR_WORKSPACE_SCOPE_ENABLED: 'true' });
    expect(res.status).toBe(200);
    expect(spy.eventsFor).toEqual(['org_small']);
    expect(spy.canScopeCalls).toEqual([]);
  });

  it('(c) flag ON + requested != auth AND owner/member: reads the requested workspace', async () => {
    const spy = chSpy(); spy.canScope = true;
    const res = await chAsk(chApp(spy), { message: 'hi', workspace_id: 'org_big' }, { OPERATOR_WORKSPACE_SCOPE_ENABLED: 'true' });
    expect(res.status).toBe(200);
    expect(spy.eventsFor).toEqual(['org_big']);     // events read from the AUTHORIZED requested org
    expect(spy.ctxFor).toEqual(['org_big']);
    expect(spy.canScopeCalls).toEqual([['u_op', 'org_big']]);
  });

  it('(d) flag ON + requested != auth AND NOT owner/member: 403 FORBIDDEN, no events read', async () => {
    const spy = chSpy(); spy.canScope = false;
    const res = await chAsk(chApp(spy), { message: 'hi', workspace_id: 'org_big' }, { OPERATOR_WORKSPACE_SCOPE_ENABLED: 'true' });
    expect(res.status).toBe(403);
    const b = await res.json() as { code: string };
    expect(b.code).toBe('FORBIDDEN');
    expect(spy.eventsFor).toEqual([]);              // NEITHER workspace's events were read
    expect(spy.ctxFor).toEqual([]);
    expect(spy.canScopeCalls).toEqual([['u_op', 'org_big']]);
  });
});


// ─────────────────────────────────────────────────────────────────────────────────────────────────
// JB · resolveScopedWorkspace(requireOwner=true) — the WRITE-path authorization (packet:create,
// signoff:decide). Reads accept owner OR member; WRITES require OWNERSHIP (owner_user_id only). This
// proves the stricter predicate is the one consulted, and that flag-off is byte-identical (no probe).
// ─────────────────────────────────────────────────────────────────────────────────────────────────
function wDal(spy: { ownsCalls: Array<[string, string]>; canScopeCalls: Array<[string, string]>; owns: boolean }) {
  return {
    userOwnsWorkspace: async (u: string, w: string) => { spy.ownsCalls.push([u, w]); return spy.owns; },
    userCanScopeWorkspace: async (u: string, w: string) => { spy.canScopeCalls.push([u, w]); return true; },
  } as any;
}
function wCtx(cap: { status?: number }) {
  return {
    get: (k: string) => (k === 'request_id' ? 'rq_w' : undefined),
    status: (n: number) => { cap.status = n; },
    json: (o: unknown) => ({ __json: o } as any),
  } as any;
}
const wSpy = () => ({ ownsCalls: [] as Array<[string, string]>, canScopeCalls: [] as Array<[string, string]>, owns: true });

describe('resolveScopedWorkspace · WRITE path (requireOwner=true)', () => {
  it('(a) flag OFF: authWs unconditionally, ownership NEVER probed (byte-identical)', async () => {
    const spy = wSpy(); const cap: { status?: number } = {};
    const r = await resolveScopedWorkspace(wCtx(cap), undefined, 'ws_small', 'u_op', 'ws_big', wDal(spy) as any, true);
    expect(r).toEqual({ ok: true, ws: 'ws_small' });
    expect(spy.ownsCalls).toEqual([]);
    expect(spy.canScopeCalls).toEqual([]);
  });

  it('(b) flag ON + requested === auth: unchanged, no ownership probe', async () => {
    const spy = wSpy(); const cap: { status?: number } = {};
    const r = await resolveScopedWorkspace(wCtx(cap), 'true', 'ws_small', 'u_op', 'ws_small', wDal(spy) as any, true);
    expect(r).toEqual({ ok: true, ws: 'ws_small' });
    expect(spy.ownsCalls).toEqual([]);
  });

  it('(c) flag ON + requested != auth AND OWNER: resolves to requested via userOwnsWorkspace ONLY (not the member predicate)', async () => {
    const spy = wSpy(); spy.owns = true; const cap: { status?: number } = {};
    const r = await resolveScopedWorkspace(wCtx(cap), 'true', 'ws_small', 'u_op', 'ws_big', wDal(spy) as any, true);
    expect(r).toEqual({ ok: true, ws: 'ws_big' });
    expect(spy.ownsCalls).toEqual([['u_op', 'ws_big']]);   // OWNER predicate consulted
    expect(spy.canScopeCalls).toEqual([]);                  // member predicate NEVER consulted for a write
  });

  it('(d) flag ON + requested != auth AND NOT owner: hard 403 (a mere member cannot write cross-workspace)', async () => {
    const spy = wSpy(); spy.owns = false; const cap: { status?: number } = {};
    const r = await resolveScopedWorkspace(wCtx(cap), 'true', 'ws_small', 'u_op', 'ws_big', wDal(spy) as any, true);
    expect(r.ok).toBe(false);
    expect(cap.status).toBe(403);
    expect(spy.ownsCalls).toEqual([['u_op', 'ws_big']]);
    expect(spy.canScopeCalls).toEqual([]);
  });

  it('(e) requireOwner=false (read default) still uses the member predicate', async () => {
    const spy = wSpy(); const cap: { status?: number } = {};
    const r = await resolveScopedWorkspace(wCtx(cap), 'true', 'ws_small', 'u_op', 'ws_big', wDal(spy) as any, false);
    expect(r).toEqual({ ok: true, ws: 'ws_big' });
    expect(spy.canScopeCalls).toEqual([['u_op', 'ws_big']]);  // member predicate for reads
    expect(spy.ownsCalls).toEqual([]);
  });
});
