// cockpit-chat-route.test.ts · 2026-06-09
// Route tests for POST /api/v1/cockpit-chat — "Chat-that-acts v1". Asserts operator-only tenancy,
// that the scoped events are READ (project_id passed through to listEventsForOperator), and that the
// returned answer is GROUNDED in the real mocked events (counts + named recent item). DAL mocked.

import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { workspacesRoute } from '../routes/workspaces';

const MBP_OWNER = 'user_operator_mbp';
const ENV = { MBP_OWNER_USER_ID: MBP_OWNER, MBP_OWNER_LINKED_USER_IDS: '', DATABASE_URL: 'x' };

const COCKPIT_EVENTS = [
  { id: 'e1', summary: 'fix(cockpit): legible empty/degraded project banner (#515)', status: 'completed', source_tool: 'github', approval_state: null, domain_id: null, occurred_at: '2026-06-09T03:13:34.000Z' },
  { id: 'e2', summary: 'feat(cockpit): operator overlay on GET /projects/:id/events (#516)', status: 'completed', source_tool: 'github', approval_state: null, domain_id: null, occurred_at: '2026-06-09T03:13:27.000Z' },
  { id: 'e3', summary: 'Owner confirmation needed · OperationsLiveStream v1', status: 'needs_review', source_tool: 'xlooop', approval_state: 'pending', domain_id: null, occurred_at: '2026-06-08T20:00:00.000Z' },
];

function appFor(auth: Record<string, unknown>, capture: { opts?: Record<string, unknown>; ids?: string[] }, env: Record<string, unknown> = ENV) {
  const app = new Hono();
  app.use('*', async (ctx, next) => {
    ctx.set('request_id', 'test');
    ctx.set('auth', auth as never);
    ctx.set('dal', {
      listEventsForOperator: async (ids: string[], opts: Record<string, unknown>) => {
        capture.ids = ids; capture.opts = opts;
        return { events: COCKPIT_EVENTS, pagination: { has_more: false, next_before: null } };
      },
    } as never);
    await next();
  });
  app.route('/api/v1', workspacesRoute);
  return { app, env };
}

const chat = (
  auth: Record<string, unknown>,
  message: string,
  scope: Record<string, unknown>,
  capture: { opts?: Record<string, unknown>; ids?: string[] } = {},
  env: Record<string, unknown> = ENV,
  context_cards?: Array<Record<string, unknown>>,
) => {
  const { app } = appFor(auth, capture, env);
  return app.request('/api/v1/cockpit-chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(context_cards ? { message, scope, context_cards } : { message, scope }),
  }, env as never);
};

const COCKPIT_SCOPE = { workspace_id: 'org_3EG82', project_id: 'org_3EG82-cockpit-ux' };

describe('POST /cockpit-chat', () => {
  it('403 for a non-operator', async () => {
    const res = await chat({ user_id: 'someone-else', workspace_id: 'their-ws', role: 'owner' }, 'summarize', COCKPIT_SCOPE);
    expect(res.status).toBe(403);
  });

  it('400 when message is missing', async () => {
    const res = await chat({ user_id: MBP_OWNER }, '', COCKPIT_SCOPE);
    expect(res.status).toBe(400);
  });

  it('reads the scoped events and returns a GROUNDED answer referencing the real data', async () => {
    const cap: { opts?: Record<string, unknown>; ids?: string[] } = {};
    const res = await chat({ user_id: MBP_OWNER }, 'summarize what is happening here', COCKPIT_SCOPE, cap);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { answer: string; generated_by: string; grounded_on: Record<string, unknown>; scope: Record<string, unknown> };
    // the operator overlay was called WITH the project_id scope
    expect(cap.opts?.project_id).toBe('org_3EG82-cockpit-ux');
    expect(cap.ids).toContain(MBP_OWNER);
    // no AI binding in this ENV → deterministic grounded answer
    expect(body.generated_by).toBe('deterministic');
    // grounded in the REAL mocked events: counts + a named recent item
    expect(body.answer).toMatch(/3 events on record/);
    expect(body.answer).toMatch(/legible empty\/degraded project banner/);
    expect(body.answer).toMatch(/1 awaiting your sign-off/);
    expect(body.grounded_on.completed).toBe(2);
    expect(body.grounded_on.needs_review).toBe(1);
    expect(body.scope).toMatchObject({ project_id: 'org_3EG82-cockpit-ux' });
  });

  it('uses the LLM answer (still grounded provenance) when a Workers-AI binding is present', async () => {
    const cap: { opts?: Record<string, unknown>; ids?: string[] } = {};
    const ai = { run: async () => ({ response: 'This project has 3 events on record, recently shipping the project banner fix and the operator overlay; one item awaits your sign-off.' }) };
    const res = await chat({ user_id: MBP_OWNER }, 'summarize', COCKPIT_SCOPE, cap, { ...ENV, AI: ai });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { answer: string; generated_by: string; grounded_on: { needs_review: number } };
    expect(body.generated_by).toBe('llm');
    expect(body.answer).toMatch(/operator overlay/);
    expect(body.grounded_on.needs_review).toBe(1); // provenance still from real events
  });

  it('answers over the WHOLE workspace when no project_id is given', async () => {
    const cap: { opts?: Record<string, unknown>; ids?: string[] } = {};
    const res = await chat({ user_id: MBP_OWNER }, 'summarize', { workspace_id: 'org_3EG82' }, cap);
    expect(res.status).toBe(200);
    expect(cap.opts?.project_id).toBeUndefined(); // no narrowing → whole workspace
  });

  it('binds a named workspace to the tenant-scoped event read when the full DAL is present', async () => {
    const calls: string[] = [];
    const app = new Hono();
    app.use('*', async (ctx, next) => {
      ctx.set('request_id', 'test');
      ctx.set('auth', { user_id: MBP_OWNER, role: 'owner' } as never);
      ctx.set('dal', {
        operatorOwnsWorkspace: async (_ids: string[], workspaceId: string) => {
          calls.push(`owns:${workspaceId}`);
          return workspaceId === 'org_3EG82';
        },
        listEvents: async (workspaceId: string) => {
          calls.push(`events:${workspaceId}`);
          return { events: COCKPIT_EVENTS, pagination: { has_more: false, next_before: null } };
        },
        listEventsForOperator: async () => { throw new Error('operator-wide read must not serve a named workspace'); },
      } as never);
      await next();
    });
    app.route('/api/v1', workspacesRoute);
    const res = await app.request('/api/v1/cockpit-chat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'summarize', scope: { workspace_id: 'org_3EG82' } }),
    }, ENV as never);
    expect(res.status).toBe(200);
    expect(calls).toEqual(['owns:org_3EG82', 'events:org_3EG82']);
  });

  it('rejects a named workspace outside the operator ownership set', async () => {
    const app = new Hono();
    app.use('*', async (ctx, next) => {
      ctx.set('request_id', 'test');
      ctx.set('auth', { user_id: MBP_OWNER, role: 'owner' } as never);
      ctx.set('dal', {
        operatorOwnsWorkspace: async () => false,
        listEvents: async () => { throw new Error('must not read'); },
      } as never);
      await next();
    });
    app.route('/api/v1', workspacesRoute);
    const res = await app.request('/api/v1/cockpit-chat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'summarize', scope: { workspace_id: 'tenant_b' } }),
    }, ENV as never);
    expect(res.status).toBe(403);
  });

  it('strict lineage mode refuses cross-workspace chat instead of assigning it to a false tenant', async () => {
    const app = new Hono();
    app.use('*', async (ctx, next) => {
      ctx.set('request_id', 'test');
      ctx.set('auth', { user_id: MBP_OWNER, role: 'owner' } as never);
      ctx.set('dal', {
        listEventsForOperator: async () => ({ events: COCKPIT_EVENTS, pagination: { has_more: false, next_before: null } }),
      } as never);
      await next();
    });
    app.route('/api/v1', workspacesRoute);
    const res = await app.request('/api/v1/cockpit-chat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'summarize', scope: { all_workspaces: true } }),
    }, { ...ENV, CONTEXT_PACKET_PERSISTENCE_ENABLED: 'true' } as never);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('CONTEXT_LINEAGE_SCOPE_REQUIRED');
  });

  // The trust fix end-to-end: a governance project with ZERO operation_events but governance packets
  // waiting on the operator's sign-off (Plane B, from the operations-live-stream snapshot). Before the
  // fix the route answered "nothing blocked"; now it reads the snapshot and reports the sign-offs.
  it('surfaces governance sign-offs from the live-stream snapshot even with 0 operation_events', async () => {
    const GOV_ROWS = [1, 2, 3].map((n) => ({
      row_id: `pkt-${n}`, stream_type: 'packet', state: 'evidence_ready',
      workspace_id: 'mbp-private', project_id: 'mbp-governance', domain_id: 'mbp-governance',
      timestamp_iso: '2026-06-09T09:00:00.000Z',
      title: `Owner confirmation · packet ${n}`, summary: 'Evidence ready; awaiting owner sign-off.',
      source_adapter: 'mbp-packet', evidence_refs: [{ uri: 'https://x/ev', label: 'ADR' }],
    }));
    const app = new Hono();
    app.use('*', async (ctx, next) => {
      ctx.set('request_id', 'test');
      ctx.set('auth', { user_id: MBP_OWNER } as never);
      ctx.set('dal', {
        listEventsForOperator: async () => ({ events: [], pagination: { has_more: false, next_before: null } }),
        getLatestLiveStreamSnapshot: async (streamId: string) => {
          expect(streamId).toBe('mbp-operations-live-stream');
          return { source_mode: 'db_live', generated_at: 'x', valid_until: null, rows_count: GOV_ROWS.length, envelope: { rows: GOV_ROWS }, ingested_at: 'x' };
        },
      } as never);
      await next();
    });
    app.route('/api/v1', workspacesRoute);
    const res = await app.request('/api/v1/cockpit-chat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: "what's blocked or needs my sign-off?", scope: { workspace_id: 'mbp-private', project_id: 'mbp-governance' } }),
    }, ENV as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { answer: string; grounded_on: { needs_review: number; planes: { governance: number }; governance: { waiting_owner: number } } };
    expect(body.grounded_on.planes.governance).toBe(3);
    expect(body.grounded_on.governance.waiting_owner).toBe(3);
    expect(body.grounded_on.needs_review).toBe(3);
    expect(body.answer).not.toMatch(/no recorded activity/i);
    expect(body.answer).not.toMatch(/you are clear/i);
    expect(body.answer).toMatch(/sign-off|Governance/i);
  });

  // Wave 3 · persistence. POST /cockpit-chat writes the exchange to the (operator, scope) thread so it
  // survives a reload / another browser; GET /cockpit-chat/history reads it back. Persistence is
  // best-effort — a DAL without the methods (or a throwing one) must never break the live answer.
  it('persists the exchange (you + assistant) to the scoped thread on a successful answer', async () => {
    const captured: { userId?: string; scope?: Record<string, unknown>; messages?: Array<Record<string, unknown>> } = {};
    const app = new Hono();
    app.use('*', async (ctx, next) => {
      ctx.set('request_id', 'test');
      ctx.set('auth', { user_id: MBP_OWNER } as never);
      ctx.set('dal', {
        listEventsForOperator: async () => ({ events: COCKPIT_EVENTS, pagination: { has_more: false, next_before: null } }),
        appendChatExchange: async (userId: string, scope: Record<string, unknown>, messages: Array<Record<string, unknown>>) => {
          captured.userId = userId; captured.scope = scope; captured.messages = messages;
        },
      } as never);
      await next();
    });
    app.route('/api/v1', workspacesRoute);
    const res = await app.request('/api/v1/cockpit-chat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'summarize', scope: COCKPIT_SCOPE, mode: 'ask' }),
    }, ENV as never);
    expect(res.status).toBe(200);
    expect(captured.userId).toBe(MBP_OWNER);
    expect(captured.messages?.length).toBe(2);
    expect(captured.messages?.[0]).toMatchObject({ role: 'you', body: 'summarize' });
    expect(captured.messages?.[1]).toMatchObject({ role: 'assistant' });
    expect(typeof (captured.messages?.[1] as { body?: string }).body).toBe('string');
  });

  it('a persistence failure NEVER breaks the live answer (best-effort)', async () => {
    const app = new Hono();
    app.use('*', async (ctx, next) => {
      ctx.set('request_id', 'test');
      ctx.set('auth', { user_id: MBP_OWNER } as never);
      ctx.set('dal', {
        listEventsForOperator: async () => ({ events: COCKPIT_EVENTS, pagination: { has_more: false, next_before: null } }),
        appendChatExchange: async () => { throw new Error('db down'); },
      } as never);
      await next();
    });
    app.route('/api/v1', workspacesRoute);
    const res = await app.request('/api/v1/cockpit-chat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'summarize', scope: COCKPIT_SCOPE }),
    }, ENV as never);
    expect(res.status).toBe(200); // answer still returned despite the persist throw
  });

  it('GET /cockpit-chat/history returns the stored thread for the operator scope (operator-only)', async () => {
    const STORED = [
      { role: 'you', body: 'summarize', mode: 'ask', generated_by: null, grounded_on: null, created_at: '2026-06-09T09:00:00.000Z' },
      { role: 'assistant', body: 'Here is what is happening…', mode: 'ask', generated_by: 'deterministic', grounded_on: { events_total: 3 }, created_at: '2026-06-09T09:00:01.000Z' },
    ];
    const cap: { userId?: string; scope?: Record<string, unknown> } = {};
    const app = new Hono();
    app.use('*', async (ctx, next) => {
      ctx.set('request_id', 'test');
      ctx.set('auth', { user_id: MBP_OWNER } as never);
      ctx.set('dal', {
        listChatHistory: async (userId: string, scope: Record<string, unknown>) => { cap.userId = userId; cap.scope = scope; return STORED; },
      } as never);
      await next();
    });
    app.route('/api/v1', workspacesRoute);
    const res = await app.request('/api/v1/cockpit-chat/history?workspace_id=org_3EG82&project_id=org_3EG82-cockpit-ux', { method: 'GET' }, ENV as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: Array<Record<string, unknown>> };
    expect(body.messages.length).toBe(2);
    expect(body.messages[0]).toMatchObject({ role: 'you', body: 'summarize' });
    expect(cap.scope).toMatchObject({ workspace_id: 'org_3EG82', project_id: 'org_3EG82-cockpit-ux' });
  });

  it('GET /cockpit-chat/history is 403 for a non-operator', async () => {
    const app = new Hono();
    app.use('*', async (ctx, next) => {
      ctx.set('request_id', 'test');
      ctx.set('auth', { user_id: 'someone-else' } as never);
      ctx.set('dal', { listChatHistory: async () => [] } as never);
      await next();
    });
    app.route('/api/v1', workspacesRoute);
    const res = await app.request('/api/v1/cockpit-chat/history?workspace_id=org_3EG82', { method: 'GET' }, ENV as never);
    expect(res.status).toBe(403);
  });

  // Wave 3b · pinned context cards posted from the cockpit ground the answer on exactly those, even
  // from other scopes. The provenance reports pinned_total so the UI can show "grounded on N pinned".
  it('grounds on the operator-attached context_cards (cross-context)', async () => {
    const cap: { opts?: Record<string, unknown>; ids?: string[] } = {};
    const res = await chat(
      { user_id: MBP_OWNER },
      'what is the status of these two?',
      COCKPIT_SCOPE,
      cap,
      ENV,
      [
        { id: 'pin-1', title: 'x-biz investor packet · evidence ready', state: 'needsrev', workspace_id: 'x-biz' },
        { id: 'pin-2', title: 'mbp governance · waiting owner', state: 'needsrev', workspace_id: 'mbp-private' },
      ],
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { answer: string; grounded_on: { pinned_total: number; pinned: Array<{ summary: string }> } };
    expect(body.grounded_on.pinned_total).toBe(2);
    expect(body.grounded_on.pinned[0].summary).toMatch(/x-biz investor packet/);
    expect(body.answer).toMatch(/You pinned 2 items/);
  });

  // Wave 5a · the durable operations_unified read-model. The chat reads it FIRST (a queryable table)
  // and falls back to the live snapshot, lazily materializing it so the table self-fills.
  const GOV3 = [1, 2, 3].map((n) => ({
    row_id: `pkt-${n}`, stream_type: 'packet', state: 'evidence_ready',
    workspace_id: 'mbp-private', project_id: 'mbp-governance', domain_id: 'mbp-governance',
    timestamp_iso: '2026-06-09T09:00:00.000Z', title: `Owner confirmation · packet ${n}`,
    summary: 'Evidence ready; awaiting owner sign-off.', source_adapter: '', evidence_refs: [],
  }));

  it('reads the governance plane from the durable operations_unified read-model when present', async () => {
    let snapshotRead = false;
    const app = new Hono();
    app.use('*', async (ctx, next) => {
      ctx.set('request_id', 'test');
      ctx.set('auth', { user_id: MBP_OWNER } as never);
      ctx.set('dal', {
        listEventsForOperator: async () => ({ events: [], pagination: { has_more: false, next_before: null } }),
        listUnifiedGovernance: async () => GOV3, // durable table has the rows
        getLatestLiveStreamSnapshot: async () => { snapshotRead = true; return null; }, // must NOT be needed
      } as never);
      await next();
    });
    app.route('/api/v1', workspacesRoute);
    const res = await app.request('/api/v1/cockpit-chat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: "what's waiting?", scope: { workspace_id: 'mbp-private', project_id: 'mbp-governance' } }),
    }, ENV as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { grounded_on: { planes: { governance: number }; governance: { waiting_owner: number } } };
    expect(body.grounded_on.planes.governance).toBe(3);
    expect(body.grounded_on.governance.waiting_owner).toBe(3);
    expect(snapshotRead).toBe(false); // durable read-model served it; the snapshot fallback was not touched
  });

  it('falls back to the live snapshot AND lazily materializes it when the unified table is empty', async () => {
    let materialized: unknown[] | null = null;
    const app = new Hono();
    app.use('*', async (ctx, next) => {
      ctx.set('request_id', 'test');
      ctx.set('auth', { user_id: MBP_OWNER } as never);
      ctx.set('dal', {
        listEventsForOperator: async () => ({ events: [], pagination: { has_more: false, next_before: null } }),
        listUnifiedGovernance: async () => [], // durable table empty → fall back
        getLatestLiveStreamSnapshot: async () => ({ source_mode: 'db_live', generated_at: 'x', valid_until: null, rows_count: 3, envelope: { rows: GOV3 }, ingested_at: 'x' }),
        materializeGovernanceSnapshot: async (rows: unknown[]) => { materialized = rows; return rows.length; },
      } as never);
      await next();
    });
    app.route('/api/v1', workspacesRoute);
    const res = await app.request('/api/v1/cockpit-chat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: "what's waiting?", scope: { workspace_id: 'mbp-private', project_id: 'mbp-governance' } }),
    }, ENV as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { grounded_on: { governance: { waiting_owner: number } } };
    expect(body.grounded_on.governance.waiting_owner).toBe(3); // served from the snapshot fallback
    expect(materialized).not.toBeNull(); // and lazily materialized for next time
    expect((materialized as unknown[]).length).toBe(3);
  });

  // ARCH-006 W1.1 — the operator-wide ("All my workspaces") fix end-to-end. The operator's exact bug:
  // viewing one workspace the chat said "0 blocked" while real blockers sat in ANOTHER owned workspace.
  // With all_workspaces (empty scope) BOTH planes span every owned workspace (HR-SCOPE-SYMMETRY-1).
  it('operator-wide surfaces governance items from MULTIPLE workspaces (the "0 blocked" fix)', async () => {
    const GOV_MULTI = [
      { row_id: 'g1', stream_type: 'packet', state: 'evidence_ready', workspace_id: 'mbp-private', project_id: 'mbp-governance', domain_id: 'mbp-governance', timestamp_iso: '2026-06-09T09:00:00.000Z', title: 'Owner confirmation · A', summary: 'awaiting owner sign-off.', source_adapter: '', evidence_refs: [] },
      { row_id: 'g2', stream_type: 'packet', state: 'evidence_ready', workspace_id: 'org_3EG82VEzc8t3t65XSZ0YDlcaDMI', project_id: 'org-cockpit', domain_id: null, timestamp_iso: '2026-06-09T09:00:00.000Z', title: 'Owner confirmation · B', summary: 'awaiting owner sign-off.', source_adapter: '', evidence_refs: [] },
    ];
    const app = new Hono();
    app.use('*', async (ctx, next) => {
      ctx.set('request_id', 'test');
      ctx.set('auth', { user_id: MBP_OWNER } as never);
      ctx.set('dal', {
        listEventsForOperator: async () => ({ events: [], pagination: { has_more: false, next_before: null } }),
        listUnifiedGovernance: async () => GOV_MULTI,
      } as never);
      await next();
    });
    app.route('/api/v1', workspacesRoute);
    const res = await app.request('/api/v1/cockpit-chat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: "what's blocked across everything?", scope: { workspace_id: '', all_workspaces: true } }),
    }, ENV as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { grounded_on: { planes: { governance: number } } };
    // BOTH workspaces' governance rows are counted — not just one (the bug was it saw only the scoped ws).
    expect(body.grounded_on.planes.governance).toBe(2);
  });

  it('narrowing to a single workspace still excludes other workspaces (no over-widening)', async () => {
    const GOV_MULTI = [
      { row_id: 'g1', stream_type: 'packet', state: 'evidence_ready', workspace_id: 'mbp-private', project_id: 'mbp-governance', domain_id: 'mbp-governance', timestamp_iso: '2026-06-09T09:00:00.000Z', title: 'Owner confirmation · A', summary: 'x', source_adapter: '', evidence_refs: [] },
      { row_id: 'g2', stream_type: 'packet', state: 'evidence_ready', workspace_id: 'org_3EG82', project_id: 'org-cockpit', domain_id: null, timestamp_iso: '2026-06-09T09:00:00.000Z', title: 'Owner confirmation · B', summary: 'x', source_adapter: '', evidence_refs: [] },
    ];
    const app = new Hono();
    app.use('*', async (ctx, next) => {
      ctx.set('request_id', 'test');
      ctx.set('auth', { user_id: MBP_OWNER } as never);
      ctx.set('dal', { listEventsForOperator: async () => ({ events: [], pagination: { has_more: false, next_before: null } }), listUnifiedGovernance: async () => GOV_MULTI } as never);
      await next();
    });
    app.route('/api/v1', workspacesRoute);
    const res = await app.request('/api/v1/cockpit-chat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'what is here?', scope: { workspace_id: 'mbp-private' } }),
    }, ENV as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { grounded_on: { planes: { governance: number } } };
    expect(body.grounded_on.planes.governance).toBe(1); // only mbp-private, not org_3EG82
  });

  it('a non-operator CANNOT reach the cross-workspace path (403 even with all_workspaces)', async () => {
    const res = await chat({ user_id: 'someone-else', role: 'owner' }, "what's blocked?", { workspace_id: '', all_workspaces: true });
    expect(res.status).toBe(403);
  });
});
