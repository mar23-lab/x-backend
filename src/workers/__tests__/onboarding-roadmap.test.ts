// onboarding-roadmap.test.ts · 2026-06-07
//
// Unit tests for the pure provisioning builders (ported from onboard-customer.mjs).
// Asserts the day-1 roadmap scales correctly by readiness level + account type, and the
// readiness brief renders the expected sections.

import { describe, it, expect } from 'vitest';
import { buildDay1Roadmap, buildReadinessBrief } from '../services/onboarding-roadmap';

describe('buildDay1Roadmap', () => {
  it('returns the 3 base steps for level null / personal', () => {
    const steps = buildDay1Roadmap({ level: null, accountType: 'personal' });
    expect(steps).toHaveLength(3);
    expect(steps[0].summary).toMatch(/single source of truth/i);
    expect(steps.map((s) => s.summary).join(' ')).not.toMatch(/teammate|workflow|Action mode/i);
  });

  it('adds the workflow-mapping step at level >= 2', () => {
    expect(buildDay1Roadmap({ level: 2, accountType: 'personal' })).toHaveLength(4);
    expect(buildDay1Roadmap({ level: 2, accountType: 'personal' }).some((s) => /recurring workflow/i.test(s.summary))).toBe(true);
  });

  it('adds the Action-mode pilot step at level >= 4 (4 base+workflow + action)', () => {
    const steps = buildDay1Roadmap({ level: 4, accountType: 'personal' });
    expect(steps).toHaveLength(5);
    expect(steps.some((s) => /Action mode/i.test(s.summary))).toBe(true);
  });

  it('adds the invite step for company / both', () => {
    expect(buildDay1Roadmap({ level: 1, accountType: 'company' })).toHaveLength(4);
    expect(buildDay1Roadmap({ level: 4, accountType: 'both' })).toHaveLength(6); // 3 base + workflow + action + invite
    expect(buildDay1Roadmap({ level: 1, accountType: 'company' }).some((s) => /Invite a teammate/i.test(s.summary))).toBe(true);
  });

  it('treats a non-integer level as level 1 (base only)', () => {
    expect(buildDay1Roadmap({ level: NaN as unknown as number, accountType: 'personal' })).toHaveLength(3);
  });
});

describe('buildReadinessBrief', () => {
  it('renders the customer header, level, and six dimensions', () => {
    const md = buildReadinessBrief({
      customerName: 'Honest & Young',
      customerEmail: 'ops@hy.example',
      accountType: 'company',
      levelLabel: 'L3',
      answers: { source: 'Google Drive', owner: 'Priya' },
      domain: 'hy.example',
      companyName: 'Honest & Young',
    });
    expect(md).toMatch(/# AI Tool Readiness — Honest & Young/);
    expect(md).toMatch(/Readiness level \| L3/);
    expect(md).toMatch(/### Source clarity/);
    expect(md).toMatch(/### Action-mode readiness/);
    expect(md).toMatch(/\*\*source:\*\* Google Drive/);
  });

  it('handles no answers gracefully', () => {
    const md = buildReadinessBrief({
      customerName: 'X', customerEmail: 'x@x', accountType: 'personal', levelLabel: 'unscored', answers: {},
    });
    expect(md).toMatch(/no structured answers captured/);
  });
});
