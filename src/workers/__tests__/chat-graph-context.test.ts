// chat-graph-context.test.ts · W5 (260708) · G6 — the pure graph-context selector.
// DECLARED AXES: edge classes [pinned · scoped cause-chain · scoped containment] · budget states
// [under · at · over] · chain states [terminating · cyclic · absent].

import { describe, it, expect } from 'vitest';
import { selectGraphContext, CHAT_GRAPH_EDGE_BUDGET } from '../services/chat-graph-context';
import type { LineageEdgeRow } from '../dal/graph-store';

const E = (from: string, to: string, type: string): LineageEdgeRow => ({
  edge_from: from, from_type: null, from_description: null,
  edge_to: to, to_type: null, to_description: null,
  edge_type: type, is_cause_edge: ['caused_by', 'realizes', 'derived_from'].includes(type),
});

describe('selectGraphContext', () => {
  it('pinned edges ALWAYS survive first; dedupe against scoped', () => {
    const pinned = [E('event:e1', 'intent:i1', 'realizes')];
    const scoped = [E('event:e1', 'intent:i1', 'realizes'), E('project:p1', 'event:e1', 'scopes')];
    const { edges } = selectGraphContext(pinned, scoped, []);
    expect(edges.length).toBe(2); // dup collapsed
    expect(edges[0]).toEqual(pinned[0]);
  });

  it('TERMINATING cause-chains from anchors are prioritized over containment when the budget bites', () => {
    // chain: event:eX —realizes→ intent:iX (terminates at iX)
    const chain = [E('event:eX', 'intent:iX', 'realizes')];
    const filler = Array.from({ length: 40 }, (_, i) => E(`project:p`, `event:f${i}`, 'scopes'));
    const { edges, cause_chains } = selectGraphContext([], [...filler, ...chain], ['event:eX'], 10);
    expect(edges.length).toBe(10);
    expect(edges.some((e) => e.edge_from === 'event:eX' && e.edge_type === 'realizes')).toBe(true); // chain made the cut
    expect(cause_chains).toEqual([{ start: 'event:eX', roots: ['intent:iX'], terminated: true }]);
  });

  it('a CYCLIC chain is NOT surfaced as a cause_chain (HR-CAUSATION-TRACEABILITY honesty)', () => {
    const cyc = [E('event:a', 'event:b', 'caused_by'), E('event:b', 'event:a', 'caused_by')];
    const { cause_chains } = selectGraphContext([], cyc, ['event:a']);
    expect(cause_chains).toEqual([]);
  });

  it('never exceeds the budget; default budget is the OS-4 P4 cap', () => {
    const many = Array.from({ length: 100 }, (_, i) => E(`a${i}`, `b${i}`, 'scopes'));
    expect(selectGraphContext([], many, []).edges.length).toBe(CHAT_GRAPH_EDGE_BUDGET);
  });

  it('deterministic: same inputs → same selection', () => {
    const pinned = [E('event:e1', 'intent:i1', 'realizes')];
    const scoped = Array.from({ length: 50 }, (_, i) => E(`x${i}`, `y${i}`, 'scopes'));
    const a = selectGraphContext(pinned, scoped, ['event:e1']);
    const b = selectGraphContext(pinned, scoped, ['event:e1']);
    expect(a.edges).toEqual(b.edges);
    expect(a.cause_chains).toEqual(b.cause_chains);
  });
});
