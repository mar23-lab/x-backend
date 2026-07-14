// chat-assembly-trace.test.ts · L1 (260710-D) · the durable context-assembly trace.
// DECLARED AXES: pure collector (record/finalize/attach semantics · redaction whitelist · clamps ·
// never-throw) · route flag gate (OFF ⇒ persisted grounded_on unchanged BY REFERENCE · ON ⇒ assembly
// present with the recorded sections · a throwing recorder never breaks the answer or the persist).

import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { createAssemblyTrace, finalizeAssemblyTrace, attachAssembly } from '../services/chat-assembly-trace';
import { customerChatRoute } from '../routes/customer-chat';

// ── Pure collector ────────────────────────────────────────────────────────────────────────────────
describe('L1 · createAssemblyTrace / finalizeAssemblyTrace', () => {
  it('nothing recorded ⇒ finalize is null (no empty assembly objects persisted)', () => {
    expect(finalizeAssemblyTrace(createAssemblyTrace('customer'))).toBeNull();
    expect(finalizeAssemblyTrace(null)).toBeNull();
  });

  it('records the five sections with plane', () => {
    const t = createAssemblyTrace('customer');
    t.recordRoleProjection({ role: 'viewer', ceiling: ['customer_visible'], events: { considered: 3, grounded: 1, excluded_by_visibility: 2 }, documents: { considered: 0, grounded: 0, excluded_by_admissibility: 0, candidate_flagged: 0 }, lineage: { considered: 0, grounded: 0 } });
    t.recordOverrideDemotions({ demoted_count: 1, superseding_providers: ['gmail'] });
    t.recordTierWeights([{ provider: 'gmail', access_tier: 'rely' }, { provider: 'slack' }]);
    t.recordGraphEdges({ considered: 40, selected: 30, cause_chains: 2 });
    t.recordBundle({ events: 1, sources_total: 2, sources_connected: 1, generated_by: 'deterministic' });
    const a = finalizeAssemblyTrace(t) as Record<string, unknown>;
    expect(a.plane).toBe('customer');
    expect(Object.keys(a).sort()).toEqual(['bundle', 'graph_edges', 'override_demotions', 'plane', 'role_projection', 'tier_weights']);
    expect((a.tier_weights as { rely: number }).rely).toBe(1);
    expect((a.tier_weights as { providers: unknown[] }).providers).toHaveLength(1); // only tiered sources
  });

  it('REDACTION: forbidden keys (body/text/email/token/summary/name) are stripped recursively', () => {
    const t = createAssemblyTrace('operator');
    t.recordBundle({ events: 1, sources_total: 1, sources_connected: 1, generated_by: 'llm' });
    // sneak forbidden keys through a loosely-typed record call
    (t.recordRoleProjection as (x: unknown) => void)({ role: 'owner', body: 'SECRET', user_email: 'a@b.co', nested: { summary: 'SECRET', ok: 1 } });
    const a = finalizeAssemblyTrace(t) as Record<string, unknown>;
    const s = JSON.stringify(a);
    expect(s).not.toContain('SECRET');
    expect(s).not.toContain('a@b.co');
    expect((a.role_projection as { nested: { ok: number } }).nested.ok).toBe(1); // safe siblings survive
  });

  it('REDACTION fails CLOSED past the depth budget: a forbidden key nested deep cannot leak', () => {
    const t = createAssemblyTrace('customer');
    // build a chain deeper than the depth-6 budget ending in a forbidden key
    let deep: Record<string, unknown> = { body: 'DEEP_SECRET' };
    for (let i = 0; i < 10; i += 1) deep = { level: deep };
    (t.recordRoleProjection as (x: unknown) => void)({ role: 'owner', chain: deep });
    t.recordBundle({ events: 0, sources_total: 0, sources_connected: 0, generated_by: 'llm' });
    const s = JSON.stringify(finalizeAssemblyTrace(t));
    expect(s).not.toContain('DEEP_SECRET'); // collapsed to '[depth-clamped]', never returned raw
    expect(s).toContain('depth-clamped');
  });

  it('CLAMP: arrays cap at 50; an over-8KB trace collapses arrays to counts with clamped:true', () => {
    const t = createAssemblyTrace('customer');
    // 50 surviving entries × ~200-char provider strings ⇒ >8KB post-sanitize ⇒ the collapse path fires.
    t.recordTierWeights(Array.from({ length: 200 }, (_, i) => ({ provider: `p${i}`.padEnd(200, 'x'), access_tier: 'rely' })));
    const a = finalizeAssemblyTrace(t) as { clamped?: boolean; tier_weights: { providers: number | unknown[]; rely: number } };
    expect(a.clamped).toBe(true);
    expect(typeof a.tier_weights.providers).toBe('number'); // collapsed to a count
    expect(a.tier_weights.rely).toBe(200);                  // counts survive the collapse
  });

  it('attachAssembly: null trace returns grounded_on UNCHANGED BY REFERENCE (flag-off guarantee)', () => {
    const g = { event_ids: ['e1'] };
    expect(attachAssembly(g, null)).toBe(g);
    const t = createAssemblyTrace('customer'); // nothing recorded ⇒ also unchanged
    expect(attachAssembly(g, t)).toBe(g);
  });

  it('attachAssembly merges without mutating the input', () => {
    const g = { event_ids: ['e1'] };
    const t = createAssemblyTrace('customer');
    t.recordBundle({ events: 0, sources_total: 0, sources_connected: 0, generated_by: 'deterministic' });
    const merged = attachAssembly(g, t) as Record<string, unknown>;
    expect(merged).not.toBe(g);
    expect((merged.assembly as { plane: string }).plane).toBe('customer');
    expect(g).toEqual({ event_ids: ['e1'] }); // input untouched
  });
});

// ── Route flag gate (customer plane) ──────────────────────────────────────────────────────────────
const AUTH = { user_id: 'u1', workspace_id: 'org_hy', email: 'a@x.example', role: 'member' };
const PROFILE = { schema_id: 'xlooop.customer_context_profile.v1', company: { name: 'Acme', domain: 'x', country: 'AU' },
  focus_90d: null, growth_posture: 'Grow', maturity_level: 'L3', ai_tools_in_use: [], customer_concentration: null,
  cyber_flag: null, notes: null, data_lives_in: [], public_signals: [], provenance: 'stated' };

function appWithCapture(captured: { messages: unknown[] }) {
  const dal = {
    getSessionEntitlement: async () => ({ state: 'approved_workspace' }),
    listEvents: async () => ({ events: [], pagination: { has_more: false, next_before: null } }),
    listUserSources: async () => [],
    getCustomerContextProfile: async () => PROFILE,
    appendChatExchange: async (_u: string, _s: unknown, messages: unknown[]) => { captured.messages = messages; },
  };
  const app = new Hono();
  app.use('*', async (ctx, next) => {
    ctx.set('request_id', 'test');
    ctx.set('auth', AUTH as never);
    ctx.set('dal', dal as never);
    await next();
  });
  app.route('/api/v1', customerChatRoute);
  return app;
}
// internal-builder suite: asserts the raw grounded_on trace — opt out of the default-ON customer-safe
// serializer (P3 260714) so the pre-serializer contract stays testable.
const ask = (app: Hono, env: Record<string, unknown>) => app.request('/api/v1/customer-chat',
  { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'hi' }) }, { CUSTOMER_SAFE_SERIALIZER_ENABLED: 'false', ...env });

describe('L1 · route flag gate (CHAT_ASSEMBLY_TRACE_ENABLED)', () => {
  it('flag OFF: the persisted grounded_on is the result grounded_on UNCHANGED (no assembly key)', async () => {
    const captured = { messages: [] as unknown[] };
    const res = await ask(appWithCapture(captured), {});
    expect(res.status).toBe(200);
    const body = await res.json() as { grounded_on: unknown };
    const assistant = captured.messages[1] as { grounded_on: Record<string, unknown> };
    expect(assistant.grounded_on).toEqual(body.grounded_on);       // identical content…
    expect(assistant.grounded_on).not.toHaveProperty('assembly');  // …no trace key
  });

  it('flag ON: the persisted grounded_on carries assembly (plane customer + bundle); response body unchanged', async () => {
    const captured = { messages: [] as unknown[] };
    const res = await ask(appWithCapture(captured), { CHAT_ASSEMBLY_TRACE_ENABLED: 'true' });
    expect(res.status).toBe(200);
    const body = await res.json() as { grounded_on: Record<string, unknown> };
    const assistant = captured.messages[1] as { grounded_on: { assembly?: { plane?: string; bundle?: { generated_by?: string } } } };
    expect(assistant.grounded_on.assembly?.plane).toBe('customer');
    expect(assistant.grounded_on.assembly?.bundle?.generated_by).toBe('deterministic');
    expect(body.grounded_on).not.toHaveProperty('assembly'); // trace is the PERSISTENCE plane, not the live response
  });

  it('flag ON + role-scoped flag ON: role_projection is captured alongside', async () => {
    const captured = { messages: [] as unknown[] };
    const res = await ask(appWithCapture(captured), { CHAT_ASSEMBLY_TRACE_ENABLED: 'true', CHAT_ROLE_SCOPED_CONTEXT_ENABLED: 'true' });
    expect(res.status).toBe(200);
    const assistant = captured.messages[1] as { grounded_on: { assembly?: { role_projection?: { role?: string } } } };
    expect(assistant.grounded_on.assembly?.role_projection?.role).toBeDefined();
  });
});
