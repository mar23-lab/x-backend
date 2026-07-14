// infer-source-context.ts · ADR-XLOOP-IA-001 R1
//
// "Connect-a-source → auto-link by context." At bind time we extract context from a
// source binding (repo/folder name, path, description, source_kind) and PROPOSE a domain
// hint + tags. This is PROPOSE-THEN-CONFIRM: the function is PURE and never mutates — the
// bind route returns the proposal alongside the created binding, and the operator/customer
// confirms before anything is tagged or a lens is created. Mirrors the priority-ordered
// keyword pattern of classify-body-of-work.ts (first match wins).
//
// It does NOT auto-create lenses, does NOT write tags, and does NOT touch the external
// MB-P graph. It only suggests.

import type { SyntheticDomainKind } from '../dal/types/synthetic-domain';

/** The non-mutating proposal returned at bind time. */
export interface SourceContextProposal {
  /** how confident the keyword match is — 'low' means "we defaulted, ask the user". */
  confidence: 'high' | 'medium' | 'low';
  /** the proposed domain discriminator. */
  kind: SyntheticDomainKind;
  /** a suggested lens/domain label the user can accept or rename. */
  domain_hint: string;
  /** suggested metadata.tags to add to the project (additive; never replaces existing tags). */
  tags: string[];
  /** which signal matched, for transparency in the UI ("matched 'investor' in the repo name"). */
  matched_on: string | null;
}

/** The minimal binding shape this reads — matches ProjectSourceBindingInput's relevant fields. */
export interface SourceContextInput {
  source_kind?: string | null;
  source_ref?: Record<string, unknown> | null;
}

interface ContextRule {
  /** tested case-insensitively against the source haystack. */
  pattern: RegExp;
  kind: SyntheticDomainKind;
  domain_hint: string;
  tags: string[];
}

// Priority-ordered. First match wins. Specific business/life contexts before generic work.
const CONTEXT_RULES: ContextRule[] = [
  // --- life domains (kind=life) -------------------------------------------------
  {
    pattern: /\b(health|medical|fitness|wellness|clinic|patient|nutrition)\b/i,
    kind: 'life', domain_hint: 'Health', tags: ['health'],
  },
  {
    pattern: /\b(career|resume|cv|linkedin|job[ -]?search|portfolio)\b/i,
    kind: 'life', domain_hint: 'Career', tags: ['career'],
  },
  {
    pattern: /\b(family|personal|home|household|travel|diary|journal)\b/i,
    kind: 'life', domain_hint: 'Personal', tags: ['personal'],
  },
  // --- company entities (kind=company) -----------------------------------------
  // A legal-entity suffix or explicit company/trust marker → a company-scoped lens.
  {
    pattern: /\b(pty\.?\s?ltd|ltd\.?|inc\.?|llc|gmbh|s\.?a\.?r\.?l|trust|holdings?|ventures?)\b/i,
    kind: 'company', domain_hint: 'Company', tags: ['company'],
  },
  // --- work domains (kind=work) -------------------------------------------------
  {
    pattern: /\b(investor|data[ -]?room|dataroom|pitch[ -]?deck|cap[ -]?table|fundrais|term[ -]?sheet|safe note)\b/i,
    kind: 'work', domain_hint: 'Investor-facing', tags: ['investor'],
  },
  {
    pattern: /\b(finance|financ|accounting|payroll|invoice|billing|revenue|budget|forecast)\b/i,
    kind: 'work', domain_hint: 'Finance', tags: ['finance'],
  },
  {
    pattern: /\b(legal|contract|compliance|gdpr|policy|patent|ip[ -]?portfolio|trademark)\b/i,
    kind: 'work', domain_hint: 'Legal & Compliance', tags: ['legal'],
  },
  {
    pattern: /\b(market|marketing|seo|campaign|growth|brand|social|content)\b/i,
    kind: 'work', domain_hint: 'Marketing', tags: ['marketing'],
  },
  {
    pattern: /\b(design|figma|ui|ux|brand[ -]?kit|prototype|wireframe)\b/i,
    kind: 'work', domain_hint: 'Design', tags: ['design'],
  },
  {
    pattern: /\b(infra|infrastructure|devops|deploy|terraform|kubernetes|k8s|ci[ -]?cd|pipeline)\b/i,
    kind: 'work', domain_hint: 'Infrastructure', tags: ['infra'],
  },
  {
    pattern: /\b(docs?|documentation|wiki|handbook|runbook|knowledge[ -]?base)\b/i,
    kind: 'work', domain_hint: 'Documentation', tags: ['docs'],
  },
  {
    pattern: /\b(api|backend|service|server|worker|sdk|engine|platform)\b/i,
    kind: 'work', domain_hint: 'Engineering', tags: ['engineering'],
  },
];

/** Build a lowercased haystack from a source binding's string-valued ref fields + the kind. */
function buildHaystack(input: SourceContextInput): string {
  const parts: string[] = [];
  if (typeof input.source_kind === 'string') parts.push(input.source_kind);
  const ref = input.source_ref ?? {};
  for (const v of Object.values(ref)) if (typeof v === 'string') parts.push(v);
  return parts.join('  ');
}

/** Tags derived purely from the source_kind (orthogonal to the context match). */
function sourceKindTags(sourceKind: string | null | undefined): string[] {
  switch (sourceKind) {
    case 'github_repo': return ['code'];
    case 'google_drive_folder': return ['drive'];
    case 'desktop_folder': return ['local'];
    default: return [];
  }
}

/**
 * PURE. Infer a context proposal from a source binding. Never mutates, never auto-creates.
 * The caller (the bind route) returns this as a suggestion; nothing happens until the
 * operator/customer confirms.
 */
export function inferSourceContext(input: SourceContextInput): SourceContextProposal {
  const haystack = buildHaystack(input);
  const kindTags = sourceKindTags(input.source_kind ?? null);

  for (const rule of CONTEXT_RULES) {
    const m = haystack.match(rule.pattern);
    if (m) {
      // de-dup the union of the rule tags + the source-kind tags
      const tags = Array.from(new Set([...rule.tags, ...kindTags]));
      return {
        confidence: 'high',
        kind: rule.kind,
        domain_hint: rule.domain_hint,
        tags,
        matched_on: m[0],
      };
    }
  }

  // No confident keyword match — default to a generic work lens and ASK (low confidence).
  return {
    confidence: 'low',
    kind: 'work',
    domain_hint: 'General',
    tags: kindTags,
    matched_on: null,
  };
}
