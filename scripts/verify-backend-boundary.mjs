#!/usr/bin/env node
// verify-backend-boundary.mjs — x-backend is an API repo: no frontend roots, no imports from
// frontend layers, and the agent ENTRY CONTRACTS (AGENTS.md / CLAUDE.md) must not carry stale
// "shadow backend / never deploy" claims that contradict production reality.
//
// P-2 REMEDIATION (260729) — this gate was a GATE_SELF_REFERENCE_BASELINE entry carrying a
// `diagnosis`. Recorded cause: the single self-referential callsite was in the --self-test,
// `validateEntryContracts(staleAgent, staleClaude)`, where `validateEntryContracts` is defined in
// this file and BOTH fixtures were string literals defined in this file. It proved a function
// returns the strings it was written to return; it never ran this gate as a process and never
// observed an exit code.
//
// THE FIX, matching the shape applied to verify-tenant-source-isolation /
// verify-domain-scaffold-honest-empty / verify-flag-parse-hygiene: a `--root=` override, and a
// self-test that SPAWNS this gate at a seeded temp root and OBSERVES the exit code.
//
// The mutant fixtures are DERIVED FROM THE REAL FILES rather than authored here: the self-test
// copies the actual AGENTS.md / CLAUDE.md into the temp root and APPENDS the stale claims. So every
// required authority marker is genuinely present, and the ONLY thing the mutant changes is the
// defect under test — which is what makes the observed exit 1 attributable to that defect alone.
//
// EXIT CODES.  0 = measured clean   1 = boundary violation(s)   2 = COULD NOT MEASURE
//
//   node scripts/verify-backend-boundary.mjs
//   node scripts/verify-backend-boundary.mjs --self-test    # OBSERVES a red
//   node scripts/verify-backend-boundary.mjs --root=<dir>   # aim it elsewhere

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const selfTest = argv.includes('--self-test');
const rootArg = argv.find((a) => a.startsWith('--root='));
const root = rootArg ? path.resolve(rootArg.slice('--root='.length)) : REPO;

const forbiddenRoots = ['src/app', 'src/runtime', 'src/widgets', 'src/pages', 'src/components', 'src/shared'];

function validateEntryContracts(agentContract, claudeContract) {
  const entryFailures = [];
  for (const marker of [
    '`x-backend` is the production API source authority',
    '`merged`,',
    '`deployed`,',
    '`authoritative`',
    '`Xlooop-XCP-demo` is',
    'donor-only',
    'numeric `schema_head`',
    'exact 40-character build SHA',
    'Never bypass `npm run deploy:api`',
    'isolated `codex/*` or `claude/*` worktree',
  ]) {
    if (!agentContract.includes(marker)) entryFailures.push(`AGENTS.md lost authority marker: ${marker}`);
  }
  for (const marker of [
    'production API source authority',
    'Deployed provenance remains independent',
    'Never bypass `npm run deploy:api`',
    '`Xlooop-XCP-demo` as donor-only',
  ]) {
    if (!claudeContract.includes(marker)) entryFailures.push(`CLAUDE.md lost authority marker: ${marker}`);
  }
  for (const [label, pattern] of [
    ['shadow-only repository claim', /A \*\*SHADOW backend\*\*/i],
    ['never-deploy repository claim', /\*\*SHADOW REPO — never deploy/i],
    ['demo deployment authority claim', /Xlooop-XCP-demo is the current deployed authority/i],
    ['shadow-until-cutover claim', /repository is a shadow backend until/i],
  ]) {
    if (pattern.test(`${agentContract}\n${claudeContract}`)) {
      entryFailures.push(`agent entry contract contains stale ${label}`);
    }
  }
  return entryFailures;
}

const importRe = /(?:from\s*|import\s*\()\s*['"]([^'"]+)['"]/g;
function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist-workers-dryrun') continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(abs));
    else if (/\.(?:ts|tsx|js|mjs)$/.test(entry.name)) files.push(abs);
  }
  return files;
}

// =================================================================================================
// SELF-TEST — the SUBJECT is this gate as a PROCESS; exit codes are OBSERVED from a child
// =================================================================================================
if (selfTest) {
  const rows = [];
  const problems = [];
  const record = (label, ok) => { rows.push('  ' + (ok ? 'PASS' : 'FAIL').padEnd(6) + '  ' + label); if (!ok) problems.push(label); };
  const run = (r) => spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--root=' + r], { encoding: 'utf8' });

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xl-backend-boundary-selftest-'));

  // Seed a root from the REAL entry contracts, optionally appending a mutation. Deriving the fixture
  // from the shipped files (rather than authoring it here) is what keeps this self-test out of the
  // self-reference class AND guarantees every required marker is genuinely present.
  const seedRoot = (name, opts) => {
    const o = opts || {};
    const r = path.join(tmp, name);
    fs.mkdirSync(path.join(r, 'src/workers'), { recursive: true });
    fs.writeFileSync(path.join(r, 'AGENTS.md'), fs.readFileSync(path.join(REPO, 'AGENTS.md'), 'utf8') + (o.agentExtra || ''));
    fs.writeFileSync(path.join(r, 'CLAUDE.md'), fs.readFileSync(path.join(REPO, 'CLAUDE.md'), 'utf8') + (o.claudeExtra || ''));
    fs.writeFileSync(path.join(r, 'src/workers/noop.ts'), o.workerFile || 'export const noop = 1;\n');
    if (o.frontendRoot) fs.mkdirSync(path.join(r, o.frontendRoot), { recursive: true });
    return r;
  };

  // (1) CANNOT MEASURE — a root that does not exist must exit 2, never 0.
  const goneRun = run(path.join(tmp, 'no-such-root'));
  record(`MISSING ROOT exits 2 "cannot measure" (observed exit=${goneRun.status})`, goneRun.status === 2);

  // (2) CANNOT MEASURE — a root with no entry contracts must exit 2. Reading zero contract bytes and
  //     reporting "no stale authority claims" would be a false zero, not a pass.
  const bare = path.join(tmp, 'bare'); fs.mkdirSync(bare, { recursive: true });
  const bareRun = run(bare);
  record(`ROOT WITHOUT AGENTS.md/CLAUDE.md exits 2 "cannot measure" (observed exit=${bareRun.status})`, bareRun.status === 2);

  // (3) CONTROL — the real entry contracts, copied unmutated, must exit 0. Without this the mutants
  //     below prove nothing: the red has to be caused by the mutation, not by the copy.
  const cleanRun = run(seedRoot('clean'));
  record(`CONTROL: unmutated copies of the real AGENTS.md/CLAUDE.md exit 0 (observed exit=${cleanRun.status})`,
    cleanRun.status === 0);

  // (4) MUTANT — the named defect: stale shadow-only authority claims appended to the real contracts.
  const staleRun = run(seedRoot('stale', {
    agentExtra: '\n\nA **SHADOW backend** that is not live.\n**SHADOW REPO — never deploy.**\n'
      + 'Xlooop-XCP-demo is the current deployed authority.\n',
    claudeExtra: '\n\nThis repository is a shadow backend until an explicitly approved cutover.\n',
  }));
  const staleOut = (staleRun.stdout || '') + (staleRun.stderr || '');
  record(`MUTANT: stale shadow-only authority claims drive exit 1 (observed exit=${staleRun.status})`, staleRun.status === 1);
  for (const claim of ['shadow-only repository claim', 'never-deploy repository claim',
    'demo deployment authority claim', 'shadow-until-cutover claim']) {
    record(`MUTANT: the stale ${claim} is NAMED in the failure output`, staleOut.includes(claim));
  }

  // (5) MUTANT — a frontend root present in an API repo.
  const feRun = run(seedRoot('frontend-root', { frontendRoot: 'src/components' }));
  const feOut = (feRun.stdout || '') + (feRun.stderr || '');
  record(`MUTANT: a frontend root (src/components) drives exit 1 (observed exit=${feRun.status})`, feRun.status === 1);
  record('MUTANT: the frontend root is NAMED in the failure output', /frontend root present: src\/components/.test(feOut));

  // (6) MUTANT — a worker importing a frontend layer.
  const impRun = run(seedRoot('forbidden-import', { workerFile: "import { thing } from '../shared/thing';\nexport const x = thing;\n" }));
  const impOut = (impRun.stdout || '') + (impRun.stderr || '');
  record(`MUTANT: a worker importing a frontend layer drives exit 1 (observed exit=${impRun.status})`, impRun.status === 1);
  record('MUTANT: the forbidden import specifier is NAMED', /imports forbidden frontend path/.test(impOut));

  // (7) CONTROL — the REAL repository root must be clean, or this gate is failing in place.
  const realRun = run(REPO);
  record(`CONTROL: the REAL repo root exits 0 (observed exit=${realRun.status})`, realRun.status === 0);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\n  SELF-TEST · verify-backend-boundary (P-2 remediation)');
  console.log('  ' + '-'.repeat(84));
  for (const r of rows) console.log(r);
  console.log('  ' + '-'.repeat(84));
  if (problems.length) {
    console.error(`  SELF-TEST FAIL — ${problems.length} case(s) wrong; this gate is a false-green.\n`);
    process.exit(1);
  }
  console.log(`  SELF-TEST PASS — ${rows.length}/${rows.length}, every case an OBSERVED exit code from a spawned run of this gate.\n`);
  process.exit(0);
}

// =================================================================================================
// THE GATE
// =================================================================================================
if (!fs.existsSync(root)) {
  console.error(`CANNOT MEASURE verify-backend-boundary — root missing: ${root}`);
  console.error('A vanished root must not silently shrink the subject. Re-point this gate, then re-run.');
  process.exit(2);
}

const agentsPath = path.join(root, 'AGENTS.md');
const claudePath = path.join(root, 'CLAUDE.md');
const missingContracts = [agentsPath, claudePath].filter((p) => !fs.existsSync(p));
if (missingContracts.length) {
  console.error(`CANNOT MEASURE verify-backend-boundary — entry contract(s) missing: ${missingContracts.map((p) => path.basename(p)).join(', ')}`);
  console.error('Zero contract bytes read cannot render as "no stale authority claims"; that is a false zero.');
  process.exit(2);
}

const failures = [];
failures.push(...validateEntryContracts(
  fs.readFileSync(agentsPath, 'utf8'),
  fs.readFileSync(claudePath, 'utf8'),
));

for (const rel of forbiddenRoots) {
  if (fs.existsSync(path.join(root, rel))) failures.push(`frontend root present: ${rel}`);
}

for (const file of [...walk(path.join(root, 'src/workers')), ...walk(path.join(root, 'functions'))]) {
  const source = fs.readFileSync(file, 'utf8');
  for (const match of source.matchAll(importRe)) {
    const specifier = match[1];
    if (/(?:^|\/)(?:app|runtime|widgets|pages|components|shared)(?:\/|$)/.test(specifier)) {
      failures.push(`${path.relative(root, file)} imports forbidden frontend path ${specifier}`);
    }
  }
}

if (failures.length) {
  for (const failure of failures) console.error(`FAIL ${failure}`);
  process.exit(1);
}
console.log('PASS backend boundary: no frontend roots and no runtime imports from frontend layers');
