// onboarding-roadmap.ts · pure context builders for customer provisioning.
//
// Ported VERBATIM from scripts/onboard-customer.mjs (R55 Phase 4b) so the
// server-side provisioner produces the exact same day-1 roadmap + readiness
// brief the proven CLI did — but as pure, unit-testable functions instead of a
// terminal script. No DB, no I/O here.
//
// buildDay1Roadmap → operation_events the customer sees on first login (scaled
//   to AI-readiness level L0-L5 + account type).
// buildReadinessBrief → the customer-safe AI_TOOL_READINESS.md markdown brief
//   (used by Wave 3's structured-brief generator; kept here next to its sibling).

export interface RoadmapStep {
  summary: string;
  body: string;
}

export interface Day1RoadmapInput {
  /** readiness deep_level (0-5); null/non-integer → treated as level 1. */
  level: number | null;
  /** 'personal' | 'company' | 'both' (anything else → no teammate step). */
  accountType: string;
}

/**
 * Day-1 roadmap, scaled to AI-readiness level + account type. Always returns the
 * 3 base steps; adds workflow-mapping (L>=2), Action-mode pilot (L>=4), and an
 * invite step (company/both). Identical output to the CLI's buildDay1Roadmap.
 */
export function buildDay1Roadmap({ level, accountType }: Day1RoadmapInput): RoadmapStep[] {
  const lvl = Number.isInteger(level as number) ? (level as number) : 1;
  const steps: RoadmapStep[] = [
    {
      summary: 'Confirm your single source of truth',
      body: 'Pick the one place your team already trusts (docs, tracker, or drive) and connect it first in Watch mode. Nothing is changed — Xlooop only observes until you grant Action authority.',
    },
    {
      summary: 'Acknowledge your privacy + authority boundary',
      body: 'Review and accept the in-app authority + consent screen. Private connectors and team invites stay locked until you do — this is the IP boundary that keeps your data yours.',
    },
    {
      summary: 'Connect your first resource in Watch mode',
      body: 'Once consent is recorded, connect a knowledge base or repository read-only. You will see it appear in your operations stream within minutes.',
    },
  ];
  if (lvl >= 2) {
    steps.push({
      summary: 'Map one recurring workflow',
      body: 'Choose a weekly operation (reporting, triage, or review) and let Xlooop watch one full cycle so it can propose a roadmap grounded in your real cadence.',
    });
  }
  if (lvl >= 4) {
    steps.push({
      summary: 'Pilot Action mode on one low-risk task',
      body: 'With a clear owner and a reversible scope, approve a single Action-mode task. Every action stays operator-gated and fully audited.',
    });
  }
  if (accountType === 'company' || accountType === 'both') {
    steps.push({
      summary: 'Invite a teammate',
      body: 'After consent is recorded, invite one teammate as a viewer so they can follow the operations stream. Owners and operators can invite from Settings.',
    });
  }
  return steps;
}

/**
 * Wave C · S5a — one "Connect <tool>" day-1 task per declared data-source integration
 * (Slack / Jira / Notion / Salesforce / …). The customer told us WHERE their work lives; this turns
 * each into an actionable connect-task on the day-1 roadmap (reusing the roadmap→operation_events
 * channel — no new surface). Until per-provider OAuth ingestion lands (S5b), this is the concrete
 * connect-checklist that makes the integration gap visible + actionable. De-duplicated; tolerant of
 * an array of {id,label} objects OR plain strings.
 */
export function buildConnectTasks(integrations: unknown): RoadmapStep[] {
  if (!Array.isArray(integrations)) return [];
  const seen = new Set<string>();
  const steps: RoadmapStep[] = [];
  for (const it of integrations) {
    const obj = it && typeof it === 'object' ? (it as { id?: unknown; label?: unknown }) : null;
    const id = String((obj ? obj.id : it) ?? '').trim();
    const label = String((obj ? (obj.label ?? obj.id) : it) ?? '').trim() || id;
    const name = label || id;
    const key = name.toLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    steps.push({
      summary: `Connect ${name}`,
      body: `You told us your work lives in ${name}. Connect it in Watch mode so Xlooop can ground its help in your real ${name} data — read-only until you grant Action authority, so nothing is changed.`,
    });
  }
  return steps;
}

export interface ReadinessBriefInput {
  customerName: string;
  customerEmail: string;
  accountType: string;
  levelLabel: string;
  answers: Record<string, unknown>;
  domain?: string | null;
  companyName?: string | null;
}

/**
 * Customer-safe AI Tool Readiness brief (markdown). No MB-P internals, no engine
 * formulas. Identical output to the CLI's buildReadinessBrief. Wave 3 promotes
 * this into a structured, provenance-carrying record; kept pure here.
 */
export function buildReadinessBrief({
  customerName,
  customerEmail,
  accountType,
  levelLabel,
  answers,
  domain,
  companyName,
}: ReadinessBriefInput): string {
  const dims: Array<[string, string]> = [
    ['Source clarity', 'Is there a clear, single source of truth to connect first?'],
    ['Workflow clarity', 'Are the recurring workflows well-defined enough to observe and map?'],
    ['Privacy boundaries', 'Has the IP / authority boundary (consent) been acknowledged?'],
    ['Owner authority', 'Is there a clear owner who can grant Action authority?'],
    ['Data quality', 'Is the connected data structured and trustworthy enough to act on?'],
    ['Action-mode readiness', 'Is the customer ready to pilot reversible, operator-gated Action mode?'],
  ];
  const answerEntries = Object.entries(answers || {});
  const answerLines = answerEntries.length
    ? answerEntries
        .map(([k, v]) => `- **${k}:** ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
        .join('\n')
    : '- _(no structured answers captured in the funnel)_';
  const dimLines = dims
    .map(
      ([name, q]) =>
        `### ${name}\n\n${q}\n\n_Operator to score against the Q&A above (readiness level ${levelLabel})._\n`,
    )
    .join('\n');
  return `# AI Tool Readiness — ${customerName}

> Generated from the readiness funnel Q&A (server-side provisioner).
> Customer-safe framing only — no internal platform details, no scoring formulas.

| Field | Value |
|---|---|
| Customer | ${customerName} |
| Contact | ${customerEmail} |
| Account type | ${accountType} |
| Readiness level | ${levelLabel} |
| Company | ${companyName || '—'} |
| Domain | ${domain || '—'} |

## Readiness Q&A (as submitted)

${answerLines}

## Six readiness dimensions

${dimLines}

## Day-1 posture

The customer starts in **Watch mode**. Private connectors and team invites are **locked** until the
in-app authority + consent acknowledgement is recorded (operator approval is already granted at
provisioning). Scale the roadmap depth to the readiness level above.
`;
}
