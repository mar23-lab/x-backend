#!/usr/bin/env node
// pilot-shadow-soak-sampler.mjs · appends one health/queue sample per invocation to the
// pilot-shadow soak evidence artifact consumed by verify-pilot-shadow-soak-rollback-evidence.mjs.
//
// The soak gate needs >=48h of samples, so evidence must ACCUMULATE across invocations: run this
// from a scheduler (launchd/cron) every N minutes for the soak window, then `--finalize` once the
// window closes. It never fabricates: each sample is a real HTTP readback of pilot-shadow /health
// plus (optionally) a real projection-queue query, and the file is append-only per sample.
//
//   XLOOOP_PILOT_SHADOW_SOAK_ROLLBACK_EVIDENCE_FILE=<path> node scripts/pilot-shadow-soak-sampler.mjs
//   # legacy alias also accepted: XLOOOP_PILOT_SHADOW_SOAK_EVIDENCE_FILE=<path>
//   ... --finalize            # stamp soak.ended_at/duration_hours + queue metrics and stop sampling
//   ... --rollback-json=<f>   # merge a recorded rollback rehearsal block (see --help)
//
// Boundary: pilot-shadow only. The sampler REFUSES a production API base, and it cannot mark
// production_cutover_authorized — that stays an operator decision outside this tool.

import fs from 'node:fs';
import path from 'node:path';

const API_BASE = process.env.XLOOOP_PILOT_SHADOW_API_BASE || 'https://xlooop-api-pilot-shadow.xlooop23.workers.dev';
const EVIDENCE_FILE = chooseEvidenceFile(process.env);
const OPERATOR = process.env.XLOOOP_SOAK_OPERATOR || 'marat';
const RUN_ID = process.env.XLOOOP_SOAK_RUN_ID || `soak-${new Date().toISOString().replace(/[^0-9TZ]/g, '')}`;
const FINALIZE = process.argv.includes('--finalize');
const SELF_TEST = process.argv.includes('--self-test');
const rollbackArg = process.argv.find((a) => a.startsWith('--rollback-json='));

if (process.argv.includes('--help')) {
  console.log('Usage: XLOOOP_PILOT_SHADOW_SOAK_ROLLBACK_EVIDENCE_FILE=<path> node scripts/pilot-shadow-soak-sampler.mjs [--finalize] [--rollback-json=<file>]');
  process.exit(0);
}
if (SELF_TEST) {
  runSelfTest();
  process.exit(0);
}
if (!EVIDENCE_FILE) {
  console.error('soak-sampler · OPERATOR-INPUT-REQUIRED — set XLOOOP_PILOT_SHADOW_SOAK_ROLLBACK_EVIDENCE_FILE to the accumulating evidence path.');
  process.exit(2);
}
// Fail closed on a production target: this sampler exists only to evidence pilot-shadow.
if (!isPilotShadowApiBase(API_BASE)) {
  console.error(`soak-sampler · REFUSED — ${API_BASE} is not a pilot-shadow API base.`);
  process.exit(2);
}

function chooseEvidenceFile(env) {
  return env.XLOOOP_PILOT_SHADOW_SOAK_ROLLBACK_EVIDENCE_FILE || env.XLOOOP_PILOT_SHADOW_SOAK_EVIDENCE_FILE;
}

function isPilotShadowApiBase(apiBase) {
  return !/api\.xlooop\.com/.test(apiBase) && /workers\.dev|pilot-shadow/.test(apiBase);
}

function readEvidence() {
  if (!fs.existsSync(EVIDENCE_FILE)) {
    return {
      schema_id: 'xlooop.pilot_shadow_soak_rollback_evidence.v1',
      evidence_class: 'pilot_shadow_soak_rollback',
      environment: 'pilot-shadow',
      authority: 'shadow',
      api_base: API_BASE,
      frontend_origin: process.env.XLOOOP_PILOT_SHADOW_FRONTEND_ORIGIN || 'https://test.xlooop.com',
      backend_build_sha: null,
      schema_head: null,
      contract_hash: null,
      generated_at: new Date().toISOString(),
      producer: {
        name: 'x-backend.pilot-shadow-soak-sampler',
        version: 'v1',
        kind: 'accumulated_live_capture',
        run_id: RUN_ID,
        started_at: new Date().toISOString(),
        last_sample_at: null,
        finalized_at: null,
        nonproduction_origin_verified: true,
        pilot_shadow_api_verified: true,
        manual: false,
        synthetic: false,
      },
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

// 260728 — THIS USED TO THROW, AND A THROW DELETED THE EVIDENCE OF THE OUTAGE.
//
// readHealth() had no try/catch. An unreachable API raised an unhandled rejection, killed the
// launchd process, and the failed probe was NEVER APPENDED. Measured on run soak-f9f2083-20260728:
// launchd runs=11 vs samples=5 (45% capture), a 180-minute hole between 02:13Z and 05:13Z, and 5
// uncaught `getaddrinfo ENOTFOUND` stanzas in the .err.log. Because only successful probes
// survived, the completion gate `health_samples.every(s => s.status === 200)` was STRUCTURALLY
// INCAPABLE of ever observing downtime — it would have certified 100% availability across a window
// that actually lost half its probes. A number that cannot be false is not evidence.
//
// A failed probe is now a RECORDED SAMPLE with status 0, so the gate can see it and fail.
async function readHealth() {
  const url = `${API_BASE}/api/v1/health?cb=soak-${Date.now()}`;
  try {
    const res = await fetch(url, { cache: 'no-store' });
    let body = {};
    try {
      body = await res.json();
    } catch (parseErr) {
      return { status: res.status, body: {}, error: `non-JSON body: ${parseErr.message}` };
    }
    return { status: res.status, body };
  } catch (err) {
    return { status: 0, body: {}, error: `${err.code || err.name || 'fetch_failed'}: ${err.message}` };
  }
}

// 260728 — THE SOAK NEVER LOOKED AT THE FRONTEND, WHICH IS THE THING THAT WAS BROKEN.
//
// `frontend_origin` was recorded in the evidence header and never fetched; the only fetch in this
// file was the API. The rollback verifier's `frontend_origin_is_nonproduction_pages` check is a
// hostname STRING test with no network call. So the 48h gate could complete fully GREEN on
// 2026-07-30 while every authenticated pilot tester saw "Workspace unavailable" — which is exactly
// what was happening: test.xlooop.com had been dead for 42+ hours on a handshake mismatch.
//
// The pilot frontend sits behind Cloudflare Access, so an unauthenticated probe legitimately gets a
// 302 to the Access login. That is NOT treated as a failure — it is recorded as `access_gated`, an
// honest "reachable but not inspectable from here". What IS captured, when the body is readable, is
// the compiled __XLOOP_EXPECTED_BACKEND_SHA, because a frontend expecting a different SHA than the
// API reports is the precise failure this soak exists to catch and was blind to.
async function readFrontend() {
  const origin = (process.env.XLOOOP_PILOT_SHADOW_FRONTEND_ORIGIN || 'https://test.xlooop.com').replace(/\/$/, '');
  try {
    const res = await fetch(`${origin}/?cb=soak-${Date.now()}`, { cache: 'no-store', redirect: 'manual' });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location') || '';
      return { status: res.status, access_gated: /cloudflareaccess\.com/.test(loc), expected_backend_sha: null };
    }
    const html = await res.text();
    const m = html.match(/__XLOOP_EXPECTED_BACKEND_SHA\s*=\s*"([0-9a-f]{40})"/);
    return { status: res.status, access_gated: false, expected_backend_sha: m ? m[1] : null };
  } catch (err) {
    return { status: 0, access_gated: false, expected_backend_sha: null, error: `${err.code || err.name || 'fetch_failed'}: ${err.message}` };
  }
}

const evidence = readEvidence();
if (!evidence.producer || typeof evidence.producer !== 'object') {
  evidence.producer = {
    name: 'x-backend.pilot-shadow-soak-sampler',
    version: 'v1',
    kind: 'accumulated_live_capture',
    run_id: RUN_ID,
    started_at: new Date().toISOString(),
    last_sample_at: null,
    finalized_at: null,
    nonproduction_origin_verified: true,
    pilot_shadow_api_verified: true,
    manual: false,
    synthetic: false,
  };
}
const { status, body, error: healthError } = await readHealth();
const frontend = await readFrontend();

// Pin identity on the first sample; a drifting build/schema mid-soak is a real finding, so record
// the sample as-is and let the strict verifier fail on the mismatch rather than silently repinning.
// Guarded so a FAILED probe (status 0, empty body) can never pin nulls as the soak's identity.
if (status === 200 && body.build && !evidence.backend_build_sha) {
  evidence.backend_build_sha = body.build;
  evidence.schema_head = Number(body.schema_head);
  evidence.contract_hash = body.contract_hash;
}
if (!evidence.soak.started_at) evidence.soak.started_at = new Date().toISOString();

evidence.health_samples.push({
  checked_at: new Date().toISOString(),
  status,
  // `error` is present ONLY on a failed probe. Its presence is the signal the completion gate
  // needs: previously a failed probe killed the process and left no trace at all.
  ...(healthError ? { error: healthError } : {}),
  build: body.build ?? null,
  schema_head: body.schema_head === undefined ? null : Number(body.schema_head),
  environment: body.environment ?? null,
  authority: body.authority ?? null,
  contract_hash: body.contract_hash ?? null,
  queue_bound: Boolean(body.bindings?.tenant_projection_queue),
  // The frontend half of the pair. `frontend_pair_ok` is the invariant the pilot outage violated:
  // the compiled __XLOOP_EXPECTED_BACKEND_SHA must equal the SHA the API reports. null means
  // "not determinable from here" (Access-gated or unreadable) — deliberately NOT false, so an
  // unreadable frontend never masquerades as a proven-good one.
  frontend: {
    status: frontend.status,
    access_gated: frontend.access_gated,
    expected_backend_sha: frontend.expected_backend_sha,
    ...(frontend.error ? { error: frontend.error } : {}),
  },
  frontend_pair_ok:
    frontend.expected_backend_sha && body.build
      ? frontend.expected_backend_sha === body.build
      : null,
});

if (rollbackArg) {
  const rollbackPath = rollbackArg.split('=').slice(1).join('=');
  evidence.rollback_rehearsal = JSON.parse(fs.readFileSync(rollbackPath, 'utf8'));
}

evidence.generated_at = new Date().toISOString();
evidence.producer.last_sample_at = evidence.generated_at;

if (FINALIZE) {
  const startedMs = Date.parse(evidence.soak.started_at);
  const endedAt = new Date().toISOString();
  evidence.soak.ended_at = endedAt;
  evidence.soak.duration_hours = Number(((Date.parse(endedAt) - startedMs) / 3.6e6).toFixed(4));
  evidence.producer.finalized_at = endedAt;
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

function runSelfTest() {
  const canonical = chooseEvidenceFile({
    XLOOOP_PILOT_SHADOW_SOAK_ROLLBACK_EVIDENCE_FILE: '/tmp/canonical.json',
    XLOOOP_PILOT_SHADOW_SOAK_EVIDENCE_FILE: '/tmp/legacy.json',
  }) === '/tmp/canonical.json';
  const legacy = chooseEvidenceFile({
    XLOOOP_PILOT_SHADOW_SOAK_EVIDENCE_FILE: '/tmp/legacy.json',
  }) === '/tmp/legacy.json';
  const prodRejected = !isPilotShadowApiBase('https://api.xlooop.com');
  const pilotAccepted = isPilotShadowApiBase('https://xlooop-api-pilot-shadow.xlooop23.workers.dev');
  if (!canonical || !legacy || !prodRejected || !pilotAccepted) {
    console.error(JSON.stringify({ canonical, legacy, prodRejected, pilotAccepted }, null, 2));
    throw new Error('self-test failed');
  }
  console.log('PASS pilot-shadow soak sampler self-test');
}
