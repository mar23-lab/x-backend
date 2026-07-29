#!/usr/bin/env node
// scripts/verify-tenant-source-isolation.mjs · ADR-XLOOP-IA-001 R2 · HR-PLATFORM-VS-INSTANCE-1 (F1-exposure)
//
// WHY
//   A per-tenant deploy bundle is a STATIC Cloudflare Pages site (index.html + dist/*.js + data/).
//   The shared worker backend lives at api.xlooop.com — a customer's static bundle has no reason
//   to carry the worker SOURCE. Yet a tenant manifest's `passthrough_dirs` copies dirs VERBATIM
//   (no workspace filter). If a CUSTOMER (non-operator) manifest passes through `src/`, the
//   operator's construction IP — the lens engine, the detector-config seed SQL, the cockpit
//   chat-bridge — ships into the customer bundle and could be served publicly. The DATA is
//   filtered; the SOURCE was not. This gate makes that a blocking defect.
//
// RULE
//   Only the OPERATOR deploy (a manifest that owns the operator workspace `mbp-private`) may
//   passthrough operator worker source. A non-operator (customer) manifest MUST NOT passthrough
//   any operator-private source dir (`src/`, `scripts/`). Customers get dist/ + data/.
//
// P-2 REMEDIATION (260729). Two defects, both of the class META-GATE P-2 was built to find:
//
//   1. THE SELF-TEST TESTED THIS FILE, NOT THE GATE. It called `evaluate()` — defined here — on
//      three fixtures defined here, and asserted the return value. Three of this gate's five
//      assertion callsites named symbols it defines itself. `evaluate()` could have been correct
//      while everything around it (manifest discovery, JSON parse, exit code) was broken, and the
//      self-test would still have printed a tick. It now writes real manifest JSON into a temp
//      directory, SPAWNS this gate against it, and OBSERVES the exit code.
//   2. ZERO MANIFESTS READ AS ISOLATED. `readdirSync` returning no .json files left `manifests`
//      empty, `fails` empty, and the gate printed "no customer tenant bundle passes through
//      operator worker source" — a false zero. A manifest directory that exists but is empty, or
//      that holds a manifest which does not parse, is now "cannot measure".
//
// EXIT CODES.  0 = isolated   1 = a customer manifest ships operator source   2 = COULD NOT MEASURE
//
//   node scripts/verify-tenant-source-isolation.mjs
//   node scripts/verify-tenant-source-isolation.mjs --self-test           # OBSERVES a red
//   node scripts/verify-tenant-source-isolation.mjs --manifest-dir=<dir>  # aim it elsewhere

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const selfTest = argv.includes('--self-test');
const dirArg = argv.find((a) => a.startsWith('--manifest-dir='));
const DEFAULT_MANIFEST_DIR = path.join(repoRoot, 'data', '_tenant-manifests');
const MANIFEST_DIR = dirArg ? path.resolve(dirArg.slice('--manifest-dir='.length)) : DEFAULT_MANIFEST_DIR;

// The operator workspace whose presence marks a manifest as the operator's own deploy.
const OPERATOR_WORKSPACE = 'mbp-private';
// Source dirs that carry operator construction IP and must never reach a customer bundle.
const OPERATOR_SOURCE_DIRS = ['src/', 'src', 'scripts/', 'scripts'];

function isOperatorManifest(m) {
  return Array.isArray(m.owned_workspaces) && m.owned_workspaces.includes(OPERATOR_WORKSPACE);
}

function offendingDirs(m) {
  const pd = m.passthrough_dirs || [];
  return pd.filter((d) => OPERATOR_SOURCE_DIRS.includes(String(d)));
}

function evaluate(manifests) {
  const fails = [];
  for (const { id, m } of manifests) {
    if (isOperatorManifest(m)) continue; // the operator's own deploy may carry operator source
    const bad = offendingDirs(m);
    if (bad.length) fails.push(`${id}: customer manifest passthroughs operator source ${JSON.stringify(bad)} — strip to dist/ + data/ only`);
  }
  return fails;
}

// =================================================================================================
// SELF-TEST — the SUBJECT is this gate as a PROCESS; exit codes are OBSERVED from a child
// =================================================================================================
if (selfTest) {
  const rows = [];
  const problems = [];
  const record = (label, ok) => { rows.push('  ' + (ok ? 'PASS' : 'FAIL').padEnd(6) + '  ' + label); if (!ok) problems.push(label); };
  const run = (dir) => spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--manifest-dir=' + dir], { encoding: 'utf8' });
  const seed = (dir, name, obj) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, name + '.json'), JSON.stringify(obj, null, 2)); };

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xl-tenant-iso-selftest-'));

  // (1) CANNOT MEASURE — a manifest directory that does not exist must exit 2, never 0.
  const goneRun = run(path.join(tmp, 'no-such-dir'));
  record(`MISSING MANIFEST DIR exits 2 "cannot measure" (observed exit=${goneRun.status})`, goneRun.status === 2);

  // (2) CANNOT MEASURE — a directory holding zero manifests must exit 2. This is the false zero the
  //     remediation closes: before it, zero manifests printed the isolation claim.
  const emptyDir = path.join(tmp, 'empty'); fs.mkdirSync(emptyDir, { recursive: true });
  const emptyRun = run(emptyDir);
  record(`EMPTY INPUT SET exits 2 "cannot measure" (observed exit=${emptyRun.status})`, emptyRun.status === 2);

  // (3) CONTROL — the REAL tenant manifests, unmutated, must exit 0.
  const controlRun = run(DEFAULT_MANIFEST_DIR);
  record(`CONTROL: the real tenant manifests exit 0 (observed exit=${controlRun.status})`, controlRun.status === 0);

  // (4) MUTANT — a customer manifest passing through src/ must drive exit 1.
  const badDir = path.join(tmp, 'customer-with-src');
  seed(badDir, 'fake-customer', { owned_workspaces: ['cust'], passthrough_dirs: ['dist/', 'src/'] });
  const badRun = run(badDir);
  const badOut = (badRun.stdout || '') + (badRun.stderr || '');
  record(`MUTANT: customer manifest with 'src/' drives exit 1 (observed exit=${badRun.status})`, badRun.status === 1);
  record('MUTANT: the offending manifest and dir are NAMED', /fake-customer/.test(badOut) && /src\//.test(badOut));

  // (5) MUTANT — `scripts/` must bite independently, or one dead entry hides behind the other.
  const badScriptsDir = path.join(tmp, 'customer-with-scripts');
  seed(badScriptsDir, 'fake-customer-2', { owned_workspaces: ['cust'], passthrough_dirs: ['dist/', 'scripts/'] });
  const badScriptsRun = run(badScriptsDir);
  record(`MUTANT: customer manifest with 'scripts/' drives exit 1 (observed exit=${badScriptsRun.status})`, badScriptsRun.status === 1);

  // (6) CONTROL — a clean customer manifest must exit 0, or the rule is "no passthrough at all".
  const cleanDir = path.join(tmp, 'customer-clean');
  seed(cleanDir, 'fake-customer', { owned_workspaces: ['cust'], passthrough_dirs: ['dist/', 'data/schemas/'] });
  const cleanRun = run(cleanDir);
  record(`CONTROL: clean customer manifest exits 0 (observed exit=${cleanRun.status})`, cleanRun.status === 0);

  // (7) CONTROL — the OPERATOR's own deploy may carry operator source; if this went red the gate
  //     would block the operator's own release, which is how a gate gets deleted rather than fixed.
  const opDir = path.join(tmp, 'operator-with-src');
  seed(opDir, 'operator-mbp', { owned_workspaces: ['mbp-private'], passthrough_dirs: ['dist/', 'src/'] });
  const opRun = run(opDir);
  record(`CONTROL: operator manifest with 'src/' is allowed, exits 0 (observed exit=${opRun.status})`, opRun.status === 0);

  // (8) CANNOT MEASURE — unparseable JSON is not "isolated". It must not be swallowed as clean.
  const brokenDir = path.join(tmp, 'broken'); fs.mkdirSync(brokenDir, { recursive: true });
  fs.writeFileSync(path.join(brokenDir, 'broken.json'), '{ not json');
  const brokenRun = run(brokenDir);
  record(`UNPARSEABLE MANIFEST exits 2 "cannot measure" (observed exit=${brokenRun.status})`, brokenRun.status === 2);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\n  SELF-TEST · verify-tenant-source-isolation (R2)');
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
if (!fs.existsSync(MANIFEST_DIR)) {
  console.error(`✗ CANNOT MEASURE tenant source isolation — manifest directory missing: ${MANIFEST_DIR}`);
  console.error('  A vanished root must not silently shrink the subject. Re-point this gate, then re-run.');
  process.exit(2);
}

const manifests = [];
for (const f of fs.readdirSync(MANIFEST_DIR)) {
  if (!f.endsWith('.json')) continue;
  try {
    manifests.push({ id: f.replace(/\.json$/, ''), m: JSON.parse(fs.readFileSync(path.join(MANIFEST_DIR, f), 'utf8')) });
  } catch (e) {
    console.error(`✗ CANNOT MEASURE tenant source isolation — ${f} does not parse: ${e.message}`);
    console.error('  An unreadable manifest is not an isolated manifest. Fix it, then re-run.');
    process.exit(2);
  }
}

// EXIT 2 — EMPTY INPUT SET. `manifests` is the denominator of the only claim this gate makes.
if (!manifests.length) {
  console.error(`✗ CANNOT MEASURE tenant source isolation — ${MANIFEST_DIR} exists but holds ZERO .json manifests.`);
  console.error('  A gate that inspected nothing has measured nothing; that is a false zero, not isolation.');
  process.exit(2);
}

const fails = evaluate(manifests);
console.log('R2 · tenant source isolation (HR-PLATFORM-VS-INSTANCE-1 · F1-exposure)');
console.log('─'.repeat(64));
const ops = manifests.filter(({ m }) => isOperatorManifest(m)).map((x) => x.id);
const custs = manifests.filter(({ m }) => !isOperatorManifest(m)).map((x) => x.id);
console.log(`  operator manifests: ${ops.join(', ') || '(none)'} · customer manifests: ${custs.join(', ') || '(none)'}`);
if (fails.length) {
  console.error('─'.repeat(64));
  console.error(`✗ tenant source isolation BROKEN · ${fails.length} customer bundle(s) ship operator source:`);
  for (const f of fails) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log('─'.repeat(64));
console.log(`☑ ${manifests.length} tenant manifest(s) inspected; no customer bundle passes through operator worker source (dist/ + data/ only)`);
process.exit(0);
