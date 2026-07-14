#!/usr/bin/env node
// verify-operation-events-append-only.mjs · BORN-WARN · ADR-XLOOP-IA-001 content-immutability (Plane 2+).
//
// ADR-XLOOP-IA-001: operation_events CONTENT is append-only — only a status-CLASS re-point is allowed
// (status / visibility / deleted_at), and results must be a NEW INSERT, never an in-place content edit.
// Today that's only schema-IMPLIED (001_init.sql has no UPDATE/DELETE path) but never actively gated:
// the unified-graph gate proves projection PURITY, not source immutability. This gate scans the
// migrations + the worker DAL for any UPDATE that mutates a CONTENT column of operation_events, or any
// DELETE/TRUNCATE of operation_events, and surfaces them as CANDIDATES.
//
// BORN-WARN (exit 0): #790 added a GOVERNED soft-delete/restore/rollback-purge path, so a hard block
// would false-positive on legitimate admin operations. This gate accrues a gate-promotion-calibration
// row (would_have_blocked) so a human can confirm each finding is a real content-mutation vs a governed
// exception; promote WARN->FAIL later via the D2.1 ladder once findings are dispositioned to zero.
//
// Run:        node scripts/verify-operation-events-append-only.mjs
// Self-test:  node scripts/verify-operation-events-append-only.mjs --self-test   (must-not-stay-dead)

import { readFileSync, readdirSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const ROOT = process.cwd();
const MIG_DIR = resolve(ROOT, 'src/workers/db/migrations');
const DAL_DIR = resolve(ROOT, 'src/workers/dal');
const CALIB = resolve(ROOT, '.gate-calibration/operation-events-append-only.ndjson');

// CONTENT columns whose in-place mutation violates append-only. status/visibility/deleted_at/restored_at
// are the ALLOWED status-class re-point and are deliberately NOT here.
const CONTENT_COLS = ['content', 'description', 'summary', 'body', 'payload', 'source_tool', 'result'];

// A forbidden UPDATE: `UPDATE operation_events SET …<content col>…` before the WHERE/;/backtick boundary.
function forbiddenUpdates(text) {
  const out = [];
  const re = /update\s+operation_events\s+set\s+([\s\S]*?)(?:\bwhere\b|;|`|\)\s*$)/gi;
  let m;
  while ((m = re.exec(text))) {
    const setClause = m[1];
    const cols = CONTENT_COLS.filter((c) => new RegExp(`\\b${c}\\s*=`, 'i').test(setClause));
    if (cols.length) out.push({ kind: 'update_content', cols, snippet: m[0].slice(0, 90).replace(/\s+/g, ' ') });
  }
  return out;
}
// A DELETE / TRUNCATE of operation_events (candidate — may be the #790 governed purge).
function forbiddenDeletes(text) {
  const out = [];
  for (const re of [/delete\s+from\s+operation_events\b/gi, /truncate\s+(?:table\s+)?[^;]*\boperation_events\b/gi]) {
    let m;
    while ((m = re.exec(text))) out.push({ kind: 'delete', snippet: m[0].slice(0, 90).replace(/\s+/g, ' ') });
  }
  return out;
}

function scanText(text) {
  return [...forbiddenUpdates(text), ...forbiddenDeletes(text)];
}

function scanTree() {
  const findings = [];
  const dirs = [
    { dir: MIG_DIR, ext: '.sql' },
    { dir: DAL_DIR, ext: '.ts' },
  ];
  for (const { dir, ext } of dirs) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(ext)) continue;
      const path = join(dir, f);
      for (const hit of scanText(readFileSync(path, 'utf8'))) findings.push({ file: `${dir.includes('migrations') ? 'migrations' : 'dal'}/${f}`, ...hit });
    }
  }
  return findings;
}

function emitCalibration(findings) {
  // Mirror the MB-P gate-promotion-calibration shape so verify_gate_promotion_readiness can consume it.
  const row = {
    gate: 'verify-operation-events-append-only',
    phase: 'advisory',
    would_have_blocked: findings.length > 0 ? 1 : 0,
    false_positive: 0, // dispositioned by a human; governed #790 purge findings set this to 1 on review
    n_findings: findings.length,
    authority: 'ADR-XLOOP-IA-001',
  };
  console.log(`gate-promotion-calibration: ${JSON.stringify(row)}`);
  try { mkdirSync(resolve(ROOT, '.gate-calibration'), { recursive: true }); appendFileSync(CALIB, JSON.stringify(row) + '\n'); } catch { /* non-fatal */ }
}

if (process.argv.includes('--self-test')) {
  // must-not-stay-dead: clean inputs → 0; seeded mutations → detected.
  const clean = `INSERT INTO operation_events (id, content) VALUES ($1,$2);\nUPDATE operation_events SET status = 'done' WHERE id=$1;`;
  const dirtyUpdate = `UPDATE operation_events SET content = 'edited', description = 'x' WHERE id=$1;`;
  const dirtyDelete = `DELETE FROM operation_events WHERE id=$1;`;
  const cleanHits = scanText(clean);
  const upHits = scanText(dirtyUpdate);
  const delHits = scanText(dirtyDelete);
  const ok = cleanHits.length === 0 && upHits.length >= 1 && upHits[0].cols.includes('content') && delHits.length >= 1;
  console.log('verify-operation-events-append-only --self-test');
  console.log(`  GREEN· clean (INSERT + status re-point) → 0 findings:   ${cleanHits.length === 0 ? 'PASS' : 'FAIL'}`);
  console.log(`  RED  · UPDATE …SET content → detected:                  ${upHits.length >= 1 ? 'PASS' : 'FAIL'}`);
  console.log(`  RED  · DELETE FROM operation_events → detected:         ${delHits.length >= 1 ? 'PASS' : 'FAIL'}`);
  console.log(`\n${ok ? '✓ self-test GREEN' : '✗ self-test RED'}`);
  process.exit(ok ? 0 : 1);
}

const findings = scanTree();
emitCalibration(findings);
console.log(`\nADR-XLOOP-IA-001 · operation_events content append-only (BORN-WARN)`);
if (findings.length === 0) {
  console.log('✓ no content-mutating UPDATE / DELETE of operation_events in migrations or DAL');
} else {
  console.log(`⚠ ${findings.length} candidate(s) — review each as content-mutation (violation) vs governed exception (#790 soft-delete/purge):`);
  for (const f of findings.slice(0, 20)) console.log(`    [${f.kind}${f.cols ? ' ' + f.cols.join(',') : ''}] ${f.file}: ${f.snippet}`);
}
process.exit(0); // BORN-WARN — never blocks
