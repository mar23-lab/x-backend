// infer-source-context.test.ts · ADR-XLOOP-IA-001 R1
// Proves inferSourceContext is a PURE propose-then-confirm classifier: it maps a source
// binding to a domain hint + tags by context, defaults honestly (low confidence) when it
// can't tell, and never mutates its input.

import { describe, it, expect } from 'vitest';
import { inferSourceContext } from '../lib/infer-source-context';

describe('inferSourceContext — propose-then-confirm context inference', () => {
  it('maps an investor/data-room repo to a work "Investor-facing" lens', () => {
    const p = inferSourceContext({ source_kind: 'github_repo', source_ref: { name: 'x-biz', description: 'investor data room + cap table' } });
    expect(p.kind).toBe('work');
    expect(p.domain_hint).toBe('Investor-facing');
    expect(p.tags).toContain('investor');
    expect(p.tags).toContain('code');     // source_kind tag union
    expect(p.confidence).toBe('high');
    expect(p.matched_on).toBeTruthy();
  });

  it('maps a health folder to a LIFE "Health" lens', () => {
    const p = inferSourceContext({ source_kind: 'desktop_folder', source_ref: { path: '/Users/me/health/fitness-log', name: 'fitness-log' } });
    expect(p.kind).toBe('life');
    expect(p.domain_hint).toBe('Health');
    expect(p.tags).toContain('health');
    expect(p.tags).toContain('local');
  });

  it('maps a legal-entity name to a COMPANY lens', () => {
    const p = inferSourceContext({ source_kind: 'manual', source_ref: { name: 'ADEVI Pty Ltd records' } });
    expect(p.kind).toBe('company');
    expect(p.domain_hint).toBe('Company');
    expect(p.tags).toContain('company');
  });

  it('defaults to a LOW-confidence generic work lens when nothing matches', () => {
    const p = inferSourceContext({ source_kind: 'github_repo', source_ref: { name: 'zxqv-1234' } });
    expect(p.confidence).toBe('low');
    expect(p.kind).toBe('work');
    expect(p.domain_hint).toBe('General');
    expect(p.matched_on).toBeNull();
    expect(p.tags).toEqual(['code']);     // only the source-kind tag, no context tag
  });

  it('is PURE — does not mutate the input', () => {
    const input = { source_kind: 'github_repo', source_ref: { name: 'investor-portal' } };
    const snapshot = JSON.stringify(input);
    inferSourceContext(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it('priority order: a specific life/company signal wins over a generic engineering one', () => {
    // "career api" — career (life) rule is ordered before engineering (work)
    const p = inferSourceContext({ source_kind: 'github_repo', source_ref: { name: 'career-api', description: 'resume + linkedin export service' } });
    expect(p.kind).toBe('life');
    expect(p.domain_hint).toBe('Career');
  });
});
