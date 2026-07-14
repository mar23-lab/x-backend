// classify-body-of-work.test.ts
//
// Unit coverage for the going-forward attribution classifier. We assert one
// representative case per bucket (real dev-commit phrasing from the corpus the
// classifier was tuned against), the cockpit-ux default, the changed-path
// hints, and a few of the hard-won tuning invariants (the bugs that cost the
// most agreement during tuning — encoded here so a future edit can't regress
// them silently).

import { describe, it, expect } from 'vitest';
import {
  classifyBodyOfWork,
  BODY_OF_WORK_SLUGS,
  DEFAULT_SLUG,
  SUMMARY_RULES,
  PATH_RULES,
} from '../classify-body-of-work';

describe('classifyBodyOfWork · per-bucket summary cases', () => {
  const cases: Array<[string, string]> = [
    ['investor', 'feat(investor): port content-corrected 13-frame pitch deck (deploy held)'],
    ['investor', 'feat(investor-portal Phase 2): session-to-tier bridge — closes real-investor access gap'],
    ['onboarding', 'feat(onboarding): server-side customer provisioner (Wave 1) - no CLI'],
    ['onboarding', 'feat(customer): gate private connectors on authority consent'],
    ['onboarding', 'Merge pull request #471 from mar23-lab/claude/onboarding-provisioner-260607'],
    ['funnel', 'feat(funnel): public marketing site lead-gen capture'],
    ['event-pipeline', 'feat(R54-Stage1): GitHub webhook producer - the first real event producer'],
    ['event-pipeline', 'chore(data): fresh cron push with staged_snapshot source_mode (id=962)'],
    ['governance', 'fix(release-truth): ignore detached pseudo branch in disposition gate'],
    ['governance', 'feat(Wave R-L Stage 0): component-size ratchet gate + ci-local --strict'],
    ['infra-deploy', 'feat(R54-Stage0): apply orphaned migrations 009/010/011 to prod + operational-liveness gate'],
    ['infra-deploy', 'chore(deploy): bump __V3_BUILD r55-13→r55-14 — ship assisted-mode rewire to app.xlooop.com'],
    ['commercial-gtm', 'feat(pmf): Sean Ellis PMF must-have metric - survey + capture + summary (migration 019)'],
    ['commercial-gtm', 'fix(xlooop): close commercial readiness p0 gates'],
    ['cockpit-ux', 'feat(workbench): multi-pane + docked-chat adapter logic + flags (ADR-V3-024 delta step 3)'],
    ['cockpit-ux', 'feat(assisted-mode): rewire hover-help onto the LIVE chat-first surfaces'],
  ];

  it.each(cases)('classifies as %s: "%s"', (expected, summary) => {
    expect(classifyBodyOfWork(summary)).toBe(expected);
  });
});

describe('classifyBodyOfWork · default + repo-prefixed summaries', () => {
  it('falls back to cockpit-ux for an ambiguous summary', () => {
    expect(classifyBodyOfWork('chore: misc tidy-up')).toBe(DEFAULT_SLUG);
    expect(classifyBodyOfWork(DEFAULT_SLUG)).toBe('cockpit-ux');
  });

  it('ignores a leading [owner/repo] prefix (keyword still matches)', () => {
    expect(classifyBodyOfWork('[mar23-lab/Xlooop-XCP-demo] feat(investor): pitch deck v2')).toBe('investor');
  });

  it('never throws on empty / non-string input and returns the default', () => {
    expect(classifyBodyOfWork('')).toBe('cockpit-ux');
    // @ts-expect-error — exercise the runtime guard for non-string input
    expect(classifyBodyOfWork(undefined)).toBe('cockpit-ux');
  });
});

describe('classifyBodyOfWork · changed-path hints (rescue the default)', () => {
  it('cockpit-ux when an ambiguous summary touches src/widgets|src/app', () => {
    expect(classifyBodyOfWork('chore: tweak', ['src/app/Shell.tsx'])).toBe('cockpit-ux');
    expect(classifyBodyOfWork('chore: tweak', ['src/widgets/EventRow.tsx'])).toBe('cockpit-ux');
  });

  it('infra-deploy when an ambiguous summary touches migrations|wrangler|*.toml', () => {
    expect(classifyBodyOfWork('chore: tidy', ['src/workers/db/migrations/020.sql'])).toBe('infra-deploy');
    expect(classifyBodyOfWork('chore: tidy', ['wrangler.toml'])).toBe('infra-deploy');
  });

  it('event-pipeline when an ambiguous summary touches the producer/live-stream routes', () => {
    expect(classifyBodyOfWork('chore: tidy', ['src/workers/routes/github-webhook.ts'])).toBe('event-pipeline');
    expect(classifyBodyOfWork('chore: tidy', ['scripts/push-operations-live-stream.mjs'])).toBe('event-pipeline');
  });

  it('governance when an ambiguous summary touches synthetic-domains|governance', () => {
    expect(classifyBodyOfWork('chore: tidy', ['src/workers/routes/synthetic-domains.ts'])).toBe('governance');
  });

  it('onboarding when an ambiguous summary touches request-access|provision', () => {
    expect(classifyBodyOfWork('chore: tidy', ['src/workers/routes/request-access.ts'])).toBe('onboarding');
  });

  it('a confident summary keyword OUTRANKS a conflicting path hint', () => {
    // summary says investor; paths say cockpit — summary wins (step 1 before paths).
    expect(classifyBodyOfWork('feat(investor): data room', ['src/widgets/Foo.tsx'])).toBe('investor');
  });
});

describe('classifyBodyOfWork · tuning invariants (regression guards)', () => {
  // The single most damaging bug found during tuning: a bare `from`/`FROM` token
  // in the infra rule mislabels every "Merge pull request #N from <branch>" row.
  it('a plain merge-PR row is NOT swept into infra-deploy by the word "from"', () => {
    const merged = classifyBodyOfWork(
      'Merge pull request #503 from mar23-lab/claude/ux-consolidation-260608',
    );
    expect(merged).not.toBe('infra-deploy');
  });

  // `onboard*` / `provision*` must match their -ing / -er / -ion suffixes.
  it('matches onboarding/provisioner suffixes (not just the bare stems)', () => {
    expect(classifyBodyOfWork('feat: customer onboarding flow')).toBe('onboarding');
    expect(classifyBodyOfWork('feat: server-side provisioner')).toBe('onboarding');
    expect(classifyBodyOfWork('chore: provisioning script')).toBe('onboarding');
  });

  // event-pipeline evidence-refresh must outrank commercial's (removed) bare
  // "readiness", and audit/closeout must stay cockpit-ux (not governance).
  it('"chore(readiness): refresh operations live stream evidence" → event-pipeline', () => {
    expect(classifyBodyOfWork('chore(readiness): refresh operations live stream evidence')).toBe('event-pipeline');
  });

  it('an audit-driven cockpit commit stays cockpit-ux (audit is not governance here)', () => {
    expect(classifyBodyOfWork('feat(cockpit): audit-driven UX honesty + protection wave')).toBe('cockpit-ux');
  });
});

describe('exports are stable for downstream reuse', () => {
  it('exposes all 8 canonical slugs', () => {
    expect([...BODY_OF_WORK_SLUGS].sort()).toEqual(
      ['cockpit-ux', 'commercial-gtm', 'event-pipeline', 'funnel', 'governance', 'infra-deploy', 'investor', 'onboarding'].sort(),
    );
  });

  it('every classifier output is one of the 8 canonical slugs', () => {
    const samples = [
      'feat(investor): deck', 'feat(onboarding): provision', 'feat(funnel): site',
      'feat(webhook): producer', 'fix(release-truth): gate', 'chore(deploy): bump',
      'feat(pmf): metric', 'random unmatched text', '',
    ];
    for (const s of samples) {
      expect(BODY_OF_WORK_SLUGS).toContain(classifyBodyOfWork(s));
    }
  });

  it('rule lists are non-empty and well-formed (slug + RegExp)', () => {
    expect(SUMMARY_RULES.length).toBeGreaterThan(0);
    expect(PATH_RULES.length).toBeGreaterThan(0);
    for (const r of [...SUMMARY_RULES, ...PATH_RULES]) {
      expect(BODY_OF_WORK_SLUGS).toContain(r.slug);
      expect(r.pattern).toBeInstanceOf(RegExp);
    }
  });
});
