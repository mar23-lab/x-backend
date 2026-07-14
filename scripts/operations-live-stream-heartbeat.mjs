#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

const args = new Set(process.argv.slice(2));
const once = args.has('--once');
const dryRun = args.has('--dry-run');
const maxRuns = Number(valueFor('--max-runs') || (once || dryRun ? 1 : 0));
const intervalSeconds = Math.max(60, Number(valueFor('--interval-seconds') || process.env.XLOOOP_OPERATIONS_FRESHNESS_HEARTBEAT_SECONDS || 600));
const jitterSeconds = Math.max(0, Number(valueFor('--jitter-seconds') || process.env.XLOOOP_OPERATIONS_FRESHNESS_HEARTBEAT_JITTER_SECONDS || 0));

if (process.env.XCP_DISABLE_OPERATIONS_FRESHNESS_HEARTBEAT === '1') {
  emit({ status: 'SKIPPED', reason: 'XCP_DISABLE_OPERATIONS_FRESHNESS_HEARTBEAT=1' });
  process.exit(0);
}

let runCount = 0;
do {
  runCount += 1;
  const result = dryRun ? dryRunResult() : spawnSync('npm', ['run', 'ensure:operations-live-stream-fresh'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
    env: process.env,
  });
  const ok = result.status === 0;
  emit({
    status: ok ? 'PASS' : 'FAIL',
    run_count: runCount,
    command: dryRun ? 'npm run ensure:operations-live-stream-fresh (dry-run)' : 'npm run ensure:operations-live-stream-fresh',
    interval_seconds: intervalSeconds,
    stdout_tail: tail(result.stdout),
    stderr_tail: tail(result.stderr),
  });
  if (!ok || once || dryRun || (maxRuns && runCount >= maxRuns)) {
    process.exit(ok ? 0 : 1);
  }
  await sleep((intervalSeconds + jitter()) * 1000);
} while (true);

function valueFor(name) {
  const arg = process.argv.slice(2).find((item) => item === name || item.startsWith(`${name}=`));
  if (!arg) return '';
  return arg.includes('=') ? arg.split('=').slice(1).join('=') : 'true';
}

function jitter() {
  if (!jitterSeconds) return 0;
  return Math.floor(Math.random() * (jitterSeconds + 1));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function dryRunResult() {
  return {
    status: 0,
    stdout: JSON.stringify({
      schema_version: 'xlooop.operations_live_stream_heartbeat.v1',
      status: 'DRY_RUN',
      would_run: 'npm run ensure:operations-live-stream-fresh',
    }),
    stderr: '',
  };
}

function tail(value) {
  return String(value || '').trim().split('\n').filter(Boolean).slice(-10);
}

function emit(payload) {
  console.log(JSON.stringify({
    schema_version: 'xlooop.operations_live_stream_heartbeat.v1',
    generated_at: new Date().toISOString(),
    ...payload,
  }, null, 2));
}
