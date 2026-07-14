// chat-assembly-trace-operator.test.ts · L1 (260710-D) · the OPERATOR/cockpit plane of the durable trace.
// Closes the review's confirmed coverage gap: the customer plane was tested, the operator plane
// (workspaces.ts POST /cockpit-chat) had NO flag-ON coverage — its unique wiring (dynamic import,
// recordGraphEdges, recordBundle, attachAssembly persist) never executed under a live trace. Uses a
// COMPLETE dal stub so it is independent of the pre-existing-red cockpit-chat-route.test.ts.

import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { workspacesRoute } from '../routes/workspaces';

const MBP_OWNER = 'user_operator_mbp';
const BASE_ENV = { MBP_OWNER_USER_ID: MBP_OWNER, MBP_OWNER_LINKED_USER_IDS: '', DATABASE_URL: 'x' };
const AUTH = { user_id: MBP_OWNER, workspace_id: 'org_3EG82', role: 'owner' };
const SCOPE = { workspace_id: 'org_3EG82', project_id: null };
const EVENTS = [
  { id: 'e1', summary: 'feat: thing', status: 'completed', source_tool: 'github', approval_state: null, domain_id: null, visibility: 'internal_workspace', occurred_at: '2026-07-01T00:00:00Z' },
];

// A COMPLETE operator-plane dal stub (the rotted suite's stubs omit getCustomerContextProfile → 500).
function completeDal(captured: { messages?: unknown[] }) {
  return {
    listEventsForOperator: async () => ({ events: EVENTS, pagination: { has_more: false, next_before: null } }),
    getCustomerContextProfile: async () => null,
    listUnifiedGovernance: async () => [],
    getArtefactLineage: async () => [],
    appendChatExchange: async (_u: string, _s: unknown, messages: unknown[]) => { captured.messages = messages; },
  };
}

function ask(env: Record<string, unknown>, captured: { messages?: unknown[] }) {
  const app = new Hono();
  app.use('*', async (ctx, next) => {
    ctx.set('request_id', 'test');
    ctx.set('auth', AUTH as never);
    ctx.set('dal', completeDal(captured) as never);
    await next();
  });
  app.route('/api/v1', workspacesRoute);
  return app.request('/api/v1/cockpit-chat',
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'summarize', scope: SCOPE }) },
    { ...BASE_ENV, ...env } as never);
}

describe('L1 · operator plane (POST /cockpit-chat) assembly trace', () => {
  it('flag OFF: persisted grounded_on has NO assembly (byte-identical persist)', async () => {
    const captured: { messages?: unknown[] } = {};
    const res = await ask({}, captured);
    expect(res.status).toBe(200);
    const assistant = (captured.messages as Array<{ grounded_on?: Record<string, unknown> }>)?.[1];
    expect(assistant?.grounded_on).not.toHaveProperty('assembly');
  });

  it('flag ON: an assembly IS persisted even with role/graph sub-flags OFF (never silently flag-off)', async () => {
    const captured: { messages?: unknown[] } = {};
    const res = await ask({ CHAT_ASSEMBLY_TRACE_ENABLED: 'true' }, captured);
    expect(res.status).toBe(200);
    const assistant = (captured.messages as Array<{ grounded_on?: { assembly?: { plane?: string; bundle?: unknown } } }>)?.[1];
    expect(assistant?.grounded_on?.assembly?.plane).toBe('operator');
    expect(assistant?.grounded_on?.assembly?.bundle).toBeDefined(); // the always-recorded operator bundle
  });

  it('flag ON + role-scoped ON: assembly carries the role_projection', async () => {
    const captured: { messages?: unknown[] } = {};
    const res = await ask({ CHAT_ASSEMBLY_TRACE_ENABLED: 'true', CHAT_ROLE_SCOPED_CONTEXT_ENABLED: 'true' }, captured);
    expect(res.status).toBe(200);
    const assistant = (captured.messages as Array<{ grounded_on?: { assembly?: { role_projection?: { role?: string } } } }>)?.[1];
    expect(assistant?.grounded_on?.assembly?.role_projection?.role).toBeDefined();
  });
});
