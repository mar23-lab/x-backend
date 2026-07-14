// decision-graph-projection.test.ts · ARCH-006 W6
// Proves a first-class decision projects into the data-graph as a `packet` node + a `caused_by` edge with
// ZERO data-graph.ts change — by the operations_unified governance mirror (kind='decision', a PACKET_KIND)
// + the audit_logs.causation_id stamp (effect 'packet:<id>' ⟶ cause 'event:<eventId>'). Pure unit, no DAL.

import { describe, it, expect } from 'vitest';
import { buildDataGraph, type DataGraphFacts } from '../graph/data-graph';

// Mirrors what the DAL writes for a decision: materializeDecisionToUnified → operations_unified row with
// plane='governance', kind='decision', source_plane_id=<bare decision id>; createDecisionRow stamps
// audit_logs(target_id=<bare id>, causation_id=<event id>) → graph-store builds {effect:'packet:<id>', cause:'event:<eventId>'}.
const DECISION_FACTS = (): DataGraphFacts => ({
  workspaces: [{ id: 'ws-1', name: 'Acme' }],
  projects: [{ id: 'proj-a', workspace_id: 'ws-1', name: 'Alpha', created_at: '2026-06-01T00:00:00Z' }],
  lenses: [], memberships: [], intents: [],
  unified: [
    { id: 'evt-row', plane: 'event_sourcing', source_plane_id: 'evt-1', workspace_id: 'ws-1', project_id: 'proj-a', kind: 'event', occurred_at: '2026-06-10T00:00:00Z', summary: 'the event the decision was made on' },
    { id: 'decision:d1', plane: 'governance', source_plane_id: 'd1', workspace_id: 'ws-1', project_id: 'proj-a', kind: 'decision', occurred_at: '2026-06-11T00:00:00Z', summary: '[decision approved] ship it' },
  ],
  bindings: [],
  causation: [{ effect: 'packet:d1', cause: 'event:evt-1' }],
});

describe('decision → data-graph projection (zero graph code change)', () => {
  it('a decision unified row projects a `packet` node id packet:<id>', () => {
    const { nodes } = buildDataGraph('ws-1', DECISION_FACTS());
    const packet = nodes.find((n) => n.id === 'packet:d1');
    expect(packet).toBeTruthy();
    expect(packet?.type).toBe('packet');
  });

  it('the audit causation stamp emits a caused_by edge packet:<id> → event:<eventId>', () => {
    const { edges } = buildDataGraph('ws-1', DECISION_FACTS());
    const caused = edges.find((e) => e.from === 'packet:d1' && e.to === 'event:evt-1' && e.type === 'caused_by');
    expect(caused).toBeTruthy();
  });

  it('no caused_by edge is emitted when the cause node is absent (dangling-safe)', () => {
    const f = DECISION_FACTS();
    f.unified = f.unified.filter((u) => u.source_plane_id !== 'evt-1'); // drop the event node
    const { edges } = buildDataGraph('ws-1', f);
    expect(edges.some((e) => e.type === 'caused_by')).toBe(false);
  });
});
