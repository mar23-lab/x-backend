// customer-census.test.ts · J-E TASK 2 (260719) · the PURE census math.
//
// Proves computeWorkspaceCensus over the REAL buildDataGraph projection (facts → graph → census), so the
// population / governed / orphan-by-class counting is verified end-to-end on the actual graph derivation,
// not a re-model. Covers all four orphan classes, the governed complement, document population, hash
// determinism, and the set-difference honesty lesson (a changed orphan SET ⇒ a changed hash).

import { describe, it, expect } from 'vitest';
import { buildDataGraph, type DataGraphFacts } from '../../graph/data-graph';
import { computeWorkspaceCensus } from '../customer-census';

const WS = 'ws1';

/** A small workspace engineered to carry exactly one orphan of each class:
 *   - unattributed events: ev2 (project_id null) + ev3 ('ws1-allactivity' catch-all) → 2
 *   - dangling intent:     int2 (no project, no derivation, no realizing event)        → 1
 *   - effect w/o cause:    pkt2 (a governance packet with no cause edge)               → 1
 *   - missing source:      projB (a project with no `feeds` binding edge)              → 1
 *  ev1 → projA is the sole attributed event; projA has a source binding; int1 → projA scopes it;
 *  pkt1 → event ev1 (a resolvable caused_by). One document (doc1) for population. */
function fixtureFacts(over: Partial<DataGraphFacts> = {}): DataGraphFacts {
  return {
    workspaces: [{ id: WS, name: 'WS1' }],
    projects: [
      { id: 'projA', workspace_id: WS, name: 'Project A' },
      { id: 'projB', workspace_id: WS, name: 'Project B' },
    ],
    lenses: [],
    memberships: [],
    intents: [
      { id: 'int1', workspace_id: WS, project_id: 'projA', title: 'Intent 1' },
      { id: 'int2', workspace_id: WS, project_id: null, title: 'Dangling intent' },
    ],
    unified: [
      { id: 'ev1', plane: 'event_sourcing', workspace_id: WS, project_id: 'projA', summary: 'attributed event' },
      { id: 'ev2', plane: 'event_sourcing', workspace_id: WS, project_id: null, summary: 'unattributed (null)' },
      { id: 'ev3', plane: 'event_sourcing', workspace_id: WS, project_id: 'ws1-allactivity', summary: 'unattributed (catch-all)' },
    ],
    bindings: [{ id: 'bindA', workspace_id: WS, project_id: 'projA', source_kind: 'github', source_ref: { repo: 'org/repo' } }],
    packets: [
      { id: 'pkt1', workspace_id: WS, project_id: 'projA', event_id: 'ev1', title: 'caused packet' },
      { id: 'pkt2', workspace_id: WS, project_id: 'projB', title: 'orphan packet' },
    ],
    documents: [{ id: 'doc1', workspace_id: WS, project_id: 'projA', title: 'Doc 1', content_hash: 'abc' }],
    evidenceLinks: [],
    causation: [],
    ...over,
  };
}

function runCensus(facts: DataGraphFacts, intakeResolutionCount = 0) {
  const { nodes, edges, snapshot } = buildDataGraph(WS, facts);
  return {
    result: computeWorkspaceCensus({ workspaceId: WS, facts, nodes, edges, graphHash: snapshot.graph_hash, intakeResolutionCount }),
    snapshot,
    edges,
  };
}

describe('computeWorkspaceCensus · population', () => {
  it('counts events, intents, and documents (population)', () => {
    const { result } = runCensus(fixtureFacts());
    expect(result.population.events).toBe(3);
    expect(result.population.intents).toBe(2);
    expect(result.population.documents).toBe(1);
    expect(result.population.total).toBe(6);
  });

  it('documents=0 when facts carry no documents (flag-off graph)', () => {
    const { result } = runCensus(fixtureFacts({ documents: [] }));
    expect(result.population.documents).toBe(0);
    expect(result.population.total).toBe(5);
  });
});

describe('computeWorkspaceCensus · orphan classes (the set-difference)', () => {
  it('identifies exactly one orphan per class', () => {
    const { result } = runCensus(fixtureFacts());
    expect(result.orphans.unattributed_events).toBe(2);
    expect(result.orphans.dangling_intents).toBe(1);
    expect(result.orphans.effect_nodes_without_cause).toBe(1);
    expect(result.orphans.missing_source_bindings).toBe(1);
    expect(result.orphans.total).toBe(5);
  });

  it('unattributed matches reclassify semantics (null OR %-allactivity)', () => {
    // Attribute ev2 → unattributed drops to 1 (only the catch-all ev3 remains).
    const facts = fixtureFacts();
    facts.unified = facts.unified.map((u) => (u.id === 'ev2' ? { ...u, project_id: 'projA' } : u));
    const { result } = runCensus(facts);
    expect(result.orphans.unattributed_events).toBe(1);
    expect(result.governed.attributed_events).toBe(2);
  });

  it('a packet with a resolvable cause is NOT an effect-without-cause orphan', () => {
    // Give pkt2 a cause (event ev1) → effect-without-cause drops to 0.
    const facts = fixtureFacts();
    facts.packets = facts.packets!.map((p) => (p.id === 'pkt2' ? { ...p, event_id: 'ev1' } : p));
    const { result } = runCensus(facts);
    expect(result.orphans.effect_nodes_without_cause).toBe(0);
  });

  it('a project that gains a source binding is no longer a missing-source orphan', () => {
    const facts = fixtureFacts();
    facts.bindings = [...facts.bindings!, { id: 'bindB', workspace_id: WS, project_id: 'projB', source_kind: 'github' }];
    const { result } = runCensus(facts);
    expect(result.orphans.missing_source_bindings).toBe(0);
  });
});

describe('computeWorkspaceCensus · governed measures', () => {
  it('attributed events are the complement of unattributed', () => {
    const { result } = runCensus(fixtureFacts());
    expect(result.governed.attributed_events).toBe(1);
  });

  it('lineage_edges equals the graph edge count; intake_resolutions is passed through', () => {
    const { result, edges } = runCensus(fixtureFacts(), 4);
    expect(result.governed.lineage_edges).toBe(edges.length);
    expect(result.governed.intake_resolutions).toBe(4);
    expect(result.governed.total).toBe(result.governed.attributed_events + edges.length + 4);
  });
});

describe('computeWorkspaceCensus · hashes (drift honesty)', () => {
  it('orphan_set_hash is orh_-prefixed and deterministic for identical input', () => {
    const a = runCensus(fixtureFacts()).result;
    const b = runCensus(fixtureFacts()).result;
    expect(a.orphan_set_hash).toMatch(/^orh_[0-9a-f]+$/);
    expect(a.orphan_set_hash).toBe(b.orphan_set_hash);
  });

  it('a changed orphan SET changes the hash (set-difference, not cardinality)', () => {
    const base = runCensus(fixtureFacts()).result;
    // Attribute ev2: the orphan SET shrinks → the hash MUST change.
    const facts = fixtureFacts();
    facts.unified = facts.unified.map((u) => (u.id === 'ev2' ? { ...u, project_id: 'projA' } : u));
    const changed = runCensus(facts).result;
    expect(changed.orphan_set_hash).not.toBe(base.orphan_set_hash);
  });

  it('carries the graph_hash through unchanged', () => {
    const { result, snapshot } = runCensus(fixtureFacts());
    expect(result.graph_hash).toBe(snapshot.graph_hash);
    expect(result.graph_hash).toMatch(/^dgh_[0-9a-f]+$/);
  });

  it('an empty workspace yields zero orphans and stable hashes', () => {
    const empty: DataGraphFacts = { workspaces: [{ id: WS }], projects: [], lenses: [], memberships: [], intents: [], unified: [] };
    const { result } = runCensus(empty);
    expect(result.population.total).toBe(0);
    expect(result.orphans.total).toBe(0);
    expect(result.orphan_set_hash).toMatch(/^orh_[0-9a-f]+$/);
  });
});
