// customer-chat-route.test.ts · the customer-safe AI chat (POST /api/v1/customer-chat).
//
// VERIFIES THE TWO THINGS THAT MATTER for a customer-facing AI:
//   1. TENANT-ISOLATION — the workspace comes ONLY from the verified JWT (auth.workspace_id), never a
//      body-supplied scope, so a customer can never read another tenant's events/context.
//   2. COMPANY-AWARENESS — the captured readiness profile (S1) reaches the answer, so the chief-of-
//      staff knows the company even with no LLM binding + 0 events (the deterministic floor path).
// Before this route existed the in-app chat short-circuited to a hardcoded client-side stub.

import { describe, it, expect, vi } from 'vitest';
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
    listProjects: async () => [],
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

function history(app: Hono, query = '', env: Record<string, unknown> = {}) {
  return app.request(`/api/v1/customer-chat/history${query}`, { method: 'GET' }, env);
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

  it('answers an explicit project-name request from the current tenant project inventory', async () => {
    let projectsQueriedFor = '';
    const dal = dalStub({
      listProjects: async (workspaceId: string) => {
        projectsQueriedFor = workspaceId;
        return [
          { id: 'project_1', workspace_id: workspaceId, name: 'Commercial proof', status: 'active', updated_at: '2026-07-25T01:00:00Z' },
          { id: 'project_2', workspace_id: workspaceId, name: 'Customer onboarding', status: 'active', updated_at: '2026-07-24T01:00:00Z' },
        ];
      },
    });
    const res = await ask(appFor(AUTH, dal), {
      message: 'List the current project names. This is read-only; do not create or change anything.',
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { answer: string; generated_by: string };
    expect(projectsQueriedFor).toBe('org_hy');
    expect(body.answer).toContain('Commercial proof');
    expect(body.answer).toContain('Customer onboarding');
    expect(body.answer).not.toContain('project_1');
    expect(body.answer).not.toContain('project_2');
    expect(body.answer).not.toContain('Here is what is happening');
    expect(body.generated_by).toBe('deterministic');
  });

  it('grounds an exact project plan question in tenant-validated plan entities and returns canonical conversation ids', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const project = {
      id: 'project_1',
      workspace_id: 'org_hy',
      name: 'Commercial launch',
      status: 'active',
      updated_at: '2026-07-26T10:00:00Z',
    };
    const dal = dalStub({
      getProject: async (workspaceId: string, projectId: string) => {
        calls.push({ method: 'getProject', workspaceId, projectId });
        return workspaceId === 'org_hy' && projectId === project.id ? project : null;
      },
      plan: {
        listPlanEntities: async (projectId: string, options: Record<string, unknown>) => {
          calls.push({ method: 'listPlanEntities', projectId, options });
          return [
            { id: 'goal_1', kind: 'goal', title: 'Launch safely', status: 'active', position: 1, target_date: null, updated_at: '2026-07-26T10:01:00Z' },
            { id: 'milestone_1', kind: 'milestone', title: 'Complete acceptance proof', status: 'planned', position: 2, target_date: null, updated_at: '2026-07-26T10:02:00Z' },
            { id: 'todo_1', kind: 'todo', title: 'Run reload journey', status: 'open', position: 3, target_date: null, updated_at: '2026-07-26T10:03:00Z' },
          ];
        },
      },
      listProjectSourceBindings: async (workspaceId: string, projectId: string) => {
        calls.push({ method: 'listProjectSourceBindings', workspaceId, projectId });
        return [
          { id: 'binding_1', source_kind: 'google_drive_folder', status: 'connected', read_policy: 'read_only' },
          { id: 'binding_2', source_kind: 'manual', status: 'pending_auth', read_policy: 'metadata_only' },
        ];
      },
      appendChatExchange: async (
        _userId: string,
        _scope: Record<string, unknown>,
        messages: Array<Record<string, unknown>>,
      ) => ({
        thread_id: 'thr_u1__orghy|project1|',
        messages: messages.map((message, index) => ({
          ...message,
          id: String(index + 101),
          thread_id: 'thr_u1__orghy|project1|',
          created_at: `2026-07-27T00:00:0${index}Z`,
        })),
      }),
    });

    const res = await askEnv(appFor(AUTH, dal), {
      message: 'What is the project name, and list every goal, milestone, todo, and admitted source with counts and last update?',
      project_id: 'project_1',
      interaction_id: 'interaction_project_1',
    }, { CHAT_HISTORY_PERSISTENCE_REQUIRED: 'true' });

    expect(res.status).toBe(200);
    const body = await res.json() as {
      answer: string;
      interaction_id: string;
      scope: Record<string, unknown>;
      requested_facts: { required: string[]; satisfied: string[]; unavailable: string[] };
      conversation: { thread_id: string; user_message_id: string; assistant_message_id: string };
    };
    expect(body.answer).toContain('Project: Commercial launch (project_1)');
    expect(body.answer).toContain('Launch safely');
    expect(body.answer).toContain('Complete acceptance proof');
    expect(body.answer).toContain('Run reload journey');
    expect(body.answer).toContain('Counts: 1 goal · 1 milestone · 1 todo · 0 intents.');
    expect(body.answer).toContain('Project sources: 2 source bindings (1 connected).');
    expect(body.answer).toContain('Plan last updated: 2026-07-26T10:03:00Z.');
    expect(body.answer).toContain('Requested facts: project name, goals, milestones, todos, counts, project sources, freshness.');
    expect(body.answer).toContain('Unavailable: none.');
    expect(body.interaction_id).toBe('interaction_project_1');
    expect(body.scope).toEqual({ workspace_id: 'org_hy', project_id: 'project_1', domain_id: null });
    expect(body.requested_facts.unavailable).toEqual([]);
    expect(body.requested_facts.required).toEqual(body.requested_facts.satisfied);
    expect(body.conversation).toEqual({
      thread_id: 'thr_u1__orghy|project1|',
      user_message_id: '101',
      assistant_message_id: '102',
    });
    expect(calls).toEqual([
      { method: 'getProject', workspaceId: 'org_hy', projectId: 'project_1' },
      { method: 'listPlanEntities', projectId: 'project_1', options: { workspaceId: 'org_hy' } },
      { method: 'listProjectSourceBindings', workspaceId: 'org_hy', projectId: 'project_1' },
    ]);
  });

  it('marks project sources unavailable when their tenant-scoped read cannot be verified', async () => {
    const dal = dalStub({
      getProject: async (workspaceId: string, projectId: string) => ({
        id: projectId,
        workspace_id: workspaceId,
        name: 'Commercial launch',
        status: 'active',
        updated_at: '2026-07-26T10:00:00Z',
      }),
      plan: { listPlanEntities: async () => [] },
      listProjectSourceBindings: async () => { throw new Error('project source read unavailable'); },
    });

    const res = await ask(appFor(AUTH, dal), {
      message: 'How many admitted sources are connected to this project?',
      project_id: 'project_1',
    });

    expect(res.status).toBe(200);
    const body = await res.json() as {
      answer: string;
      requested_facts: { required: string[]; satisfied: string[]; unavailable: string[] };
      grounding: { project_source_fact_count: number };
    };
    expect(body.answer).toContain('Project sources: unavailable.');
    expect(body.answer).toContain('Unavailable: project sources.');
    expect(body.requested_facts.required).toEqual(['counts', 'project_sources']);
    expect(body.requested_facts.satisfied).toEqual(['counts']);
    expect(body.requested_facts.unavailable).toEqual(['project_sources']);
    expect(body.grounding.project_source_fact_count).toBe(0);
  });

  it('grounds chat in an exact tenant-safe document reference and reports a customer-safe count', async () => {
    const dal = dalStub({
      listDocumentsByIds: async (workspaceId: string, ids: string[]) => [{
        id: ids[0], workspace_id: workspaceId, project_id: null, filename: 'pilot-brief.txt',
        content_type: 'text/plain', size_bytes: 40, extracted_text: 'The pilot starts in September.',
        uploaded_by: 'u1', uploaded_at: '2026-08-02T00:00:00Z', status: 'recorded',
        admissibility: 'approved', content_hash: 'a'.repeat(64), version: 1, supersedes_id: null,
      }],
    });
    const res = await ask(appFor({ ...AUTH, role: 'owner' }, dal), {
      message: 'What does the attached brief say?',
      context_refs: [{ kind: 'document', id: 'doc_pilot' }],
    });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      answer: string;
      grounded_on: { documents: { total: number; names: string[] } };
      grounding: { document_count: number };
    };
    expect(body.answer).toContain('pilot-brief.txt');
    expect(body.grounded_on.documents).toEqual({ total: 1, names: ['pilot-brief.txt'] });
    expect(body.grounding.document_count).toBe(1);
  });

  it('fails before event/model work when an exact document cannot be resolved', async () => {
    let eventsRead = false;
    const dal = dalStub({
      listDocumentsByIds: async () => [],
      listEvents: async () => {
        eventsRead = true;
        return { events: [], pagination: { has_more: false, next_before: null } };
      },
    });
    const res = await ask(appFor({ ...AUTH, role: 'owner' }, dal), {
      message: 'Use the attached brief.',
      context_refs: [{ kind: 'document', id: 'doc_missing' }],
    });
    expect(res.status).toBe(409);
    expect(eventsRead).toBe(false);
  });

  it('does not load plan facts for a project outside the authenticated workspace', async () => {
    let planReads = 0;
    const dal = dalStub({
      getProject: async () => null,
      plan: {
        listPlanEntities: async () => {
          planReads += 1;
          return [];
        },
      },
    });

    const res = await ask(appFor(AUTH, dal), {
      message: 'List the goals for this project.',
      project_id: 'project_other_tenant',
    });

    expect(res.status).toBe(404);
    expect(planReads).toBe(0);
  });

  it('returns canonical project IDs when explicitly requested and honors rows-only output', async () => {
    const dal = dalStub({
      listProjects: async (workspaceId: string) => [
        { id: 'project_1', workspace_id: workspaceId, name: 'Commercial proof', status: 'active', updated_at: '2026-07-25T01:00:00Z' },
        { id: 'project_2', workspace_id: workspaceId, name: 'Customer onboarding', status: 'active', updated_at: '2026-07-24T01:00:00Z' },
      ],
    });
    const res = await ask(appFor(AUTH, dal), {
      message: 'List every project in this workspace. Return only each project name and project ID. Do not create or change anything.',
    });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      answer: string;
      generated_by: string;
      grounded_on: { projects: { items: Array<{ id: string; name: string }> } };
    };
    expect(body.answer).toBe('• Commercial proof — project_1\n• Customer onboarding — project_2');
    expect(body.generated_by).toBe('deterministic');
    expect(body.grounded_on.projects.items).toEqual([
      expect.objectContaining({ id: 'project_1', name: 'Commercial proof' }),
      expect.objectContaining({ id: 'project_2', name: 'Customer onboarding' }),
    ]);
  });

  it('composes requested project IDs with explicitly workspace-bound source inventory', async () => {
    const source = (id: string, provider: string, workspaceId: string | null) => ({
      id,
      workspace_id: workspaceId,
      user_id: 'u1',
      provider,
      provider_user_id: id,
      provider_username: `${provider}@example.test`,
      status: 'connected',
      scopes: [],
      connected_at: '2026-07-01T00:00:00Z',
      last_sync_at: '2026-07-26T00:00:00Z',
      last_sync_error: null,
    });
    const dal = dalStub({
      listProjects: async (workspaceId: string) => [
        { id: 'project_1', workspace_id: workspaceId, name: 'Commercial proof', status: 'active', updated_at: '2026-07-25T01:00:00Z' },
      ],
      listUserSources: async () => [
        source('source_bound', 'gmail', 'org_hy'),
        source('source_legacy', 'google_drive', null),
        source('source_other', 'slack', 'org_other'),
      ],
    });
    const res = await ask(appFor(AUTH, dal), {
      message: 'First list every active project as project name and canonical project ID. Then list only source connections explicitly bound to this current workspace, with provider and binding status.',
    });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      answer: string;
      generated_by: string;
      grounded_on: { sources: { total: number; providers: Array<{ provider: string }> } };
    };
    expect(body.answer).toContain('• Commercial proof — project_1');
    expect(body.answer).toContain('gmail connected, workspace-bound');
    expect(body.answer).not.toContain('google_drive');
    expect(body.answer).not.toContain('slack');
    expect(body.answer).not.toContain('legacy user-account binding');
    expect(body.generated_by).toBe('deterministic');
    expect(body.grounded_on.sources).toMatchObject({
      total: 1,
      providers: [expect.objectContaining({ provider: 'gmail' })],
    });
  });

  it('reports an honest empty bound-source inventory even when no activity events exist', async () => {
    const dal = dalStub({
      listUserSources: async () => [{
        id: 'source_legacy',
        workspace_id: null,
        user_id: 'u1',
        provider: 'gmail',
        provider_user_id: 'legacy',
        provider_username: 'legacy@example.test',
        status: 'connected',
        scopes: [],
        connected_at: '2026-07-01T00:00:00Z',
        last_sync_at: '2026-07-26T00:00:00Z',
        last_sync_error: null,
      }],
    });
    const res = await ask(appFor(AUTH, dal), {
      message: 'Which source connections are explicitly bound to this workspace and synced?',
    });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      answer: string;
      grounded_on: { sources: { total: number } };
    };
    expect(body.answer).toBe('• Source status: no explicitly workspace-bound source connections are recorded.');
    expect(body.answer).not.toContain('legacy');
    expect(body.grounded_on.sources.total).toBe(0);
  });

  it('fails closed rather than returning a partial inventory when a canonical project ID is missing', async () => {
    const dal = dalStub({
      listProjects: async (workspaceId: string) => [
        { id: '   ', workspace_id: workspaceId, name: 'Commercial proof', status: 'active', updated_at: '2026-07-25T01:00:00Z' },
      ],
    });
    const res = await ask(appFor(AUTH, dal), {
      message: 'List each project name and ID.',
    });
    expect(res.status).toBe(503);
    const body = await res.json() as Record<string, unknown>;
    expect(body.code).toBe('SERVICE_UNAVAILABLE');
    expect(body).not.toHaveProperty('answer');
  });

  it('fails closed when an explicit project-name request cannot load the current inventory', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const dal = dalStub({
      listProjects: async () => { throw new Error('project store unavailable'); },
    });
    const res = await ask(appFor(AUTH, dal), {
      message: 'List the current project names. This is read-only.',
    });
    expect(res.status).toBe(503);
    const body = await res.json() as Record<string, unknown>;
    expect(body.code).toBe('SERVICE_UNAVAILABLE');
    expect(body).not.toHaveProperty('answer');
    expect(logSpy.mock.calls.map((args) => args.join(' ')).join('\n')).not.toContain('project store unavailable');
    logSpy.mockRestore();
  });

  it('does not misclassify a project-status question as a project-inventory request', async () => {
    let projectInventoryReads = 0;
    const dal = dalStub({
      listProjects: async () => {
        projectInventoryReads += 1;
        return [];
      },
    });
    const res = await ask(appFor(AUTH, dal), {
      message: 'What is blocked in this project?',
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { answer: string };
    expect(projectInventoryReads).toBe(0);
    expect(body.answer).not.toContain('Current active projects');
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

  it('legacy/default mode still returns the answer when chat history persistence fails', async () => {
    const dal = dalStub({
      appendChatExchange: async () => { throw new Error('chat table unavailable'); },
    });
    const res = await ask(appFor(AUTH, dal), { message: 'what should I do?' });
    expect(res.status).toBe(200);
    const body = await res.json() as { answer: string };
    expect(body.answer).toContain('Honest & Young');
  });

  it('strict pilot mode fails before answering when chat persistence is unavailable', async () => {
    let eventsRead = false;
    const dal = dalStub({
      listEvents: async () => { eventsRead = true; return { events: [], pagination: { has_more: false, next_before: null } }; },
    });
    const res = await askEnv(appFor(AUTH, dal), { message: 'what should I do?' }, { CHAT_HISTORY_PERSISTENCE_REQUIRED: 'true' });
    const body = await res.json() as Record<string, unknown>;
    expect(res.status).toBe(503);
    expect(body.code).toBe('CHAT_HISTORY_PERSISTENCE_UNAVAILABLE');
    expect(eventsRead).toBe(false);
  });

  it('strict pilot mode fails closed when the exchange cannot be durably recorded', async () => {
    const dal = dalStub({
      appendChatExchange: async () => { throw new Error('insert failed'); },
    });
    const res = await askEnv(appFor(AUTH, dal), { message: 'what should I do?' }, { CHAT_HISTORY_PERSISTENCE_REQUIRED: 'true' });
    const body = await res.json() as Record<string, unknown>;
    expect(res.status).toBe(503);
    expect(body.code).toBe('CHAT_HISTORY_PERSISTENCE_FAILED');
    expect(body).not.toHaveProperty('answer');
  });

  it('403 when there is no signed-in workspace', async () => {
    const res = await ask(appFor({ ...AUTH, workspace_id: '' }, dalStub()), { message: 'hi' });
    expect(res.status).toBe(403);
  });
});

describe('GET /api/v1/customer-chat/history', () => {
  it('returns the signed-in customer thread from the same workspace-only scope used by POST', async () => {
    const stored = [
      { role: 'you', body: 'What is blocking us?', created_at: '2026-07-24T01:00:00.000Z' },
      { role: 'assistant', body: 'One approval is waiting.', created_at: '2026-07-24T01:00:01.000Z' },
    ];
    const captured: { userId?: string; scope?: Record<string, unknown>; limit?: number } = {};
    const dal = dalStub({
      listChatHistory: async (userId: string, scope: Record<string, unknown>, limit: number) => {
        captured.userId = userId;
        captured.scope = scope;
        captured.limit = limit;
        return stored;
      },
    });
    const res = await history(appFor(AUTH, dal), '?workspace_id=org_ATTACKER');
    expect(res.status).toBe(200);
    const body = await res.json() as { messages: unknown[]; scope: Record<string, unknown> };
    expect(body.messages).toEqual(stored);
    expect(body.scope).toEqual({ workspace_id: 'org_hy', project_id: null, domain_id: null });
    expect(captured).toEqual({
      userId: 'u1',
      scope: { workspace_id: 'org_hy', project_id: null, domain_id: null },
      limit: 100,
    });
  });

  it('fails closed instead of returning a false empty thread when strict persistence is unavailable', async () => {
    const res = await history(
      appFor(AUTH, dalStub({ listChatHistory: async () => { throw new Error('database unavailable'); } })),
      '',
      { CHAT_HISTORY_PERSISTENCE_REQUIRED: 'true' },
    );
    expect(res.status).toBe(503);
    const body = await res.json() as { code: string };
    expect(body.code).toBe('CHAT_HISTORY_PERSISTENCE_FAILED');
  });

  it('validates and scopes project history through the authenticated workspace', async () => {
    const captured: Array<Record<string, unknown>> = [];
    const dal = dalStub({
      getProject: async (workspaceId: string, projectId: string) => {
        captured.push({ method: 'getProject', workspaceId, projectId });
        return { id: projectId, workspace_id: workspaceId, name: 'Launch', status: 'active' };
      },
      listChatHistory: async (userId: string, scope: Record<string, unknown>, limit: number) => {
        captured.push({ method: 'listChatHistory', userId, scope, limit });
        return [];
      },
    });

    const res = await history(appFor(AUTH, dal), '?workspace_id=org_ATTACKER&project_id=project_1');
    expect(res.status).toBe(200);
    expect(captured).toEqual([
      { method: 'getProject', workspaceId: 'org_hy', projectId: 'project_1' },
      {
        method: 'listChatHistory',
        userId: 'u1',
        scope: { workspace_id: 'org_hy', project_id: 'project_1', domain_id: null },
        limit: 100,
      },
    ]);
  });

  it('legacy mode degrades to an empty thread when the DAL history contract is absent', async () => {
    const res = await history(appFor(AUTH, dalStub()));
    expect(res.status).toBe(200);
    const body = await res.json() as { messages: unknown[] };
    expect(body.messages).toEqual([]);
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
