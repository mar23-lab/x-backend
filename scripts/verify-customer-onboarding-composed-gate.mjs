#!/usr/bin/env node
// verify-customer-onboarding-composed-gate.mjs
//
// Composed customer-onboarding gate: runs the customer-onboarding sub-gate family in real mode
// and aggregates their exit codes.
//
// Exit codes:
//   0  every sub-gate passed
//   1  at least one sub-gate FAILED (measured red)
//   2  at least one sub-gate script is MISSING/unreadable (could not measure) — deliberately
//      distinct from 1, so "could not measure" can never render as "measured clean" and cannot
//      hide inside an ordinary red either.
//
// 260730 sub-gate reconciliation. All three previously-unresolvable entries were donor-only
// artifacts from Xlooop-XCP-demo that arrived referenced-but-unported in the bootstrap seed
// 9dc68a7 ("feat: bootstrap provenance-verified backend shadow seed"). `git log -- <path>` is
// EMPTY for each of them in this repo and a full --all history scan finds no blob, so none was
// ever deleted here — the composed list was simply ported ahead of its sub-gates:
//
//   * scripts/verify-aps-ecosystem-skeleton.mjs   REMOVED from this list.
//     Its subject is a directory on the operator's laptop (APS_ECOSYSTEM_ROOT, default
//     '/Users/maratbasyrov/Andrey P - Ecosystem') that lives outside every repo. Asserting that 21
//     onboarding documents exist inside a customer's private local folder is not a property of
//     x-backend, cannot hold on any other machine or in CI, and would make this gate depend on a
//     runtime filesystem outside the repo. Deleted rather than resurrected.
//
//   * scripts/verify-customer-authority-gates.mjs PORTED as a backend-portable subset.
//     See that file's header. Every read-model assertion it makes holds in this repo (28/28
//     measured); only its src/widgets/AccountScreens/*.jsx UI-marker assertions were dropped,
//     because x-backend carries no frontend surface.
//
//   * scripts/verify-customer-delete-export.mjs   REPOINTED to its ported successor,
//     scripts/verify-delete-export-execution.mjs — the consolidation shim into
//     `verify-template-policy-suite.mjs --check=delete_export`. The refactor that produced it also
//     consolidated six sibling verifiers into the same suite.
//
// Usage:
//   node scripts/verify-customer-onboarding-composed-gate.mjs
//   node scripts/verify-customer-onboarding-composed-gate.mjs --gates-file=<json>
//   node scripts/verify-customer-onboarding-composed-gate.mjs --self-test
//
// --gates-file takes a JSON array of [script, ...args] entries and runs the SAME runner over them.
// It exists so --self-test can drive this binary, as a child process, over fixture sub-gates whose
// real exit codes are known, and observe that a red is actually propagated.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..');

const DEFAULT_GATES = [
  ['scripts/verify-customer-onboarding-standard.mjs'],
  ['scripts/seam-gates/run.mjs', '--gate', 'customer-privacy-boundary'],
  ['scripts/verify-customer-projection-honesty.mjs'],
  ['scripts/verify-customer-workflow-opportunity-radar.mjs'],
  ['scripts/verify-customer-ai-ready-scorecard.mjs'],
  ['scripts/verify-customer-ip-boundary.mjs'],
  ['scripts/verify-customer-authority-gates.mjs'],
  ['scripts/verify-customer-ecosystem-template.mjs'],
  ['scripts/verify-customer-health-value-read-model.mjs'],
  ['scripts/verify-delete-export-execution.mjs'],
];

const argv = process.argv.slice(2);
if (argv.includes('--self-test')) process.exit(selfTest());

const gatesFile = flagValue(argv, '--gates-file');
let gates = DEFAULT_GATES;
if (gatesFile) {
  try {
    gates = JSON.parse(fs.readFileSync(gatesFile, 'utf8'));
  } catch (err) {
    console.error(`verify-customer-onboarding-composed-gate · UNMEASURABLE · unreadable --gates-file ${gatesFile}: ${err.message}`);
    process.exit(2);
  }
}

process.exit(run(gates));

// ---- runner ----------------------------------------------------------------
function run(list) {
  // Fail-closed on missing inputs BEFORE running anything: a sub-gate script that is not on disk
  // is an unmeasured gate, not a failing one, and the two must not collapse into one exit code.
  const missing = list.filter(([script]) => !fs.existsSync(path.join(repoRoot, script)));
  if (missing.length) {
    console.error(`verify-customer-onboarding-composed-gate · UNMEASURABLE · checks=${list.length}`);
    console.error(`missing sub-gate scripts (cannot measure):\n${missing.map(([s]) => s).join('\n')}`);
    return 2;
  }

  const failures = [];
  for (const [script, ...args] of list) {
    const result = spawnSync(process.execPath, [path.join(repoRoot, script), ...args], {
      cwd: repoRoot,
      stdio: 'pipe',
      encoding: 'utf8',
      env: { ...process.env, XCP_VERIFY_READONLY: process.env.XCP_VERIFY_READONLY || '1' },
    });
    process.stdout.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
    if (result.status !== 0) failures.push(`${script} ${args.join(' ')}`.trim());
  }

  console.log(`verify-customer-onboarding-composed-gate · ${failures.length ? 'FAIL' : 'PASS'} · checks=${list.length}`);
  if (failures.length) {
    console.error(`failed checks:\n${failures.join('\n')}`);
    return 1;
  }
  return 0;
}

function flagValue(args, flag) {
  const prefix = `${flag}=`;
  const hit = args.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : '';
}

// ---- self-test -------------------------------------------------------------
// Spawns THIS gate as a child process and observes its real exit codes. A control that only
// inspects its own in-file fixtures proves nothing; each case below re-invokes the binary.
function selfTest() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'composed-gate-selftest-'));
  const rel = (p) => path.relative(repoRoot, p);
  const green = path.join(dir, 'green.mjs');
  const red = path.join(dir, 'red.mjs');
  fs.writeFileSync(green, 'process.exit(0);\n');
  fs.writeFileSync(red, 'process.exit(1);\n');

  const cases = [
    ['control (all sub-gates green) exits 0', [[rel(green)], [rel(green)]], 0],
    ['mutant (one sub-gate red) exits 1', [[rel(green)], [rel(red)]], 1],
    ['missing sub-gate script exits 2', [[rel(green)], ['scripts/__does-not-exist__.mjs']], 2],
  ];

  let failed = 0;
  for (const [label, list, want] of cases) {
    const listFile = path.join(dir, `${label.replace(/\W+/g, '-')}.json`);
    fs.writeFileSync(listFile, JSON.stringify(list));
    const got = spawnSync(process.execPath, [__filename, `--gates-file=${listFile}`], {
      cwd: repoRoot,
      stdio: 'pipe',
      encoding: 'utf8',
    }).status;
    const ok = got === want;
    if (!ok) failed += 1;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label} (want ${want}, got ${got})`);
  }

  // The real list must also be reachable: every default sub-gate script must exist on disk.
  const missing = DEFAULT_GATES.filter(([s]) => !fs.existsSync(path.join(repoRoot, s))).map(([s]) => s);
  if (missing.length) {
    failed += 1;
    console.log(`FAIL  every default sub-gate script exists (missing: ${missing.join(', ')})`);
  } else {
    console.log(`PASS  every default sub-gate script exists (${DEFAULT_GATES.length} sub-gates)`);
  }

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`verify-customer-onboarding-composed-gate:self-test · ${failed ? 'FAIL' : 'PASS'}`);
  return failed ? 1 : 0;
}
