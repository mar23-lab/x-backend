#!/usr/bin/env node
// verify-frontend-pair-before-api-deploy.mjs · the frontend-pairing deploy gate (260728).
//
// FAILURE CLASS: app.xlooop.com COMPILES the backend sha it expects into its bundle, and
// wired/live-data.js pins it by exact 40-char equality:
//
//     if (health.build !== window.__XLOOP_EXPECTED_BACKEND_SHA)
//       return { ok: false, reason: 'backend build mismatch' };
//
// So a backend deploy that is not accompanied by a Pages rebuild does not degrade a feature —
// it puts EVERY authenticated user on "Workspace unavailable". Measured on 260728: none of the
// nine `deploy:api` preflights referenced app.xlooop.com at all, so nothing in the chain could
// see the frontend it was about to strand. It fired for real on the pilot on 260728 and
// production carried the identical exposure.
//
// This gate closes it: before `wrangler deploy` it READS THE LIVE FRONTEND and refuses unless
// the sha it is about to ship is a sha the live frontend already accepts.
//
// WHY THIS SITS BEFORE consume-api-deployment-authorization.mjs (not after):
// that step RESERVES the operator's one-shot deployment authorization ("a failed or interrupted
// deploy attempt requires a new operator authorization"). A gate that fires after it would burn
// a time-boxed operator approval on a refusal it could have made a moment earlier. So this is
// the LAST NON-CONSUMING preflight — as late as possible, still free to say no.
//
// PASSES on exactly two states:
//   1. the live frontend's __XLOOP_EXPECTED_BACKEND_SHA already equals the sha being deployed
//      (the normal case: the paired Pages release shipped first, or nothing changed); or
//   2. the authority decision packet carries a `paired_frontend_release` block naming a
//      LOCALLY ASSEMBLED release artifact whose own compiled backend sha equals it — i.e. the
//      operator is mid-cutover and the replacement frontend already exists on disk.
//
// FAILS CLOSED on fetch error, non-2xx, timeout, and unparseable HTML. "Could not check" must
// never read as "safe to deploy": that inversion is the false-zero class this estate keeps
// paying for, and it is exactly how a gate that exists still lets the outage through.
//
// Deliberate exception (paired cutover where Pages genuinely cannot go first):
//   XLOOOP_FRONTEND_PAIR_OVERRIDE=1 plus a non-empty XLOOOP_FRONTEND_PAIR_OVERRIDE_REASON.
// It prints a full-width banner and writes a durable waiver receipt into the git common dir,
// so "who stranded the frontend, when, and why" is answerable from an artifact. It is not
// silent and it is not free.
//
// Self-test: `node scripts/verify-frontend-pair-before-api-deploy.mjs --self-test` spawns this
// file as a CHILD PROCESS against a loopback fixture server and asserts REAL exit codes for
// mismatch / unreachable / unparseable / timeout / paired-release / override. A gate nobody has
// watched go red is not a gate.
//
// Note on markers: this reuses the exported parseFrontendReleaseHtml() /
// parseFrontendReleaseArtifact() from lib/app-pages-release-contract.mjs rather than growing a
// second parser for the same markers. That parser exposes backend_sha, frontend_sha and
// schema_head; __XLOOP_EXPECTED_CONTRACT_HASH is deliberately left alone here because widening
// the shared parser would change what every other consumer of it requires to be present.

import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SHA_PATTERN,
  parseFrontendReleaseArtifact,
  parseFrontendReleaseHtml,
} from './lib/app-pages-release-contract.mjs';

const selfPath = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(selfPath), '..');
const GATE = 'frontend-pair-before-api-deploy';
const PRODUCTION_FRONTEND_URL = 'https://app.xlooop.com/';
const DEFAULT_TIMEOUT_MS = 15_000;

// Test seams are honoured ONLY in a self-test child. A real deploy cannot redirect this gate at
// a friendlier server or shorten its patience, because neither seam opens without this marker.
const selfTestChild = process.env.XLOOOP_FRONTEND_PAIR_SELF_TEST_CHILD === '1';

function fail(message, ...detail) {
  console.error(`✗ ${GATE} · FAIL-CLOSED — ${message}`);
  for (const line of detail) console.error(`    ${line}`);
  process.exit(1);
}

function frontendUrl() {
  const raw = process.env.XLOOOP_FRONTEND_PAIR_URL;
  if (!raw) return PRODUCTION_FRONTEND_URL;
  if (!selfTestChild) {
    fail(
      'XLOOOP_FRONTEND_PAIR_URL is a self-test seam and is refused during a real deploy.',
      'The gate checks the production frontend or it checks nothing.',
    );
  }
  const parsed = new URL(raw);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) {
    fail(`self-test frontend url must be loopback, got ${parsed.hostname}`);
  }
  return raw;
}

function timeoutMs() {
  const raw = process.env.XLOOOP_FRONTEND_PAIR_TIMEOUT_MS;
  if (!raw || !selfTestChild) return DEFAULT_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
}

/** Durable waiver receipt, written to the git COMMON dir so every worktree observes it. */
function writeWaiverReceipt(fields) {
  try {
    const commonDir = execFileSync(
      'git',
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      { cwd: root, encoding: 'utf8', timeout: 30_000 },
    ).trim();
    const dir = path.join(commonDir, 'xlooop-frontend-pair-waivers');
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(dir, `${stamp}-${(fields.deploying_sha || 'unknown').slice(0, 12)}.json`);
    writeFileSync(file, `${JSON.stringify({
      schema_id: 'xlooop.frontend_pair_waiver.v1',
      waived_gate: GATE,
      ...fields,
    }, null, 2)}\n`);
    return file;
  } catch (error) {
    return `UNWRITABLE:${error instanceof Error ? error.message : String(error)}`;
  }
}

function banner(lines) {
  const bar = '='.repeat(78);
  console.log(bar);
  for (const line of lines) console.log(line);
  console.log(bar);
}

/** Read the LIVE frontend. Throws on transport, status, timeout and marker problems alike. */
async function observeLiveFrontend(url) {
  const target = new URL(url);
  // Nonce + no-store: a cached edge response would let us certify a frontend that is no longer
  // being served. CF Pages caches aggressively; this gate must observe, not remember.
  target.searchParams.set('xlooop_pair_check', `${Date.now().toString(36)}-${randomUUID()}`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs());
  try {
    const response = await fetch(target, {
      cache: 'no-store',
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'cache-control': 'no-cache', pragma: 'no-cache' },
    });
    if (!response.ok) throw new Error(`frontend responded HTTP ${response.status}`);
    return parseFrontendReleaseHtml(await response.text());
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`timed out after ${timeoutMs()}ms`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The one legitimate way past a live mismatch: the authority packet names a paired release that
 * ALREADY EXISTS ON DISK and is itself compiled against the sha being deployed. The packet's own
 * claim is not enough — the assembled artifact is opened and its compiled marker is read.
 */
function assessPairedFrontendRelease(deployingSha) {
  const packetPath = process.env.XLOOOP_AUTHORITY_DECISION_PACKET;
  if (!packetPath) return { ok: false, reason: 'XLOOOP_AUTHORITY_DECISION_PACKET is not set' };

  let packet;
  try {
    packet = JSON.parse(readFileSync(path.resolve(root, packetPath), 'utf8'));
  } catch (error) {
    return { ok: false, reason: `authority packet unreadable: ${error instanceof Error ? error.message : String(error)}` };
  }

  const block = packet?.paired_frontend_release;
  if (!block || typeof block !== 'object' || Array.isArray(block)) {
    return { ok: false, reason: 'authority packet carries no paired_frontend_release block' };
  }
  if (typeof block.artifact_dir !== 'string' || block.artifact_dir.trim() === '') {
    return { ok: false, reason: 'paired_frontend_release.artifact_dir is missing' };
  }
  if (!SHA_PATTERN.test(block.backend_sha || '')) {
    return { ok: false, reason: 'paired_frontend_release.backend_sha is not a 40-char sha' };
  }
  if (block.backend_sha !== deployingSha) {
    return {
      ok: false,
      reason: `paired_frontend_release.backend_sha ${block.backend_sha.slice(0, 12)} != deploying sha ${deployingSha.slice(0, 12)}`,
    };
  }

  const artifactDir = path.resolve(root, block.artifact_dir);
  let assembled;
  try {
    assembled = parseFrontendReleaseArtifact(artifactDir);
  } catch (error) {
    return { ok: false, reason: `paired release artifact unusable at ${artifactDir}: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (assembled.backend_sha !== deployingSha) {
    return {
      ok: false,
      reason: `assembled release at ${artifactDir} is compiled against ${String(assembled.backend_sha).slice(0, 12)}, not ${deployingSha.slice(0, 12)}`,
    };
  }
  if (!SHA_PATTERN.test(assembled.frontend_sha || '')) {
    return { ok: false, reason: `assembled release at ${artifactDir} has no valid frontend_sha` };
  }
  return { ok: true, artifactDir, assembled };
}

async function main() {
  let deployingSha;
  try {
    deployingSha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root, encoding: 'utf8', timeout: 30_000,
    }).trim();
  } catch (error) {
    fail(`could not resolve the sha being deployed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!SHA_PATTERN.test(deployingSha)) fail(`git HEAD is not a 40-char sha: ${deployingSha}`);

  const url = frontendUrl();

  // ---- LOUD, AUDITED OVERRIDE ------------------------------------------------------------
  if (process.env.XLOOOP_FRONTEND_PAIR_OVERRIDE === '1') {
    const reason = (process.env.XLOOOP_FRONTEND_PAIR_OVERRIDE_REASON || '').trim();
    if (!reason) {
      fail(
        'OVERRIDE REFUSED — XLOOOP_FRONTEND_PAIR_OVERRIDE=1 requires a reason.',
        'Set XLOOOP_FRONTEND_PAIR_OVERRIDE_REASON="<why the live frontend may be stranded>".',
        'An override with no recorded reason cannot be audited, so it is not permitted.',
      );
    }
    let observed = null;
    let observeError = null;
    try {
      observed = await observeLiveFrontend(url);
    } catch (error) {
      observeError = error instanceof Error ? error.message : String(error);
    }
    const stranding = observed ? observed.backend_sha !== deployingSha : null;
    const receipt = writeWaiverReceipt({
      deploying_sha: deployingSha,
      frontend_url: url,
      live_expected_backend_sha: observed?.backend_sha ?? null,
      live_frontend_sha: observed?.frontend_sha ?? null,
      observation_error: observeError,
      frontend_will_be_stranded: stranding,
      reason,
      waived_at: new Date().toISOString(),
      consequence: stranding === false
        ? 'live frontend already accepts this sha; override was not needed'
        : 'EVERY AUTHENTICATED USER SEES "Workspace unavailable" UNTIL THE PAIRED PAGES RELEASE SHIPS',
    });
    banner([
      '⚠  FRONTEND PAIRING GATE OVERRIDDEN — THIS CAN BLACK OUT EVERY AUTHENTICATED USER  ⚠',
      `   deploying sha      : ${deployingSha}`,
      `   live frontend wants: ${observed?.backend_sha ?? `UNKNOWN (${observeError})`}`,
      `   stranding frontend : ${stranding === null ? 'UNKNOWN' : String(stranding).toUpperCase()}`,
      `   reason             : ${reason}`,
      `   waiver receipt     : ${receipt}`,
      '   YOU MUST SHIP THE PAIRED app.xlooop.com RELEASE IMMEDIATELY AFTER THIS DEPLOY.',
    ]);
    process.exit(0);
  }

  // ---- OBSERVE THE LIVE FRONTEND (fail-closed) -------------------------------------------
  let live;
  try {
    live = await observeLiveFrontend(url);
  } catch (error) {
    fail(
      `could not read the live frontend at ${url}: ${error instanceof Error ? error.message : String(error)}`,
      'This is NOT a pass. An unreadable frontend means the pairing is UNKNOWN, and an unknown',
      'pairing is how every authenticated user ends up on "Workspace unavailable".',
      'Fix the network/frontend and retry, or take the audited exception:',
      '  XLOOOP_FRONTEND_PAIR_OVERRIDE=1 XLOOOP_FRONTEND_PAIR_OVERRIDE_REASON="..." npm run deploy:api',
    );
  }

  if (live.backend_sha === deployingSha) {
    console.log(`☑ ${GATE} · PASS · live app.xlooop.com already expects ${deployingSha.slice(0, 12)}`);
    console.log(`    frontend sha : ${String(live.frontend_sha).slice(0, 12)}  schema_head: ${String(live.schema_head)}`);
    process.exit(0);
  }

  // ---- MISMATCH: only a real, on-disk paired release answers it ---------------------------
  const paired = assessPairedFrontendRelease(deployingSha);
  if (paired.ok) {
    const receipt = writeWaiverReceipt({
      deploying_sha: deployingSha,
      frontend_url: url,
      live_expected_backend_sha: live.backend_sha,
      paired_release_dir: paired.artifactDir,
      paired_release_frontend_sha: paired.assembled.frontend_sha,
      accepted_via: 'authority_packet.paired_frontend_release',
      waived_at: new Date().toISOString(),
      consequence: 'API leads Pages inside a cutover window; users are stranded until the paired release is published',
    });
    banner([
      `⚠  PAIRED CUTOVER — app.xlooop.com does NOT yet accept ${deployingSha.slice(0, 12)}`,
      `   live frontend wants : ${live.backend_sha}`,
      `   paired release      : ${paired.artifactDir}`,
      `   paired frontend sha : ${paired.assembled.frontend_sha}`,
      `   receipt             : ${receipt}`,
      '   Authenticated users are stranded from this deploy until that release is published.',
      '   SHIP IT IN THE SAME WINDOW.',
    ]);
    process.exit(0);
  }

  fail(
    'the live frontend does not accept the sha you are about to deploy.',
    `deploying sha       : ${deployingSha}`,
    `app.xlooop.com wants: ${live.backend_sha}`,
    `live frontend sha   : ${live.frontend_sha}`,
    '',
    'wired/live-data.js compares these by EXACT equality. Deploying now puts EVERY',
    'authenticated user on "Workspace unavailable" until the paired Pages release ships.',
    '',
    `paired-release escape not available: ${paired.reason}`,
    '',
    'Fix, in order of preference:',
    '  1. Build and deploy the paired app.xlooop.com release FIRST, then re-run this deploy.',
    '  2. Assemble the paired release locally and name it in the authority decision packet:',
    '       "paired_frontend_release": { "artifact_dir": "<dir>", "backend_sha": "<deploying sha>" }',
    '  3. Audited exception, only for a genuine API-then-Pages cutover window:',
    '       XLOOOP_FRONTEND_PAIR_OVERRIDE=1 XLOOOP_FRONTEND_PAIR_OVERRIDE_REASON="..." npm run deploy:api',
  );
}

// -------------------------------------------------------------------------------------------
// SELF-TEST — spawns this file as a child process and observes REAL exit codes.
// -------------------------------------------------------------------------------------------

function fixtureHtml({ backendSha, frontendSha = 'a'.repeat(40) }) {
  return [
    '<!doctype html><html><head><script>',
    'window.__XLOOP_BUILD_MODE="production";',
    'window.__XLOOP_REQUIRE_CONTRACT_HANDSHAKE=true;',
    'window.__XLOOP_API_BASE="https://api.xlooop.com";',
    `window.__XLOOP_FRONTEND_SHA="${frontendSha}";`,
    `window.__XLOOP_EXPECTED_BACKEND_SHA="${backendSha}";`,
    'window.__XLOOP_EXPECTED_SCHEMA_HEAD=91;',
    'window.__XLOOP_EXPECTED_ENVIRONMENT="production";',
    'window.__XLOOP_EXPECTED_AUTHORITY="production";',
    'window.__XLOOP_EXPECTED_FEATURE_POSTURE={"single_intake":true,"role_skill_catalog":true,'
      + '"context_packet_persistence":true,"chat_history_persistence_required":true,'
      + '"tenant_projection_queue":false,"current_work_projection":false};',
    '</script></head><body></body></html>',
  ].join('\n');
}

/**
 * Runs the gate as a real child process and resolves its REAL exit code.
 *
 * Deliberately spawn(), not spawnSync(): the fixture HTTP server lives in THIS process, and a
 * synchronous spawn blocks this event loop, so the server can never answer the child. That
 * mistake makes every refusal control go green for the wrong reason — the child times out
 * instead of refusing — which is precisely the false-green this gate exists to stamp out.
 */
function runGateChild(env) {
  const childEnv = { ...process.env, XLOOOP_FRONTEND_PAIR_SELF_TEST_CHILD: '1' };
  for (const key of [
    'XLOOOP_FRONTEND_PAIR_OVERRIDE',
    'XLOOOP_FRONTEND_PAIR_OVERRIDE_REASON',
    'XLOOOP_FRONTEND_PAIR_TIMEOUT_MS',
    'XLOOOP_AUTHORITY_DECISION_PACKET',
  ]) delete childEnv[key];
  Object.assign(childEnv, env);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [selfPath], { cwd: root, env: childEnv });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { out += chunk; });
    // A signalled or un-spawnable child has a null code; that is a self-test failure, not a pass.
    child.on('close', (code, signal) => resolve({ status: code, signal, out }));
    child.on('error', reject);
  });
}

async function runSelfTest() {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const otherSha = 'b'.repeat(40);

  const server = createServer((req, res) => {
    const route = new URL(req.url, 'http://127.0.0.1').pathname;
    if (route === '/hang') return; // never responds — exercises the timeout path
    res.writeHead(route === '/notfound' ? 404 : 200, { 'content-type': 'text/html' });
    if (route === '/match') return res.end(fixtureHtml({ backendSha: head }));
    if (route === '/mismatch') return res.end(fixtureHtml({ backendSha: otherSha }));
    return res.end('<!doctype html><html><body>no xlooop markers here</body></html>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  // A paired release that is genuinely compiled against the sha being deployed.
  const goodDir = mkdtempSync(path.join(tmpdir(), 'xlooop-paired-good-'));
  writeFileSync(path.join(goodDir, 'index.html'), fixtureHtml({ backendSha: head }));
  const goodPacket = path.join(goodDir, 'packet.json');
  writeFileSync(goodPacket, JSON.stringify({
    paired_frontend_release: { artifact_dir: goodDir, backend_sha: head },
  }));

  // A packet that CLAIMS the pairing while the artifact on disk says otherwise.
  const lyingDir = mkdtempSync(path.join(tmpdir(), 'xlooop-paired-lying-'));
  writeFileSync(path.join(lyingDir, 'index.html'), fixtureHtml({ backendSha: otherSha }));
  const lyingPacket = path.join(lyingDir, 'packet.json');
  writeFileSync(lyingPacket, JSON.stringify({
    paired_frontend_release: { artifact_dir: lyingDir, backend_sha: head },
  }));

  // Every control asserts the exit code AND the reason. Exit code alone is not enough: a
  // refusal for an unintended reason (a timeout standing in for a real mismatch verdict) is a
  // green that proves nothing.
  const cases = [
    ['matching pair passes',
      { XLOOOP_FRONTEND_PAIR_URL: `${base}/match` }, 'zero', /PASS · live app\.xlooop\.com already expects/],
    ['mismatched backend sha is REFUSED',
      { XLOOOP_FRONTEND_PAIR_URL: `${base}/mismatch` }, 'nonzero', /does not accept the sha you are about to deploy/],
    ['unreachable frontend is REFUSED',
      { XLOOOP_FRONTEND_PAIR_URL: 'http://127.0.0.1:1/' }, 'nonzero', /could not read the live frontend/],
    ['unparseable html is REFUSED',
      { XLOOOP_FRONTEND_PAIR_URL: `${base}/garbage` }, 'nonzero', /artifact marker missing/],
    ['non-2xx frontend is REFUSED',
      { XLOOOP_FRONTEND_PAIR_URL: `${base}/notfound` }, 'nonzero', /responded HTTP 404/],
    ['timeout is REFUSED',
      { XLOOOP_FRONTEND_PAIR_URL: `${base}/hang`, XLOOOP_FRONTEND_PAIR_TIMEOUT_MS: '800' }, 'nonzero', /timed out after 800ms/],
    ['paired release on disk rescues a mismatch',
      { XLOOOP_FRONTEND_PAIR_URL: `${base}/mismatch`, XLOOOP_AUTHORITY_DECISION_PACKET: goodPacket },
      'zero', /PAIRED CUTOVER/],
    ['packet claiming a pairing its artifact contradicts is REFUSED',
      { XLOOOP_FRONTEND_PAIR_URL: `${base}/mismatch`, XLOOOP_AUTHORITY_DECISION_PACKET: lyingPacket },
      'nonzero', /is compiled against/],
    ['override with a reason passes and is recorded', {
      XLOOOP_FRONTEND_PAIR_URL: `${base}/mismatch`,
      XLOOOP_FRONTEND_PAIR_OVERRIDE: '1',
      XLOOOP_FRONTEND_PAIR_OVERRIDE_REASON: 'self-test paired cutover window',
    }, 'zero', /FRONTEND PAIRING GATE OVERRIDDEN/],
    ['override without a reason is REFUSED',
      { XLOOOP_FRONTEND_PAIR_URL: `${base}/mismatch`, XLOOOP_FRONTEND_PAIR_OVERRIDE: '1' },
      'nonzero', /OVERRIDE REFUSED/],
    ['url seam is refused outside --self-test',
      { XLOOOP_FRONTEND_PAIR_URL: `${base}/match`, XLOOOP_FRONTEND_PAIR_SELF_TEST_CHILD: '' },
      'nonzero', /self-test seam and is refused during a real deploy/],
  ];

  const failures = [];
  for (const [label, env, expected, expectedReason] of cases) {
    // eslint-disable-next-line no-await-in-loop -- controls share one fixture server; keep them serial
    const { status, signal, out } = await runGateChild(env);
    const observed = status === 0 ? 'zero' : 'nonzero';
    const reasonSeen = expectedReason.test(out);
    const ok = status !== null && observed === expected && reasonSeen;
    console.log(
      `  ${ok ? '☑' : '✗'} exit=${status === null ? `null(signal ${signal})` : status}`
      + ` · expected ${expected} · reason ${reasonSeen ? 'matched' : 'NOT MATCHED'} · ${label}`,
    );
    if (!ok) failures.push(label);
  }

  server.close();
  if (failures.length > 0) {
    console.error(`✗ ${GATE} self-test FAIL: ${failures.join(' | ')}`);
    process.exit(1);
  }
  console.log(`☑ ${GATE} self-test PASS · ${cases.length} controls, observed child exit codes`);
  process.exit(0);
}

if (process.argv.includes('--self-test')) await runSelfTest();
else await main();
