#!/usr/bin/env node
// verify-migration-state-ssot.mjs · S2/F1 (260709) — the anti-drift gate for migration APPLIED/STAGED prose.
//
// FAILURE CLASS (F1 — recurred twice, 260708): whether a migration is APPLIED is a PROD fact
// (workers_schema_version max), but hand-written prose restated it per-migration in multiple places and
// drifted ("056 staged" lingered after the apply, misleading an external report into "Gate-1 RED").
//
// RULE ENFORCED (docs/governance/OPERATOR_AXIS_AUTHORITY.md "APPLIED-STATE SSOT"):
//   Across docs/governance/*.md, a line that names a migration number (\b0\d\d\b) AND claims state
//   (APPLIED or STAGED, case-sensitive — the state-claim convention) is allowed ONLY:
//     (a) inside the <!-- APPLIED-STATE-SSOT-BEGIN --> ... <!-- APPLIED-STATE-SSOT-END --> block
//         (the one dated snapshot, re-verified against prod schema_head), or
//     (b) when the line itself carries a date (yymmdd 26xxxx or ISO 20xx-xx-xx) — a dated line is an
//         EVENT RECORD ("APPLIED to prod (verified 260708)"), not a current-state claim, and cannot drift.
//   Undated, out-of-block state claims are exactly the lines that rot — the gate fails on them.
//
// Self-test: --self-test injects an undated violation into a temp copy and asserts the gate goes RED.

import { readFileSync, readdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const GOV_DIR = 'docs/governance';
const BEGIN = 'APPLIED-STATE-SSOT-BEGIN';
const END = 'APPLIED-STATE-SSOT-END';
const MIGRATION_NUM = /\b0\d{2}\b/;                    // 054, 057, 060 ... (word-bounded)
const STATE_CLAIM = /\b(APPLIED|STAGED)\b/;            // case-sensitive: the state-claim convention
const DATED = /\b26\d{4}\b|\b20\d{2}-\d{2}-\d{2}\b/;   // yymmdd or ISO date => event record, exempt

export function findViolations(fileName, text) {
  const out = [];
  let inSsot = false;
  text.split('\n').forEach((line, i) => {
    if (line.includes(BEGIN)) { inSsot = true; return; }
    if (line.includes(END)) { inSsot = false; return; }
    if (inSsot) return;
    if (MIGRATION_NUM.test(line) && STATE_CLAIM.test(line) && !DATED.test(line)) {
      out.push({ file: fileName, line: i + 1, text: line.trim().slice(0, 140) });
    }
  });
  return out;
}

function scan(dir) {
  const violations = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.md')) continue;
    violations.push(...findViolations(join(dir, f), readFileSync(join(dir, f), 'utf8')));
  }
  return violations;
}

function selfTest() {
  const tmp = mkdtempSync(join(tmpdir(), 'ssot-gate-'));
  try {
    // RED: an undated out-of-block state claim MUST be caught.
    writeFileSync(join(tmp, 'a.md'), 'intro\nMigration 056 is STAGED and waiting.\n');
    if (scan(tmp).length !== 1) return 'self-test RED case failed: undated claim not caught';
    // GREEN 1: the same claim inside SSOT markers passes.
    writeFileSync(join(tmp, 'a.md'), `<!-- ${BEGIN} -->\n056 STAGED\n<!-- ${END} -->\n`);
    if (scan(tmp).length !== 0) return 'self-test GREEN(ssot) failed: in-block claim flagged';
    // GREEN 2: a dated event record passes.
    writeFileSync(join(tmp, 'a.md'), 'Migration 054 APPLIED to prod (verified 260708).\n');
    if (scan(tmp).length !== 0) return 'self-test GREEN(dated) failed: dated record flagged';
    // GREEN 3: sequencing prose without the uppercase state keyword passes.
    writeFileSync(join(tmp, 'a.md'), 'AFTER 050 is applied to prod, run the probe.\n');
    if (scan(tmp).length !== 0) return 'self-test GREEN(lowercase) failed: sequencing prose flagged';
    return null;
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

const selfTestErr = selfTest();
if (selfTestErr) {
  console.error(`✗ verify:migration-state-ssot · GATE SELF-TEST FAILED: ${selfTestErr}`);
  process.exit(1);
}
if (process.argv.includes('--self-test')) {
  console.log('☑ verify:migration-state-ssot · self-test passed (RED + 3 GREEN cases)');
  process.exit(0);
}

const violations = scan(GOV_DIR);
if (violations.length) {
  console.error(`✗ verify:migration-state-ssot · ${violations.length} undated migration-state claim(s) outside the SSOT block:`);
  for (const v of violations) console.error(`  ${v.file}:${v.line} · ${v.text}`);
  console.error('  Fix: state current migration status ONLY in the APPLIED-STATE-SSOT block, or date the line (a dated line is an event record).');
  process.exit(1);
}
console.log('☑ verify:migration-state-ssot · governance docs clean (self-test green)');
