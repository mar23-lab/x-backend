// persist-data-graph.test.ts · ADR-XLOOP-ARCH-003 Phase 2 · buildDataGraph's first real caller.
// Proves the orchestration (assemble → build → drift-compare → persist) + the tenant-safe digest,
// against an in-memory fake DAL (the SQL itself is validated separately on a Neon dev branch).

import { describe, it, expect } from 'vitest';
import { persistDataGraph, checkGraphDrift, tenantSafeGraphDigest, type GraphPersistDeps } from '../graph/persist-data-graph';
import { buildDataGraph, type DataGraphFacts } from '../graph/data-graph';
import type { GraphSnapshotRow } from '../dal/graph-store';

const FACTS = (): DataGraphFacts => ({
  workspaces: [{ id: 'ws-1', name: 'Acme' }],
  projects: [{ id: 'proj-a', workspace_id: 'ws-1', name: 'Alpha', created_at: '2026-06-01T00:00:00Z' }],
  lenses: [],
  memberships: [],
  intents: [{ id: 'int-1', workspace_id: 'ws-1', project_id: 'proj-a', title: 'goal', derived_from: null, created_at: '2026-06-02T00:00:00Z' }],
  unified: [{ id: 'u1', plane: 'event_sourcing', source_plane_id: 'evt-1', workspace_id: 'ws-1', project_id: 'proj-a', kind: 'event', occurred_at: '2026-06-03T00:00:00Z', summary: 'did a thing', intent_id: 'int-1' }],
  bindings: [{ id: 'psb-1', workspace_id: 'ws-1', project_id: 'proj-a', source_kind: 'github_repo', source_ref: { label: 'acme/api' }, created_at: '2026-05-30T00:00:00Z' }],
  causation: [],
});

/** In-memory fake: holds the latest snapshot + the last replace call. */
function fakeDeps(facts: DataGraphFacts) {
  let latest: GraphSnapshotRow | null = null;
  const replaced: Array<{ nodeCount: number; edgeCount: number; hash: string }> = [];
  const deps: GraphPersistDeps = {
    assembleDataGraphFacts: async () => facts,
    getLatestGraphSnapshot: async () => latest,
    replaceWorkspaceGraph: async (_ws, nodes, edges, meta, _at) => {
      replaced.push({ nodeCount: nodes.length, edgeCount: edges.length, hash: meta.graph_hash });
      latest = { workspace_id: 'ws-1', generated_at: _at, graph_version: meta.graph_version, graph_hash: meta.graph_hash, node_count: meta.node_count, edge_count: meta.edge_count };
    },
  };
  return { deps, replaced, setLatest: (s: GraphSnapshotRow | null) => { latest = s; } };
}

describe('persistDataGraph — the first real caller', () => {
  it('first build: drift=new, persists, returns the hash + counts', async () => {
    const { deps, replaced } = fakeDeps(FACTS());
    const r = await persistDataGraph(deps, 'ws-1', '2026-06-10T00:00:00Z');
    expect(r.drift).toBe('new');
    expect(r.persisted).toBe(true);
    expect(r.node_count).toBeGreaterThan(0);
    expect(replaced).toHaveLength(1);
    expect(replaced[0].hash).toBe(r.graph_hash);
  });

  it('idempotent: a second build over unchanged facts is drift=fresh and does NOT re-persist', async () => {
    const { deps, replaced } = fakeDeps(FACTS());
    await persistDataGraph(deps, 'ws-1', '2026-06-10T00:00:00Z');     // new → persists
    const r2 = await persistDataGraph(deps, 'ws-1', '2026-06-10T01:00:00Z'); // unchanged → fresh
    expect(r2.drift).toBe('fresh');
    expect(r2.persisted).toBe(false);
    expect(replaced).toHaveLength(1); // only the first write
  });

  it('changed facts → drift=changed → re-persists with a new hash', async () => {
    const facts = FACTS();
    const { deps, replaced } = fakeDeps(facts);
    await persistDataGraph(deps, 'ws-1', '2026-06-10T00:00:00Z');
    facts.unified.push({ id: 'u2', plane: 'event_sourcing', source_plane_id: 'evt-2', workspace_id: 'ws-1', project_id: 'proj-a', kind: 'event', occurred_at: '2026-06-09T00:00:00Z', summary: 'another' });
    const r = await persistDataGraph(deps, 'ws-1', '2026-06-10T02:00:00Z');
    expect(r.drift).toBe('changed');
    expect(r.persisted).toBe(true);
    expect(replaced).toHaveLength(2);
    expect(replaced[1].hash).not.toBe(replaced[0].hash);
  });
});

describe('checkGraphDrift — the read-side drift gate', () => {
  it('reports fresh when the stored hash matches a re-projection', async () => {
    const { deps } = fakeDeps(FACTS());
    await persistDataGraph(deps, 'ws-1', '2026-06-10T00:00:00Z');
    const d = await checkGraphDrift(deps, 'ws-1');
    expect(d.drift).toBe('fresh');
    expect(d.stored_hash).toBe(d.fresh_hash);
  });
  it('reports changed when the facts drifted from the stored snapshot', async () => {
    const facts = FACTS();
    const { deps } = fakeDeps(facts);
    await persistDataGraph(deps, 'ws-1', '2026-06-10T00:00:00Z');
    facts.projects.push({ id: 'proj-b', workspace_id: 'ws-1', name: 'Beta', created_at: '2026-06-08T00:00:00Z' });
    const d = await checkGraphDrift(deps, 'ws-1');
    expect(d.drift).toBe('changed');
    expect(d.stored_hash).not.toBe(d.fresh_hash);
  });
});

describe('tenantSafeGraphDigest — IP-light export aggregate', () => {
  it('emits counts + recent + root-causes, no derivation IP', () => {
    const { nodes, edges, snapshot } = buildDataGraph('ws-1', FACTS());
    const d = tenantSafeGraphDigest('ws-1', nodes, edges, snapshot.graph_hash, '2026-06-10T00:00:00Z');
    expect(d.schema_id).toBe('xlooop.product_graph_digest.v1');
    expect(d.node_counts.event).toBe(1);
    expect(d.node_counts.source).toBe(1);
    expect(d.recent.length).toBeGreaterThan(0);
    // the digest is a flat aggregate — it carries NO derivation fingerprint / binding internals
    expect(JSON.stringify(d)).not.toMatch(/derivation_fingerprint|source_ref|binding_version/);
  });
});
