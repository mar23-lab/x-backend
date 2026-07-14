// context-resolver.ts · ctx_v1 company-context validator + day-1 setup resolver.
//
// Authority: the post-launch "build the context" reframe (strategy synthesis).
// CompanyContext types are owned in ./types/access.ts (HR-XCP-DEMO-NO-COUPLE).
//
// ┌─────────────────────────────────────────────────────────────────────────┐
// │ SAFETY: this is ADDITIVE foundation. resolveDay1Setup is a STANDALONE     │
// │ module. It is NOT wired into the live provision route (routes/admin.ts)  │
// │ or scripts/onboard-customer.mjs — buildDay1Roadmap stays the live default.│
// │ The operator flips this resolver on post-launch after validating it       │
// │ against a real pilot. That wiring is a later, deliberate step.            │
// └─────────────────────────────────────────────────────────────────────────┘
//
// Two exports:
//   validateCompanyContext(input) — closes the "unvalidated JSONB silent
//     corruption" risk: when x-web emits a context into readiness_answers.context,
//     a malformed payload is REJECTED with errors rather than silently accepted.
//   resolveDay1Setup(context)     — deterministic, pure projection of a validated
//     CompanyContext into a concrete day-1 setup (agents + connectors + roadmap +
//     risk register). A superset of buildDay1Roadmap's roadmap-only output.
//
// No I/O. No DB. No side effects. Fully unit-testable.

import type {
  CompanyContext,
  ContextConnectorProvider,
  Day1AgentPick,
  Day1ConnectorPick,
  Day1RoadmapStep,
  Day1Risk,
  Day1Setup,
  Fact,
} from './types/access';

// ============================================================================
// PART 2 · VALIDATOR (stdlib — no zod dependency)
// ============================================================================
//
// zod is NOT a project dependency (verified: grep package.json + src imports →
// none). Per the task's no-new-dependency constraint, this is a focused stdlib
// runtime validator. It checks exactly what the resolver relies on: the
// schema_version tag, the required identity/sector/goals shape, the bounded
// Fact<> envelope on every provenance-tracked field, and the closed enum sets.

export type ValidateCompanyContextResult =
  | { ok: true; context: CompanyContext }
  | { ok: false; errors: string[] };

const FACT_SOURCES = ['public_signal', 'stated', 'connected_data', 'operator', 'inferred'] as const;
const CONFIDENCES = ['low', 'medium', 'high'] as const;
const GROWTH_POSTURES = ['Grow', 'Sustain', 'Transition', 'Exit'] as const;
const STAGES = ['startup', 'growth', 'mature', 'transition'] as const;
const VALUE_HORIZONS = ['days', 'weeks', 'quarter', 'exploratory'] as const;
const TARGET_KINDS = ['revenue', 'margin', 'compliance_deadline', 'concentration'] as const;
const AUTHORITIES = ['full', 'needs_signoff'] as const;
const TOOL_DEPTHS = ['exploration', 'pilot', 'production'] as const;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Validate the Fact<> envelope at `path`. Returns null if `raw` is absent
 * (optional fields are allowed to be missing); otherwise pushes any structural
 * errors into `errors` and returns whether the envelope is well-formed.
 *
 * `valueCheck` validates the inner `value` (e.g. is it one of an enum set).
 */
function checkFact(
  raw: unknown,
  path: string,
  errors: string[],
  valueCheck?: (value: unknown, errors: string[], path: string) => void,
): void {
  if (!isPlainObject(raw)) {
    errors.push(`${path}: expected a Fact object { value, source, confidence, asOf }`);
    return;
  }
  if (!('value' in raw)) errors.push(`${path}.value: required`);
  if (!FACT_SOURCES.includes(raw.source as (typeof FACT_SOURCES)[number])) {
    errors.push(`${path}.source: must be one of ${FACT_SOURCES.join('|')}`);
  }
  if (!CONFIDENCES.includes(raw.confidence as (typeof CONFIDENCES)[number])) {
    errors.push(`${path}.confidence: must be one of ${CONFIDENCES.join('|')}`);
  }
  if (typeof raw.asOf !== 'string' || raw.asOf.trim() === '') {
    errors.push(`${path}.asOf: required ISO-8601 string`);
  }
  if (valueCheck && 'value' in raw) valueCheck(raw.value, errors, path);
}

function checkEnum(
  value: unknown,
  allowed: readonly string[],
  errors: string[],
  path: string,
): void {
  if (!allowed.includes(value as string)) {
    errors.push(`${path}: must be one of ${allowed.join('|')}`);
  }
}

/**
 * validateCompanyContext — runtime gate for ctx_v1 context payloads.
 *
 * Rejects (ok:false) on: wrong/missing schema_version, missing required identity
 * fields, missing/malformed required Fact<> envelopes (company.sector, goals), bad
 * enum members. Accepts (ok:true) a well-formed context and narrows it to the type.
 */
export function validateCompanyContext(input: unknown): ValidateCompanyContextResult {
  const errors: string[] = [];

  if (!isPlainObject(input)) {
    return { ok: false, errors: ['root: expected a CompanyContext object'] };
  }

  // schema_version tag — the hard gate.
  if (input.schema_version !== 'ctx_v1') {
    errors.push(`schema_version: must be 'ctx_v1' (got ${JSON.stringify(input.schema_version)})`);
  }

  // company (required)
  const company = input.company;
  if (!isPlainObject(company)) {
    errors.push('company: required object');
  } else {
    const identity = company.identity;
    if (!isPlainObject(identity)) {
      errors.push('company.identity: required object');
    } else {
      if (typeof identity.legalName !== 'string' || identity.legalName.trim() === '') {
        errors.push('company.identity.legalName: required non-empty string');
      }
      if (typeof identity.jurisdiction !== 'string' || identity.jurisdiction.trim() === '') {
        errors.push('company.identity.jurisdiction: required non-empty string');
      }
    }
    // sector is a REQUIRED Fact<string> (the resolver branches on it).
    checkFact(company.sector, 'company.sector', errors, (value, errs, path) => {
      if (typeof value !== 'string' || value.trim() === '') {
        errs.push(`${path}.value: required non-empty string`);
      }
    });
    if (company.stage !== undefined) {
      checkFact(company.stage, 'company.stage', errors, (v, e, p) => checkEnum(v, STAGES, e, `${p}.value`));
    }
    if (!isPlainObject(company.sizeStructure)) {
      errors.push('company.sizeStructure: required object (fields may be empty)');
    }
    if (company.regulatoryRegime !== undefined) {
      checkFact(company.regulatoryRegime, 'company.regulatoryRegime', errors, (v, e, p) => {
        if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
          e.push(`${p}.value: must be a string[]`);
        }
      });
    }
    if (company.techStack !== undefined && !Array.isArray(company.techStack)) {
      errors.push('company.techStack: must be a string[]');
    }
  }

  // goals (required object; growthPosture / quantifiedTarget are optional Facts)
  const goals = input.goals;
  if (!isPlainObject(goals)) {
    errors.push('goals: required object');
  } else {
    if (goals.growthPosture !== undefined) {
      checkFact(goals.growthPosture, 'goals.growthPosture', errors, (v, e, p) =>
        checkEnum(v, GROWTH_POSTURES, e, `${p}.value`),
      );
    }
    if (goals.quantifiedTarget !== undefined) {
      checkFact(goals.quantifiedTarget, 'goals.quantifiedTarget', errors, (v, e, p) => {
        if (!isPlainObject(v)) {
          e.push(`${p}.value: must be a { kind, value?, by? } object`);
        } else {
          checkEnum(v.kind, TARGET_KINDS, e, `${p}.value.kind`);
        }
      });
    }
  }

  // urgency (optional)
  if (input.urgency !== undefined) {
    if (!isPlainObject(input.urgency)) {
      errors.push('urgency: must be an object');
    } else if (input.urgency.valueHorizon !== undefined) {
      checkFact(input.urgency.valueHorizon, 'urgency.valueHorizon', errors, (v, e, p) =>
        checkEnum(v, VALUE_HORIZONS, e, `${p}.value`),
      );
    }
  }

  // operatingReality (optional)
  if (input.operatingReality !== undefined) {
    if (!isPlainObject(input.operatingReality)) {
      errors.push('operatingReality: must be an object');
    } else if (input.operatingReality.aiTools !== undefined) {
      checkFact(input.operatingReality.aiTools, 'operatingReality.aiTools', errors, (v, e, p) => {
        if (!Array.isArray(v)) {
          e.push(`${p}.value: must be an array of { id, depth }`);
        } else {
          v.forEach((tool, i) => {
            if (!isPlainObject(tool) || typeof tool.id !== 'string') {
              e.push(`${p}.value[${i}].id: required string`);
            } else {
              checkEnum(tool.depth, TOOL_DEPTHS, e, `${p}.value[${i}].depth`);
            }
          });
        }
      });
    }
  }

  // people (optional)
  if (input.people !== undefined) {
    if (!isPlainObject(input.people)) {
      errors.push('people: must be an object');
    } else {
      const operator = input.people.operator;
      if (operator !== undefined) {
        if (!isPlainObject(operator)) {
          errors.push('people.operator: must be an object');
        } else if (operator.authority !== undefined) {
          checkEnum(operator.authority, AUTHORITIES, errors, 'people.operator.authority');
        }
      }
      if (input.people.decisionMakerNamed !== undefined) {
        checkFact(input.people.decisionMakerNamed, 'people.decisionMakerNamed', errors, (v, e, p) => {
          if (typeof v !== 'boolean') e.push(`${p}.value: must be a boolean`);
        });
      }
      if (input.people.reviewerNamed !== undefined) {
        checkFact(input.people.reviewerNamed, 'people.reviewerNamed', errors, (v, e, p) => {
          if (typeof v !== 'boolean') e.push(`${p}.value: must be a boolean`);
        });
      }
    }
  }

  // readiness (optional)
  if (input.readiness !== undefined) {
    if (!isPlainObject(input.readiness)) {
      errors.push('readiness: must be an object');
    } else if (input.readiness.level !== undefined) {
      checkFact(input.readiness.level, 'readiness.level', errors, (v, e, p) => {
        if (typeof v !== 'number' || v < 0 || v > 5) {
          e.push(`${p}.value: must be a number in [0,5]`);
        }
      });
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, context: input as unknown as CompanyContext };
}

// ============================================================================
// PART 3 · RESOLVER (deterministic, pure)
// ============================================================================

/** The 5 real connector providers, in their stable default fallback order. */
const ALL_PROVIDERS: ContextConnectorProvider[] = [
  'github',
  'google_drive',
  'dropbox',
  'gitlab',
  'microsoft_onedrive',
];

/** Document-store (knowledge) connectors — what a REGULATED firm gets FIRST. */
const DOCUMENT_PROVIDERS: ContextConnectorProvider[] = [
  'google_drive',
  'microsoft_onedrive',
  'dropbox',
];

/** Code/repo connectors — relevant to software-leaning tech stacks. */
const REPO_PROVIDERS: ContextConnectorProvider[] = ['github', 'gitlab'];

/** Sources the confidence gate TRUSTS (a fact from here can drive an 'auto' step). */
const TRUSTED_SOURCES: ReadonlyArray<Fact<unknown>['source']> = [
  'stated',
  'connected_data',
  'operator',
];

function isTrusted(fact: Fact<unknown> | undefined): boolean {
  return !!fact && TRUSTED_SOURCES.includes(fact.source);
}

function lc(s: string | undefined): string {
  return (s || '').toLowerCase();
}

/** True if the company operates under any regulatory regime. */
function isRegulated(ctx: CompanyContext): boolean {
  const regime = ctx.company.regulatoryRegime?.value;
  return Array.isArray(regime) && regime.length > 0;
}

// ── 3a · agent roster ───────────────────────────────────────────────────────
// Pick agents by sector + growthPosture + urgency. Regulated professional-services
// firms get a compliance/workpaper agent; a 'Grow' posture adds a pipeline agent;
// an 'Exit' posture adds a valuation agent; short value-horizons add a quick-win
// agent. Always includes the baseline operations agent.
function resolveAgentRoster(ctx: CompanyContext): Day1AgentPick[] {
  const roster: Day1AgentPick[] = [];
  const sector = lc(ctx.company.sector.value);
  const posture = ctx.goals.growthPosture?.value;
  const horizon = ctx.urgency?.valueHorizon?.value;

  // Baseline — every customer gets an operations/chief-of-staff agent.
  roster.push({
    id: 'operations-coordinator',
    reason: 'Baseline operations coordinator — watches the source of truth and stages the stream.',
  });

  // Regulated / professional-services / accounting → compliance + workpaper agent.
  const regulated = isRegulated(ctx);
  const profServices =
    sector.includes('account') ||
    sector.includes('legal') ||
    sector.includes('audit') ||
    sector.includes('professional');
  if (regulated || profServices) {
    roster.push({
      id: 'compliance-workpaper',
      reason: `Regulated/professional-services sector ("${ctx.company.sector.value}") — compliance + workpaper agent for evidence trails and regime obligations.`,
    });
  }

  // Construction / building-inspection → defect + inspection compliance agent.
  if (sector.includes('construction') || sector.includes('building') || sector.includes('inspection')) {
    roster.push({
      id: 'inspection-compliance',
      reason: `Construction/inspection sector — defect-liability + inspection compliance agent.`,
    });
  }

  // Growth posture.
  if (posture === 'Grow') {
    roster.push({
      id: 'pipeline-growth',
      reason: 'Growth posture (Grow) — pipeline agent to surface and progress opportunities.',
    });
  } else if (posture === 'Exit') {
    roster.push({
      id: 'valuation-readiness',
      reason: 'Exit posture — valuation-readiness agent to assemble diligence-grade records.',
    });
  } else if (posture === 'Transition') {
    roster.push({
      id: 'transition-continuity',
      reason: 'Transition posture — continuity agent to capture process knowledge during change.',
    });
  }

  // Short value-horizon → a quick-win agent to deliver value fast.
  if (horizon === 'days' || horizon === 'weeks') {
    roster.push({
      id: 'quick-win-scout',
      reason: `Short value-horizon (${horizon}) — quick-win scout to find one reversible win in the first cycle.`,
    });
  }

  return roster;
}

// ── 3b · connectors ───────────────────────────────────────────────────────
// Rank the 5 real providers by regulatoryRegime + techStack. REGULATED firms get
// document stores (Drive/OneDrive) FIRST — never an accounting backend (none
// exists). Software-leaning stacks bubble repo providers up. Output is a stable,
// de-duplicated, 1-based ranking over ONLY the 5 real providers.
function resolveConnectors(ctx: CompanyContext): Day1ConnectorPick[] {
  const regulated = isRegulated(ctx);
  const stack = (ctx.company.techStack || []).map(lc).join(' ');
  const usesMicrosoft = stack.includes('microsoft') || stack.includes('365') || stack.includes('onedrive') || stack.includes('sharepoint');
  const usesGoogle = stack.includes('google') || stack.includes('gdrive') || stack.includes('workspace');
  const softwareLeaning =
    stack.includes('github') || stack.includes('gitlab') || stack.includes('git') || stack.includes('repo') || stack.includes('code');

  const ordered: ContextConnectorProvider[] = [];
  const push = (p: ContextConnectorProvider) => {
    if (!ordered.includes(p)) ordered.push(p);
  };

  if (regulated) {
    // Regulated → document-first. Prefer the suite the stack already uses.
    if (usesMicrosoft && !usesGoogle) {
      push('microsoft_onedrive');
      push('google_drive');
    } else {
      push('google_drive');
      push('microsoft_onedrive');
    }
    push('dropbox');
    // Repos last for regulated firms unless clearly software-leaning.
    if (softwareLeaning) {
      push('github');
      push('gitlab');
    }
  } else if (softwareLeaning) {
    // Software-leaning, non-regulated → repos first.
    push('github');
    push('gitlab');
    if (usesMicrosoft) push('microsoft_onedrive');
    push('google_drive');
    push('dropbox');
  } else {
    // Default → document stores, suite-aware.
    if (usesMicrosoft && !usesGoogle) push('microsoft_onedrive');
    push('google_drive');
    push('microsoft_onedrive');
    push('dropbox');
  }

  // Backfill any remaining real providers in stable order (never invent accounting).
  for (const p of ALL_PROVIDERS) push(p);

  return ordered.map((provider, i) => {
    const isDoc = DOCUMENT_PROVIDERS.includes(provider);
    const isRepo = REPO_PROVIDERS.includes(provider);
    let reason: string;
    if (regulated && isDoc) {
      reason = 'Regulated firm — connect a document store first (evidence + workpapers live here).';
    } else if (softwareLeaning && isRepo) {
      reason = 'Software-leaning stack — repository is the live source of truth.';
    } else if (isDoc) {
      reason = 'Document store — the most common single source of truth.';
    } else {
      reason = 'Available connector (lower priority for this profile).';
    }
    return { provider, rank: i + 1, reason } satisfies Day1ConnectorPick;
  });
}

// ── 3c · roadmap ───────────────────────────────────────────────────────────
// Scale step count + aggressiveness by readiness.level × urgency.valueHorizon ×
// people.operator.authority. CONFIDENCE GATE: a step is 'auto' only if its driving
// facts are sourced stated|connected_data|operator; a public_signal-only/inferred
// driving fact downgrades the step to 'confirm' (a "confirm this" card, never auto).
// An operator whose authority is 'needs_signoff' makes Action steps 'needs_signoff'.
function resolveRoadmap(ctx: CompanyContext): Day1RoadmapStep[] {
  const level = ctx.readiness?.level?.value;
  const lvl = typeof level === 'number' ? level : 1;
  const horizon = ctx.urgency?.valueHorizon?.value;
  const authority = ctx.people?.operator?.authority;
  const needsSignoff = authority === 'needs_signoff';

  // The sector fact + regime fact drive the "what to connect / what to govern" steps;
  // their provenance decides whether those steps auto-seed or need a confirm card.
  const sectorTrusted = isTrusted(ctx.company.sector);
  const regimeTrusted = isTrusted(ctx.company.regulatoryRegime);
  const readinessTrusted = isTrusted(ctx.readiness?.level);

  const steps: Array<{ body: string; gate: Day1RoadmapStep['gate']; isAction: boolean }> = [];

  // Step 1 — confirm the single source of truth (driven by sector + tech stack).
  steps.push({
    body: 'Confirm your single source of truth and connect it first in Watch mode — Xlooop only observes until you grant Action authority.',
    gate: sectorTrusted ? 'auto' : 'confirm',
    isAction: false,
  });

  // Step 2 — acknowledge the authority + consent boundary (always governed).
  steps.push({
    body: 'Review and accept the in-app authority + consent boundary. Private connectors and team invites stay locked until you do.',
    gate: 'auto',
    isAction: false,
  });

  // Step 3 — connect first resource read-only. Trusted if the sector/profile fact is trusted.
  steps.push({
    body: 'Connect your first resource read-only. You will see it appear in your operations stream within minutes.',
    gate: sectorTrusted ? 'auto' : 'confirm',
    isAction: false,
  });

  // Step 4 — regulated firms confirm the regime obligations. Provenance-gated: an
  // inferred/public-signal regime becomes a "confirm this" card (we GUESSED the regime).
  if (isRegulated(ctx)) {
    steps.push({
      body: `Confirm your regulatory regime (${(ctx.company.regulatoryRegime?.value || []).join(', ')}) so the compliance agent scopes the right obligations.`,
      gate: regimeTrusted ? 'auto' : 'confirm',
      isAction: false,
    });
  }

  // Step 5 — map a recurring workflow (readiness >= 2). Gated by readiness provenance.
  if (lvl >= 2) {
    steps.push({
      body: 'Map one recurring workflow and let Xlooop watch a full cycle so it can propose a roadmap grounded in your real cadence.',
      gate: readinessTrusted ? 'auto' : 'confirm',
      isAction: false,
    });
  }

  // Step 6 — quick-win Action pilot for short horizons OR high readiness. This is an
  // ACTION step: under needs_signoff authority it becomes 'needs_signoff'; otherwise
  // its gate follows the readiness provenance.
  if (lvl >= 4 || horizon === 'days' || horizon === 'weeks') {
    steps.push({
      body: 'Pilot Action mode on one low-risk, reversible task with a clear owner. Every action stays operator-gated and fully audited.',
      gate: needsSignoff ? 'needs_signoff' : readinessTrusted ? 'auto' : 'confirm',
      isAction: true,
    });
  }

  // Apply the authority gate uniformly: any Action step under needs_signoff authority
  // must be 'needs_signoff' regardless of provenance.
  return steps.map((s, i) => ({
    n: i + 1,
    body: s.body,
    gate: s.isAction && needsSignoff ? 'needs_signoff' : s.gate,
  }));
}

// ── 3d · risk register ───────────────────────────────────────────────────────
// Derive risks from cyberPosture (disclosed incident / DMARC) + customer
// concentration + a quantified compliance-deadline target.
function resolveRiskRegister(ctx: CompanyContext): Day1Risk[] {
  const risks: Day1Risk[] = [];
  const cyber = ctx.company.cyberPosture;

  if (cyber?.disclosedIncident) {
    risks.push({
      risk: 'A cyber incident has been publicly disclosed for this company — verify remediation before connecting sensitive sources.',
      severity: 'high',
      source: 'company.cyberPosture.disclosedIncident',
    });
  }

  const dmarc = lc(cyber?.dmarc);
  if (dmarc && dmarc !== 'pass' && dmarc !== 'reject' && dmarc !== 'quarantine') {
    risks.push({
      risk: `DMARC posture is "${cyber?.dmarc}" — email spoofing exposure; recommend tightening before agent-driven outbound.`,
      severity: dmarc === 'fail' || dmarc === 'none' ? 'high' : 'medium',
      source: 'company.cyberPosture.dmarc',
    });
  }

  const topPct = ctx.company.customerConcentration?.topPct;
  if (typeof topPct === 'number' && topPct >= 25) {
    risks.push({
      risk: `Customer concentration: top customer(s) represent ~${topPct}% of revenue — a single-account dependency risk.`,
      severity: topPct >= 50 ? 'high' : 'medium',
      source: 'company.customerConcentration.topPct',
    });
  }

  const target = ctx.goals.quantifiedTarget?.value;
  if (target?.kind === 'compliance_deadline') {
    risks.push({
      risk: `Compliance deadline${target.by ? ` (by ${target.by})` : ''}${target.value ? `: ${target.value}` : ''} — a hard date the roadmap must respect.`,
      severity: 'high',
      source: 'goals.quantifiedTarget',
    });
  } else if (target?.kind === 'concentration') {
    risks.push({
      risk: `Target addresses customer concentration${target.by ? ` by ${target.by}` : ''} — track diversification progress.`,
      severity: 'medium',
      source: 'goals.quantifiedTarget',
    });
  }

  return risks;
}

/**
 * resolveDay1Setup — the conclusive ctx_v1 projection. Deterministic + pure: same
 * CompanyContext in → same Day1Setup out, no I/O. A SUPERSET of buildDay1Roadmap
 * (roster + connectors + provenance-gated roadmap + risk register).
 *
 * NOT wired into the live provision path — buildDay1Roadmap stays the live default.
 */
export function resolveDay1Setup(context: CompanyContext): Day1Setup {
  return {
    agentRoster: resolveAgentRoster(context),
    connectors: resolveConnectors(context),
    roadmap: resolveRoadmap(context),
    riskRegister: resolveRiskRegister(context),
  };
}
