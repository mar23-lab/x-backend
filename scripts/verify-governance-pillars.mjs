#!/usr/bin/env node
// verify-governance-pillars.mjs · L3 (260710-D) — the drift gate for docs/governance/GOVERNANCE_PILLARS.yml.
//
// WHY: the pillars manifest is only "enforceable architecture" if IT can't drift. This gate resolves every
// reference the manifest makes against the real tree:
//   1. gates[]/enforced_by[]  → a ci-local GATES id (parsed from scripts/ci-local.mjs) OR a package.json
//      script key. A renamed/removed gate breaks the manifest immediately.
//   2. runtime_flags[]        → bound in wrangler.toml [vars] OR read somewhere in src/workers/**/*.ts
//      (this repo has NO central EnvBindings interface — greping both is strictly stronger).
//   3. canonical_docs[]/defined_at → the path exists.
//   4. metrics[]              → an ObservabilityKind union member OR a pre_existing_kinds entry in
//      METRIC_PRODUCER_CONSUMER_MANIFEST.yml.
//   5. failure_classes        → unique ids · status enforced ⇒ non-empty enforced_by · corrections present.
// Self-test (line-parser fidelity): a temp manifest with a nonexistent gate must go RED; the real tree GREEN.
// Wired tier:'warn' first per the ci-local no-new-blocking-gate guardrail; promotion-when-GREEN is an
// explicit operator step (260710-D L5 §11).

import { readFileSync, writeFileSync, rmSync, mkdtempSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const MANIFEST = 'docs/governance/GOVERNANCE_PILLARS.yml';

// ── line-based YAML extraction (schema is flat lists; no yaml dependency — house pattern) ───────────
function parseManifest(text) {
  const listValues = (key) => {
    // inline form: `key: [a, b]`
    const out = [];
    for (const m of text.matchAll(new RegExp(`${key}: \\[([^\\]]*)\\]`, 'g'))) {
      out.push(...m[1].split(',').map((s) => s.trim()).filter((s) => s && !s.startsWith('#')));
    }
    return out;
  };
  const blockValues = (key) => {
    // block form:  `key:\n  - value`
    const out = [];
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      if (!new RegExp(`^\\s*${key}:\\s*$`).test(lines[i])) continue;
      const indent = lines[i].match(/^\s*/)[0].length;
      for (let j = i + 1; j < lines.length; j += 1) {
        const m = lines[j].match(/^(\s*)- (.+)$/);
        if (!m || m[1].length <= indent) break;
        out.push(m[2].split('#')[0].trim());
      }
    }
    return out;
  };
  const failureClasses = [];
  const fcBlock = text.split(/^failure_classes:/m)[1]?.split(/^corrections:/m)[0] ?? '';
  for (const chunk of fcBlock.split(/\n  - id: /).slice(1)) {
    const id = chunk.split('\n')[0].trim();
    const status = chunk.match(/status: (\w+)/)?.[1] ?? '';
    const enforcedBy = (chunk.match(/enforced_by: \[([^\]]*)\]/)?.[1] ?? '')
      .split(',').map((s) => s.trim()).filter(Boolean);
    const definedAt = chunk.match(/defined_at: (\S+)/)?.[1] ?? '';
    failureClasses.push({ id, status, enforcedBy, definedAt });
  }
  return {
    gates: [...listValues('gates'), ...failureClasses.flatMap((f) => f.enforcedBy)],
    flags: listValues('runtime_flags'),
    docs: [...blockValues('canonical_docs'), ...failureClasses.map((f) => f.definedAt).filter(Boolean)],
    metrics: listValues('metrics'),
    failureClasses,
    hasCorrections: /^corrections:/m.test(text),
  };
}

// ── resolvers against the real tree ─────────────────────────────────────────────────────────────────
function loadResolvers(root) {
  const ciLocal = readFileSync(join(root, 'scripts/ci-local.mjs'), 'utf8');
  const gateIds = new Set([...ciLocal.matchAll(/id: '([^']+)'/g)].map((m) => m[1]));
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const scriptKeys = new Set(Object.keys(pkg.scripts ?? {}));
  const wrangler = readFileSync(join(root, 'wrangler.toml'), 'utf8');
  const obsTs = readFileSync(join(root, 'src/workers/lib/observability.ts'), 'utf8');
  const kindUnion = new Set([...(obsTs.match(/export type ObservabilityKind =([\s\S]*?);/)?.[1] ?? '')
    .matchAll(/'([^']+)'/g)].map((m) => m[1]));
  const metricYaml = readFileSync(join(root, 'docs/governance/METRIC_PRODUCER_CONSUMER_MANIFEST.yml'), 'utf8');
  const preExisting = new Set([...metricYaml.matchAll(/^\s+- ([a-z_.]+)$/gm)].map((m) => m[1]));

  // one recursive source scan for flag reads (workers only)
  let workersBlob = '';
  const walk = (dir) => {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) { if (f !== '__tests__' && f !== 'node_modules') walk(p); }
      else if (f.endsWith('.ts')) workersBlob += readFileSync(p, 'utf8');
    }
  };
  walk(join(root, 'src/workers'));

  return {
    gateResolves: (g) => gateIds.has(g) || scriptKeys.has(g),
    flagResolves: (f) => wrangler.includes(f) || workersBlob.includes(f),
    docResolves: (d) => existsSync(join(root, d)),
    metricResolves: (m) => kindUnion.has(m) || preExisting.has(m),
  };
}

function runChecks(manifestText, resolvers) {
  const m = parseManifest(manifestText);
  const errors = [];
  for (const g of m.gates) if (!resolvers.gateResolves(g)) errors.push(`gate does not resolve: '${g}' (not a ci-local GATES id or package.json script)`);
  for (const f of m.flags) if (!resolvers.flagResolves(f)) errors.push(`flag does not resolve: '${f}' (not in wrangler.toml [vars] and never read in src/workers)`);
  for (const d of m.docs) if (!resolvers.docResolves(d)) errors.push(`doc path missing: '${d}'`);
  for (const mt of m.metrics) if (!resolvers.metricResolves(mt)) errors.push(`metric unknown: '${mt}' (not in ObservabilityKind or the metric manifest)`);
  const ids = m.failureClasses.map((f) => f.id);
  if (new Set(ids).size !== ids.length) errors.push(`failure_classes ids are not unique: ${ids.join(', ')}`);
  for (const f of m.failureClasses) {
    if (f.status === 'enforced' && f.enforcedBy.length === 0) errors.push(`failure class ${f.id} is 'enforced' with empty enforced_by`);
    if (!['enforced', 'prose'].includes(f.status)) errors.push(`failure class ${f.id} has invalid status '${f.status}'`);
  }
  if (!m.hasCorrections) errors.push('corrections block missing (the F18/F17 record must not be dropped)');
  return { errors, counts: { pillGates: m.gates.length, flags: m.flags.length, docs: m.docs.length, metrics: m.metrics.length, fclasses: m.failureClasses.length } };
}

// ── self-test: RED on an injected dangling gate; GREEN on the real manifest ─────────────────────────
// Robust to manifest edits: the RED fixture APPENDS a synthetic `gates: [...]` line naming a gate that
// cannot exist. gates[] is parsed by a GLOBAL regex (position-independent), so this does not depend on
// any exact existing manifest line — legitimate edits to real pillar entries can't false-fail the gate.
function selfTest(resolvers) {
  const tmp = mkdtempSync(join(tmpdir(), 'pillars-gate-'));
  try {
    const real = readFileSync(MANIFEST, 'utf8');
    const red = `${real}\n# selftest fixture (never in the real file):\n        gates: [verify:this-gate-cannot-exist-selftest]\n`;
    writeFileSync(join(tmp, 'red.yml'), red);
    const redResult = runChecks(readFileSync(join(tmp, 'red.yml'), 'utf8'), resolvers);
    if (!redResult.errors.some((e) => e.includes('this-gate-cannot-exist-selftest'))) {
      return 'self-test RED case failed: injected dangling gate not caught';
    }
    // GREEN: the real manifest (unmodified) must itself resolve clean.
    if (runChecks(real, resolvers).errors.length !== 0) {
      return 'self-test GREEN case failed: the real manifest has unresolved references';
    }
    return null;
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

const resolvers = loadResolvers('.');
const selfTestErr = selfTest(resolvers);
if (selfTestErr) {
  console.error(`✗ verify:governance-pillars · GATE SELF-TEST FAILED: ${selfTestErr}`);
  process.exit(1);
}
if (process.argv.includes('--self-test')) {
  console.log('☑ verify:governance-pillars · self-test passed (dangling-gate RED case caught)');
  process.exit(0);
}

const { errors, counts } = runChecks(readFileSync(MANIFEST, 'utf8'), resolvers);
if (errors.length) {
  console.error(`✗ verify:governance-pillars · ${errors.length} dangling reference(s) in ${MANIFEST}:`);
  for (const e of errors) console.error(`  · ${e}`);
  process.exit(1);
}
console.log(`☑ verify:governance-pillars · PASS · ${counts.pillGates} gate refs · ${counts.flags} flags · ${counts.docs} docs · ${counts.metrics} metrics · ${counts.fclasses} failure classes (self-test green)`);
