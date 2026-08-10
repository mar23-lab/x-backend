#!/usr/bin/env node
// verify-customer-ecosystem-template.mjs — the customer ecosystem template must carry every required
// artifact, must not leak internal governance/IP detail, and must make authority/consent state
// visible rather than implied.
//
// P-2 REMEDIATION (260729) — this gate was a GATE_SELF_REFERENCE_BASELINE entry carrying a
// `diagnosis`. Recorded cause: the flagged callsite was
// `emit('verify-customer-ecosystem-template', failures, { required_files: required.length })`, where
// `required` was a 16-entry const-array literal of template paths defined in this file.
//
// THE DIAGNOSIS ALSO RECORDED THAT THE DETECTOR WAS PARTLY OVER-MATCHING HERE, and that remains
// true: `required.length` is a METRIC in the emit payload, not the asserted subject — the asserted
// subject was already `failures`. That is stated plainly rather than used as an excuse, because the
// honest clear was available and is what this change makes:
//   - the 16-path required list moved OUT to docs/contracts/CUSTOMER_ECOSYSTEM_TEMPLATE_CONTRACT.json,
//     so the template's contract is reviewable and diffable without reading this gate;
//   - `--template-root=` and `--contract=` overrides, so the gate can be aimed at a seeded tree;
//   - a DENOMINATOR GUARD: a contract listing zero required files exits 2, never passes vacuously;
//   - a `--self-test` that SPAWNS this gate and OBSERVES the exit code. This gate previously had
//     NO self-test at all, and was the only baseline entry with external_subject=false.
//
// EXIT CODES.  0 = measured clean   1 = template contract violated   2 = COULD NOT MEASURE
//
//   node scripts/verify-customer-ecosystem-template.mjs
//   node scripts/verify-customer-ecosystem-template.mjs --self-test           # OBSERVES a red
//   node scripts/verify-customer-ecosystem-template.mjs --template-root=<dir>
//   node scripts/verify-customer-ecosystem-template.mjs --contract=<file>

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_TEMPLATE_ROOT = path.join(REPO, 'templates/customer-ecosystem-template');
const DEFAULT_CONTRACT = path.join(REPO, 'docs/contracts/CUSTOMER_ECOSYSTEM_TEMPLATE_CONTRACT.json');

const argv = process.argv.slice(2);
const selfTest = argv.includes('--self-test');
const rootArg = argv.find((a) => a.startsWith('--template-root='));
const contractArg = argv.find((a) => a.startsWith('--contract='));
const templateRoot = rootArg ? path.resolve(rootArg.slice('--template-root='.length)) : DEFAULT_TEMPLATE_ROOT;
const contractPath = contractArg ? path.resolve(contractArg.slice('--contract='.length)) : DEFAULT_CONTRACT;

// =================================================================================================
// SELF-TEST — the SUBJECT is this gate as a PROCESS; exit codes are OBSERVED from a child
// =================================================================================================
if (selfTest) {
  const rows = [];
  const problems = [];
  const record = (label, ok) => { rows.push('  ' + (ok ? 'PASS' : 'FAIL').padEnd(6) + '  ' + label); if (!ok) problems.push(label); };
  const run = (args) => spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...args], { encoding: 'utf8' });

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xl-cust-template-selftest-'));
  // The seed is a COPY OF THE REAL TEMPLATE, so a mutant's red is attributable to the mutation
  // rather than to an authored-here stand-in that never resembled the shipped tree.
  const seedTemplate = (name) => {
    const dest = path.join(tmp, name);
    fs.cpSync(DEFAULT_TEMPLATE_ROOT, dest, { recursive: true });
    return dest;
  };

  // (1) CANNOT MEASURE — a template root that does not exist must exit 2, never 0.
  const goneRun = run(['--template-root=' + path.join(tmp, 'no-such-root')]);
  record(`MISSING TEMPLATE ROOT exits 2 "cannot measure" (observed exit=${goneRun.status})`, goneRun.status === 2);

  // (2) CANNOT MEASURE — a missing contract must exit 2, never 0.
  const noContractRun = run(['--contract=' + path.join(tmp, 'no-such-contract.json')]);
  record(`MISSING CONTRACT exits 2 "cannot measure" (observed exit=${noContractRun.status})`, noContractRun.status === 2);

  // (3) CANNOT MEASURE — THE DENOMINATOR GUARD. A contract listing zero required files must exit 2.
  //     Without it, an emptied contract makes every check vacuous and the gate prints PASS · files=0.
  const emptyContract = path.join(tmp, 'empty-contract.json');
  fs.writeFileSync(emptyContract, JSON.stringify({ schema_id: 'customer_ecosystem_template_contract.v1', required_files: [] }));
  const emptyRun = run(['--contract=' + emptyContract]);
  record(`ZERO REQUIRED FILES exits 2 "cannot measure" (observed exit=${emptyRun.status})`, emptyRun.status === 2);

  // (4) CONTROL — the real template against the real contract must exit 0.
  const realRun = run([]);
  record(`CONTROL: the REAL template exits 0 (observed exit=${realRun.status})`, realRun.status === 0);

  // (5) CONTROL — an unmutated COPY of the real template must exit 0, or the mutant proves nothing.
  const copyRun = run(['--template-root=' + seedTemplate('copy')]);
  record(`CONTROL: an unmutated copy of the template exits 0 (observed exit=${copyRun.status})`, copyRun.status === 0);

  // (6) MUTANT — delete ONE required file; the gate must exit 1 and NAME it.
  const missingRoot = seedTemplate('missing-one');
  fs.rmSync(path.join(missingRoot, 'governance/AI_TOOL_READINESS.md'), { force: true });
  const missingRun = run(['--template-root=' + missingRoot]);
  const missingOut = (missingRun.stdout || '') + (missingRun.stderr || '');
  record(`MUTANT: one required file deleted drives exit 1 (observed exit=${missingRun.status})`, missingRun.status === 1);
  record('MUTANT: the missing required file is NAMED',
    /template missing governance\/AI_TOOL_READINESS\.md/.test(missingOut));

  // (7) MUTANT — an internal governance/IP leak in a template file must exit 1.
  const leakRoot = seedTemplate('leak');
  fs.appendFileSync(path.join(leakRoot, 'README.md'), '\n\nSee HR-EVIDENCE-FIRST-AUDIT-1 for the engine weights.\n');
  const leakRun = run(['--template-root=' + leakRoot]);
  const leakOut = (leakRun.stdout || '') + (leakRun.stderr || '');
  record(`MUTANT: an internal governance/IP leak drives exit 1 (observed exit=${leakRun.status})`, leakRun.status === 1);
  record('MUTANT: the leaking file is NAMED', /README\.md: template leaks internal governance\/IP detail/.test(leakOut));

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\n  SELF-TEST · verify-customer-ecosystem-template (P-2 remediation)');
  console.log('  ' + '-'.repeat(84));
  for (const r of rows) console.log(r);
  console.log('  ' + '-'.repeat(84));
  if (problems.length) {
    console.error(`  SELF-TEST FAIL — ${problems.length} case(s) wrong; this gate is a false-green.\n`);
    process.exit(1);
  }
  const passed = rows.length - problems.length;
  console.log(`  SELF-TEST PASS — ${passed}/${rows.length}, every case an OBSERVED exit code from a spawned run of this gate.\n`);
  process.exit(0);
}

// =================================================================================================
// THE GATE
// =================================================================================================
if (!fs.existsSync(contractPath)) {
  console.error(`CANNOT MEASURE verify-customer-ecosystem-template — contract missing: ${contractPath}`);
  console.error('The required-file list is the denominator of this gate; without it nothing was measured.');
  process.exit(2);
}
if (!fs.existsSync(templateRoot)) {
  console.error(`CANNOT MEASURE verify-customer-ecosystem-template — template root missing: ${templateRoot}`);
  console.error('A vanished root must not silently shrink the subject. Re-point this gate, then re-run.');
  process.exit(2);
}

const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
const required = Array.isArray(contract.required_files) ? contract.required_files : [];

// EXIT 2 — DENOMINATOR GUARD. A contract with zero required files makes every loop below vacuous.
if (!required.length) {
  console.error(`CANNOT MEASURE verify-customer-ecosystem-template — ${path.basename(contractPath)} lists ZERO required files.`);
  console.error('A gate that required nothing has verified nothing; that is a false zero, not a pass.');
  process.exit(2);
}

const leakRe = new RegExp(contract.internal_detail_leak_pattern
  || 'MB-P hard-rule|HR-[A-Z0-9-]+-\\d+|engine weights?|prompt chain|architecture dependency map', 'i');
const authorityFiles = Array.isArray(contract.authority_consent_visible_in) ? contract.authority_consent_visible_in : [];

const failures = [];

for (const rel of required) {
  const full = path.join(templateRoot, rel);
  if (!fs.existsSync(full)) {
    failures.push(`template missing ${rel}`);
    continue;
  }
  if (leakRe.test(fs.readFileSync(full, 'utf8'))) {
    failures.push(`${rel}: template leaks internal governance/IP detail`);
  }
}

function read(rel) {
  const full = path.join(templateRoot, rel);
  return fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : '';
}

for (const rel of authorityFiles) {
  if (!/authority|consent|pending|blocked/i.test(read(rel))) {
    failures.push(`${rel}: must make authority/consent pending or blocked visible`);
  }
}
if (!/3-5/.test(read('workflows/workflow-opportunity-radar.md'))) {
  failures.push('workflow radar must require 3-5 opportunities');
}
if (!/Watch|proposal-only/i.test(read('governance/ROLE_AND_INVITE_POLICY.md'))) {
  failures.push('role/invite policy must default to Watch or proposal-only');
}

const status = failures.length ? 'FAIL' : 'PASS';
console.log(`verify-customer-ecosystem-template · ${status} · files=${required.length}`);
if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
process.exit(0);
