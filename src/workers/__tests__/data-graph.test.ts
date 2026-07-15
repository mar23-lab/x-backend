// data-graph.test.ts · ADR-XLOOP-IA-001 R3 · the unified temporal data-graph projection.
// Proves: the projection is correct (nodes/edges from facts), workspace-scoped (tenant isolation),
// temporally stamped, PURE (mutates no input), the typed domain_id resolver disambiguates lens vs life,
// and the graph_hash is deterministic + drift-detectable.

import { describe, it, expect } from 'vitest';
import { buildDataGraph, resolveDomainId, computeGraphHash, traceCause, effectNodesRequiringCause, type DataGraphFacts } from '../graph/data-graph';

const FACTS = (): DataGraphFacts => ({
  workspaces: [{ id: 'ws-1', name: 'Acme' }, { id: 'ws-OTHER', name: 'Other tenant' }],
  projects: [
    { id: 'proj-a', workspace_id: 'ws-1', created_at: '2026-06-01T00:00:00Z' },
    { id: 'proj-b', workspace_id: 'ws-1', created_at: '2026-06-02T00:00:00Z' },
    { id: 'proj-X', workspace_id: 'ws-OTHER', created_at: '2026-06-01T00:00:00Z' }, // foreign tenant
  ],
  lenses: [{ id: 'sd-investor', workspace_id: 'ws-1', label: 'Investor-facing', created_at: '2026-06-03T00:00:00Z' }],
  memberships: [{ domain_id: 'sd-investor', project_id: 'proj-a' }],
  intents: [
    { id: 'int-root', workspace_id: 'ws-1', project_id: 'proj-a', domain_id: 'sd-investor', derived_from: null, created_at: '2026-06-04T00:00:00Z' },
    { id: 'int-child', workspace_id: 'ws-1', project_id: 'proj-a', derived_from: 'int-root', created_at: '2026-06-05T00:00:00Z' },
  ],
  unified: [
    { id: 'u1', plane: 'event_sourcing', source_plane_id: 'evt-1', workspace_id: 'ws-1', project_id: 'proj-a', kind: 'event', occurred_at: '2026-06-06T00:00:00Z', ingested_at: '2026-06-06T00:01:00Z', intent_id: 'int-root', summary: 'shipped X' },
    { id: 'u2', plane: 'governance', source_plane_id: 'pkt-1', workspace_id: 'ws-1', project_id: 'proj-a', kind: 'packet', occurred_at: '2026-06-07T00:00:00Z', ingested_at: '2026-06-07T00:01:00Z', domain_id: 'sd-investor', summary: 'sign-off needed' },
    { id: 'u3', plane: 'event_sourcing', source_plane_id: 'evt-X', workspace_id: 'ws-OTHER', project_id: 'proj-X', kind: 'event', occurred_at: '2026-06-06T00:00:00Z', summary: 'foreign' },
  ],
});

describe('buildDataGraph — derived projection', () => {
  it('projects canonical task packets directly and links their source event', () => {
    const facts = FACTS();
    facts.unified.push({ id: 'evt-source', source_plane_id: 'evt-source', plane: 'event_sourcing', workspace_id: 'ws-1', project_id: 'proj-a', kind: 'event' });
    facts.packets = [{ id: 'pkt-intake', workspace_id: 'ws-1', project_id: 'proj-a', event_id: 'evt-source', title: 'Launch pilot', summary: 'Governed intake result', created_at: '2026-07-15T00:00:00Z' }];
    const { nodes, edges } = buildDataGraph('ws-1', facts);
    expect(nodes.find((n) => n.id === 'packet:pkt-intake')).toMatchObject({ type: 'packet', plane: 'governance', description: 'Governed intake result' });
    expect(edges).toContainEqual({ from: 'project:proj-a', to: 'packet:pkt-intake', type: 'scopes' });
    expect(edges).toContainEqual({ from: 'packet:pkt-intake', to: 'event:evt-source', type: 'caused_by' });
  });
  it('projects the 6 node types, workspace-scoped, with the right edges', () => {
    const { nodes, edges } = buildDataGraph('ws-1', FACTS());
    const byType = (t: string) => nodes.filter((n) => n.type === t).map((n) => n.ref_id).sort();
    expect(byType('workspace')).toEqual(['ws-1']);
    expect(byType('project')).toEqual(['proj-a', 'proj-b']);     // foreign proj-X excluded
    expect(byType('lens')).toEqual(['sd-investor']);
    expect(byType('intent')).toEqual(['int-child', 'int-root']);
    expect(byType('event')).toEqual(['evt-1']);                  // foreign evt-X excluded
    expect(byType('packet')).toEqual(['pkt-1']);
    // edges
    const has = (from: string, type: string, to: string) => edges.some((e) => e.from === from && e.type === type && e.to === to);
    expect(has('workspace:ws-1', 'contains', 'project:proj-a')).toBe(true);
    expect(has('lens:sd-investor', 'views', 'project:proj-a')).toBe(true);       // lens → project, never reverse
    expect(has('project:proj-a', 'scopes', 'intent:int-root')).toBe(true);
    expect(has('intent:int-child', 'derived_from', 'intent:int-root')).toBe(true);
    expect(has('event:evt-1', 'realizes', 'intent:int-root')).toBe(true);
  });

  it('TENANT ISOLATION: no foreign-workspace node leaks', () => {
    const { nodes } = buildDataGraph('ws-1', FACTS());
    expect(nodes.every((n) => n.workspace_id === 'ws-1')).toBe(true);
    expect(nodes.some((n) => n.ref_id === 'proj-X' || n.ref_id === 'evt-X')).toBe(false);
  });

  it('every fact node carries its bitemporal stamps (occurred_at / ingested_at)', () => {
    const { nodes } = buildDataGraph('ws-1', FACTS());
    const evt = nodes.find((n) => n.id === 'event:evt-1');
    expect(evt?.occurred_at).toBe('2026-06-06T00:00:00Z');
    expect(evt?.ingested_at).toBe('2026-06-06T00:01:00Z');
    // every non-workspace node has at least one timestamp
    expect(nodes.filter((n) => n.type !== 'workspace').every((n) => n.occurred_at || n.ingested_at)).toBe(true);
  });

  it('NEVER points the structure back at a lens (only lens→project views edges)', () => {
    const { edges } = buildDataGraph('ws-1', FACTS());
    // no edge whose TO is a lens node (lenses are only sources of "views")
    expect(edges.some((e) => e.to.startsWith('lens:'))).toBe(false);
  });

  it('is PURE — does not mutate the input facts', () => {
    const f = FACTS();
    const snapshot = JSON.stringify(f);
    buildDataGraph('ws-1', f);
    expect(JSON.stringify(f)).toBe(snapshot);
  });

  it('snapshot graph_hash is deterministic + drift-detectable', () => {
    const a = buildDataGraph('ws-1', FACTS()).snapshot.graph_hash;
    const b = buildDataGraph('ws-1', FACTS()).snapshot.graph_hash;
    expect(a).toBe(b);                                    // deterministic
    const mutated = FACTS();
    mutated.unified.push({ id: 'u9', plane: 'event_sourcing', source_plane_id: 'evt-9', workspace_id: 'ws-1', project_id: 'proj-b', kind: 'event', occurred_at: '2026-06-08T00:00:00Z' });
    expect(buildDataGraph('ws-1', mutated).snapshot.graph_hash).not.toBe(a); // a fact change → a new hash (drift)
  });
});

describe('resolveDomainId — the typed integrity fix (lens vs life vs unknown)', () => {
  it('classifies a known lens id, a life-domain id, and an unknown', () => {
    const ctx = { lensIds: ['sd-investor'], lifeDomainIds: ['domain:mbp:career'] };
    expect(resolveDomainId('sd-investor', ctx)).toEqual({ kind: 'lens', id: 'sd-investor' });
    expect(resolveDomainId('domain:mbp:career', ctx)).toEqual({ kind: 'life', id: 'domain:mbp:career' });
    expect(resolveDomainId('sd-unseen', ctx)).toEqual({ kind: 'unknown', id: 'sd-unseen' });
    expect(resolveDomainId(null, ctx)).toBeNull();
  });

  it('F7: a bare lens-named id colliding with a life keyword is NOT guessed as life', () => {
    const ctx = { lensIds: [], lifeDomainIds: [] };
    // these LOOK life-ish but are lens names — the old heuristic misclassified them as 'life'
    for (const id of ['companies-pipeline', 'trust-ledger', 'healthkit-lens', 'career-board']) {
      expect(resolveDomainId(id, ctx).kind).toBe('unknown');
    }
    // only a NAMESPACE-PREFIXED life id resolves to life
    expect(resolveDomainId('domain:mbp:health', ctx)).toEqual({ kind: 'life', id: 'domain:mbp:health' });
    expect(resolveDomainId('life:companies', ctx)).toEqual({ kind: 'life', id: 'life:companies' });
  });
});

describe('buildDataGraph — F1 tenant isolation: cross-workspace operator lens excluded', () => {
  it('a workspace_id=null (operator-only cross-workspace) lens does NOT appear in a tenant graph', () => {
    const f = FACTS();
    f.lenses.push({ id: 'sd-operator-global', workspace_id: null, label: 'Operator fleet lens', created_at: '2026-06-03T00:00:00Z' } as any);
    const { nodes } = buildDataGraph('ws-1', f);
    expect(nodes.some((n) => n.ref_id === 'sd-operator-global')).toBe(false); // not leaked into the tenant graph
    expect(nodes.filter((n) => n.type === 'lens').map((n) => n.ref_id)).toEqual(['sd-investor']);
  });
});

// ── ADR-XLOOP-ARCH-003 VI/VII · lineage spine + causation/RCA ──────────────────
const LINEAGE_FACTS = (): DataGraphFacts => ({
  workspaces: [{ id: 'ws-1', name: 'Acme' }],
  projects: [{ id: 'proj-a', workspace_id: 'ws-1', name: 'Alpha', description: 'the alpha project', created_at: '2026-06-01T00:00:00Z' }],
  lenses: [{ id: 'sd-x', workspace_id: 'ws-1', label: 'Commercial', created_at: '2026-06-02T00:00:00Z' }],
  memberships: [{ domain_id: 'sd-x', project_id: 'proj-a' }],
  intents: [
    { id: 'int-root', workspace_id: 'ws-1', project_id: 'proj-a', title: 'ship the thing', derived_from: null, created_at: '2026-06-03T00:00:00Z' },
    { id: 'int-child', workspace_id: 'ws-1', project_id: 'proj-a', title: 'sub-step', derived_from: 'int-root', created_at: '2026-06-04T00:00:00Z' },
  ],
  unified: [
    { id: 'u1', plane: 'event_sourcing', source_plane_id: 'evt-1', workspace_id: 'ws-1', project_id: 'proj-a', kind: 'event', occurred_at: '2026-06-05T00:00:00Z', summary: 'commit pushed', intent_id: 'int-child' },
    { id: 'u2', plane: 'governance', source_plane_id: 'pkt-1', workspace_id: 'ws-1', project_id: 'proj-a', kind: 'packet', occurred_at: '2026-06-06T00:00:00Z', summary: 'sign-off' },
  ],
  bindings: [
    { id: 'psb-1', workspace_id: 'ws-1', project_id: 'proj-a', source_kind: 'github_repo', source_ref: { repo: 'acme/api', label: 'acme/api' }, created_at: '2026-05-30T00:00:00Z' },
  ],
  // pkt-1 (governance effect) was caused_by evt-1 (the event that triggered the sign-off).
  causation: [{ effect: 'packet:pkt-1', cause: 'event:evt-1' }],
});

describe('lineage spine — source node + feeds edge + derived descriptions', () => {
  it('emits a source node + a feeds edge (source → project), the new lineage origin', () => {
    const { nodes, edges } = buildDataGraph('ws-1', LINEAGE_FACTS());
    expect(nodes.find((n) => n.id === 'source:psb-1')?.type).toBe('source');
    expect(nodes.find((n) => n.id === 'source:psb-1')?.label).toBe('acme/api');
    expect(edges.some((e) => e.from === 'source:psb-1' && e.type === 'feeds' && e.to === 'project:proj-a')).toBe(true);
  });
  it('every node carries a NON-EMPTY derived description (lineage-completeness invariant)', () => {
    const { nodes } = buildDataGraph('ws-1', LINEAGE_FACTS());
    expect(nodes.length).toBeGreaterThan(0);
    expect(nodes.every((n) => typeof n.description === 'string' && n.description.length > 0)).toBe(true);
    // descriptions are DERIVED (title/summary/source_ref), not from an L0 column
    expect(nodes.find((n) => n.id === 'intent:int-root')?.description).toBe('ship the thing');
    expect(nodes.find((n) => n.id === 'event:evt-1')?.description).toBe('commit pushed');
  });
});

describe('causation — caused_by edge + RCA traversal (HR-CAUSATION-TRACEABILITY-1)', () => {
  // ADR-XLOOP-IA-001 immutability: causation is derived from audit_logs.causation_id (immutable), NEVER
  // self-generated from the mutable operation_events / event rows. Same event rows, no audit pairs → zero
  // caused_by; with the audit pairs → exactly those edges (1:1), so a mutated/forged event row cannot
  // invent a cause it never had. Pairs with the new born-WARN verify-operation-events-append-only gate.
  it('caused_by comes ONLY from audit_logs-derived causation pairs — mutable event rows alone create NONE', () => {
    const facts = LINEAGE_FACTS();
    const noAuditCausation = buildDataGraph('ws-1', { ...facts, causation: [] }).edges;
    expect(noAuditCausation.some((e) => e.type === 'caused_by')).toBe(false); // events do not self-cause

    const withAudit = buildDataGraph('ws-1', facts).edges.filter((e) => e.type === 'caused_by');
    expect(withAudit).toHaveLength(facts.causation!.length); // exactly the audit-derived pairs, no more
    expect(withAudit.every((e) => facts.causation!.some((c) => c.effect === e.from && c.cause === e.to))).toBe(true);
  });
  it('emits caused_by ONLY when both endpoints resolve to real nodes (no fabricated/dangling edge)', () => {
    const { edges } = buildDataGraph('ws-1', LINEAGE_FACTS());
    expect(edges.some((e) => e.from === 'packet:pkt-1' && e.type === 'caused_by' && e.to === 'event:evt-1')).toBe(true);
    // a dangling pair (cause node absent) is dropped
    const f = LINEAGE_FACTS(); f.causation = [{ effect: 'packet:pkt-1', cause: 'event:DOES-NOT-EXIST' }];
    const { edges: e2 } = buildDataGraph('ws-1', f);
    expect(e2.some((e) => e.type === 'caused_by')).toBe(false);
  });
  it('RCA backward walk reaches a root and is acyclic (terminated)', () => {
    const { edges } = buildDataGraph('ws-1', LINEAGE_FACTS());
    // packet:pkt-1 -caused_by-> event:evt-1 -realizes-> intent:int-child -derived_from-> intent:int-root (root)
    const t = traceCause(edges, 'packet:pkt-1', 'backward');
    expect(t.cyclic).toBe(false);
    expect(t.terminated).toBe(true);
    expect(t.roots).toContain('intent:int-root');
  });
  it('detects a cycle (the verifier self-test condition)', () => {
    const edges = [
      { from: 'packet:p', to: 'event:e', type: 'caused_by' as const },
      { from: 'event:e', to: 'intent:i', type: 'realizes' as const },
      { from: 'intent:i', to: 'packet:p', type: 'derived_from' as const }, // closes the loop
    ];
    const t = traceCause(edges, 'packet:p', 'backward');
    expect(t.cyclic).toBe(true);
    expect(t.terminated).toBe(false);
  });
  it('effectNodesRequiringCause flags packets (and events on a causal chain), not source roots', () => {
    const { nodes, edges } = buildDataGraph('ws-1', LINEAGE_FACTS());
    const effects = effectNodesRequiringCause(nodes, edges).map((n) => n.id);
    expect(effects).toContain('packet:pkt-1');     // a packet MUST have a cause
    expect(effects).not.toContain('source:psb-1'); // a source is a root, never an orphan effect
  });
  it('forward impact walk: from a root event, reach the downstream effects', () => {
    const { edges } = buildDataGraph('ws-1', LINEAGE_FACTS());
    const impact = traceCause(edges, 'event:evt-1', 'forward');
    expect(impact.visited).toContain('packet:pkt-1'); // the packet evt-1 ultimately caused
  });
});

describe('computeGraphHash', () => {
  it('is order-independent over the same node/edge set', () => {
    const n = [{ id: 'a', type: 'project', workspace_id: 'w', ref_id: 'a' }, { id: 'b', type: 'event', workspace_id: 'w', ref_id: 'b' }] as any;
    const e = [{ from: 'a', to: 'b', type: 'scopes' }] as any;
    expect(computeGraphHash(n, e)).toBe(computeGraphHash([n[1], n[0]], e));
  });

  it('F10: a node reclassified to a different plane/type yields a different hash', () => {
    const base = [{ id: 'event:e1', type: 'event', workspace_id: 'w', ref_id: 'e1', plane: 'event_sourcing', occurred_at: 't' }] as any;
    const reclassified = [{ id: 'event:e1', type: 'packet', workspace_id: 'w', ref_id: 'e1', plane: 'governance', occurred_at: 't' }] as any;
    expect(computeGraphHash(base, [])).not.toBe(computeGraphHash(reclassified, [])); // plane/type now in the hash material
  });
});

describe('computeGraphHash', () => {
  it('is order-independent over the same node/edge set', () => {
    const n = [{ id: 'a', type: 'project', workspace_id: 'w', ref_id: 'a' }, { id: 'b', type: 'event', workspace_id: 'w', ref_id: 'b' }] as any;
    const e = [{ from: 'a', to: 'b', type: 'scopes' }] as any;
    expect(computeGraphHash(n, e)).toBe(computeGraphHash([n[1], n[0]], e));
  });
});
