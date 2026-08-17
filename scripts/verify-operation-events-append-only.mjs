#!/usr/bin/env node
// verify-operation-events-append-only.mjs · ADR-XLOOP-IA-001 content immutability (Plane 2+).
//
// ADR-XLOOP-IA-001: operation_events CONTENT is append-only. Only the trigger allow-list may be
// re-pointed in place (status, approval_state, next_action, archived_at, project_id, intent_id);
// changed content must be a NEW INSERT.
// Today that's only schema-IMPLIED (001_init.sql has no UPDATE/DELETE path) but never actively gated:
// the unified-graph gate proves projection PURITY, not source immutability. This gate scans the
// migrations + the worker DAL + the customer onboarding CLI for any UPDATE/upsert that mutates a
// CONTENT column of operation_events, or any DELETE/TRUNCATE of operation_events.
//
// Content mutation is blocking. DELETE/TRUNCATE remains advisory because #790 has a governed
// rollback-purge path that requires human disposition.
//
// Run:        node scripts/verify-operation-events-append-only.mjs
// Self-test:  node scripts/verify-operation-events-append-only.mjs --self-test   (must-not-stay-dead)

import { readFileSync, readdirSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const ROOT = process.cwd();
const MIG_DIR = resolve(ROOT, 'src/workers/db/migrations');
const DAL_DIR = resolve(ROOT, 'src/workers/dal');
const SCRIPT_FILES = [resolve(ROOT, 'scripts/onboard-customer.mjs')];
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
// A forbidden upsert: INSERT INTO operation_events ... ON CONFLICT ... DO UPDATE SET <content>.
// This is the exact production failure class that direct-UPDATE-only scanning missed.
function forbiddenUpserts(text) {
  const out = [];
  const re = /insert\s+into\s+operation_events\b[\s\S]*?on\s+conflict\b[\s\S]*?do\s+update\s+set\s+([\s\S]*?)(?:;|`)/gi;
  let m;
  while ((m = re.exec(text))) {
    const setClause = m[1];
    const cols = CONTENT_COLS.filter((c) => new RegExp(`\\b${c}\\s*=`, 'i').test(setClause));
    if (cols.length) out.push({ kind: 'upsert_content', cols, snippet: m[0].slice(0, 120).replace(/\s+/g, ' ') });
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
  return [...forbiddenUpdates(text), ...forbiddenUpserts(text), ...forbiddenDeletes(text)];
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
  for (const path of SCRIPT_FILES) {
    if (!existsSync(path)) continue;
    for (const hit of scanText(readFileSync(path, 'utf8'))) findings.push({ file: `scripts/${path.split('/').pop()}`, ...hit });
  }
  return findings;
}

function emitCalibration(findings) {
  // Mirror the MB-P gate-promotion-calibration shape so verify_gate_promotion_readiness can consume it.
  const row = {
    gate: 'verify-operation-events-append-only',
    phase: 'blocking_content_advisory_delete',
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
  const cleanUpsert = `INSERT INTO operation_events (id, summary) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING;`;
  const dirtyUpdate = `UPDATE operation_events SET content = 'edited', description = 'x' WHERE id=$1;`;
  const dirtyUpsert = `INSERT INTO operation_events (id, summary) VALUES ($1,$2) ON CONFLICT (id) DO UPDATE SET summary = EXCLUDED.summary;`;
  const dirtyDelete = `DELETE FROM operation_events WHERE id=$1;`;
  const cleanHits = scanText(`${clean}\n${cleanUpsert}`);
  const upHits = scanText(dirtyUpdate);
  const upsertHits = scanText(dirtyUpsert);
  const delHits = scanText(dirtyDelete);
  const ok = cleanHits.length === 0
    && upHits.some((hit) => hit.kind === 'update_content' && hit.cols.includes('content'))
    && upsertHits.some((hit) => hit.kind === 'upsert_content' && hit.cols.includes('summary'))
    && delHits.length >= 1;
  console.log('verify-operation-events-append-only --self-test');
  console.log(`  GREEN· clean (INSERT + status re-point) → 0 findings:   ${cleanHits.length === 0 ? 'PASS' : 'FAIL'}`);
  console.log(`  RED  · UPDATE …SET content → detected:                  ${upHits.length >= 1 ? 'PASS' : 'FAIL'}`);
  console.log(`  RED  · ON CONFLICT …DO UPDATE summary → detected:       ${upsertHits.length >= 1 ? 'PASS' : 'FAIL'}`);
  console.log(`  RED  · DELETE FROM operation_events → detected:         ${delHits.length >= 1 ? 'PASS' : 'FAIL'}`);
  console.log(`\n${ok ? '✓ self-test GREEN' : '✗ self-test RED'}`);
  process.exit(ok ? 0 : 1);
}

const findings = scanTree();
const blocking = findings.filter((finding) => finding.kind === 'update_content' || finding.kind === 'upsert_content');
const advisory = findings.filter((finding) => finding.kind === 'delete');
emitCalibration(findings);
console.log(`\nADR-XLOOP-IA-001 · operation_events content append-only (ENFORCED)`);
if (blocking.length === 0) {
  console.log('✓ no content-mutating UPDATE/upsert of operation_events');
} else {
  console.log(`✗ ${blocking.length} content mutation(s) violate append-only authority:`);
  for (const f of blocking.slice(0, 20)) console.log(`    [${f.kind} ${f.cols.join(',')}] ${f.file}: ${f.snippet}`);
}
if (advisory.length) {
  console.log(`⚠ ${advisory.length} DELETE/TRUNCATE candidate(s) require governed-purge review:`);
  for (const f of advisory.slice(0, 20)) console.log(`    [${f.kind}] ${f.file}: ${f.snippet}`);
}
process.exit(blocking.length === 0 ? 0 : 1);
