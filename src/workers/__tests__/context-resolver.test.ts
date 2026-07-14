// context-resolver.test.ts · 2026-06-09
//
// Golden-fixture tests for the ctx_v1 company-context resolver (resolveDay1Setup)
// + the runtime validator (validateCompanyContext). The resolver is a STANDALONE,
// ADDITIVE module — buildDay1Roadmap stays the live default. These tests pin the
// deterministic projection of two real archetypes and guard the confidence gate.

import { describe, it, expect } from 'vitest';
import {
  resolveDay1Setup,
  validateCompanyContext,
} from '../dal/context-resolver';
import type { CompanyContext } from '../dal/types/access';

// ── Fixture A · HONEST & YOUNG — AU accounting firm, Grow posture ────────────
const HONEST_AND_YOUNG: CompanyContext = {
  schema_version: 'ctx_v1',
  company: {
    identity: {
      legalName: 'Honest & Young Pty Ltd',
      tradingName: 'Honest & Young',
      jurisdiction: 'AU',
    },
    sector: { value: 'Accounting', source: 'stated', confidence: 'high', asOf: '2026-06-01' },
    sizeStructure: { headcount: '6-9', entityType: 'Pty Ltd' },
    regulatoryRegime: {
      value: ['professional-services', 'AU-privacy'],
      source: 'stated',
      confidence: 'high',
      asOf: '2026-06-01',
    },
    techStack: ['QuickBooks Online', 'Google Workspace'],
    // dmarc is a PUBLIC_SIGNAL-only fact at this level (OSINT scan), per-field source
    // is carried by the resolver's risk register, not a Fact<> here (cyberPosture is plain).
    cyberPosture: { dmarc: 'warn' },
  },
  goals: {
    priority90d: 'Grow advisory revenue',
    growthPosture: { value: 'Grow', source: 'stated', confidence: 'high', asOf: '2026-06-01' },
  },
  urgency: {
    valueHorizon: { value: 'quarter', source: 'stated', confidence: 'medium', asOf: '2026-06-01' },
  },
  people: {
    operator: { role: 'Managing Partner', authority: 'full' },
  },
  readiness: {
    // INFERRED readiness level (we estimated it, the customer did not self-score) →
    // the confidence gate must downgrade readiness-driven steps to 'confirm'.
    level: { value: 2, source: 'inferred', confidence: 'low', asOf: '2026-06-01' },
  },
};

// ── Fixture B · ACCESS PROPERTY SERVICES (ASP) — AU building inspection ──────
const ACCESS_PROPERTY_SERVICES: CompanyContext = {
  schema_version: 'ctx_v1',
  company: {
    identity: {
      legalName: 'Access Property Services Pty Ltd',
      tradingName: 'Access Property Services',
      jurisdiction: 'AU',
    },
    sector: {
      value: 'Construction · Building inspection',
      source: 'stated',
      confidence: 'high',
      asOf: '2026-06-01',
    },
    sizeStructure: { headcount: '6-9', entityType: 'Pty Ltd' },
    regulatoryRegime: {
      value: ['NSW-fair-trading', 'defect-liability'],
      source: 'stated',
      confidence: 'high',
      asOf: '2026-06-01',
    },
    techStack: ['QuickBooks Online', 'Google Workspace', 'iAuditor'],
    customerConcentration: { topPct: 40 },
  },
  goals: {
    priority90d: 'Stabilise inspection throughput',
    growthPosture: { value: 'Sustain', source: 'stated', confidence: 'high', asOf: '2026-06-01' },
  },
  urgency: {
    valueHorizon: { value: 'weeks', source: 'stated', confidence: 'medium', asOf: '2026-06-01' },
  },
  people: {
    // needs_signoff authority → Action steps must be gate:'needs_signoff'.
    operator: { role: 'Director', authority: 'needs_signoff' },
  },
  readiness: {
    level: { value: 1, source: 'stated', confidence: 'medium', asOf: '2026-06-01' },
  },
};

describe('resolveDay1Setup · HONEST & YOUNG (AU accounting, Grow)', () => {
  const setup = resolveDay1Setup(HONEST_AND_YOUNG);

  it('roster includes a compliance/workpaper agent', () => {
    expect(setup.agentRoster.some((a) => a.id === 'compliance-workpaper')).toBe(true);
  });

  it('roster includes a growth/pipeline agent for the Grow posture', () => {
    expect(setup.agentRoster.some((a) => a.id === 'pipeline-growth')).toBe(true);
  });

  it('ranks google_drive (or microsoft_onedrive) ABOVE every other provider', () => {
    const top = setup.connectors.find((c) => c.rank === 1);
    expect(top).toBeDefined();
    expect(['google_drive', 'microsoft_onedrive']).toContain(top!.provider);
  });

  it('NEVER surfaces an accounting provider (no accounting backend exists)', () => {
    const REAL = ['github', 'google_drive', 'dropbox', 'gitlab', 'microsoft_onedrive'];
    for (const c of setup.connectors) {
      expect(REAL).toContain(c.provider);
      expect(c.provider).not.toMatch(/quickbooks|xero|account/i);
    }
  });

  it('produces a roadmap with >= 3 steps', () => {
    expect(setup.roadmap.length).toBeGreaterThanOrEqual(3);
  });

  it('has at least one "confirm" gate (readiness level is an inferred fact)', () => {
    expect(setup.roadmap.some((s) => s.gate === 'confirm')).toBe(true);
  });

  it('flags the warn-DMARC posture in the risk register', () => {
    expect(setup.riskRegister.some((r) => /dmarc/i.test(r.risk))).toBe(true);
  });
});

describe('resolveDay1Setup · ACCESS PROPERTY SERVICES (AU building inspection, Sustain, needs_signoff)', () => {
  const setup = resolveDay1Setup(ACCESS_PROPERTY_SERVICES);

  it('roster reflects construction/inspection compliance', () => {
    const ids = setup.agentRoster.map((a) => a.id);
    expect(ids).toContain('inspection-compliance');
    // regulated → compliance/workpaper agent too
    expect(ids).toContain('compliance-workpaper');
  });

  it('ranks a document store first (document-first for a regulated firm)', () => {
    const top = setup.connectors.find((c) => c.rank === 1);
    expect(['google_drive', 'microsoft_onedrive', 'dropbox']).toContain(top!.provider);
  });

  it('makes Action roadmap steps gate:"needs_signoff" (authority gating works)', () => {
    const actionSteps = setup.roadmap.filter((s) => /Action mode/i.test(s.body));
    expect(actionSteps.length).toBeGreaterThan(0);
    for (const s of actionSteps) {
      expect(s.gate).toBe('needs_signoff');
    }
  });

  it('produces a non-empty risk register (customer concentration 40%)', () => {
    expect(setup.riskRegister.length).toBeGreaterThan(0);
    expect(setup.riskRegister.some((r) => /concentration/i.test(r.risk))).toBe(true);
  });
});

describe('validateCompanyContext', () => {
  it('accepts a well-formed ctx_v1 context', () => {
    const res = validateCompanyContext(HONEST_AND_YOUNG);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.context.schema_version).toBe('ctx_v1');
  });

  it('rejects a malformed context (wrong schema_version + bad enum)', () => {
    const malformed = {
      ...HONEST_AND_YOUNG,
      schema_version: 'ctx_v0', // wrong tag
      goals: {
        growthPosture: { value: 'Expand', source: 'stated', confidence: 'high', asOf: '2026-06-01' }, // bad enum
      },
    };
    const res = validateCompanyContext(malformed);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors.some((e) => /schema_version/.test(e))).toBe(true);
      expect(res.errors.some((e) => /growthPosture/.test(e))).toBe(true);
    }
  });

  it('rejects a context missing the required sector Fact envelope', () => {
    const broken = {
      schema_version: 'ctx_v1',
      company: {
        identity: { legalName: 'X', jurisdiction: 'AU' },
        sizeStructure: {},
        // sector omitted
      },
      goals: {},
    };
    const res = validateCompanyContext(broken);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.some((e) => /company\.sector/.test(e))).toBe(true);
  });
});

describe('confidence gate', () => {
  it('downgrades a public_signal-only driving fact to gate:"confirm", never "auto"', () => {
    // A context whose sector fact is PUBLIC_SIGNAL-only (we scraped it, customer never
    // confirmed). The sector-driven roadmap steps must be 'confirm', not 'auto'.
    const publicSignalCtx: CompanyContext = {
      ...HONEST_AND_YOUNG,
      company: {
        ...HONEST_AND_YOUNG.company,
        sector: {
          value: 'Accounting',
          source: 'public_signal',
          confidence: 'low',
          asOf: '2026-06-01',
        },
      },
      readiness: {
        level: { value: 1, source: 'public_signal', confidence: 'low', asOf: '2026-06-01' },
      },
    };
    const setup = resolveDay1Setup(publicSignalCtx);
    // The source-of-truth + first-connect steps are sector-driven → must be 'confirm'.
    const sectorDriven = setup.roadmap.filter((s) =>
      /single source of truth|Connect your first resource/i.test(s.body),
    );
    expect(sectorDriven.length).toBeGreaterThan(0);
    for (const s of sectorDriven) {
      expect(s.gate).not.toBe('auto');
      expect(s.gate).toBe('confirm');
    }
  });

  it('keeps a step gate:"auto" when its driving fact is stated/operator/connected_data', () => {
    // HONEST_AND_YOUNG.sector is source:'stated' → its driven steps are 'auto'.
    const setup = resolveDay1Setup(HONEST_AND_YOUNG);
    const firstConnect = setup.roadmap.find((s) => /Connect your first resource/i.test(s.body));
    expect(firstConnect).toBeDefined();
    expect(firstConnect!.gate).toBe('auto');
  });
});
