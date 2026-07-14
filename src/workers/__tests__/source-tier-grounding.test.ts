// source-tier-grounding.test.ts · D-16 (260710) · the grounding-weight CONSUMER.
// TWO boundaries:
//   A) buildSourceFacts (pure) — absent map ⇒ byte-identical (no access_tier, input order preserved);
//      present map ⇒ each fact annotated + rely/operate ordered FIRST (stable within a tier).
//   B) the route flag gate — OFF ⇒ no sql read at all; ON ⇒ the injected sql read is threaded and
//      fail-safe (a throwing sql never breaks the answer). Proves the wiring, not just the pure core.

import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { buildSourceFacts, customerChatRoute } from '../routes/customer-chat';
import type { SourceTier } from '../services/source-tier';

// Minimal source rows — only the fields buildSourceFacts reads.
function row(id: string, provider: string, workspace_id: string | null = 'org_hy') {
  return {
    id, provider, workspace_id, user_id: 'u1', provider_user_id: null, provider_username: null,
    scopes: [], contract: {}, status: 'connected', connected_at: '2026-07-01T00:00:00Z',
    last_sync_at: null, last_sync_error: null, created_at: '2026-07-01T00:00:00Z', updated_at: '2026-07-01T00:00:00Z',
  } as never;
}

describe('D-16 · buildSourceFacts — absent tier map ⇒ byte-identical', () => {
  it('no access_tier is set and the input order is preserved', () => {
    const facts = buildSourceFacts('org_hy', [row('c1', 'gmail'), row('c2', 'slack')], []);
    expect(facts.map((f) => f.provider)).toEqual(['gmail', 'slack']);
    expect(facts.every((f) => f.access_tier === undefined)).toBe(true);
  });
});

describe('D-16 · buildSourceFacts — present tier map ⇒ annotate + rely-first order', () => {
  it('annotates each source and orders the higher-trust source first (stable within a tier)', () => {
    const tiers = new Map<string, SourceTier>([['c2', 'rely']]); // slack is Rely; gmail has NO binding
    const facts = buildSourceFacts('org_hy', [row('c1', 'gmail'), row('c2', 'slack')], [], tiers);
    expect(facts.map((f) => f.provider)).toEqual(['slack', 'gmail']); // rely leads
    expect(facts.find((f) => f.provider === 'slack')?.access_tier).toBe('rely');
    // gmail has no per-project binding ⇒ access_tier undefined (distinct from 'index' = bound-but-metadata-only);
    // the reorder coalesces undefined→index rank, so it still sorts after the Rely source.
    expect(facts.find((f) => f.provider === 'gmail')?.access_tier).toBeUndefined();
  });

  it('operate outranks rely outranks index', () => {
    const tiers = new Map<string, SourceTier>([['c1', 'index'], ['c2', 'operate'], ['c3', 'rely']]);
    const facts = buildSourceFacts('org_hy', [row('c1', 'a'), row('c2', 'b'), row('c3', 'c')], [], tiers);
    expect(facts.map((f) => f.provider)).toEqual(['b', 'c', 'a']); // operate, rely, index
  });
});

// ── Route flag gate ───────────────────────────────────────────────────────────────────────────────
const AUTH = { user_id: 'u1', workspace_id: 'org_hy', email: 'a@x.example', role: 'member' };
const PROFILE = { schema_id: 'xlooop.customer_context_profile.v1', company: { name: 'Acme', domain: 'x', country: 'AU' },
  focus_90d: null, growth_posture: 'Grow', maturity_level: 'L3', ai_tools_in_use: [], customer_concentration: null,
  cyber_flag: null, notes: null, data_lives_in: [], public_signals: [], provenance: 'stated' };
const GMAIL = { id: 'src_gmail', workspace_id: 'org_hy', user_id: 'u1', provider: 'gmail', provider_user_id: 'g',
  provider_username: 'a@x.example', status: 'connected', scopes: ['gmail.readonly'], connected_at: '2026-07-01T00:00:00Z',
  last_sync_at: '2026-07-09T00:00:00Z', last_sync_error: null };

function appWith(sqlStub: unknown) {
  const dal = {
    getSessionEntitlement: async () => ({ state: 'approved_workspace' }),
    listEvents: async () => ({ events: [], pagination: { has_more: false, next_before: null } }),
    listUserSources: async () => [GMAIL],
    getCustomerContextProfile: async () => PROFILE,
  };
  const app = new Hono();
  app.use('*', async (ctx, next) => {
    ctx.set('request_id', 'test');
    ctx.set('auth', AUTH as never);
    ctx.set('dal', dal as never);
    if (sqlStub) ctx.set('sql', sqlStub as never);
    await next();
  });
  app.route('/api/v1', customerChatRoute);
  return app;
}
const askEnv = (app: Hono, env: Record<string, unknown>) => app.request('/api/v1/customer-chat',
  { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'hi' }) }, env);

describe('D-16 · route flag gate (SOURCE_TIER_GROUNDING_ENABLED)', () => {
  it('flag ON: the injected sql read is threaded and the answer still grounds on the source', async () => {
    let readWorkspace = '';
    // tagged-template stub: sql`SELECT ... WHERE workspace_id = ${wid} ...`
    const sqlStub = (_strings: TemplateStringsArray, ...vals: unknown[]) => {
      readWorkspace = String(vals[0] ?? '');
      return Promise.resolve([{ user_source_connection_id: 'src_gmail', read_policy: 'read_only' }]);
    };
    const res = await askEnv(appWith(sqlStub), { SOURCE_TIER_GROUNDING_ENABLED: 'true' });
    expect(res.status).toBe(200);
    const body = await res.json() as { grounded_on: { sources: { total: number } } };
    expect(readWorkspace).toBe('org_hy');           // tenant-scoped read ran against the JWT workspace only
    expect(body.grounded_on.sources.total).toBe(1); // tier weighting never drops a source
  });

  it('flag ON but the sql read THROWS: fail-safe — the answer still returns 200 and grounds', async () => {
    const throwing = () => { throw new Error('db down'); };
    const res = await askEnv(appWith(throwing), { SOURCE_TIER_GROUNDING_ENABLED: 'true' });
    expect(res.status).toBe(200);
    const body = await res.json() as { grounded_on: { sources: { total: number } } };
    expect(body.grounded_on.sources.total).toBe(1);
  });

  it('flag OFF: the sql read is NEVER called (byte-identical path)', async () => {
    let called = false;
    const spy = () => { called = true; return Promise.resolve([]); };
    const res = await askEnv(appWith(spy), {}); // flag absent
    expect(res.status).toBe(200);
    expect(called).toBe(false);
  });
});
