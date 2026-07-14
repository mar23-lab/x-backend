#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoReadOnlyVerificationLock } from './lib/generated-artifact-lock.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const args = new Set(process.argv.slice(2));
const checkOnly = args.has('--check');
const readOnly = process.env.XCP_VERIFY_READONLY === '1';
const streamPath = path.join(repoRoot, 'data', 'operations-live-stream.json');
const leaseStartedAt = new Date();
const MIN_COMMERCIAL_RUN_LEASE_SECONDS = 30 * 60;

const before = summarizeStream();
const initial = run('npm', ['run', 'verify:operations-live-stream-contract'], { capture: true });

if (initial.ok) {
  pass({ refreshed: false, before, after: summarizeStream() });
}

if (checkOnly) {
  fail('OperationsLiveStream freshness failed and --check forbids refresh', {
    before,
    verifier: tail(initial),
    blocker_id: 'stale_needs_refresh',
    renewal_command: 'npm run ensure:operations-live-stream-fresh',
  });
}

if (readOnly) {
  fail('OperationsLiveStream freshness failed and XCP_VERIFY_READONLY forbids refresh', {
    before,
    verifier: tail(initial),
    blocker_id: 'stale_needs_preflight_before_readonly_verification',
    renewal_command: 'npm run commercial:preflight',
  });
}

assertNoReadOnlyVerificationLock('ensure-operations-live-stream-fresh');

const poll = run('npm', ['run', 'poll:mbp-operations-live-stream']);
if (!poll.ok) {
  fail('OperationsLiveStream poll/refresh failed', { before, poll: tail(poll) });
}

const final = run('npm', ['run', 'verify:operations-live-stream-contract'], { capture: true });
if (!final.ok) {
  fail('OperationsLiveStream freshness still fails after refresh', { before, after: summarizeStream(), verifier: tail(final) });
}

pass({ refreshed: true, before, after: summarizeStream() });

function summarizeStream() {
  if (!fs.existsSync(streamPath)) {
    return {
      status: 'missing',
      path: path.relative(repoRoot, streamPath),
      last_successful_poll_at: null,
      age_seconds: null,
      sla_seconds: null,
      source_adapter: null,
      receipt_id: null,
    };
  }
  const stream = JSON.parse(fs.readFileSync(streamPath, 'utf8'));
  const lastPoll = stream.gateway_poll_sla?.last_successful_poll_at || null;
  const lastPollMs = Date.parse(lastPoll || '');
  const ageSeconds = Number.isFinite(lastPollMs) ? Math.max(0, Math.round((Date.now() - lastPollMs) / 1000)) : null;
  const slaSeconds = Number(stream.gateway_poll_sla?.stale_after_seconds || 0) || null;
  const status = stream.gateway_poll_sla?.state === 'green' && ageSeconds !== null && slaSeconds !== null && ageSeconds <= slaSeconds
    ? 'fresh'
    : 'stale_or_invalid';
  return {
    status,
    last_successful_poll_at: lastPoll,
    age_seconds: ageSeconds,
    sla_seconds: slaSeconds,
    source_adapter: stream.authoritative_receipt_ingestion?.source_adapter || null,
    receipt_id: stream.stream_id || stream.authoritative_receipt_ingestion?.receipt_id || null,
    rows: Array.isArray(stream.rows) ? stream.rows.length : 0,
    coverage_percent: stream.required_source_coverage?.coverage_percent ?? null,
  };
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    shell: false,
    env: process.env,
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error ? String(result.error.message || result.error) : null,
  };
}

function tail(result) {
  return [
    result.error,
    result.stdout,
    result.stderr,
  ].filter(Boolean).join('\n').trim().split('\n').slice(-12).join('\n');
}

function pass(details) {
  const after = details.after || summarizeStream();
  console.log(JSON.stringify({
    schema_version: 'xlooop.operations_live_stream_freshness_receipt.v1',
    status: 'PASS',
    generated_at: new Date().toISOString(),
    lease_started_at: leaseStartedAt.toISOString(),
    lease_expires_at: leaseExpiresAt(after),
    last_checked_at: new Date().toISOString(),
    age_seconds: after.age_seconds,
    sla_seconds: after.sla_seconds,
    refresh_attempted: details.refreshed === true,
    source_adapter: after.source_adapter,
    receipt_id: after.receipt_id,
    ...details,
  }, null, 2));
  process.exit(0);
}

function fail(message, details = {}) {
  const after = details.after || summarizeStream();
  console.error(JSON.stringify({
    schema_version: 'xlooop.operations_live_stream_freshness_receipt.v1',
    status: 'FAIL',
    generated_at: new Date().toISOString(),
    lease_started_at: leaseStartedAt.toISOString(),
    lease_expires_at: leaseExpiresAt(after),
    last_checked_at: new Date().toISOString(),
    age_seconds: after.age_seconds,
    sla_seconds: after.sla_seconds,
    refresh_attempted: details.poll ? true : false,
    source_adapter: after.source_adapter,
    receipt_id: after.receipt_id,
    message,
    ...details,
  }, null, 2));
  process.exit(1);
}

function leaseExpiresAt(stream) {
  const streamSlaSeconds = Number(stream.sla_seconds || 900);
  const gateP95Seconds = Number(process.env.XCP_COMMERCIAL_GATE_P95_SECONDS || 0);
  const leaseSeconds = Math.max(
    Number(process.env.XCP_OPERATIONS_FRESHNESS_LEASE_SECONDS || 0),
    streamSlaSeconds,
    MIN_COMMERCIAL_RUN_LEASE_SECONDS,
    gateP95Seconds > 0 ? gateP95Seconds + 5 * 60 : 0,
  );
  const lastPollMs = Date.parse(stream.last_successful_poll_at || '');
  const baseMs = stream.status === 'fresh'
    ? leaseStartedAt.getTime()
    : (Number.isFinite(lastPollMs) ? lastPollMs : leaseStartedAt.getTime());
  return new Date(baseMs + leaseSeconds * 1000).toISOString();
}
