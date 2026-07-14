// classify-body-of-work.ts · going-forward attribution classifier
//
// PURE, deterministic, no I/O, worker-safe. Given a (commit/PR/issue) summary
// and optional changed paths, returns ONE of the 8 canonical "body of work"
// slugs so a new GitHub event can self-file into the right project at ingest —
// instead of every event from a repo getting one static project_id.
//
// Used by src/workers/routes/github-webhook.ts when a repo opts into per-event
// split (GITHUB_WEBHOOK_REPO_MAP entry has `"split": true`). The producer
// prefixes the workspace id: project_id = `${workspace_id}-${slug}`.
//
// Design (per _cockpit-ia-260609/GOING_FORWARD_SPEC.md):
//   - PRIORITY-ORDERED summary keyword rules. First match wins. This matters:
//     a commit touching "investor onboarding" must resolve deterministically,
//     so investor outranks onboarding, onboarding outranks funnel, etc.
//   - Optional changed-path hints REFINE the decision: a path signal can only
//     OVERRIDE the keyword result up to the default `cockpit-ux` (i.e. paths
//     never demote a confident keyword match, they rescue the default).
//   - Default slug is `cockpit-ux` (the dominant bucket for dev-commit traffic:
//     cockpit / workspace / runtime / render / UI / design work).
//
// Validated against 694 operator-labeled events (their existing project_id is
// the ground truth). See classify-body-of-work.test.ts for the agreement gate.

export type BodyOfWorkSlug =
  | 'cockpit-ux'
  | 'event-pipeline'
  | 'infra-deploy'
  | 'governance'
  | 'onboarding'
  | 'commercial-gtm'
  | 'investor'
  | 'funnel';

/** The 8 canonical slugs, in their priority order (investor first, cockpit-ux is the default). */
export const BODY_OF_WORK_SLUGS: readonly BodyOfWorkSlug[] = [
  'investor',
  'onboarding',
  'funnel',
  'event-pipeline',
  'governance',
  'infra-deploy',
  'commercial-gtm',
  'cockpit-ux',
] as const;

export const DEFAULT_SLUG: BodyOfWorkSlug = 'cockpit-ux';

export interface SummaryRule {
  slug: BodyOfWorkSlug;
  /** Tested against the summary, case-insensitively. */
  pattern: RegExp;
}

// PRIORITY-ORDERED summary keyword rules. First match wins.
// Exported so the validation/unit test reuses the exact same list (no drift).
//
// This ruleset was TUNED against 694 operator-labeled events (the existing
// project_id is the ground truth) — agreement ~82% overall. The dev-commit
// corpus is noisy (identical commits sometimes live in two buckets; plain
// "Merge pull request #N from <branch>" rows are near-arbitrary; a11y/audit/
// security/email work is split across cockpit-ux and governance/infra/onboarding)
// so ~82% is close to the deterministic-keyword ceiling here. cockpit-ux is the
// dominant bucket (39% of rows) and the default, so the priority order leads
// with the high-precision buckets and a strong cockpit-ux "claim" rule that
// protects clearly-cockpit work (workbench / ADR-V3 / assisted-mode / UX) from
// being stolen by the greedier governance / infra keywords.
//
// Tuning decisions worth remembering (each backed by a ground-truth count):
//   - A bare `from`/`FROM` token catastrophically mislabels every
//     "Merge pull request #N from <branch>" row as infra — NEVER add it.
//   - `audit`, `closeout`, bare `security`/`egress`, `reconcile`, `bundle`,
//     `repo schema` lean cockpit-ux, NOT governance/infra — keep them out of
//     those buckets (they sit in the cockpit-ux claim instead).
//   - `readiness` alone is ambiguous (commercial vs onboarding vs event-
//     pipeline evidence-refresh); only the qualified forms are used.
//   - `email`/`notifier` split ~50/50 infra vs onboarding (literally the same
//     commit in both) → kept in infra; onboarding still catches its email rows
//     via `customer approved`/`access-request`/`company_name`.
//   - `workspace create`/`createWorkspace`/`slug collision` lean cockpit-ux.
export const SUMMARY_RULES: readonly SummaryRule[] = [
  // 1. investor — data room / deck / SAFE / cap table / portal.
  {
    slug: 'investor',
    pattern:
      /\b(investor|data[ -]?room|dataroom|DR-1|pitch[ -]?deck|cap[ -]?table|SAFE|fundrais|seed round|term[ -]?sheet|investor-portal|investor-store|IDR_CCY|currency selector)\b/i,
  },
  // 2. infra-deploy HIGH-PRECISION pre-tier — unambiguous deploy/migration/
  //    merge-conflict signals that the cockpit-ux claim below would otherwise
  //    steal (e.g. "chore(deploy): bump __V3_BUILD ... ship assisted-mode"
  //    contains "assisted-mode"; "Merge remote-tracking branch" has no other
  //    signal). Only the safest, near-zero-ambiguity infra phrases live here.
  {
    slug: 'infra-deploy',
    pattern:
      /(chore\(deploy\)|fix\(deploy\)|feat\(deploy\)|ops\(deploy\)|chore\(build\)|chore\(deps\)|chore\(schema\)|chore\(hosted\)|chore\(email\)|fix\(email\)|fix\(health\)|fix\(db\)|fix\(build\)|apply orphaned migration|prod-migration|__V3_BUILD|REPO-SCHEMA regen|repo-schema|render-gate|merge remote-tracking|deploy receipt|deployment evidence|deploy evidence|align DAL to operator-applied|provider schema|schema realign)/i,
  },
  // 3. cockpit-ux STRONG claim — protect unambiguous cockpit/UX work from the
  //    greedier governance/infra keywords downstream. Checked early on purpose.
  {
    slug: 'cockpit-ux',
    pattern:
      /(workbench|ADR-V3|pane-?host|pane catalogue|multi-pane|assisted-mode|hover-help|notifications|first-run tour|design-adoption|MetricCard|EmptyState|god-component|decompose|decomp-|left-rail|drill-down|empty\/degraded|workspace-shell|reorder|UX critique|UX honesty|origin badge|design prompt|claude design|shell-widgets|shell CSS|retention|audit-driven|repo schema|source binding|project source|migration 014|domain scope|workspace[ -]?create|createWorkspace|slug collision)/i,
  },
  // 3. commercial-gtm — pmf / launch / pricing / demo-proof / walkthrough.
  //    Placed before onboarding & event-pipeline so "production-launch",
  //    "demo readiness", "pmf", "preflight" win their rows.
  {
    slug: 'commercial-gtm',
    pattern:
      /\b(commercial|showcase|demo[ -]?proof|demo[ -]?readiness|demo readiness|demo posture|public[ -]?launch|production[ -]?launch|four-pilot|customer[ -]?safe|pricing|sales|go-to-market|gtm|one-?pager|whitepaper|value prop|pmf|sean ellis|must-have|north-star|DAU|return-rate|engagement readout|walkthrough|presenter|commercial readiness|preflight)\b/i,
  },
  // 4. governance (high-precision tier) — release-truth / disposition / gates /
  //    ci-local / cwd-anchor / a11y-disposition. Before event-pipeline so the
  //    "refresh ... evidence" rows that are really governance land here.
  {
    slug: 'governance',
    pattern:
      /\b(release[ -]?truth|disposition|HR-|claim[ -]?safety|claim posture|verification matrix|branch disposition|classify .*a11y|a11y branch|release debt|nested-interactive release|governance|seam-gate|component-size|ci-?local|cilocal|cwd-anchor|worktree guard|pre-?commit|precommit|auto-stage|orphaned (gate|verify)|gate hardening|gate-triage|structural verify|verify gate|charter-gates|isolation verifier|current-integrity|land-lock|npm run land|parity-proven|mental-model ground-truth|archive .*audit docs|reuse-map gate|axe-core|enforce-first|enforceable regression)\b/i,
  },
  // 5. event-pipeline — the producer/ingest/projection plane.
  {
    slug: 'event-pipeline',
    pattern:
      /\b(webhook|live[ -]?stream|livestream|live-data|live-workspaces|live seam|live-events|producer|projection|operation_events|operation event|ingest|ingestion|event pipeline|event-pipeline|event-store|sweep|backfill|cron|staged_snapshot|source_mode|source-sync|source.sync|scope_binding|scope breadcrumb|provenance endpoint|inference-store|\/events|useProjectEvents|enriched.?stream|synthetic domain|fixture.?live|operations evidence|operations live stream|per-provider|sources\/:id|hydrat|attribution|digest agent|governed digest|workers ai|agent-strip|agentfeed|readagentfeed|operator-overlay|operator overlay|dual-source|valid_until|freshness badge|self-diagnosing|real event)\b/i,
  },
  // 6. onboarding — provisioning / customer registration / consent / access.
  //    NOTE: prefix tokens (onboard*, provision*) deliberately omit the trailing
  //    \b so "onboarding" / "provisioner" / "provisioning" all match.
  {
    slug: 'onboarding',
    pattern:
      /\b(onboard\w*|provision\w*|request[ -]?access|access-request|access-store|day[ -]?1|day[ -]?one|magic[ -]?link|clerk|invite|entitlement|on-?ramp|customer[ -]?registration|customer onboarding|customer readiness|customer approved|admin approve|signup|CompanyContext|repo[ -]?picker|repo picker|turnstile|company_name|registration|go-live|consent|authority|reconnect source)\b/i,
  },
  // 7. governance (residual tier) — redaction / X-SCP / a11y-gate terms that we
  //    keep below event-pipeline & onboarding so they don't over-claim.
  {
    slug: 'governance',
    pattern: /\b(redaction|X-SCP|regression gate|clickability gate|baseline gate|architecture[ -]?baseline|FSD)\b/i,
  },
  // 8. infra-deploy — migrations / deploy / build tokens / wrangler / email
  //    config / schema realign / hosting. NOTE: never add a bare `from`/`db`/
  //    `workflow` token here — they mislabel merge/cockpit rows (see header).
  {
    slug: 'infra-deploy',
    pattern:
      /\b(migration|deploy|cloudflare|wrangler|pages|build token|__V3_BUILD|cache.?buster|cache token|submodule|secret|env var|vite|esbuild|tsconfig|lockfile|package lock|deps|email|notifier|cloudflare email|subdomain|health|schema regen|schema realign|rate-limit|prod-migration|sidecar|MIME|_middleware|CSP|preview|consolidate DAL|DAL helpers|deploy:|hosted|provider schema|fix\(db\)|db:|database|CJS\/ESM|worker test suite|alert recipient)\b/i,
  },
  // 9. funnel — public marketing site / lead funnel (NOT bare "enrich").
  {
    slug: 'funnel',
    pattern: /\b(funnel|x-web|marketing site|landing page|lead[ -]?gen|public site|waitlist)\b/i,
  },
];

export interface PathRule {
  slug: BodyOfWorkSlug;
  /** Tested against each changed path, case-insensitively. */
  pattern: RegExp;
}

// Changed-path hints. Only consulted to RESCUE the default (cockpit-ux): when
// the summary keyword rules find no confident match, the changed paths get a
// vote. Priority-ordered, first match wins, same priority intent as summaries.
// Exported so the unit test can exercise each hint.
export const PATH_RULES: readonly PathRule[] = [
  { slug: 'onboarding', pattern: /(routes\/request-access|request-access|onboarding|provision|onboarding-provisioner)/i },
  {
    slug: 'event-pipeline',
    pattern: /(routes\/github-webhook|github-webhook|live-stream|livestream|live_stream|producer|activity-webhook|operation_events|projection)/i,
  },
  { slug: 'governance', pattern: /(routes\/synthetic-domains|synthetic-domains|governance|\.signoff|verify-)/i },
  { slug: 'investor', pattern: /(invest|data-?room|dataroom)/i },
  { slug: 'funnel', pattern: /(x-web|funnel|marketing)/i },
  { slug: 'infra-deploy', pattern: /(migrations\/|wrangler|\.toml$|\.github\/workflows|deployment\/|scripts\/deploy)/i },
  { slug: 'commercial-gtm', pattern: /(commercial|pricing|showcase|gtm)/i },
  { slug: 'cockpit-ux', pattern: /(src\/widgets|src\/app|src\/components|cockpit|\.css$|design)/i },
];

/**
 * Classify a single body of work from a summary line (and optional changed paths).
 *
 * @param summary      The event summary (commit subject / PR title / issue title).
 *                     May include a `[owner/repo] ` prefix — that's fine, it's ignored
 *                     by the keyword rules.
 * @param changedPaths Optional list of file paths touched (push events). Used only to
 *                     rescue the `cockpit-ux` default when the summary is ambiguous.
 * @returns One of the 8 canonical slugs. Never throws.
 */
export function classifyBodyOfWork(summary: string, changedPaths?: string[]): BodyOfWorkSlug {
  const text = typeof summary === 'string' ? summary : '';

  // 1) Priority-ordered summary keyword rules — first match wins.
  for (const rule of SUMMARY_RULES) {
    if (rule.pattern.test(text)) return rule.slug;
  }

  // 2) No confident summary match → let changed paths vote (rescue the default).
  if (Array.isArray(changedPaths) && changedPaths.length > 0) {
    for (const rule of PATH_RULES) {
      for (const p of changedPaths) {
        if (typeof p === 'string' && rule.pattern.test(p)) return rule.slug;
      }
    }
  }

  // 3) Default — the dominant bucket for cockpit/runtime/UI work.
  return DEFAULT_SLUG;
}
