// customer-chat-route.test.ts · the customer-safe AI chat (POST /api/v1/customer-chat).
//
// VERIFIES THE TWO THINGS THAT MATTER for a customer-facing AI:
//   1. TENANT-ISOLATION — the workspace comes ONLY from the verified JWT (auth.workspace_id), never a
//      body-supplied scope, so a customer can never read another tenant's events/context.
//   2. COMPANY-AWARENESS — the captured readiness profile (S1) reaches the answer, so the chief-of-
//      staff knows the company even with no LLM binding + 0 events (the deterministic floor path).
// Before this route existed the in-app chat short-circuited to a hardcoded client-side stub.

import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { customerChatRoute } from '../routes/customer-chat';

const PROFILE = {
  schema_id: 'xlooop.customer_context_profile.v1',
  company: { name: 'Honest & Young', domain: 'honestyoung.example', country: 'AU' },
  focus_90d: 'cut workpaper cross-check time without new hires',
  growth_posture: 'Grow',
  maturity_level: 'L4/5',
  ai_tools_in_use: ['chatgpt', 'claude'],
  customer_concentration: null,
  cyber_flag: null,
  notes: null,
  data_lives_in: ['xero'],
  public_signals: ['Email SPF record: SPF published'],
  provenance: 'stated' as const,
};

function dalStub(overrides: Record<string, unknown> = {}) {
  return {
    getSessionEntitlement: async () => ({ state: 'approved_workspace' }),
    listEvents: async () => ({ events: [], pagination: { has_more: false, next_before: null } }),
    listUserSources: async () => [],
    getCustomerContextProfile: async () => PROFILE,
    ...overrides,
  } as Record<string, unknown>;
}

function appFor(auth: Record<string, unknown> | null, dal: Record<string, unknown>) {
  const app = new Hono();
  app.use('*', async (ctx, next) => {
    ctx.set('request_id', 'test');
    if (auth) ctx.set('auth', auth as never);
    ctx.set('dal', dal as never);
    await next();
  });
  app.route('/api/v1', customerChatRoute);
  return app;
}

function ask(app: Hono, body: Record<string, unknown>) {
  return app.request(
    '/api/v1/customer-chat',
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    // internal-builder suite: assert the RAW pre-serializer contract. P3 (260714) made the customer-safe
    // serializer DEFAULT-ON (missing flag = safe), so these tests opt out explicitly.
    { CUSTOMER_SAFE_SERIALIZER_ENABLED: 'false' },
  );
}

const AUTH = { user_id: 'u1', workspace_id: 'org_hy', email: 'a@honestyoung.example', role: 'member' };

describe('POST /api/v1/customer-chat', () => {
  it('answers COMPANY-AWARE from the captured profile (no LLM binding, 0 events → deterministic floor)', async () => {
    const res = await ask(appFor(AUTH, dalStub()), { message: 'what should I do?' });
    expect(res.status).toBe(200);
    const body = await res.json() as { answer: string; generated_by: string };
    expect(body.answer).toContain('Honest & Young');
    expect(body.answer).toContain('workpaper'); // their real 90-day focus reached the answer
    expect(body.generated_by).toBe('deterministic'); // no AI binding in the test env
  });

  it('TENANT-SAFE: a body-supplied scope.workspace_id is IGNORED — only the JWT workspace is read', async () => {
    let eventsQueriedFor = '';
    let contextQueriedFor = '';
    let sourcesQueriedFor = '';
    const dal = dalStub({
      listEvents: async (wid: string) => { eventsQueriedFor = wid; return { events: [], pagination: { has_more: false, next_before: null } }; },
      listUserSources: async (userId: string) => { sourcesQueriedFor = userId; return []; },
      getCustomerContextProfile: async (wid: string) => { contextQueriedFor = wid; return PROFILE; },
    });
    const res = await ask(appFor(AUTH, dal), { message: 'hi', scope: { workspace_id: 'org_ATTACKER' } });
    expect(res.status).toBe(200);
    expect(eventsQueriedFor).toBe('org_hy'); // never the attacker-supplied id
    expect(sourcesQueriedFor).toBe('u1');
    expect(contextQueriedFor).toBe('org_hy');
  });

  it('reports Gmail connected/synced even when no Gmail events have been ingested yet', async () => {
    const dal = dalStub({
      listEvents: async () => ({
        events: [{
          id: 'evt_setup_gmail',
          workspace_id: 'org_hy',
          project_id: null,
          source_tool: 'xlooop',
          agent_id: null,
          intent_id: null,
          status: 'queued',
          summary: 'Connect Gmail',
          body: null,
          evidence_link: null,
          visibility: 'internal_workspace',
          permission_scope: null,
          risk: null,
          approval_state: null,
          next_action: null,
          occurred_at: '2026-06-29T00:00:00Z',
        }],
        pagination: { has_more: false, next_before: null },
      }),
      listUserSources: async () => [{
        id: 'src_gmail',
        workspace_id: 'org_hy',
        user_id: 'u1',
        provider: 'gmail',
        provider_user_id: 'google_ext',
        provider_username: 'codelooop23@gmail.com',
        scopes: ['gmail.readonly'],
        contract: { version: 1, ingestion_mode: 'reflection_only', allowed_fields: [], max_body_bytes: 200, rate_limit: { per_hour: 5000 } },
        status: 'connected',
        connected_at: '2026-07-01T00:00:00Z',
        last_sync_at: '2026-07-01T01:00:00Z',
        last_sync_error: null,
        created_at: '2026-07-01T00:00:00Z',
        updated_at: '2026-07-01T01:00:00Z',
      }],
    });
    const res = await ask(appFor(AUTH, dal), { message: 'do i have new emails?' });
    expect(res.status).toBe(200);
    const body = await res.json() as { answer: string; grounded_on: { sources: { providers: Array<{ provider: string; event_count: number }> } } };
    expect(body.answer).toContain('gmail connected');
    expect(body.answer).toContain('0 ingested events');
    expect(body.grounded_on.sources.providers[0]).toMatchObject({ provider: 'gmail', event_count: 0 });
  });

  it('summarizes Gmail metadata events when they are present for this workspace', async () => {
    const dal = dalStub({
      listEvents: async () => ({
        events: [{
          id: 'usc_evt_gmail_msg_m1',
          workspace_id: 'org_hy',
          project_id: null,
          source_tool: 'gmail',
          agent_id: 'gmail:Jane',
          intent_id: null,
          status: 'completed',
          summary: '[Email] June invoice',
          body: 'June invoice attached',
          evidence_link: 'https://mail.google.com/mail/u/0/#all/m1',
          visibility: 'internal_workspace',
          permission_scope: null,
          risk: null,
          approval_state: null,
          next_action: null,
          occurred_at: '2026-07-01T02:00:00Z',
        }],
        pagination: { has_more: false, next_before: null },
      }),
      listUserSources: async () => [{
        id: 'src_gmail',
        workspace_id: 'org_hy',
        user_id: 'u1',
        provider: 'gmail',
        provider_user_id: 'google_ext',
        provider_username: 'codelooop23@gmail.com',
        scopes: ['gmail.readonly'],
        contract: { version: 1, ingestion_mode: 'reflection_only', allowed_fields: [], max_body_bytes: 200, rate_limit: { per_hour: 5000 } },
        status: 'connected',
        connected_at: '2026-07-01T00:00:00Z',
        last_sync_at: '2026-07-01T02:01:00Z',
        last_sync_error: null,
        created_at: '2026-07-01T00:00:00Z',
        updated_at: '2026-07-01T02:01:00Z',
      }],
    });
    const res = await ask(appFor(AUTH, dal), { message: 'what are my emails?' });
    expect(res.status).toBe(200);
    const body = await res.json() as { answer: string; grounded_on: { sources: { providers: Array<{ provider: string; event_count: number }> } } };
    expect(body.answer).toContain('[Email] June invoice');
    expect(body.answer).toContain('gmail connected');
    expect(body.grounded_on.sources.providers[0]).toMatchObject({ provider: 'gmail', event_count: 1 });
  });

  it('403 when the workspace is not provisioned', async () => {
    const dal = dalStub({ getSessionEntitlement: async () => ({ state: 'authenticated_no_access' }) });
    const res = await ask(appFor(AUTH, dal), { message: 'hi' });
    expect(res.status).toBe(403);
  });

  it('400 on an empty message', async () => {
    const res = await ask(appFor(AUTH, dalStub()), { message: '   ' });
    expect(res.status).toBe(400);
  });

  it('403 when there is no signed-in workspace', async () => {
    const res = await ask(appFor({ ...AUTH, workspace_id: '' }, dalStub()), { message: 'hi' });
    expect(res.status).toBe(403);
  });
});

// ── T1/P3 (260710) · mechanical source-truth override (flag-gated) ────────────────────────────────
const STALE_SETUP_EVENT = {
  id: 'evt_setup_gmail', workspace_id: 'org_hy', project_id: null, source_tool: 'xlooop', agent_id: null,
  intent_id: null, status: 'queued', summary: 'Connect Gmail', body: null, evidence_link: null,
  visibility: 'internal_workspace', permission_scope: null, risk: null, approval_state: null,
  next_action: null, occurred_at: '2026-06-29T00:00:00Z',
};
const GMAIL_ROW = {
  id: 'src_gmail', workspace_id: 'org_hy', user_id: 'u1', provider: 'gmail', provider_user_id: 'g',
  provider_username: 'a@honestyoung.example', status: 'connected', scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
  connected_at: '2026-07-01T00:00:00Z', last_sync_at: '2026-07-09T00:00:00Z', last_sync_error: null,
};
const askEnv = (app: Hono, body: Record<string, unknown>, env: Record<string, unknown>) =>
  app.request('/api/v1/customer-chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, { CUSTOMER_SAFE_SERIALIZER_ENABLED: 'false', ...env }); // raw pre-serializer contract (P3 opt-out)

describe('T1 · source-truth override (CHAT_SOURCE_TRUTH_OVERRIDE_ENABLED)', () => {
  const dal = () => dalStub({
    listEvents: async () => ({ events: [STALE_SETUP_EVENT], pagination: { has_more: false, next_before: null } }),
    listUserSources: async () => [GMAIL_ROW],
  });

  it('flag ON: the queued "Connect Gmail" reminder is DEMOTED once gmail is connected (live truth wins)', async () => {
    const res = await askEnv(appFor(AUTH, dal()), { message: 'is my email connected?' }, { CHAT_SOURCE_TRUTH_OVERRIDE_ENABLED: 'true' });
    expect(res.status).toBe(200);
    const body = await res.json() as { grounded_on: { events_considered: number; sources: { connected: number } } };
    expect(body.grounded_on.events_considered).toBe(0);   // the stale reminder no longer grounds the answer
    expect(body.grounded_on.sources.connected).toBe(1);   // …while the source truth still does
  });

  it('flag OFF (default): byte-identical to today — the reminder still grounds', async () => {
    const res = await askEnv(appFor(AUTH, dal()), { message: 'is my email connected?' }, {});
    const body = await res.json() as { grounded_on: { events_considered: number } };
    expect(body.grounded_on.events_considered).toBe(1);
  });

  it('flag ON but gmail NOT connected: the reminder correctly STAYS (nothing supersedes it)', async () => {
    const notConnected = dalStub({
      listEvents: async () => ({ events: [STALE_SETUP_EVENT], pagination: { has_more: false, next_before: null } }),
      listUserSources: async () => [],
    });
    const res = await askEnv(appFor(AUTH, notConnected), { message: 'hi' }, { CHAT_SOURCE_TRUTH_OVERRIDE_ENABLED: 'true' });
    const body = await res.json() as { grounded_on: { events_considered: number } };
    expect(body.grounded_on.events_considered).toBe(1);
  });
});

describe('T1 · G9 sources ride the role projection (CHAT_ROLE_SCOPED_CONTEXT_ENABLED)', () => {
  const dal = () => dalStub({ listUserSources: async () => [GMAIL_ROW] });
  const RSC_ON = { CHAT_ROLE_SCOPED_CONTEXT_ENABLED: 'true' };

  it('owner (flag on): source facts ground as before', async () => {
    const res = await askEnv(appFor({ ...AUTH, role: 'owner' }, dal()), { message: 'hi' }, RSC_ON);
    const body = await res.json() as { grounded_on: { sources: { total: number } } };
    expect(body.grounded_on.sources.total).toBe(1);
  });

  it('viewer (flag on): source facts are ops-internal → do NOT ground', async () => {
    const res = await askEnv(appFor({ ...AUTH, role: 'viewer' }, dal()), { message: 'hi' }, RSC_ON);
    const body = await res.json() as { grounded_on: { sources: { total: number } } };
    expect(body.grounded_on.sources.total).toBe(0);
  });

  it('flag OFF: viewer still sees source facts (today, byte-identical)', async () => {
    const res = await askEnv(appFor({ ...AUTH, role: 'viewer' }, dal()), { message: 'hi' }, {});
    const body = await res.json() as { grounded_on: { sources: { total: number } } };
    expect(body.grounded_on.sources.total).toBe(1);
  });
});
