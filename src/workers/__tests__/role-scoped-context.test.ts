// role-scoped-context.test.ts · G9 (260709) — the four §168 acceptance invariants.
// DECLARED AXES: roles [owner · operator · viewer · client · unknown] · admissibility [approved · visible ·
// candidate-own · candidate-other · excluded · absent] · visibility [all 4 values · absent] ·
// invariants [monotone bundles · no non-approved ref · client empty + neutralize · flag-off byte-parity
// (proven at the route level: the assembler is never invoked flag-off — see the call-site guards)].

import { describe, it, expect } from 'vitest';
import {
  assembleRoleScopedContext,
  passesNeutralizeInvariants,
  type GroundableEvent,
  type GroundableDocument,
} from '../services/role-scoped-context';

// One fixed fact-set (the "given one fixed graph" of the §168 monotonicity test).
const EVENTS: GroundableEvent[] = [
  { id: 'e-owner', visibility: 'internal_owner_only', summary: 'board note' },
  { id: 'e-ws', visibility: 'internal_workspace', summary: 'ops detail' },
  { id: 'e-proj', visibility: 'internal_project', summary: 'project fact' },
  { id: 'e-pub', visibility: 'public_safe', summary: 'public fact' },
  { id: 'e-none', summary: 'legacy row, no visibility field' }, // → treated internal_workspace
];
const DOCS: GroundableDocument[] = [
  { id: 'd-appr', filename: 'contract.pdf', admissibility: 'approved', uploaded_by: 'u-any' },
  { id: 'd-vis', filename: 'notes.pdf', admissibility: 'visible', uploaded_by: 'u-any' },
  { id: 'd-cand-mine', filename: 'draft.pdf', admissibility: 'candidate', uploaded_by: 'u-op' },
  { id: 'd-cand-other', filename: 'their-draft.pdf', admissibility: 'candidate', uploaded_by: 'u-else' },
  { id: 'd-excl', filename: 'barred.pdf', admissibility: 'excluded', uploaded_by: 'u-any' },
  { id: 'd-legacy', filename: 'old.pdf' }, // absent admissibility → M6 default 'approved'
];
const LINEAGE = [{ edge_from: 'event:e1', edge_to: 'intent:i1', edge_type: 'realizes' }];

const view = (role: string, user_id = 'u-x') => ({ role, user_id });
const ids = (xs: Array<{ id?: unknown }>) => xs.map((x) => String(x.id)).sort();

describe('G9 §168 · invariant 1 — bundles monotone by authority (owner ⊇ operator ⊇ viewer ⊇ client)', () => {
  it('event bundles nest strictly down the role ladder (same asker, no candidates in play)', () => {
    const bundles = ['owner', 'operator', 'viewer', 'client'].map((r) =>
      new Set(ids(assembleRoleScopedContext(view(r), { events: EVENTS }).admissibleFacts.events)));
    for (let i = 1; i < bundles.length; i++) {
      for (const id of bundles[i]) expect(bundles[i - 1].has(id)).toBe(true); // lower ⊆ higher
    }
    expect(bundles[0].size).toBe(5); // owner: all (incl. owner-only + legacy)
    expect(bundles[1].size).toBe(4); // operator: no internal_owner_only
    expect(bundles[2].size).toBe(2); // viewer: project + public
    expect(bundles[3].size).toBe(0); // client: empty (D-7)
  });
});

describe('G9 §168 · invariant 2 — no ref with admissibility ≠ approved in ANY bundle (candidate-own excepted, flagged)', () => {
  it('only approved docs ground a non-proposer; visible/excluded/candidate-other never do', () => {
    for (const r of ['owner', 'operator', 'viewer']) {
      const docs = assembleRoleScopedContext(view(r, 'u-not-proposer'), { documents: DOCS }).admissibleFacts.documents;
      expect(ids(docs)).toEqual(['d-appr', 'd-legacy']); // approved + M6-default only
      expect(docs.every((d) => !d.unpromoted)).toBe(true);
    }
  });

  it("the proposer's own candidate grounds, flagged unpromoted — and ONLY for the proposer (D-6)", () => {
    const mine = assembleRoleScopedContext(view('operator', 'u-op'), { documents: DOCS }).admissibleFacts.documents;
    expect(ids(mine)).toEqual(['d-appr', 'd-cand-mine', 'd-legacy']);
    expect(mine.find((d) => d.id === 'd-cand-mine')?.unpromoted).toBe(true);
    expect(mine.find((d) => d.id === 'd-appr')?.unpromoted).toBeUndefined();
    const audit = assembleRoleScopedContext(view('operator', 'u-op'), { documents: DOCS }).auditLine;
    expect(audit.documents.candidate_flagged).toBe(1);
  });
});

describe('G9 §168 · invariant 3 — client bundle empty + neutralize invariants', () => {
  it('client gets NO grounded spine at all (D-7), with the audited reason', () => {
    const rsc = assembleRoleScopedContext(view('client'), { events: EVENTS, documents: DOCS, lineage: LINEAGE });
    expect(rsc.admissibleFacts.events).toEqual([]);
    expect(rsc.admissibleFacts.documents).toEqual([]);
    expect(rsc.visibleLineage).toEqual([]);
    expect(rsc.redactionProfile).toEqual({ expose: 'none', neutralize: true });
    expect(rsc.auditLine.reason).toBe('client_contribution_only');
    expect(passesNeutralizeInvariants(rsc.admissibleFacts)).toBe(true); // trivially — nothing to leak
  });

  it('neutralize invariants themselves bite (receipt uid / email / route shapes fail)', () => {
    expect(passesNeutralizeInvariants({ x: 'rcpt_abc123' })).toBe(false);
    expect(passesNeutralizeInvariants({ x: 'marat@xlooop.com' })).toBe(false);
    expect(passesNeutralizeInvariants({ x: '/api/v1/customer-lineage' })).toBe(false);
    expect(passesNeutralizeInvariants({ x: 'a plain business fact' })).toBe(true);
  });

  it('unknown role fails CLOSED to the client projection (never widens)', () => {
    const rsc = assembleRoleScopedContext(view('superadmin'), { events: EVENTS });
    expect(rsc.admissibleFacts.events).toEqual([]);
    expect(rsc.auditLine.reason).toBe('client_contribution_only');
  });
});

describe('G9 §167/U2 · lineage is owner/operator-class; auditLine is complete', () => {
  it('viewer keeps ceiling events but loses lineage entirely', () => {
    const rsc = assembleRoleScopedContext(view('viewer'), { events: EVENTS, lineage: LINEAGE });
    expect(rsc.admissibleFacts.events.length).toBe(2);
    expect(rsc.visibleLineage).toEqual([]);
    expect(rsc.auditLine.lineage).toEqual({ considered: 1, grounded: 0 });
  });

  it('auditLine accounts for every considered fact (grounded + excluded == considered)', () => {
    const a = assembleRoleScopedContext(view('operator', 'u-op'), { events: EVENTS, documents: DOCS, lineage: LINEAGE }).auditLine;
    expect(a.events.grounded + a.events.excluded_by_visibility).toBe(a.events.considered);
    expect(a.documents.grounded + a.documents.excluded_by_admissibility).toBe(a.documents.considered);
    expect(a.role).toBe('operator');
    expect(a.ceiling.length).toBeGreaterThan(0);
  });
});
