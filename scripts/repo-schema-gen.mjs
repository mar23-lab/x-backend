#!/usr/bin/env node
// scripts/repo-schema-gen.mjs · Phase 10B P10B.3 (MVP)
//
// Generates docs/REPO-SCHEMA.md (human) + docs/REPO-SCHEMA.yaml
// (machine) describing every meaningful file in the repository:
// path, role, source_status, edit_policy, tool_role, owner, loc,
// risk_level, depends_on.
//
// MVP scope (P10B.3):
//   · path inventory walk (filesystem)
//   · per-path metadata (the 7 fields above + risk_level)
//   · repo-level metrics (the §11 list)
//   · markdown + YAML output
//
// DEFERRED (Phase 11+):
//   · deep AST extraction of every helper
//   · complex dependency graph (full topo-sort export)
//   · advanced agent Q&A (semantic search)
//
// IP-leak guard: this generator emits STRUCTURAL metadata only.
// Domain content (contract seed values, client_intent text, etc.)
// MUST NOT appear in REPO-SCHEMA outputs. A separate skill-export
// tool is the right place for opt-in domain content (when Xlooop
// later ships skill packs as a product).
//
// Usage:
//   node scripts/repo-schema-gen.mjs           # generate + write
//   node scripts/repo-schema-gen.mjs --check   # exit 1 if drift

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildTimestampIso } from './lib/build-timestamp.mjs';

let parser = null;
try {
  parser = await import('@babel/parser');
} catch {
  // Dependency-free CI runs this generator without npm ci. In that mode the
  // manifest remains structural; parser-backed syntax validation is skipped.
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const argv = process.argv.slice(2);
const CHECK_MODE = argv.includes('--check');

// --- 1 · Walk the repo tree --------------------------------------------------

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'test-results', 'playwright-report',
  '.signoff/.cache', '.claude',  // skip session state
]);
const SKIP_FILES = new Set([
  '.DS_Store', '.smoke-result.json',
]);

function walk(dir, out = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    if (SKIP_FILES.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      walk(full, out);
    } else if (e.isFile()) {
      out.push(full);
    }
  }
  return out;
}

function gitListZ(args) {
  return execSync(`git ${args}`, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
    .split('\0')
    .filter(Boolean);
}

function trackedFiles() {
  try {
    // "Current files" = the working-tree content set, INDEPENDENT of the git
    // index (staging) state. `git ls-files` alone lists only the index, so a
    // just-created file is invisible until `git add`: the first repo-schema-gen
    // run misses it and only a SECOND run (after staging) registers it, so
    // `--check` passes locally after the first regen then FAILS in the pre-push
    // gate once the file is staged — the 2026-06-11 first-run-miss flake
    // (PRs #586/#587, two forced `--amend` cycles in one session).
    //
    // Union tracked + untracked-not-ignored (so a brand-new file is captured on
    // the FIRST regen), then drop paths no longer on disk (the symmetric
    // not-yet-staged DELETE skew). The result is staging-invariant: one regen
    // captures every current file and `--check` is stable on the first try,
    // regardless of whether the change has been `git add`-ed yet.
    const tracked = gitListZ('ls-files -z');
    const untracked = gitListZ('ls-files --others --exclude-standard -z');
    return [...new Set([...tracked, ...untracked])]
      .filter(rel => !SKIP_FILES.has(path.basename(rel)))
      .filter(rel => fs.existsSync(path.join(REPO_ROOT, rel)))
      .sort();
  } catch {
    return walk(REPO_ROOT)
      .map(f => path.relative(REPO_ROOT, f))
      .sort();
  }
}

const allFiles = trackedFiles();

// --- 2 · Classify each path --------------------------------------------------

function classify(rel) {
  const p = rel.replace(/\\/g, '/');
  // legacy
  if (p.startsWith('legacy/')) {
    return {
      role: 'archived v1 prototype reference',
      source_status: 'legacy',
      edit_policy: 'archive_only',
      owner: 'archive',
      tool_role: null,
    };
  }
  // C26 · root current source layout. v3 current code was absorbed into
  // root src/ plus root data/dist/index shells so agents discover one product
  // source tree instead of nested version folders.
  if (
    p.startsWith('src/') ||
    p.startsWith('data/') ||
    p.startsWith('dist/') ||
    p === 'index.html' ||
    p === 'index.standalone.html'
  ) {
    const sub = p.startsWith('src/') ? p.slice('src/'.length) : p;
    let role = 'current source file';
    if (sub.startsWith('app/'))                     role = 'v3 app shell';
    else if (sub.startsWith('pages/'))              role = 'v3 page (FSD)';
    else if (sub.startsWith('widgets/project-modes/')) role = 'v3 mode-widget (T2-D · tier-2 composite)';
    else if (sub.startsWith('widgets/'))            role = 'v3 widget (FSD)';
    else if (sub.startsWith('features/'))           role = 'v3 feature (FSD)';
    else if (sub.startsWith('entities/'))           role = 'v3 entity (DDD · T1-B)';
    else if (sub.startsWith('shared/uiKit/'))       role = 'v3 uiKit primitive (T2-A · tier-1)';
    else if (sub.startsWith('shared/services/'))    role = 'v3 shared service (T1-C/D/E/G)';
    else if (sub.startsWith('shared/lib/'))         role = 'v3 shared helper';
    else if (sub.startsWith('shared/storybook/'))   role = 'v3 storybook decorator/fixture';
    else if (sub.startsWith('runtime/'))            role = 'v3 runtime helper (TS · precompiled via T2-B)';
    else if (sub.startsWith('contracts/'))          role = 'v3 contract (TS · precompiled via T2-B)';
    else if (sub.startsWith('__contracts__/'))      role = 'v3 type-only contract pin (tsc gate)';
    else if (sub.startsWith('entry/'))              role = 'v3 precompile entry point';
    else if (p.startsWith('dist/'))                 role = 'v3 precompiled bundle (T2-B/T2-C output)';
    else if (p.startsWith('data/'))                 role = 'v3 seed data (JSON)';
    else if (sub === 'index.html')                  role = 'v3 modular shell (HTTP)';
    else if (sub === 'index.standalone.html')       role = 'v3 standalone bundle (file://)';
    return {
      role,
      source_status: 'current',
      edit_policy: p.startsWith('dist/') ? 'generated_only' : 'safe_to_edit',
      owner: 'frontend-demo',
      tool_role: null,
    };
  }
  // tests
  if (p.startsWith('tests/')) {
    return {
      role: p.includes('/e2e/') ? 'Playwright e2e spec' :
            p.includes('/unit/') ? 'Node unit test' :
            p.includes('/smoke/') ? 'smoke-test' : 'test',
      source_status: 'test',
      edit_policy: 'safe_to_edit',
      owner: 'frontend-demo',
      tool_role: null,
    };
  }
  // scripts · tool_role classification
  if (p.startsWith('scripts/')) {
    const GATE_SCRIPTS = new Set([
      'scripts/cwd-anchor.mjs',
      'scripts/smoke-cli.mjs',
      'scripts/audit-gen.mjs',
      'scripts/signoff.mjs',
      'scripts/pre-commit.sh',
      'scripts/verify-current-platform-integrity.mjs',
    ]);
    return {
      role: 'tooling script',
      source_status: 'tooling',
      edit_policy: 'safe_to_edit',
      owner: 'frontend-demo',
      tool_role: GATE_SCRIPTS.has(p) ? 'gate' : 'inform',
    };
  }
  // .signoff
  if (p.startsWith('.signoff/')) {
    return {
      role: 'phase signoff evidence (generated)',
      source_status: 'generated-output',
      edit_policy: 'generated_only',
      owner: 'frontend-demo',
      tool_role: null,
    };
  }
  // .github
  if (p.startsWith('.github/')) {
    return {
      role: 'GitHub Actions config',
      source_status: 'tooling',
      edit_policy: 'safe_to_edit',
      owner: 'frontend-demo',
      tool_role: 'inform',  // CI is nice-to-have post-P10A.0.5; L56
    };
  }
  // docs · classify by subfolder
  if (p.startsWith('docs/')) {
    if (p.includes('/audits/')) return {
      role: 'phase audit + retrospective',
      source_status: p.endsWith('-implementation-audit.md') ? 'generated-doc' : 'docs',
      edit_policy: p.endsWith('-implementation-audit.md') ? 'generated_only' : 'safe_to_edit',
      owner: 'docs',
      tool_role: null,
    };
    if (p.includes('/architecture/frontend-surface-contract-inventory')) return {
      role: 'frontend surface inventory (generated)',
      source_status: 'generated-doc',
      edit_policy: 'generated_only',
      owner: 'docs',
      tool_role: null,
    };
    if (p === 'docs/REPO-SCHEMA.md' || p === 'docs/REPO-SCHEMA.yaml') return {
      role: 'repo schema (generated by repo-schema-gen.mjs)',
      source_status: 'generated-doc',
      edit_policy: 'generated_only',
      owner: 'docs',
      tool_role: null,
    };
    if (p.includes('/adrs/')) return {
      role: 'architecture decision record',
      source_status: 'docs',
      edit_policy: 'safe_to_edit',
      owner: 'docs',
      tool_role: null,
    };
    if (p.includes('/coverage/')) return {
      role: 'coverage baseline doc',
      source_status: 'docs',
      edit_policy: 'safe_to_edit',
      owner: 'docs',
      tool_role: null,
    };
    return {
      role: 'project documentation',
      source_status: 'docs',
      edit_policy: 'safe_to_edit',
      owner: 'docs',
      tool_role: null,
    };
  }
  // root config + meta
  if (p === 'package.json' || p === 'package-lock.json') return {
    role: 'npm package manifest',
    source_status: 'tooling',
    edit_policy: p === 'package-lock.json' ? 'generated_only' : 'safe_to_edit',
    owner: 'frontend-demo',
    tool_role: null,
  };
  if (p === '.gitignore' || p === '.xlooop-root' || p === 'README.md' || (p.startsWith('playwright') && p.endsWith('.config.ts'))) return {
    role: 'repo-level config',
    source_status: 'tooling',
    edit_policy: 'safe_to_edit',
    owner: 'frontend-demo',
    tool_role: null,
  };
  // anything else
  return {
    role: 'misc',
    source_status: 'ignored',
    edit_policy: 'safe_to_edit',
    owner: 'unspecified',
    tool_role: null,
  };
}

// --- 3 · LOC + risk per path -------------------------------------------------

function locOf(rel) {
  if (rel === 'docs/REPO-SCHEMA.md' || rel === 'docs/REPO-SCHEMA.yaml') {
    return 0;
  }
  try {
    const stat = fs.statSync(path.join(REPO_ROOT, rel));
    if (stat.size === 0) return 0;
    if (stat.size > 5_000_000) return -1; // skip huge files
    const txt = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
    return txt.split('\n').length;
  } catch { return 0; }
}

function riskOf(rel, source_status, loc) {
  if (source_status === 'legacy') return { risk_level: 'low', risk_reason: 'archived; not in build path' };
  if (source_status === 'tooling' && loc > 800) return { risk_level: 'medium', risk_reason: 'large tooling script' };
  if (source_status === 'current' && loc > 600) return { risk_level: 'medium', risk_reason: 'large source module' };
  return { risk_level: 'low', risk_reason: 'within bounds' };
}

// --- 4 · depends_on ----------------------------------------------------------

function dependsOn(rel) {
  return null;
}

// --- 5 · Build per-path entries ----------------------------------------------

const entries = [];
for (const rel of allFiles) {
  const cls = classify(rel);
  const loc = locOf(rel);
  const risk = riskOf(rel, cls.source_status, loc);
  entries.push({
    path: rel,
    role: cls.role,
    source_status: cls.source_status,
    edit_policy: cls.edit_policy,
    owner: cls.owner,
    tool_role: cls.tool_role,
    loc,
    risk_level: risk.risk_level,
    risk_reason: risk.risk_reason,
    depends_on: dependsOn(rel),
  });
}

// --- 6 · Repo-level metrics (the §11 list) -----------------------------------

function locTotal(predicate) {
  return entries.filter(predicate).reduce((s, e) => s + (e.loc || 0), 0);
}

const html = '';

function countMatches(re, src = html) {
  const m = src.match(re);
  return m ? m.length : 0;
}

function readOptionalJson(rel, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8'));
  } catch {
    return fallback;
  }
}

function summarizeUiActionContractMatrix() {
  const matrix = readOptionalJson('data/ui-action-contract-matrix.json', null);
  const controls = Array.isArray(matrix?.controls) ? matrix.controls : [];
  const feedback = Array.isArray(matrix?.agent_feedback_summary) ? matrix.agent_feedback_summary : [];
  const nonActionAspects = Array.isArray(matrix?.non_action_aspects) ? matrix.non_action_aspects : [];
  const byClassification = controls.reduce((acc, control) => {
    const key = control.classification || 'unknown';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  const surfaces = [...new Set(controls.map(control => control.surface).filter(Boolean))].sort();
  return {
    schema_version: matrix?.schema_version || null,
    phase: matrix?.phase || null,
    source_path: matrix ? 'data/ui-action-contract-matrix.json' : null,
    controls_count: controls.length,
    non_action_aspects_count: nonActionAspects.length,
    surfaces,
    by_classification: byClassification,
    high_risk_count: controls.filter(control => control.risk === 'high').length,
    unresolved_feedback_count: feedback.filter(item => ['high', 'medium'].includes(item.severity)).length,
    top_agent_feedback: feedback.slice(0, 4).map(item => ({
      severity: item.severity || 'unknown',
      area: item.area || 'unknown',
      message: item.message || '',
    })),
  };
}

function summarizeUiJourneyPriorityMatrix() {
  const matrix = readOptionalJson('data/ui-journey-priority-matrix.json', null);
  const stories = Array.isArray(matrix?.user_stories) ? matrix.user_stories : [];
  const aspects = Array.isArray(matrix?.ui_aspects) ? matrix.ui_aspects : [];
  const feedback = Array.isArray(matrix?.agent_feedback) ? matrix.agent_feedback : [];
  const byPriority = aspects.reduce((acc, aspect) => {
    const key = aspect.priority_rank || 'unknown';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  return {
    schema_version: matrix?.schema_version || null,
    phase: matrix?.phase || null,
    source_path: matrix ? 'data/ui-journey-priority-matrix.json' : null,
    stories_count: stories.length,
    aspects_count: aspects.length,
    by_priority: byPriority,
    top_agent_feedback: feedback.slice(0, 4).map(item => ({
      severity: item.severity || 'unknown',
      area: item.area || 'unknown',
      message: item.message || '',
    })),
  };
}

const kindsMatch = html.match(/window\.CONTRACT_KINDS\s*=\s*\[([\s\S]*?)\]/);
const contractKindsCount = kindsMatch
  ? kindsMatch[1].split(',').map(s => s.trim().replace(/['"]/g, '').replace(/\/\/.*/, '').trim()).filter(Boolean).length
  : 0;

const apiMethodsMatch = html.match(/window\.__xcontractAPI\s*=\s*\{([\s\S]*?)\n\};/);
const mutationApiMethodCount = apiMethodsMatch
  ? (apiMethodsMatch[1].match(/^\s*[a-zA-Z_]\w*\s*\(/gm) || []).length
  : 0;

const playwrightTestCount = entries.filter(e =>
  e.path.startsWith('tests/e2e/') && e.path.endsWith('.spec.ts')
).length;

const smokeCheckCount = (() => {
  try {
    const smoke = fs.readFileSync(path.join(REPO_ROOT, 'scripts/smoke-cli.mjs'), 'utf8');
    return (smoke.match(/^\s*check\(/gm) || []).length;
  } catch { return 0; }
})();

const adrsCount = entries.filter(e => e.path.startsWith('docs/adrs/') && e.path.endsWith('.md')).length;
const generatedDocsCount = entries.filter(e => e.source_status === 'generated-doc').length;

const directContractMutations = (() => {
  // Same regex as P10A.0.7 + L48-EXCEPTION marker logic.
  if (!html) return 0;
  const lines = html.split('\n');
  let count = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!/update\(s => \(\{ \.\.\.s, contracts:/.test(lines[i])) continue;
    let prev = i - 1;
    while (prev >= 0 && /^\s*$/.test(lines[prev])) prev--;
    const marked = prev >= 0 && /\/\/\s*L48-EXCEPTION:/.test(lines[prev]);
    if (!marked) count++;
  }
  return count;
})();

const clientViewCallers = (html.match(/(?:window\.)?clientView\s*\(/g) || []).length;
const contextPreviewCallers = (html.match(/(?:window\.)?__xcontextPreview\s*\(/g) || []).length;
const impactOfCallers = (html.match(/(?:window\.)?impactOf\s*\(/g) || []).length;

const windowGlobalsCount = (() => {
  if (!html) return 0;
  const matches = html.match(/^\s*window\.[A-Za-z_][A-Za-z0-9_]*\s*=\s*/gm) || [];
  return new Set(matches.map(m => m.match(/window\.([A-Za-z_]\w*)/)[1])).size;
})();

const validatorCount = (() => {
  if (!html) return 0;
  return (html.match(/drift\.push\(\{\s*kind:\s*['"][\w-]+['"]/g) || []).length;
})();

const legacyImportCount = (() => {
  try {
    const out = execSync(
      "grep -rn --include='*.js' --include='*.mjs' --include='*.ts' --include='*.tsx' --include='*.jsx' --include='*.html' \"from ['\\\"][^'\\\"]*legacy/v1-src\" src/ scripts/ tests/ 2>/dev/null || true",
      { encoding: 'utf8', cwd: REPO_ROOT }
    );
    return out.trim() ? out.split('\n').length : 0;
  } catch { return 0; }
})();

const uiActionContractMatrix = summarizeUiActionContractMatrix();
const uiJourneyPriorityMatrix = summarizeUiJourneyPriorityMatrix();

const metrics = {
  v2_app_html_loc: 0,
  v2_src_total_loc: 0,
  legacy_src_loc: locTotal(e => e.path.startsWith('legacy/v1-src/')),
  contract_module_loc: locTotal(e => e.path.startsWith('src/contracts/') && e.path.endsWith('.ts')),
  runtime_module_loc: locTotal(e => e.path.startsWith('src/runtime/') && e.path.endsWith('.ts')),
  ui_module_loc: locTotal(e => e.path.startsWith('src/shared/uiKit/') && (e.path.endsWith('.jsx') || e.path.endsWith('.tsx'))),
  docs_loc: locTotal(e => e.source_status === 'docs' || e.source_status === 'generated-doc'),
  scripts_loc: locTotal(e => e.path.startsWith('scripts/')),
  window_global_count: windowGlobalsCount,
  mutation_api_method_count: mutationApiMethodCount,
  contract_kinds_count: contractKindsCount,
  validators_count: validatorCount,
  playwright_test_count: playwrightTestCount,
  smoke_check_count: smokeCheckCount,
  signoff_files_count: entries.filter(e => e.path.startsWith('.signoff/') && e.path.endsWith('.json')).length,
  adrs_count: adrsCount,
  generated_docs_count: generatedDocsCount,
  legacy_imports_count: legacyImportCount,
  direct_state_contracts_mutations_count: directContractMutations,
  client_view_callers_count: clientViewCallers,
  context_preview_callers_count: contextPreviewCallers,
  impact_of_callers_count: impactOfCallers,
  ui_action_controls_count: uiActionContractMatrix.controls_count,
  ui_action_non_action_aspects_count: uiActionContractMatrix.non_action_aspects_count,
  ui_action_high_risk_count: uiActionContractMatrix.high_risk_count,
  ui_action_unresolved_feedback_count: uiActionContractMatrix.unresolved_feedback_count,
  ui_journey_user_stories_count: uiJourneyPriorityMatrix.stories_count,
  ui_journey_aspects_count: uiJourneyPriorityMatrix.aspects_count,
};

// --- 7 · Render Markdown -----------------------------------------------------

const mdLines = [];
mdLines.push('# Repo schema · generated · v3 current + v2 active legacy gate map');
mdLines.push('');
mdLines.push('> **DO NOT EDIT BY HAND.** Generated by `scripts/repo-schema-gen.mjs`.');
mdLines.push('> Re-run via `node scripts/repo-schema-gen.mjs`. Pre-commit hook auto-regenerates.');
mdLines.push('> Phase 10B P10B.3 (MVP) · structural metadata only · no domain content (IP-leak guard).');
mdLines.push('');
mdLines.push(`Generated: ${buildTimestampIso()}`);
mdLines.push('');
mdLines.push('## Repo metrics');
mdLines.push('');
mdLines.push('| Metric | Value |');
mdLines.push('|---|---:|');
for (const [k, v] of Object.entries(metrics)) {
  mdLines.push(`| \`${k}\` | ${v} |`);
}
mdLines.push('');
mdLines.push('## Per-path inventory');
mdLines.push('');
mdLines.push('| Path | Role | Status | Edit policy | Tool role | LOC | Risk |');
mdLines.push('|---|---|---|---|---|---:|---|');
for (const e of entries) {
  if (e.loc < 0 || e.source_status === 'ignored') continue;
  mdLines.push(`| \`${e.path}\` | ${e.role} | ${e.source_status} | ${e.edit_policy} | ${e.tool_role || '—'} | ${e.loc} | ${e.risk_level} |`);
}
mdLines.push('');
mdLines.push('## UI action contract matrix');
mdLines.push('');
if (uiActionContractMatrix.source_path) {
  mdLines.push(`- Source: \`${uiActionContractMatrix.source_path}\``);
  mdLines.push(`- Phase: \`${uiActionContractMatrix.phase || 'unknown'}\``);
  mdLines.push(`- Controls: ${uiActionContractMatrix.controls_count}`);
  mdLines.push(`- Non-action status aspects: ${uiActionContractMatrix.non_action_aspects_count}`);
  mdLines.push(`- High-risk controls: ${uiActionContractMatrix.high_risk_count}`);
  mdLines.push(`- Unresolved agent-feedback items: ${uiActionContractMatrix.unresolved_feedback_count}`);
  mdLines.push('');
  mdLines.push('| Classification | Count |');
  mdLines.push('|---|---:|');
  for (const [classification, count] of Object.entries(uiActionContractMatrix.by_classification).sort()) {
    mdLines.push(`| \`${classification}\` | ${count} |`);
  }
  mdLines.push('');
  mdLines.push('| Agent feedback |');
  mdLines.push('|---|');
  for (const item of uiActionContractMatrix.top_agent_feedback) {
    mdLines.push(`| **${item.severity} · ${item.area}** — ${String(item.message).replace(/\|/g, '/')} |`);
  }
} else {
  mdLines.push('- No `data/ui-action-contract-matrix.json` present.');
}
mdLines.push('');
mdLines.push('## UI journey priority matrix');
mdLines.push('');
if (uiJourneyPriorityMatrix.source_path) {
  mdLines.push(`- Source: \`${uiJourneyPriorityMatrix.source_path}\``);
  mdLines.push(`- Phase: \`${uiJourneyPriorityMatrix.phase || 'unknown'}\``);
  mdLines.push(`- User stories: ${uiJourneyPriorityMatrix.stories_count}`);
  mdLines.push(`- Ranked UI aspects: ${uiJourneyPriorityMatrix.aspects_count}`);
  mdLines.push('');
  mdLines.push('| Priority | Count |');
  mdLines.push('|---|---:|');
  for (const [priority, count] of Object.entries(uiJourneyPriorityMatrix.by_priority).sort()) {
    mdLines.push(`| \`${priority}\` | ${count} |`);
  }
  mdLines.push('');
  mdLines.push('| Agent feedback |');
  mdLines.push('|---|');
  for (const item of uiJourneyPriorityMatrix.top_agent_feedback) {
    mdLines.push(`| **${item.severity} · ${item.area}** — ${String(item.message).replace(/\|/g, '/')} |`);
  }
} else {
  mdLines.push('- No `data/ui-journey-priority-matrix.json` present.');
}
mdLines.push('');
mdLines.push('## Cross-references');
mdLines.push('');
mdLines.push('- ADR-0001 · single-file vs bundler · LOC trip thresholds + Phase 10B target.');
mdLines.push('- ADR-0002 · module strategy + namespacing + unit-test architecture.');
mdLines.push('- `docs/AGENT-ONBOARDING.md` · cold-load reading order for AI agents.');
mdLines.push('- `docs/Workflow.md` §14 · Phase 10A learnings codified (L57..L60).');
mdLines.push('- `docs/_archive/audits/phase-10A-retrospective.md` · 15 G-tier gaps + closure plan.');
mdLines.push('');

const mdOut = mdLines.join('\n') + '\n';

// --- 8 · Render YAML (minimal hand-emitter) ---------------------------------

function yamlVal(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) {
    if (v.length === 0) return '[]';
    return '\n' + v.map(x => `    - ${yamlScalar(x)}`).join('\n');
  }
  return yamlScalar(v);
}
function yamlScalar(s) {
  const str = String(s);
  if (/^[A-Za-z0-9_./@:-]+$/.test(str) && !/^(true|false|null|yes|no)$/i.test(str)) return str;
  return JSON.stringify(str);
}

const yamlLines = [];
yamlLines.push('# docs/REPO-SCHEMA.yaml · generated by scripts/repo-schema-gen.mjs');
yamlLines.push('# DO NOT EDIT BY HAND. Phase 10B P10B.3 (MVP).');
yamlLines.push(`generated_at: ${buildTimestampIso()}`);
yamlLines.push('schema_version: "1.0"');
yamlLines.push('');
yamlLines.push('metrics:');
for (const [k, v] of Object.entries(metrics)) {
  yamlLines.push(`  ${k}: ${yamlVal(v)}`);
}
yamlLines.push('');
yamlLines.push('ui_action_contract_matrix:');
yamlLines.push(`  schema_version: ${yamlVal(uiActionContractMatrix.schema_version)}`);
yamlLines.push(`  phase: ${yamlVal(uiActionContractMatrix.phase)}`);
yamlLines.push(`  source_path: ${yamlVal(uiActionContractMatrix.source_path)}`);
yamlLines.push(`  controls_count: ${uiActionContractMatrix.controls_count}`);
yamlLines.push(`  non_action_aspects_count: ${uiActionContractMatrix.non_action_aspects_count}`);
yamlLines.push(`  high_risk_count: ${uiActionContractMatrix.high_risk_count}`);
yamlLines.push(`  unresolved_feedback_count: ${uiActionContractMatrix.unresolved_feedback_count}`);
yamlLines.push('  surfaces:');
if (uiActionContractMatrix.surfaces.length) {
  for (const surface of uiActionContractMatrix.surfaces) yamlLines.push(`    - ${yamlScalar(surface)}`);
} else {
  yamlLines.push('    []');
}
yamlLines.push('  by_classification:');
for (const classification of Object.keys(uiActionContractMatrix.by_classification).sort()) {
  yamlLines.push(`    ${classification}: ${uiActionContractMatrix.by_classification[classification]}`);
}
yamlLines.push('  top_agent_feedback:');
if (uiActionContractMatrix.top_agent_feedback.length) {
  for (const item of uiActionContractMatrix.top_agent_feedback) {
    yamlLines.push(`    - severity: ${yamlScalar(item.severity)}`);
    yamlLines.push(`      area: ${yamlScalar(item.area)}`);
    yamlLines.push(`      message: ${yamlScalar(item.message)}`);
  }
} else {
  yamlLines.push('    []');
}
yamlLines.push('');
yamlLines.push('paths:');
for (const e of entries) {
  if (e.loc < 0 || e.source_status === 'ignored') continue;
  yamlLines.push(`  - path: ${yamlScalar(e.path)}`);
  yamlLines.push(`    role: ${yamlScalar(e.role)}`);
  yamlLines.push(`    source_status: ${e.source_status}`);
  yamlLines.push(`    edit_policy: ${e.edit_policy}`);
  yamlLines.push(`    owner: ${e.owner}`);
  yamlLines.push(`    tool_role: ${yamlVal(e.tool_role)}`);
  yamlLines.push(`    loc: ${e.loc}`);
  yamlLines.push(`    risk_level: ${e.risk_level}`);
  yamlLines.push(`    risk_reason: ${yamlScalar(e.risk_reason)}`);
  if (e.depends_on !== null) {
    yamlLines.push(`    depends_on: ${yamlVal(e.depends_on)}`);
  }
}
yamlLines.push('');

const yamlOut = yamlLines.join('\n');

// --- 9 · Write or check ------------------------------------------------------

const mdPath = path.join(REPO_ROOT, 'docs/REPO-SCHEMA.md');
const yamlPath = path.join(REPO_ROOT, 'docs/REPO-SCHEMA.yaml');

// Phase 10C P10C.2 · c161 · L67 closure.
// EXCLUDE_FROM_FRESHNESS_GATE register: high-churn observed metrics
// that change every time a smoke check / signoff / audit doc / etc.
// is added. These reflect ACTUAL repo state correctly, but they
// shouldn't flap the freshness gate because they're not structural.
//
// Workflow §15.13 escalation rule: a high-churn metric escalates to
// blocking ONLY if a downstream test reads it (currently NONE do for
// these specific keys). agent-navigability.test.mjs reads paths +
// edit_policy + role + source_status, NOT these metrics.
const EXCLUDE_FROM_FRESHNESS_GATE = [
  'smoke_check_count',
  'signoff_files_count',
  'generated_docs_count',
  'docs_loc',
  'scripts_loc',
];

function normalizeForFreshnessCheck(s) {
  let out = s
    .replace(/^Generated:.*$/gm, 'Generated: <timestamp>')
    .replace(/^generated_at:.*$/gm, 'generated_at: <timestamp>');
  for (const key of EXCLUDE_FROM_FRESHNESS_GATE) {
    // Match `  <key>: <value>` (any whitespace, any value) and replace
    // the value with a stable placeholder.
    const re = new RegExp(`^(\\s*)${key}:\\s*\\S+`, 'gm');
    out = out.replace(re, `$1${key}: <high-churn>`);
    const mdRe = new RegExp(`^(\\| \`${key}\` \\| )[^|]+( \\|)$`, 'gm');
    out = out.replace(mdRe, `$1<high-churn>$2`);
  }
  return out;
}

if (CHECK_MODE) {
  const existingMd = fs.existsSync(mdPath) ? fs.readFileSync(mdPath, 'utf8') : '';
  const existingYaml = fs.existsSync(yamlPath) ? fs.readFileSync(yamlPath, 'utf8') : '';
  if (normalizeForFreshnessCheck(existingMd) !== normalizeForFreshnessCheck(mdOut) ||
      normalizeForFreshnessCheck(existingYaml) !== normalizeForFreshnessCheck(yamlOut)) {
    console.error('repo-schema-gen --check · DRIFT detected.');
    console.error('  Run `node scripts/repo-schema-gen.mjs` to regenerate.');
    process.exit(1);
  }
  console.log('repo-schema-gen --check · clean.');
  process.exit(0);
}

fs.writeFileSync(mdPath, mdOut);
fs.writeFileSync(yamlPath, yamlOut);
console.log(`repo-schema-gen · wrote ${path.relative(REPO_ROOT, mdPath)} (${entries.length} paths · ${Object.keys(metrics).length} metrics)`);
console.log(`                  wrote ${path.relative(REPO_ROOT, yamlPath)}`);
