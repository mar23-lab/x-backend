// synthetic-binding-source-filters.test.ts · ADR-XLOOP-IA-001 R1
// Proves the two NEW source-aware lens binding filters (source_kind_in, source_ref_path)
// match a project by its CONNECTED SOURCE properties — robust without pre-tagging.

import { describe, it, expect } from 'vitest';
import { evaluateSyntheticBinding, type CandidateProject } from '../dal/synthetic-domain-store';
import type { SyntheticDomainBinding } from '../dal/types/synthetic-domain';

// Minimal candidate project — evaluateFilter only reads workspace_id/status/parent/metadata/source_bindings.
function proj(over: Partial<CandidateProject>): CandidateProject {
  return {
    id: 'p1', workspace_id: 'ws-1', name: 'P1', status: 'active', description: null,
    metadata: {}, scope_binding: null, scope_binding_updated_at: null, scope_binding_updated_by: null,
    parent_project_id: null, created_at: '2026-06-01T00:00:00Z', updated_at: '2026-06-01T00:00:00Z',
    ...over,
  } as CandidateProject;
}
const binding = (filters: SyntheticDomainBinding['filters'], combine: 'any' | 'all' = 'any'): SyntheticDomainBinding => ({ version: 1, combine, filters });

describe('source_kind_in filter', () => {
  it('matches a project whose connected source kind is in the values', () => {
    const p = proj({ source_bindings: [{ source_kind: 'github_repo', source_ref: { name: 'x' } }] });
    expect(evaluateSyntheticBinding(p, binding([{ type: 'source_kind_in', values: ['github_repo'] }]))).toBe(true);
    expect(evaluateSyntheticBinding(p, binding([{ type: 'source_kind_in', values: ['desktop_folder'] }]))).toBe(false);
  });

  it('does NOT match a project with no source bindings (honest empty)', () => {
    const p = proj({ source_bindings: [] });
    expect(evaluateSyntheticBinding(p, binding([{ type: 'source_kind_in', values: ['github_repo'] }]))).toBe(false);
    // undefined bindings (never attached) also safe
    const p2 = proj({});
    expect(evaluateSyntheticBinding(p2, binding([{ type: 'source_kind_in', values: ['github_repo'] }]))).toBe(false);
  });
});

describe('source_ref_path filter', () => {
  const investorRepo = proj({
    source_bindings: [{ source_kind: 'github_repo', source_ref: { name: 'investor-portal', description: 'cap table' } }],
  });

  it('matches a bare substring against any string field of source_ref', () => {
    expect(evaluateSyntheticBinding(investorRepo, binding([{ type: 'source_ref_path', values: ['investor'] }]))).toBe(true);
    expect(evaluateSyntheticBinding(investorRepo, binding([{ type: 'source_ref_path', values: ['cap table'] }]))).toBe(true);
    expect(evaluateSyntheticBinding(investorRepo, binding([{ type: 'source_ref_path', values: ['unrelated'] }]))).toBe(false);
  });

  it('matches a field-scoped term (field~substr), case-insensitive', () => {
    expect(evaluateSyntheticBinding(investorRepo, binding([{ type: 'source_ref_path', values: ['name~INVESTOR'] }]))).toBe(true);
    // the substring is in description, not name → field-scoped name~ must NOT match
    expect(evaluateSyntheticBinding(investorRepo, binding([{ type: 'source_ref_path', values: ['name~cap'] }]))).toBe(false);
  });
});

describe('combine semantics with source-aware filters', () => {
  const p = proj({ source_bindings: [{ source_kind: 'github_repo', source_ref: { name: 'investor-portal' } }] });

  it('combine=all requires every filter to pass', () => {
    const all = binding([
      { type: 'source_kind_in', values: ['github_repo'] },
      { type: 'source_ref_path', values: ['investor'] },
    ], 'all');
    expect(evaluateSyntheticBinding(p, all)).toBe(true);

    const allFail = binding([
      { type: 'source_kind_in', values: ['github_repo'] },
      { type: 'source_ref_path', values: ['nomatch'] },
    ], 'all');
    expect(evaluateSyntheticBinding(p, allFail)).toBe(false);
  });

  it('combine=any passes if a source filter OR a classic filter matches', () => {
    const any = binding([
      { type: 'status_in', values: ['archived'] },          // false (project is active)
      { type: 'source_ref_path', values: ['investor'] },    // true
    ], 'any');
    expect(evaluateSyntheticBinding(p, any)).toBe(true);
  });
});
