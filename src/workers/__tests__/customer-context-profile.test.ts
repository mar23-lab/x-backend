// customer-context-profile.test.ts · S1 (260628) · the write-only-silo fix.
// VERIFIES THE OUTCOME (not just that it persists): the captured readiness answers project into a
// COMPANY-AWARE context + preamble that the AI consumers read — and the generic fallback is used when
// nothing is captured, NEVER the old hardcoded "accounting / building inspection" stereotype.

import { describe, it, expect } from 'vitest';
import { buildCustomerContextProfile, companyContextPreamble } from '../dal/customer-context-store';

const assessment = {
  id: 'rdy_1', access_request_id: 'req_1', user_id: 'user_codelooop', workspace_id: 'org_hy',
  email: 'codelooop23@gmail.com', account_type: 'company', also_personal_space: false,
  company_name: 'Honest & Young', domain: 'honestyoung.example', country: 'AU', deep_level: 5,
  readiness_answers: {
    q1: 'make it easy for employees to work with AI so they serve customers faster',
    q2: 'about 18%', q3: 'no', q4: 'Grow', q5: 'key-person dependency',
    ai_tools: ['claude', 'chatgpt'],
  },
  deep_check: null, enrichment: null, consent: {}, source: 'inapp-readiness-journey',
  metadata: {}, created_at: '2026-06-28T00:00:00Z', updated_at: '2026-06-28T00:00:00Z',
} as never;

describe('S1 · customer context profile (closes the write-only silo)', () => {
  it('projects the captured answers into a company-aware profile', () => {
    const p = buildCustomerContextProfile(assessment);
    expect(p.provenance).toBe('stated');
    expect(p.company.name).toBe('Honest & Young');
    expect(p.focus_90d).toContain('easy for employees');
    expect(p.growth_posture).toBe('Grow');
    expect(p.maturity_level).toBe('L5/5');
    expect(p.ai_tools_in_use).toEqual(['claude', 'chatgpt']);
    expect(p.customer_concentration).toBe('about 18%');
    expect(p.cyber_flag).toBe('nothing flagged');
  });

  it('the preamble is COMPANY-aware, NOT the hardcoded accountant stereotype', () => {
    const text = companyContextPreamble(buildCustomerContextProfile(assessment));
    expect(text).toContain('Honest & Young');
    expect(text).toContain('easy for employees');
    expect(text).toContain('grow the business');
    expect(text).toContain('claude');
    expect(text).not.toContain('accounting / building inspection'); // the exact bug fixed
  });

  it('falls back to the generic line when nothing is captured (never the stereotype)', () => {
    expect(buildCustomerContextProfile(null).provenance).toBe('none');
    const text = companyContextPreamble(buildCustomerContextProfile(null));
    expect(text).toContain('small-to-mid-size business');
    expect(text).not.toContain('accounting / building inspection');
  });

  it('reaches the AI from the WEBSITE funnel shape too (scraped stack/firmographics/cyber)', () => {
    // The website funnel stores the x-web enrichment shape (stack/firmographics/cyber, no Wave-B `.sources`).
    // Previously this was a write-only silo here — the scraped data never reached the AI. Now it does.
    const webLead = { ...assessment, enrichment: {
      domain: 'honestyoung.example',
      stack: [{ name: 'WordPress', category: 'CMS' }, { name: 'Cloudflare', category: 'Infrastructure' }],
      firmographics: { legalName: 'HONEST & YOUNG PTY LTD', identifiers: { abn: '88 412 776 905' } },
      cyber: [{ label: 'DMARC', state: 'pass' }, { label: 'SPF', state: 'fail' }, { label: 'TLS', state: 'inferred' }],
    } } as never;
    const p = buildCustomerContextProfile(webLead);
    const sig = p.public_signals.join(' | ');
    expect(sig).toContain('Technology stack: WordPress, Cloudflare');
    expect(sig).toContain('Registered entity: HONEST & YOUNG PTY LTD · ABN 88 412 776 905');
    expect(sig).toContain('DMARC: configured');
    expect(sig).toContain('SPF: missing');
    expect(sig).not.toContain('TLS'); // 'inferred' is unknown → never a claim (the honest-data rule)
    expect(companyContextPreamble(p)).toContain('Technology stack: WordPress'); // reaches the AI preamble
  });
});
