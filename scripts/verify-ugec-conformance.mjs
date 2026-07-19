#!/usr/bin/env node
// verify-ugec-conformance.mjs · ADR-XB-008 — the UGEC coverage counter, born-shadow.
//
// Approximate STATIC scan (labelled as such): counts write-handler sites vs
// spine-authority call sites vs principal-stamping sites vs fence checks across
// src/workers/routes/*.ts. It is a COVERAGE RATCHET, not a proof of enforcement:
// spine coverage must not DECREASE and uncovered write handlers must not INCREASE
// past the committed baseline (docs/contracts/UGEC_CONFORMANCE_BASELINE.json).
// The H1/N.6 ratchet doctrine, third application: absolute-100% would Goodhart
// (reward deleting routes over governing them); a monotone floor catches drift.
//
// Usage: node scripts/verify-ugec-conformance.mjs [--ratchet] [--write-baseline]

import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROUTES_DIR = join(ROOT, 'src', 'workers', 'routes');
const BASELINE_PATH = join(ROOT, 'docs', 'contracts', 'UGEC_CONFORMANCE_BASELINE.json');

const WRITE_RE = /\.(post|patch|put|delete)\(/g;
const SPINE_RE = /authorize(SpineWrite|GovernedWrite)\(/g;
const LINEAGE_RE = /lineageFor\(/g;
const FENCE_RE = /evaluateUgecFence\(/g;

const perFile = {};
let totals = { write_handlers: 0, spine_authorize_calls: 0, lineage_stamp_sites: 0, fence_check_sites: 0 };

for (const f of readdirSync(ROUTES_DIR).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts')).sort()) {
  const text = readFileSync(join(ROUTES_DIR, f), 'utf8');
  const counts = {
    write_handlers: (text.match(WRITE_RE) ?? []).length,
    spine_authorize_calls: (text.match(SPINE_RE) ?? []).length,
    lineage_stamp_sites: (text.match(LINEAGE_RE) ?? []).length,
    fence_check_sites: (text.match(FENCE_RE) ?? []).length,
  };
  if (Object.values(counts).some((n) => n > 0)) perFile[f] = counts;
  for (const k of Object.keys(totals)) totals[k] += counts[k];
}

const report = {
  schema_id: 'ugec_conformance_report.v1',
  approximate_static_scan: true,
  note: 'coverage ratchet, not enforcement proof: spine calls are byte-identical to legacy role checks while ENTITLEMENT_ENFORCEMENT is off (spine-authority.ts). See ADR-XB-008.',
  totals,
  uncovered_write_handlers: totals.write_handlers - totals.spine_authorize_calls,
  per_file: perFile,
};

const args = process.argv.slice(2);
if (args.includes('--write-baseline')) {
  writeFileSync(BASELINE_PATH, JSON.stringify({
    schema_id: 'ugec_conformance_baseline.v1',
    rule: 'spine_authorize_calls MUST NOT decrease; uncovered_write_handlers MUST NOT increase. Monotone ratchet (ADR-XB-008), never an absolute-100% target. Lower uncovered/raise spine ceilings to lock gains.',
    spine_authorize_calls_floor: totals.spine_authorize_calls,
    uncovered_write_handlers_ceiling: report.uncovered_write_handlers,
    captured_at: new Date().toISOString().slice(0, 10),
  }, null, 2) + '\n');
  console.log(`baseline written: floor=${totals.spine_authorize_calls} ceiling=${report.uncovered_write_handlers}`);
}

let ratchet = null;
if (args.includes('--ratchet')) {
  if (!existsSync(BASELINE_PATH)) {
    ratchet = { status: 'no_baseline', note: 'run --write-baseline to arm the ratchet' };
  } else {
    const base = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
    const regressions = [];
    if (totals.spine_authorize_calls < base.spine_authorize_calls_floor) {
      regressions.push(`spine_authorize_calls ${totals.spine_authorize_calls} < floor ${base.spine_authorize_calls_floor}`);
    }
    if (report.uncovered_write_handlers > base.uncovered_write_handlers_ceiling) {
      regressions.push(`uncovered_write_handlers ${report.uncovered_write_handlers} > ceiling ${base.uncovered_write_handlers_ceiling}`);
    }
    ratchet = regressions.length
      ? { status: 'fail', regressions }
      : { status: totals.spine_authorize_calls > base.spine_authorize_calls_floor
          || report.uncovered_write_handlers < base.uncovered_write_handlers_ceiling ? 'improved' : 'held' };
  }
  report.ratchet = ratchet;
}

console.log(JSON.stringify(report, null, 2));
process.exit(ratchet && ratchet.status === 'fail' ? 1 : 0);
