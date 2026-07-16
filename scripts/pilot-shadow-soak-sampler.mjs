#!/usr/bin/env node
// pilot-shadow-soak-sampler.mjs · appends one health/queue sample per invocation to the
// pilot-shadow soak evidence artifact consumed by verify-pilot-shadow-soak-rollback-evidence.mjs.
//
// The soak gate needs >=48h of samples, so evidence must ACCUMULATE across invocations: run this
// from a scheduler (launchd/cron) every N minutes for the soak window, then `--finalize` once the
// window closes. It never fabricates: each sample is a real HTTP readback of pilot-shadow /health
// plus (optionally) a real projection-queue query, and the file is append-only per sample.
//
//   XLOOOP_PILOT_SHADOW_SOAK_EVIDENCE_FILE=<path> node scripts/pilot-shadow-soak-sampler.mjs
//   ... --finalize            # stamp soak.ended_at/duration_hours + queue metrics and stop sampling
//   ... --rollback-json=<f>   # merge a recorded rollback rehearsal block (see --help)
//
// Boundary: pilot-shadow only. The sampler REFUSES a production API base, and it cannot mark
// production_cutover_authorized — that stays an operator decision outside this tool.

import fs from 'node:fs';
import path from 'node:path';

const API_BASE = process.env.XLOOOP_PILOT_SHADOW_API_BASE || 'https://xlooop-api-pilot-shadow.xlooop23.workers.dev';
const EVIDENCE_FILE = process.env.XLOOOP_PILOT_SHADOW_SOAK_EVIDENCE_FILE;
const OPERATOR = process.env.XLOOOP_SOAK_OPERATOR || 'marat';
const FINALIZE = process.argv.includes('--finalize');
const rollbackArg = process.argv.find((a) => a.startsWith('--rollback-json='));

if (process.argv.includes('--help')) {
  console.log('Usage: XLOOOP_PILOT_SHADOW_SOAK_EVIDENCE_FILE=<path> node scripts/pilot-shadow-soak-sampler.mjs [--finalize] [--rollback-json=<file>]');
  process.exit(0);
}
if (!EVIDENCE_FILE) {
  console.error('soak-sampler · OPERATOR-INPUT-REQUIRED — set XLOOOP_PILOT_SHADOW_SOAK_EVIDENCE_FILE to the accumulating evidence path.');
  process.exit(2);
}
// Fail closed on a production target: this sampler exists only to evidence pilot-shadow.
if (/api\.xlooop\.com/.test(API_BASE) || !/workers\.dev|pilot-shadow/.test(API_BASE)) {
  console.error(`soak-sampler · REFUSED — ${API_BASE} is not a pilot-shadow API base.`);
  process.exit(2);
}

function readEvidence() {
  if (!fs.existsSync(EVIDENCE_FILE)) {
    return {
      schema_id: 'xlooop.pilot_shadow_soak_rollback_evidence.v1',
      evidence_class: 'pilot_shadow_soak_rollback',
      environment: 'pilot-shadow',
      authority: 'shadow',
      api_base: API_BASE,
      frontend_origin: process.env.XLOOOP_PILOT_SHADOW_FRONTEND_ORIGIN || 'https://codex-pilot-shadow-evidence.xlooop-app-next.pages.dev',
      backend_build_sha: null,
      schema_head: null,
      contract_hash: null,
      generated_at: new Date().toISOString(),
      soak: { started_at: null, ended_at: null, duration_hours: null, production_untouched: true, operator: OPERATOR },
      health_samples: [],
      // metrics/queue stay null until --finalize supplies REAL measured values; the strict verifier
      // treats null as missing and fails closed, so an unfinalized window can never claim the gate.
      metrics: null,
      queue: null,
      rollback_rehearsal: null,
      production_cutover_authorized: false,
    };
  }
  return JSON.parse(fs.readFileSync(EVIDENCE_FILE, 'utf8'));
}

function writeEvidence(evidence) {
  fs.mkdirSync(path.dirname(EVIDENCE_FILE), { recursive: true });
  fs.writeFileSync(EVIDENCE_FILE, `${JSON.stringify(evidence, null, 2)}\n`);
}

async function readHealth() {
  const url = `${API_BASE}/api/v1/health?cb=soak-${Date.now()}`;
  const res = await fetch(url, { cache: 'no-store' });
  const body = await res.json();
  return { status: res.status, body };
}

const evidence = readEvidence();
const { status, body } = await readHealth();

// Pin identity on the first sample; a drifting build/schema mid-soak is a real finding, so record
// the sample as-is and let the strict verifier fail on the mismatch rather than silently repinning.
if (!evidence.backend_build_sha) {
  evidence.backend_build_sha = body.build;
  evidence.schema_head = Number(body.schema_head);
  evidence.contract_hash = body.contract_hash;
}
if (!evidence.soak.started_at) evidence.soak.started_at = new Date().toISOString();

evidence.health_samples.push({
  checked_at: new Date().toISOString(),
  status,
  build: body.build,
  schema_head: Number(body.schema_head),
  environment: body.environment,
  authority: body.authority,
  contract_hash: body.contract_hash,
  queue_bound: Boolean(body.bindings?.tenant_projection_queue),
});

if (rollbackArg) {
  const rollbackPath = rollbackArg.split('=').slice(1).join('=');
  evidence.rollback_rehearsal = JSON.parse(fs.readFileSync(rollbackPath, 'utf8'));
}

evidence.generated_at = new Date().toISOString();

if (FINALIZE) {
  const startedMs = Date.parse(evidence.soak.started_at);
  const endedAt = new Date().toISOString();
  evidence.soak.ended_at = endedAt;
  evidence.soak.duration_hours = Number(((Date.parse(endedAt) - startedMs) / 3.6e6).toFixed(4));
  // metrics/queue come from the operator's read-only DB + queue query at finalize time
  // (XLOOOP_SOAK_METRICS_JSON / XLOOOP_SOAK_QUEUE_JSON). The sampler will NOT invent them:
  // without those files the strict verifier fails on the missing fields, which is correct.
  if (process.env.XLOOOP_SOAK_METRICS_JSON) {
    evidence.metrics = JSON.parse(fs.readFileSync(process.env.XLOOOP_SOAK_METRICS_JSON, 'utf8'));
  }
  if (process.env.XLOOOP_SOAK_QUEUE_JSON) {
    evidence.queue = JSON.parse(fs.readFileSync(process.env.XLOOOP_SOAK_QUEUE_JSON, 'utf8'));
  }
}

writeEvidence(evidence);
const n = evidence.health_samples.length;
const last = evidence.health_samples[n - 1];
console.log(`soak-sampler · sample ${n} recorded · status=${last.status} build=${last.build?.slice(0, 12)} env=${last.environment}${FINALIZE ? ` · FINALIZED duration=${evidence.soak.duration_hours}h` : ''}`);
if (last.status !== 200 || last.environment !== 'pilot-shadow' || last.authority !== 'shadow') {
  console.error('soak-sampler · sample is NOT clean — the strict verifier will fail this window.');
  process.exit(1);
}
