// graph-document-nodes.test.ts · W3 (260708) · G5/G1 — documents as first-class lineage nodes + the
// customer's own lineage read. DECLARED COVERAGE AXES: flag_states [documents absent (off) / present (on)] ·
// actors [provisioned customer / unprovisioned / no-workspace] · data_states [versioned docs · evidence-linked ·
// orphan hash · foreign-workspace doc].

import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { buildDataGraph, computeGraphHash, type DataGraphFacts } from '../graph/data-graph';
import { customerLineageRoute } from '../routes/customer-lineage';

const BASE = (): DataGraphFacts => ({
  workspaces: [{ id: 'ws-1', name: 'Acme' }],
  projects: [{ id: 'p1', workspace_id: 'ws-1', name: 'P1' }],
  lenses: [],
  memberships: [],
  intents: [{ id: 'i1', workspace_id: 'ws-1', project_id: 'p1', title: 'Intent' }],
  unified: [
    { id: 'e1', plane: 'event_sourcing', source_plane_id: 'e1', workspace_id: 'ws-1', project_id: 'p1', kind: 'operator', occurred_at: '2026-07-01T00:00:00Z', summary: 'ev', intent_id: 'i1' },
    { id: 'g1', plane: 'governance', source_plane_id: 'pk1', workspace_id: 'ws-1', project_id: 'p1', kind: 'packet', occurred_at: '2026-07-02T00:00:00Z', summary: 'pk' },
  ],
});

describe('buildDataGraph · document nodes (W3, flag-gated at facts assembly)', () => {
  it('FLAG-OFF PARITY: facts without documents produce a hash byte-identical to pre-W3', () => {
    const a = buildDataGraph('ws-1', BASE());
    const b = buildDataGraph('ws-1', { ...BASE(), documents: undefined, evidenceLinks: undefined });
    expect(a.snapshot.graph_hash).toBe(b.snapshot.graph_hash);
    expect(a.nodes.some((n) => n.type === 'document')).toBe(false);
  });

  it('document nodes: project contains, version chain = derived_from, evidences via content_hash join', () => {
    const facts: DataGraphFacts = {
      ...BASE(),
      documents: [
        { id: 'd1', workspace_id: 'ws-1', project_id: 'p1', title: 'Contract v1', content_hash: 'aaa', created_at: '2026-07-01T00:00:00Z' },
        { id: 'd2', workspace_id: 'ws-1', project_id: 'p1', title: 'Contract v2', content_hash: 'bbb', supersedes_id: 'd1', created_at: '2026-07-02T00:00:00Z' },
        { id: 'dx', workspace_id: 'ws-OTHER', title: 'foreign doc', content_hash: 'zzz' }, // must NOT appear
      ],
      evidenceLinks: [
        { content_hash: 'bbb', packet_id: 'pk1', event_id: null },   // → packet exists → edge
        { content_hash: 'bbb', event_id: 'e1', packet_id: null },    // → event exists → edge
        { content_hash: 'orphan', packet_id: 'pk1' },                // no doc with this hash → nothing
        { content_hash: 'aaa', event_id: 'e-missing' },              // endpoint missing → no edge
      ],
    };
    const { nodes, edges } = buildDataGraph('ws-1', facts);
    const docNodes = nodes.filter((n) => n.type === 'document').map((n) => n.id).sort();
    expect(docNodes).toEqual(['document:d1', 'document:d2']); // foreign-workspace doc excluded
    const has = (f: string, ty: string, to: string) => edges.some((e) => e.from === f && e.type === ty && e.to === to);
    expect(has('project:p1', 'contains', 'document:d1')).toBe(true);
    expect(has('document:d2', 'derived_from', 'document:d1')).toBe(true);   // version chain IS derivation
    expect(has('document:d2', 'evidences', 'packet:pk1')).toBe(true);
    expect(has('document:d2', 'evidences', 'event:e1')).toBe(true);
    expect(edges.some((e) => e.type === 'evidences' && e.to === 'event:e-missing')).toBe(false); // both-endpoints discipline
  });

  it('deterministic: same facts → same hash (with documents)', () => {
    const facts = { ...BASE(), documents: [{ id: 'd1', workspace_id: 'ws-1', project_id: 'p1', title: 'D', content_hash: 'h1' }] };
    expect(buildDataGraph('ws-1', facts).snapshot.graph_hash).toBe(buildDataGraph('ws-1', facts).snapshot.graph_hash);
    expect(computeGraphHash(buildDataGraph('ws-1', facts).nodes, buildDataGraph('ws-1', facts).edges)).toBeTruthy();
  });
});

// ── customer-lineage route: tenant-safe by construction ─────────────────────────
function appFor(auth: Record<string, unknown>, dal: Record<string, unknown>, env: Record<string, unknown> = {}) {
  const app = new Hono();
  app.use('*', async (ctx, next) => { ctx.set('request_id', 't'); ctx.set('auth', auth as never); ctx.set('dal', dal as never); await next(); });
  app.route('/', customerLineageRoute);
  return { app, env: env as never };
}
const PROVISIONED = { getSessionEntitlement: async () => ({ state: 'approved_workspace' }) };

describe('GET /customer-lineage · tenant-safe', () => {
  it('no signed-in workspace → 403', async () => {
    const { app, env } = appFor({ user_id: 'u1' }, PROVISIONED);
    const res = await app.request('/customer-lineage', {}, env);
    expect(res.status).toBe(403);
  });

  it('unprovisioned workspace → 403', async () => {
    const { app, env } = appFor({ user_id: 'u1', workspace_id: 'ws-1' }, { getSessionEntitlement: async () => ({ state: 'pending' }) });
    const res = await app.request('/customer-lineage', {}, env);
    expect(res.status).toBe(403);
  });

  it('provisioned → reads ONLY the JWT workspace (dal called with auth.workspace_id, never a query param)', async () => {
    const calls: string[] = [];
    const dal = { ...PROVISIONED, getArtefactLineage: async (ws: string) => { calls.push(ws); return [{ edge_from: 'intent:i1', edge_to: 'event:e1', edge_type: 'realizes' }]; } };
    // owner: lineage is now an owner/operator-class governance surface (see customer-lineage-authority.test.ts)
    const { app, env } = appFor({ user_id: 'u1', workspace_id: 'ws-MINE', role: 'owner' }, dal);
    // attacker passes a foreign workspace as a query param — it must be IGNORED (no such param is read)
    const res = await app.request('/customer-lineage?workspace_id=ws-VICTIM&node=intent:i1', {}, env);
    expect(res.status).toBe(200);
    expect(calls).toEqual(['ws-MINE']);
    const body = await res.json() as { edges: unknown[]; data_class?: string };
    expect(body.edges.length).toBe(1);
  });

  it('unbuilt graph degrades to empty edges, not an error', async () => {
    const dal = { ...PROVISIONED, getArtefactLineage: async () => { throw new Error('relation v_artefact_lineage does not exist'); } };
    const { app, env } = appFor({ user_id: 'u1', workspace_id: 'ws-1', role: 'owner' }, dal);
    const res = await app.request('/customer-lineage', {}, env);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { edges: unknown[] }).edges).toEqual([]);
  });
});
