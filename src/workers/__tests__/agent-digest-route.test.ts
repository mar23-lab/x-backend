// agent-digest-route.test.ts · 2026-06-08
// Route tests for POST /workspaces/:id/agent/digest — the governed agent action. Asserts tenancy
// + that the agent posts a PENDING (needs_review) proposal into the approval spine. DAL mocked.

import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { workspacesRoute } from '../routes/workspaces';

const MBP_OWNER = 'user_operator_mbp';
const ENV = { MBP_OWNER_USER_ID: MBP_OWNER, MBP_OWNER_LINKED_USER_IDS: '', DATABASE_URL: 'x' };
const SUMMARY = {
  workspace_id: 'ws1', events_total: 10, events_completed: 6, signoffs_total: 3, projects_total: 2,
  connected_sources: 1, first_activity_at: null, last_activity_at: null, days_of_history: 5,
  needs_you: 2, since: null, events_since: 0, signoffs_since: 0,
};

function appFor(auth: Record<string, unknown>, capture: { event?: Record<string, unknown>; wsId?: string }) {
  const app = new Hono();
  app.use('*', async (ctx, next) => {
    ctx.set('request_id', 'test');
    ctx.set('auth', auth as never);
    ctx.set('dal', {
      getWorkspaceActivitySummary: async (id: string) => ({ ...SUMMARY, workspace_id: id }),
      upsertEvent: async (wsId: string, event: Record<string, unknown>) => {
        capture.event = event; capture.wsId = wsId; return { id: event.id, created: true };
      },
    } as never);
    await next();
  });
  app.route('/api/v1', workspacesRoute);
  return app;
}
const digest = (auth: Record<string, unknown>, capture: { event?: Record<string, unknown>; wsId?: string } = {}, id = 'ws1') =>
  appFor(auth, capture).request(`/api/v1/workspaces/${id}/agent/digest`, { method: 'POST' }, ENV as never);

describe('POST /workspaces/:id/agent/digest', () => {
  it('403 for a non-member requesting another workspace', async () => {
    expect((await digest({ user_id: 'u2', workspace_id: 'their-ws', role: 'owner' }, {}, 'someone-else')).status).toBe(403);
  });

  it('403 for a client role', async () => {
    expect((await digest({ user_id: 'u3', workspace_id: 'ws1', role: 'client' })).status).toBe(403);
  });

  it('201 posts a PENDING needs_review proposal into the spine', async () => {
    const cap: { event?: Record<string, unknown> } = {};
    const res = await digest({ user_id: 'u1', workspace_id: 'ws1', role: 'owner' }, cap);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { proposal: { status: string; approval_state: string; summary: string; generated_by: string } };
    expect(body.proposal.status).toBe('needs_review');
    expect(body.proposal.approval_state).toBe('pending');
    expect(body.proposal.summary).toMatch(/Workspace digest/);
    expect(body.proposal.generated_by).toBe('deterministic'); // no AI binding in this ENV → fallback
    // the agent actually posted a governed proposal into the approval queue
    expect(cap.event?.status).toBe('needs_review');
    expect(cap.event?.approval_state).toBe('pending');
    expect(cap.event?.source_tool).toBe('xlooop');
    expect(cap.event?.agent_id).toBe('xlooop:digest-agent');
    expect(cap.event?.next_action).toBe('approve_to_post_digest');
  });

  it('the operator can run it on any workspace', async () => {
    expect((await digest({ user_id: MBP_OWNER }, {}, 'customer-ws')).status).toBe(201);
  });

  it('uses the LLM draft + posts it (still PENDING) when a Workers-AI binding is present', async () => {
    const cap: { event?: Record<string, unknown> } = {};
    const ai = { run: async () => ({ response: 'A productive week across the workspace; the operational record is complete and audit-ready for the period. Next: clear the items awaiting your sign-off.' }) };
    const res = await appFor({ user_id: 'u1', workspace_id: 'ws1', role: 'owner' }, cap)
      .request('/api/v1/workspaces/ws1/agent/digest', { method: 'POST' }, { ...ENV, AI: ai } as never);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { proposal: { generated_by: string; approval_state: string } };
    expect(body.proposal.generated_by).toBe('llm');
    expect(body.proposal.approval_state).toBe('pending'); // governed: the LLM draft is NOT auto-posted
    expect(String(cap.event?.body)).toMatch(/productive week/);
    expect(cap.event?.status).toBe('needs_review');
  });
});
