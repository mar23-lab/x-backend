// intent-enrichment.test.ts · ARCH-006 W6 · packet/intent pre-enrichment
// Tests the generator ladder (Claude→Llama→deterministic, never-throws, no fabricated web_sources) and
// the route wiring (POST /intents best-effort enrichment, GET /intents/:id merge, POST /intents/:id/enrich).

import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { workspacesRoute } from '../routes/workspaces';
import { generateIntentEnrichment } from '../services/packet-enrichment';
import type { AiRunner } from '../services/agent-digest';

const MBP_OWNER = 'user_operator_mbp';
const ENV = { MBP_OWNER_USER_ID: MBP_OWNER, MBP_OWNER_LINKED_USER_IDS: '', DATABASE_URL: 'x' };
const INTENT = { title: 'Ship the read-model', summary: 'consolidate the planes', project_id: 'p1', domain_id: null };

describe('generateIntentEnrichment — the LLM ladder', () => {
  it('returns a deterministic enrichment (empty web_sources) when no ai/claudeKey', async () => {
    const e = await generateIntentEnrichment(INTENT, { similar_intents: [{ title: 'prior thing', status: 'done' }] });
    expect(e.generated_by).toBe('deterministic');
    expect(e.model).toBeNull();
    expect(e.web_sources).toEqual([]);
    expect(e.prior_resources.some((r) => r.includes('prior thing'))).toBe(true);
    expect(e.confidence).toBeGreaterThanOrEqual(0);
  });

  it('parses strict JSON from a stubbed AiRunner → workers_ai', async () => {
    const ai: AiRunner = { run: async () => ({ response: JSON.stringify({ pros: ['fast'], cons: ['risk'], prior_resources: [], web_sources: [], recommended_path: 'do it', metrics: { effort: 'M' }, confidence: 0.7 }) }) };
    const e = await generateIntentEnrichment(INTENT, {}, ai);
    expect(e.generated_by).toBe('workers_ai');
    expect(e.pros).toEqual(['fast']);
    expect(e.recommended_path).toBe('do it');
    expect(e.confidence).toBeCloseTo(0.7);
  });

  it('falls back to deterministic on non-JSON / throwing ai output (never throws)', async () => {
    const garbage: AiRunner = { run: async () => ({ response: 'sorry, here is some prose without json' }) };
    const e1 = await generateIntentEnrichment(INTENT, {}, garbage);
    expect(e1.generated_by).toBe('deterministic');
    const thrower: AiRunner = { run: async () => { throw new Error('ai down'); } };
    const e2 = await generateIntentEnrichment(INTENT, {}, thrower);
    expect(e2.generated_by).toBe('deterministic');
  });

  it('NEVER fabricates web_sources even if the model returns URLs (honesty guard)', async () => {
    const liar: AiRunner = { run: async () => ({ response: JSON.stringify({ pros: [], cons: [], prior_resources: [], web_sources: ['https://made-up.example/x'], recommended_path: '', metrics: {}, confidence: 0.9 }) }) };
    const e = await generateIntentEnrichment(INTENT, {}, liar);
    expect(e.web_sources).toEqual([]); // stripped — no web retrieval wired
  });

  it('tolerates code-fenced JSON', async () => {
    const fenced: AiRunner = { run: async () => ({ response: '```json\n{"pros":["x"],"cons":[],"prior_resources":[],"web_sources":[],"recommended_path":"y","metrics":{},"confidence":0.5}\n```' }) };
    const e = await generateIntentEnrichment(INTENT, {}, fenced);
    expect(e.generated_by).toBe('workers_ai');
    expect(e.pros).toEqual(['x']);
  });
});

type Cap = { upserted?: { id: string; enr: Record<string, unknown> }; created?: Record<string, unknown> };

function dalFor(cap: Cap, opts: { upsertThrows?: boolean; lineage?: unknown } = {}): Record<string, unknown> {
  return {
    listWorkspacesForOperator: async () => [{ id: 'org_3EG82' }],
    listIntentsForOperator: async () => [{ title: 'another', status: 'open' }],
    createIntent: async (input: Record<string, unknown>) => { cap.created = input; return { id: 'intent-new', ...input, summary: input.summary ?? null }; },
    upsertEvent: async () => ({ id: 'evt', created: true }),
    upsertIntentEnrichment: async (id: string, enr: Record<string, unknown>) => { if (opts.upsertThrows) throw new Error('031 missing'); cap.upserted = { id, enr }; },
    getIntentEnrichmentForIntent: async (id: string) => ({ intent_id: id, pros: ['p'], cons: [], prior_resources: [], web_sources: [], recommended_path: 'go', metrics: {}, confidence: 0.3, generated_by: 'deterministic', model: null, status: 'generated', generated_at: '', updated_at: '' }),
    getIntentLineageForOperator: async (_ids: string[], id: string) => opts.lineage !== undefined ? opts.lineage : { intent: { id, title: 'Ship', summary: null, project_id: 'p1', domain_id: null, workspace_id: 'org_3EG82' }, child_events: [], derived_intents: [] },
  };
}

function appWith(auth: Record<string, unknown>, dal: Record<string, unknown>) {
  const app = new Hono();
  app.use('*', async (ctx, next) => { ctx.set('request_id', 'test'); ctx.set('auth', auth as never); ctx.set('dal', dal as never); await next(); });
  app.route('/api/v1', workspacesRoute);
  return app;
}

describe('POST /intents — best-effort enrichment at create-time', () => {
  it('201 sets enrichment_generated=true when the upsert succeeds', async () => {
    const cap: Cap = {};
    const res = await appWith({ user_id: MBP_OWNER }, dalFor(cap)).request('/api/v1/intents', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Do X', workspace_id: 'org_3EG82' }) }, ENV as never);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { enrichment_generated: boolean };
    expect(body.enrichment_generated).toBe(true);
    expect(cap.upserted?.id).toBe('intent-new');
  });
  it('a failing enrichment upsert never blocks the create (201, enrichment_generated=false)', async () => {
    const res = await appWith({ user_id: MBP_OWNER }, dalFor({}, { upsertThrows: true })).request('/api/v1/intents', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Do X', workspace_id: 'org_3EG82' }) }, ENV as never);
    expect(res.status).toBe(201);
    expect((await res.json() as { enrichment_generated: boolean }).enrichment_generated).toBe(false);
  });
});

describe('GET /intents/:id — merges the enrichment', () => {
  it('includes enrichment when present', async () => {
    const res = await appWith({ user_id: MBP_OWNER }, dalFor({})).request('/api/v1/intents/intent-abc', { method: 'GET' }, ENV as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { enrichment: { pros: string[] } | null };
    expect(body.enrichment?.pros).toEqual(['p']);
  });
});

describe('POST /intents/:id/enrich — on-demand regen', () => {
  it('403 for a non-operator', async () => {
    const res = await appWith({ user_id: 'x' }, dalFor({})).request('/api/v1/intents/i1/enrich', { method: 'POST' }, ENV as never);
    expect(res.status).toBe(403);
  });
  it('404 when the intent is not the operator\'s', async () => {
    const res = await appWith({ user_id: MBP_OWNER }, dalFor({}, { lineage: null })).request('/api/v1/intents/i1/enrich', { method: 'POST' }, ENV as never);
    expect(res.status).toBe(404);
  });
  it('200 + a regenerated enrichment for the operator\'s own intent', async () => {
    const cap: Cap = {};
    const res = await appWith({ user_id: MBP_OWNER }, dalFor(cap)).request('/api/v1/intents/i1/enrich', { method: 'POST' }, ENV as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { enrichment: { generated_by: string } };
    expect(['claude', 'workers_ai', 'deterministic']).toContain(body.enrichment.generated_by);
    expect(cap.upserted?.id).toBe('i1');
  });
});
