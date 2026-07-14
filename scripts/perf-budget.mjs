#!/usr/bin/env node
// T3-D · bundle perf budget assertion (no external dep).
//
// Asserts that the v3 production artefacts stay within the agreed size
// envelope. Budgets are intentionally generous · the goal is to catch
// surprise +50% growths (a stray dependency, a regression in dead-code
// elimination), not to police every kilobyte.
//
// Run:
//   node scripts/perf-budget.mjs
//
// Update budgets here when an architectural change legitimately moves
// the floor (e.g. T2-C JSX precompile is expected to shrink the standalone
// significantly; bump those budgets down with the same commit).

import { statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoStandaloneBuildLock } from './lib/generated-artifact-lock.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

assertNoStandaloneBuildLock('perf-budget');

const BUDGETS = [
  // path                              · max bytes  · rationale
  { path: 'dist/v3-runtime.js',  max: 120 * 1024, reason: 'precompiled runtime+contracts IIFE (C60 plus owner-approved internal-full MB-P projection contract)' },
  { path: 'dist/v3-app.js',      max: 1300 * 1024, reason: 'T2-C precompiled jsx app bundle plus BoardLayout.v2, anchored Markdown review, proposal-only writeback flow, production paid-pilot boundary visibility, tenant-safe onboarding, AuthenticatedSessionV1 fields, Round 5 Wave 5f-5n shell-experience feature-flag infrastructure (16 flags), Round 6 Phase A-F foundation, Round 7-9 visible UX integration, Round 10 readability compression + inspector progressive disclosure, Round 10b company-agnostic UX taxonomy primitives (StatusBadge + ActionButton + ContextChip + FilterChip + FilterBar + ActiveFilterSummary + MoreFiltersPopover + RecentSearches), and Round 12 R12.2 SavedFilterSet + R12.3 LearnedChips primitives — budget bumped 1216 → 1280 KiB to absorb Round 12 wave-train remainder while preserving 48 KiB minimum composition headroom · 2026-05-30 bumped 1280 → 1344 to absorb the host-routed investor portal, then RESOLVED the tracked follow-up the same day: extracted the 12 InvestorPortal components to a separate host-gated IIFE (dist/v3-investor.js · scripts/build-investor-bundle.mjs · src/entry/investor-bundle.jsx), reverting to 1280 KiB — v3-app measured 1,165,356 B after extraction (~131 KiB removed); investor loads only on invest.xlooop.com · 2026-06-22 bumped 1280 → 1292 KiB for P0 tenant-boundary/customer-readonly hardening after removing the internal governance seed fixture from CockpitStreamSource; measured 1,272,183 B · 2026-06-23 bumped 1292 → 1294 KiB for customer-visible API & Desktop access guidance in Profile · 2026-06-23 bumped 1294 → 1300 KiB for Developer Access Center tabs, redacted receipt state, and Claude/Codex/Cursor guidance while preserving >=48 KiB composition headroom and keeping a separate tight ratchet in verify-bundle-headroom-ratchet' },
  { path: 'dist/v3-project-workspace.js', max: 220 * 1024, reason: 'Project Operating Space sidecar extracted from v3-app so the app shell has durable bundle headroom while project/document workbench behavior remains route-backed and browser-safe' },
  { path: 'dist/v3-readiness.js', max: 32 * 1024, reason: 'M.7 · in-app first-login readiness onboarding journey sidecar (faithful x-web port: 4-milestone bar, animated public-signal sweep, AI-tools checklist, the 4 interview questions, real submit) extracted from v3-app.js so the AMBER app bundle keeps its composition headroom; loaded before v3-app, rendered by SessionGate on state needs_readiness. src/entry/readiness-bundle.jsx · scripts/build-readiness.mjs' },
  { path: 'dist/v3-investor.js', max: 160 * 1024, reason: 'investor portal IIFE sidecar (12 InvestorPortal components) extracted from v3-app.js 2026-05-30 per the perf-budget tracked-follow-up (R51-widgets pattern) — host-gated, loaded ONLY on invest.xlooop.com (injected into dist-cloudflare/index.html by prepare-cloudflare-pages.mjs). Larger than the ~68 KiB it added to v3-app because a separate IIFE re-bundles shared deps (the expected split tradeoff). src/entry/investor-bundle.jsx · scripts/build-investor-bundle.mjs' },
  { path: 'dist/v3-shell.css',    max: 100 * 1024, reason: 'externalized modular shell CSS, split out of index.html for UI headroom' },
  { path: 'index.html',          max: 100 * 1024, reason: 'modular shell + external CSS link' },
  { path: 'index.standalone.html', max: 2176 * 1024, reason: 'standalone all-in-one cockpit bundle (does NOT inline investor; matches app.xlooop.com). 2026-07-04 bumped 2152 to 2176 KiB during the PaneOperations facade-first decomposition: a full rebuild caught the committed index.standalone.html up to the already-committed current dist/v3-app.js. The committed standalone was stale (built from an older v3-app minification), so regenerating it grew the file ~94 KiB independent of this refactor; the refactor itself adds only ~5 KiB to v3-app. No new inlined sidecar was added; the growth is drift-correction of the stale all-in-one plus the small app delta. Prior bumps: 2026-06-27 +16 KiB for M.7 onboarding (readiness journey ships as EXTERNAL sidecar dist/v3-readiness.js, not inlined); 2026-05-30 investor portal EXTRACTED to dist/v3-investor.js; 2026-06-04 +restored operator workspace/domain controls + preview fallback; 2026-06-23 +Developer Access Center tabs, redacted receipt state, and Claude/Codex/Cursor guidance. Inlines runtime + app + live read models, operating-boundary sidecars, project workspace storage sidecar, Project Operating Space V2, proposal-only Markdown writeback UI, and the Round 4-12 UX primitive train.' },
];

let fail = 0;
const lines = [];

for (const b of BUDGETS) {
  let size = 0;
  try { size = statSync(resolve(REPO_ROOT, b.path)).size; }
  catch (_) {
    lines.push(`✗ perf-budget · ${b.path} missing`);
    fail++;
    continue;
  }
  const pct = Math.round((size / b.max) * 100);
  const ok = size <= b.max;
  if (!ok) fail++;
  lines.push(`${ok ? '☑' : '✗'} ${b.path}  ${size.toLocaleString()} B / ${b.max.toLocaleString()} B (${pct}%)  · ${b.reason}`);
}

console.log('perf-budget · v3');
for (const l of lines) console.log('  ' + l);

if (fail > 0) {
  console.error(`\n✗ perf-budget · ${fail} budget(s) exceeded`);
  console.error('  If the growth is intentional, bump the budget in scripts/perf-budget.mjs');
  console.error('  with the same commit and a one-line rationale.');
  process.exit(1);
}
console.log('  all budgets within envelope');

// OPERATOR-STABILITY-2 Wave B (2026-06-05) · generic headroom WARN tier — the
// bundle-headroom-watch below only watches dist/v3-app.js; this surfaces ANY
// artefact crossing 90% of its budget (notably dist/v3-shell.css, the tightest)
// as an early non-blocking warning before the 100% hard gate.
for (const b of BUDGETS) {
  let size = 0;
  try { size = statSync(resolve(REPO_ROOT, b.path)).size; } catch (_) { continue; }
  const pct = size / b.max;
  if (pct > 0.90 && size <= b.max) {
    console.warn(`  ⚠ headroom · ${b.path} at ${Math.round(pct * 100)}% of budget (${(b.max - size).toLocaleString()} B left)`);
  }
}

// R26.2 (2026-05-22) · bundle headroom trigger watch · prints AMBER/RED
// early warning per BUNDLE_HEADROOM_PREMORTEM.md every ci-local run.
// Non-blocking · perf-budget remains the hard gate at 100%.
try {
  const { execSync } = await import('node:child_process');
  execSync('node scripts/bundle-headroom-watch.mjs --quiet', { cwd: REPO_ROOT, stdio: 'inherit' });
} catch (_) { /* watch is non-blocking */ }
