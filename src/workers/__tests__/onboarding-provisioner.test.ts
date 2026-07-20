// onboarding-provisioner.test.ts · 2026-06-07
//
// Orchestration tests for the server-side customer provisioner (replaces onboard-customer CLI).
// Mocks the DAL so we assert: the readiness-scaled roadmap + deterministic project id are passed
// to provisionCustomerWorkspace; a missing readiness assessment is NON-FATAL (base roadmap +
// warning); a missing access request 404s; missing ids are rejected; slug derivation.

import { describe, it, expect, vi } from 'vitest';
import {
  provisionCustomerFromAccessRequest,
  slugifyCustomer,
  mapSetupToRoadmapSteps,
  buildCharterSeed,
  type OnboardingProvisionerDal,
} from '../services/onboarding-provisioner';
import { buildDay1Roadmap } from '../services/onboarding-roadmap';
import { resolveDay1Setup } from '../dal/context-resolver';
import type { CompanyContext } from '../dal/types/access';

type ProvisionInput = Parameters<OnboardingProvisionerDal['provisionCustomerWorkspace']>[0];

const ACTIVITY_SUMMARY = {
  workspace_id: 'ws', events_total: 4, events_completed: 0, signoffs_total: 0, projects_total: 1,
  connected_sources: 0, first_activity_at: null, last_activity_at: null, days_of_history: 0,
  needs_you: 4, since: null, events_since: 0, signoffs_since: 0,
};

function mockDal(over: Record<string, unknown> = {}) {
  const provisionCalls: ProvisionInput[] = [];
  const upsertCalls: Array<{ wsId: string; event: Record<string, unknown> }> = [];
  const attachCalls: Array<{ email: string; wsId: string; userId: string | null }> = [];
  const scaffoldCalls: Array<{ input: Record<string, unknown>; actor: string }> = [];
  const base = {
    getAccessRequest: async () => ({
      id: 'ar1', email: 'ops@hy.example', company_name: 'Honest & Young', invited_to_workspace_id: null,
    }),
    getReadinessAssessment: async () => ({
      deep_level: 4, account_type: 'company', readiness_answers: { source: 'gdrive' },
      company_name: 'Honest & Young', domain: 'hy.example',
    }),
    // Part R · Stage C — defaults: no prior anonymous readiness by email (the email-fallback only
    // fires when getReadinessAssessment returns null), and the attach is a tracked no-op.
    getReadinessAssessmentByEmail: async () => null,
    attachReadinessToWorkspaceByEmail: async (email: string, wsId: string, userId: string | null) => {
      attachCalls.push({ email, wsId, userId });
      return 1;
    },
    provisionCustomerWorkspace: async (input: ProvisionInput) => {
      provisionCalls.push(input);
      return {
        workspace_id: input.clerkOrgId, project_id: input.projectId,
        members: input.operatorClerkId ? 2 : 1,
        events_created: 1 + input.roadmap.length, roadmap_steps: input.roadmap.length,
      };
    },
    getWorkspaceActivitySummary: async (id: string) => ({ ...ACTIVITY_SUMMARY, workspace_id: id }),
    upsertEvent: async (wsId: string, event: Record<string, unknown>) => {
      upsertCalls.push({ wsId, event });
      return { id: event.id, created: true };
    },
    createSyntheticDomain: async (input: Record<string, unknown>, actor: string) => {
      scaffoldCalls.push({ input, actor });
      return { id: `sd_${input.slug}`, ...input } as unknown;
    },
  };
  const dal = { ...base, ...over } as unknown as OnboardingProvisionerDal;
  return { dal, provisionCalls, upsertCalls, attachCalls, scaffoldCalls };
}

const REQ = {
  accessRequestId: 'ar1', clerkOrgId: 'org_abc123', ownerClerkId: 'user_owner123', approvedBy: 'user_admin',
};

describe('provisionCustomerFromAccessRequest', () => {
  it('provisions with a readiness-scaled roadmap + deterministic project id', async () => {
    const { dal, provisionCalls } = mockDal();
    const out = await provisionCustomerFromAccessRequest(dal, REQ);
    expect(provisionCalls).toHaveLength(1);
    const input = provisionCalls[0];
    expect(input.clerkOrgId).toBe('org_abc123');
    expect(input.ownerClerkId).toBe('user_owner123');
    expect(input.customerName).toBe('Honest & Young');
    expect(input.customerSlug).toBe('honest-young');
    expect(input.accessRequestId).toBe('ar1');
    expect(input.projectId).toBe('proj_honest-young_default');
    expect(input.roadmap).toHaveLength(6); // level 4 + company: 3 base + workflow + action + invite
    expect(out.readiness).toEqual({ level: 4, account_type: 'company', answers_count: 1 });
    expect(out.warnings).toHaveLength(0);
    expect(out.result.events_created).toBe(7);
  });

  it('is NON-FATAL when no readiness assessment exists (base roadmap + warning)', async () => {
    const { dal, provisionCalls } = mockDal({ getReadinessAssessment: async () => null });
    const out = await provisionCustomerFromAccessRequest(dal, REQ);
    expect(provisionCalls).toHaveLength(1);
    // level null -> 1, accountType defaults to 'company' -> 3 base + invite = 4
    expect(provisionCalls[0].roadmap).toHaveLength(4);
    expect(out.readiness).toBeNull();
    expect(out.warnings.join(' ')).toMatch(/no readiness assessment/i);
  });

  // Part R · Stage C — anonymous-lead → registration context linking.
  it('LINKS a prior anonymous readiness by verified email when the request has none', async () => {
    const { dal, provisionCalls, attachCalls } = mockDal({
      getReadinessAssessment: async () => null, // the fresh Clerk-org access_request has no readiness
      getReadinessAssessmentByEmail: async () => ({ // ...but this email has a prior anonymous funnel lead
        deep_level: 4, account_type: 'company', readiness_answers: { source: 'gdrive' },
        company_name: 'Honest & Young', domain: 'hy.example',
      }),
    });
    const out = await provisionCustomerFromAccessRequest(dal, REQ);
    // roadmap scaled from the LINKED readiness (level 4 → 6 steps), NOT the null-readiness base (4)
    expect(provisionCalls[0].roadmap).toHaveLength(6);
    expect(out.readiness).toEqual({ level: 4, account_type: 'company', answers_count: 1 });
    expect(out.warnings.join(' ')).toMatch(/linked by verified email/i);
    // the linked readiness is stamped onto the NEW workspace (so getCustomerContextProfile recovers it)
    expect(attachCalls).toEqual([{ email: 'ops@hy.example', wsId: 'org_abc123', userId: 'user_owner123' }]);
  });

  it('does NOT link or stamp when no readiness exists for the email (base roadmap, no leak)', async () => {
    const { dal, provisionCalls, attachCalls } = mockDal({
      getReadinessAssessment: async () => null,
      getReadinessAssessmentByEmail: async () => null, // no prior lead for this email
    });
    const out = await provisionCustomerFromAccessRequest(dal, REQ);
    expect(provisionCalls[0].roadmap).toHaveLength(4); // base roadmap (level null → 1, company)
    expect(out.readiness).toBeNull();
    expect(attachCalls).toHaveLength(0); // never stamps someone else's row
    expect(out.warnings.join(' ')).toMatch(/no readiness assessment/i);
  });

  it('404s when the access request is not found', async () => {
    const { dal } = mockDal({ getAccessRequest: async () => null });
    await expect(provisionCustomerFromAccessRequest(dal, REQ)).rejects.toThrow(/not found/i);
  });

  it('rejects when clerkOrgId or ownerClerkId is missing', async () => {
    const { dal } = mockDal();
    await expect(
      provisionCustomerFromAccessRequest(dal, { ...REQ, clerkOrgId: '' }),
    ).rejects.toThrow(/required/i);
  });

  it('drafts ONE day-1 PENDING welcome proposal into the new workspace', async () => {
    const { dal, upsertCalls } = mockDal();
    const out = await provisionCustomerFromAccessRequest(dal, REQ);
    expect(out.welcome_drafted).toBe(true);
    expect(upsertCalls).toHaveLength(1);
    const { wsId, event } = upsertCalls[0];
    expect(wsId).toBe('org_abc123');
    // a governed PENDING proposal the bell renders + can approve
    expect(event.status).toBe('needs_review');
    expect(event.approval_state).toBe('pending');
    expect(event.agent_id).toBe('xlooop:digest-agent');
    expect(event.source_tool).toBe('xlooop');
    expect(event.next_action).toBe('approve_to_post_digest');
    // distinct, idempotent id — never collides with the weekly digest's evt_agent_digest_*
    expect(event.id).toBe('evt_agent_welcome_org_abc123');
    expect(String(event.summary)).toMatch(/Honest & Young/);
    // it is a WELCOME, not a generic digest
    expect(String(event.body)).toMatch(/Welcome to Honest & Young/);
  });

  it('STILL provisions when getWorkspaceActivitySummary throws (welcome is best-effort)', async () => {
    const { dal, provisionCalls } = mockDal({
      getWorkspaceActivitySummary: async () => { throw new Error('summary boom'); },
    });
    const out = await provisionCustomerFromAccessRequest(dal, REQ);
    expect(provisionCalls).toHaveLength(1); // workspace was provisioned
    expect(out.result.workspace_id).toBe('org_abc123'); // result returned
    expect(out.welcome_drafted).toBe(false);
    expect(out.warnings.join(' ')).toMatch(/welcome draft skipped/i);
  });

  it('STILL provisions when upsertEvent throws (welcome is best-effort)', async () => {
    const { dal, provisionCalls } = mockDal({
      upsertEvent: async () => { throw new Error('upsert boom'); },
    });
    const out = await provisionCustomerFromAccessRequest(dal, REQ);
    expect(provisionCalls).toHaveLength(1);
    expect(out.result.workspace_id).toBe('org_abc123');
    expect(out.welcome_drafted).toBe(false);
    expect(out.warnings.join(' ')).toMatch(/welcome draft skipped/i);
  });

  it('LLM-enriches the welcome when a Workers-AI binding is passed', async () => {
    const { dal, upsertCalls } = mockDal();
    const ai = {
      run: async () => ({
        response: 'Welcome to Honest & Young — your workspace is live and ready. Four day-one items are queued and one project is set up. No sources are connected yet. Connect your first source to start capturing evidence.',
      }),
    };
    const out = await provisionCustomerFromAccessRequest(dal, { ...REQ, ai });
    expect(out.welcome_drafted).toBe(true);
    expect(String(upsertCalls[0].event.body)).toMatch(/workspace is live and ready/);
    // still PENDING — the LLM draft is never auto-posted
    expect(upsertCalls[0].event.approval_state).toBe('pending');
  });

  it('strict model lineage skips an unreceipted welcome model call without failing provisioning', async () => {
    const { dal, provisionCalls, upsertCalls } = mockDal();
    const run = vi.fn(async () => ({ response: 'This must not run.' }));

    const out = await provisionCustomerFromAccessRequest(dal, {
      ...REQ,
      ai: { run },
      modelLineageRequired: true,
    });

    expect(provisionCalls).toHaveLength(1);
    expect(out.welcome_drafted).toBe(false);
    expect(out.warnings.join(' ')).toMatch(/welcome draft skipped/i);
    expect(run).not.toHaveBeenCalled();
    expect(upsertCalls).toHaveLength(0);
  });

  it('strict model lineage wraps the welcome model call and closes skill lineage', async () => {
    const { dal } = mockDal();
    const finish = vi.fn(async () => undefined);
    const start = vi.fn(async () => ({ complete: finish }));
    const complete = vi.fn(async () => [] as string[]);
    const modelLineageFactory = vi.fn(async () => ({ observer: { start }, complete }));
    const ai = { run: vi.fn(async () => ({
      response: 'Welcome to Honest & Young. Your governed workspace is ready for a safe first review and source connection.',
    })) };

    const out = await provisionCustomerFromAccessRequest(dal, {
      ...REQ,
      ai,
      modelLineageRequired: true,
      modelLineageFactory,
    });

    expect(out.welcome_drafted).toBe(true);
    expect(modelLineageFactory).toHaveBeenCalledWith(expect.objectContaining({
      workspace_id: 'org_abc123',
      principal_id: 'xlooop:digest-agent',
      role: 'automation',
      action: 'assistant:onboard',
    }));
    expect(start).toHaveBeenCalledTimes(1);
    expect(finish).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed' }));
    expect(complete).toHaveBeenCalledTimes(1);
  });
});

// ── ctx_v1 resolver flag (CONTEXT_RESOLVER_ENABLED) ─────────────────────────
// Wiring: the resolver is OFF by default (zero behavior change). It only drives
// the roadmap when the flag is exactly 'true' AND readiness_answers.context is a
// valid ctx_v1 CompanyContext. Any failure falls back to buildDay1Roadmap.

// A valid ctx_v1 context (regulated professional-services). Chosen so the resolver
// output is observably DIFFERENT from buildDay1Roadmap (adds a regime-confirm step
// + provenance-gated bodies), making the "which source ran" assertions unambiguous.
const VALID_CONTEXT: CompanyContext = {
  schema_version: 'ctx_v1',
  company: {
    identity: { legalName: 'Honest & Young Pty Ltd', jurisdiction: 'AU' },
    sector: { value: 'Accounting', source: 'stated', confidence: 'high', asOf: '2026-06-09' },
    sizeStructure: { headcount: '11-50' },
    regulatoryRegime: { value: ['APES110'], source: 'operator', confidence: 'high', asOf: '2026-06-09' },
  },
  goals: {
    growthPosture: { value: 'Grow', source: 'stated', confidence: 'high', asOf: '2026-06-09' },
  },
  readiness: { level: { value: 4, source: 'operator', confidence: 'high', asOf: '2026-06-09' } },
};

// readiness assessment whose readiness_answers carries a ctx_v1 context payload.
function readinessWithContext(context: unknown) {
  return async () => ({
    deep_level: 4,
    account_type: 'company',
    readiness_answers: { source: 'gdrive', context },
    company_name: 'Honest & Young',
    domain: 'hy.example',
  });
}

describe('ctx_v1 resolver flag wiring', () => {
  // (a) flag OFF → buildDay1Roadmap is used (provisioning unchanged).
  it('flag OFF (default): uses buildDay1Roadmap — byte-identical to today', async () => {
    const { dal, provisionCalls } = mockDal({ getReadinessAssessment: readinessWithContext(VALID_CONTEXT) });
    // No env arg at all — the default ({}) path.
    const out = await provisionCustomerFromAccessRequest(dal, REQ);
    const expected = buildDay1Roadmap({ level: 4, accountType: 'company' });
    expect(provisionCalls[0].roadmap).toEqual(expected); // exact same steps as before
    expect(provisionCalls[0].roadmap).toHaveLength(6); // 3 base + workflow + action + invite
    // none of the resolver's regime-confirm body leaks in
    expect(JSON.stringify(provisionCalls[0].roadmap)).not.toMatch(/regulatory regime/i);
    // no resolver fallback warnings on the off path
    expect(out.warnings.join(' ')).not.toMatch(/context resolver/i);
  });

  it('flag explicitly OFF (anything not "true"): still uses buildDay1Roadmap', async () => {
    const { dal, provisionCalls } = mockDal({ getReadinessAssessment: readinessWithContext(VALID_CONTEXT) });
    await provisionCustomerFromAccessRequest(dal, REQ, { CONTEXT_RESOLVER_ENABLED: 'false' });
    expect(provisionCalls[0].roadmap).toEqual(buildDay1Roadmap({ level: 4, accountType: 'company' }));
  });

  // (b) flag ON + valid context → resolveDay1Setup drives the roadmap.
  it('flag ON + valid context: resolveDay1Setup drives the roadmap', async () => {
    const { dal, provisionCalls } = mockDal({ getReadinessAssessment: readinessWithContext(VALID_CONTEXT) });
    const out = await provisionCustomerFromAccessRequest(dal, REQ, { CONTEXT_RESOLVER_ENABLED: 'true' });
    const expected = mapSetupToRoadmapSteps(resolveDay1Setup(VALID_CONTEXT));
    expect(provisionCalls[0].roadmap).toEqual(expected); // resolver-sourced steps
    // the resolver output is observably DIFFERENT from the base roadmap
    expect(provisionCalls[0].roadmap).not.toEqual(buildDay1Roadmap({ level: 4, accountType: 'company' }));
    // resolver-only signal: regulated firms get a regime-confirm step
    expect(JSON.stringify(provisionCalls[0].roadmap)).toMatch(/regulatory regime/i);
    // adapter shape: every step is the SAME { summary, body } contract the seeding consumes
    for (const step of provisionCalls[0].roadmap) {
      expect(typeof step.summary).toBe('string');
      expect(step.summary.length).toBeGreaterThan(0);
      expect(typeof step.body).toBe('string');
      expect(step).not.toHaveProperty('gate'); // gate is NOT propagated downstream
      expect(step).not.toHaveProperty('n');
    }
    expect(out.warnings.join(' ')).not.toMatch(/falling back/i);
  });

  // (c) flag ON + invalid context → falls back to buildDay1Roadmap (never fails).
  it('flag ON + INVALID context: falls back to buildDay1Roadmap (+ warning)', async () => {
    const { dal, provisionCalls } = mockDal({
      getReadinessAssessment: readinessWithContext({ schema_version: 'not_ctx_v1', company: {} }),
    });
    const out = await provisionCustomerFromAccessRequest(dal, REQ, { CONTEXT_RESOLVER_ENABLED: 'true' });
    expect(provisionCalls[0].roadmap).toEqual(buildDay1Roadmap({ level: 4, accountType: 'company' }));
    expect(out.warnings.join(' ')).toMatch(/context resolver:.*invalid/i);
    // provisioning STILL succeeded
    expect(out.result.workspace_id).toBe('org_abc123');
  });

  // (c') flag ON + MISSING context → falls back to buildDay1Roadmap (never fails).
  it('flag ON + MISSING context: falls back to buildDay1Roadmap (+ warning)', async () => {
    const { dal, provisionCalls } = mockDal({
      // readiness_answers without a `context` key at all
      getReadinessAssessment: async () => ({
        deep_level: 4, account_type: 'company', readiness_answers: { source: 'gdrive' },
        company_name: 'Honest & Young', domain: 'hy.example',
      }),
    });
    const out = await provisionCustomerFromAccessRequest(dal, REQ, { CONTEXT_RESOLVER_ENABLED: 'true' });
    expect(provisionCalls[0].roadmap).toEqual(buildDay1Roadmap({ level: 4, accountType: 'company' }));
    expect(out.warnings.join(' ')).toMatch(/context resolver:.*invalid/i);
    expect(out.result.workspace_id).toBe('org_abc123');
  });
});

describe('mapSetupToRoadmapSteps adapter', () => {
  it('converts Day1Setup.roadmap → { summary, body } and drops gate/n', () => {
    const steps = mapSetupToRoadmapSteps(resolveDay1Setup(VALID_CONTEXT));
    expect(steps.length).toBe(resolveDay1Setup(VALID_CONTEXT).roadmap.length);
    for (const step of steps) {
      expect(Object.keys(step).sort()).toEqual(['body', 'summary']);
      expect(step.summary.length).toBeGreaterThan(0);
      expect(step.summary.length).toBeLessThanOrEqual(81); // 80 + ellipsis cap
      // body is preserved verbatim from the resolver step
    }
    // summary is derived from the body's leading clause
    expect(steps[0].body).toMatch(/single source of truth/i);
    expect(steps[0].summary).toMatch(/single source of truth/i);
  });
});

describe('slugifyCustomer', () => {
  it('lowercases + hyphenates + trims', () => {
    expect(slugifyCustomer('Honest & Young')).toBe('honest-young');
    expect(slugifyCustomer('A.C.M.E Corp!!')).toBe('a-c-m-e-corp');
    expect(slugifyCustomer('')).toBe('customer');
  });
});

describe('ABS-P3 · DOMAIN_SCAFFOLD_ENABLED domain-skeleton scaffold', () => {
  it('flag OFF (default) ⇒ NO scaffold calls, domains_scaffolded=0, byte-identical', async () => {
    const { dal, scaffoldCalls } = mockDal();
    const out = await provisionCustomerFromAccessRequest(dal, REQ); // no env ⇒ flag off
    expect(scaffoldCalls).toHaveLength(0);
    expect(out.domains_scaffolded).toBe(0);
    expect(out.warnings).toHaveLength(0);
  });

  it('flag ON ⇒ scaffolds the account-type archetype as honest-empty domains', async () => {
    const { dal, scaffoldCalls } = mockDal(); // readiness account_type='company' ⇒ regulated-smb (6 domains)
    const out = await provisionCustomerFromAccessRequest(dal, REQ, { DOMAIN_SCAFFOLD_ENABLED: 'true' });
    expect(out.domains_scaffolded).toBe(6);
    expect(scaffoldCalls).toHaveLength(6);
    for (const call of scaffoldCalls) {
      expect(call.input.workspace_id).toBe('org_abc123');
      expect(call.actor).toBe('user_owner123');
      // honest-empty: no fabricated content in any scaffolded input
      expect(JSON.stringify(call.input)).not.toMatch(/goal_count|has_roadmap|target_value|metric_name|review_due/);
      expect((call.input.metadata as Record<string, unknown>).scaffolded_by).toBe('domain-archetype-scaffold');
    }
    expect(scaffoldCalls.map((c) => c.input.slug)).toContain('operations');
  });

  it('flag ON · a per-domain create failure is NON-FATAL (warning, provisioning continues)', async () => {
    let n = 0;
    const { dal } = mockDal({
      createSyntheticDomain: async (input: Record<string, unknown>) => {
        n += 1;
        if (n === 1) throw new Error('binding rejected');
        return { id: `sd_${input.slug}` } as unknown;
      },
    });
    const out = await provisionCustomerFromAccessRequest(dal, REQ, { DOMAIN_SCAFFOLD_ENABLED: 'true' });
    expect(out.domains_scaffolded).toBe(5); // 6 attempted, 1 failed
    expect(out.warnings.join(' ')).toMatch(/domain scaffold: could not create/);
    expect(out.result).toBeTruthy(); // provisioning still succeeded
  });
});

// PR-3 (260721) · charter seed — the info->plan join. buildCharterSeed is pure; assert it seeds only
// typed fields + the customer's OWN verbatim q1 focus, fabricates nothing, and degrades honestly.
describe('buildCharterSeed', () => {
  it('seeds objectives_summary + a neutrally-titled objective from the verbatim q1 focus', () => {
    const seed = buildCharterSeed({
      answers: { q1: '  Cut month-end close from 10 days to 3  ' },
      accountType: 'company',
      level: 3,
      companyName: 'Acme Co',
    });
    expect(seed.objectives_summary).toBe('Cut month-end close from 10 days to 3'); // trimmed, verbatim
    expect(seed.objective).toEqual({
      title: 'Initial focus (from onboarding)', // neutral label — accurate regardless of q1 wording
      summary: 'Cut month-end close from 10 days to 3',
    });
    expect(seed.background).toBe('Acme Co · company · readiness level 3');
    expect(seed.mission).toBeNull(); // never fabricated
    expect(seed.industry).toBeNull();
  });

  it('seeds NO objective when q1 is absent/blank (honest-empty)', () => {
    const seed = buildCharterSeed({ answers: { q1: '   ' }, accountType: 'personal', level: null, companyName: 'Solo' });
    expect(seed.objective).toBeNull();
    expect(seed.objectives_summary).toBeNull();
    expect(seed.background).toBe('Solo · personal'); // no level suffix when level is null
  });

  it('degrades to all-null when readiness is empty (the store COALESCE then no-ops)', () => {
    const seed = buildCharterSeed({ answers: {}, accountType: 'company', level: null, companyName: '' });
    expect(seed.background).toBeNull();
    expect(seed.objectives_summary).toBeNull();
    expect(seed.objective).toBeNull();
  });
});
