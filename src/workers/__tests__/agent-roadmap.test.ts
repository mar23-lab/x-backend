// agent-roadmap.test.ts · W3 Track A · pure unit tests for the roadmap-synthesis draft builder.
// Same deterministic contract as buildWorkspaceDigest: pure, never throws, governed-proposal copy.
import { describe, it, expect } from 'vitest';
import { buildWorkspaceRoadmap } from '../services/agent-roadmap';

const DOMAIN = (over: any = {}) => ({
  id: 'd1', label: 'Career', workspace_id: 'ws1', roadmaps: [], goals: [], ...over,
});
const ROADMAP = (over: any = {}) => ({
  id: 'r1', domain_id: 'd1', title: 'Ship v1', status: 'active', items_total: 4, items_done: 2,
  updated_at: '2026-06-10T00:00:00Z', ...over,
});
const GOAL = (over: any = {}) => ({
  id: 'g1', domain_id: 'd1', title: 'Reach 10 pilots', status: 'active', metric_name: 'pilots',
  metric_unit: null, target_value: 10, current_value: 2, updated_at: '2026-06-10T00:00:00Z', ...over,
});

describe('buildWorkspaceRoadmap · deterministic synthesis', () => {
  it('empty plan → honest "no plan yet" draft, never throws', () => {
    const d = buildWorkspaceRoadmap([]);
    expect(d.summary).toMatch(/no plan/i);
    expect(d.body).toMatch(/no roadmaps or goals/i);
    // tolerates malformed input without throwing
    expect(() => buildWorkspaceRoadmap(undefined as any)).not.toThrow();
    expect(() => buildWorkspaceRoadmap([DOMAIN({ roadmaps: null, goals: null })] as any)).not.toThrow();
  });

  it('populated plan → counts roadmaps/goals + step progress in the summary', () => {
    const d = buildWorkspaceRoadmap([
      DOMAIN({ roadmaps: [ROADMAP()], goals: [GOAL()] }),
      DOMAIN({ id: 'd2', label: 'Health', roadmaps: [ROADMAP({ id: 'r2', items_total: 2, items_done: 1 })], goals: [] }),
    ]);
    expect(d.summary).toMatch(/2 roadmaps/);
    expect(d.summary).toMatch(/3\/6 steps done/); // (2+1)/(4+2)
    expect(d.body).toMatch(/Active goals:/);
    expect(d.body).toMatch(/Reach 10 pilots \(2\/10\)/);
    expect(d.body).toMatch(/Approve to post/);
  });

  it('flags the two planning gaps: goals with no roadmap + roadmaps with no movement', () => {
    const d = buildWorkspaceRoadmap([
      DOMAIN({ label: 'Career', roadmaps: [], goals: [GOAL()] }),               // goals, no roadmap
      DOMAIN({ id: 'd2', label: 'Ops', roadmaps: [ROADMAP({ items_total: 3, items_done: 0 })], goals: [] }), // stalled
    ]);
    expect(d.body).toMatch(/have goals but no roadmap/i);
    expect(d.body).toMatch(/Career/);
    expect(d.body).toMatch(/no steps done yet/i);
  });
});
