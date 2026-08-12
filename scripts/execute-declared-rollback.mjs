#!/usr/bin/env node
// execute-declared-rollback.mjs · consume the rollback targets the schemas have always required.
//
// WHY THIS EXISTS. Both packet schemas MANDATE a rollback block —
//   authority_decision_packet.v2   rollback.target_sha (40-hex) + cloudflare_version_id (uuid)
//                                  + evidence_reference
//   app_pages_deployment_decision  rollback.frontend_sha + cloudflare_deployment_id
// — and `ls scripts | grep -i rollback` returned exactly one file: an evidence VERIFIER. Repo-wide
// there was a single `wrangler rollback` mention, in a doc. So every packet carried a rollback
// target that nothing could execute, and the 260728 audit had to estimate recovery as "2-4 minutes
// IF both UUIDs are already in hand, unbounded otherwise".
//
// A required field that no code reads is a promise nobody kept. This reads it.
//
// WHAT IT WILL NOT DO
//   - It will not invent a target. A missing or malformed rollback block is a REFUSAL, never a
//     best-effort guess. "Could not determine where to roll back to" must never read as success.
//   - It will not declare victory on a single read. The deploy docs record a ~10-25s edge
//     propagation lag, so an immediate /health read returns the PREVIOUS build and would certify a
//     rollback that has not landed. It POLLS until the target is observed, or fails.
//   - --dry-run touches nothing and prints the exact commands it would run.
//
// Usage:
//   node scripts/execute-declared-rollback.mjs --packet <path> [--dry-run]
//        [--api-base https://api.xlooop.com] [--timeout-seconds 120]
//   node scripts/execute-declared-rollback.mjs --self-test
//
// Exit: 0 rolled back and VERIFIED (or dry-run/self-test ok) · 1 refused or unverified

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFrontendReleaseHtml, parseReactRuntimeManifest } from './lib/app-pages-release-contract.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const SELF_TEST = argv.includes('--self-test');
const DRY_RUN = argv.includes('--dry-run');

function arg(name, fallback = null) {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
}
function refuse(reason, hint) {
  console.error('execute-declared-rollback · REFUSED — ' + reason);
  if (hint) console.error('  ' + hint);
  process.exit(1);
}

const HEX40 = /^[0-9a-f]{40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Exported so the self-test asserts the REAL predicate, not a reimplementation of it. A self-test
// that validates a parallel copy of the logic proves nothing about the code that ships — a defect
// found in reconcile-delta-provenance.mjs on 260728.
export function assessRollbackBlock(packet) {
  const problems = [];
  if (!packet || typeof packet !== 'object') return { ok: false, problems: ['packet_not_an_object'], plan: null };
  const rb = packet.rollback;
  if (!rb || typeof rb !== 'object') return { ok: false, problems: ['rollback_block_missing'], plan: null };

  const isPages = !!(rb.frontend_sha || rb.cloudflare_deployment_id);
  const targetSha = isPages ? rb.frontend_sha : rb.target_sha;
  const targetId = isPages ? rb.cloudflare_deployment_id : rb.cloudflare_version_id;

  if (!targetSha || !HEX40.test(String(targetSha))) problems.push('rollback_target_sha_malformed');
  if (!targetId || !UUID.test(String(targetId))) problems.push('rollback_target_id_malformed');

  const candidate = packet.candidate_commit_sha
    || (packet.candidate && (packet.candidate.backend_sha || packet.candidate.frontend_sha));
  if (candidate && targetSha && String(candidate) === String(targetSha)) {
    // Rolling back TO the thing being deployed is not a rollback; it is a no-op that would report
    // success and leave the incident in place.
    problems.push('rollback_target_equals_candidate');
  }
  return {
    ok: problems.length === 0,
    problems,
    plan: problems.length ? null : { surface: isPages ? 'pages' : 'worker', targetSha: String(targetSha), targetId: String(targetId) },
  };
}

function run(cmd, args, dryRun) {
  const printable = cmd + ' ' + args.join(' ');
  if (dryRun) { console.log('  DRY-RUN would run: ' + printable); return ''; }
  console.log('  running: ' + printable);
  // Strip git's per-invocation env — under a hook GIT_DIR redirects discovery (see #108).
  const env = { ...process.env };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_PREFIX', 'GIT_COMMON_DIR',
    'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_QUARANTINE_PATH']) delete env[k];
  return execFileSync(cmd, args, { cwd: ROOT, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
}

function wranglerCredentials() {
  const json = run(process.execPath, [
    path.join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js'),
    'auth', 'token', '--json',
  ], false);
  let parsed;
  try { parsed = JSON.parse(json); } catch { refuse('Wrangler did not return usable Cloudflare credentials'); }
  const token = parsed?.token || parsed?.api_token || parsed?.credentials?.token;
  if (!token) refuse('Wrangler authentication token is unavailable for Pages rollback');
  return token;
}

async function rollbackPagesDeployment(targetId, dryRun) {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || '725b9700a78047bee164431a5a432d13';
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/pages/projects/xlooop-app/deployments/${targetId}/rollback`;
  if (dryRun) {
    console.log(`  DRY-RUN would POST ${endpoint}`);
    return;
  }
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${wranglerCredentials()}` },
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.success !== true) {
    refuse(`Cloudflare Pages rollback API returned ${response.status}`,
      JSON.stringify(body?.errors || body || 'unreadable response'));
  }
}

async function pollUntilBuild(apiBase, targetSha, timeoutSeconds) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(apiBase.replace(/\/$/, '') + '/api/v1/health?rb=' + Date.now(),
        { cache: 'no-store', signal: AbortSignal.timeout(10000) });
      if (res.ok) {
        const body = await res.json();
        last = body.build;
        if (body.build === targetSha) return { ok: true, observed: body.build };
      }
    } catch { /* transient during propagation — keep polling until the deadline */ }
    await new Promise((r) => setTimeout(r, 5000));
  }
  return { ok: false, observed: last };
}

async function pollUntilFrontend(appBase, targetFrontendSha, targetBackendSha, timeoutSeconds) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const base = appBase.replace(/\/$/, '');
      const nonce = Date.now();
      let identity = null;
      const manifestResponse = await fetch(`${base}/runtime-manifest.json?rb=${nonce}`, {
        cache: 'no-store', signal: AbortSignal.timeout(10_000),
      });
      if (manifestResponse.ok) {
        try { identity = parseReactRuntimeManifest(await manifestResponse.json()); } catch { /* legacy SPA fallback */ }
      }
      if (!identity) {
        const response = await fetch(`${base}/?rb=${nonce}`, {
          cache: 'no-store', signal: AbortSignal.timeout(10_000),
        });
        if (response.ok) identity = parseFrontendReleaseHtml(await response.text());
      }
      last = identity;
      if (identity?.frontend_sha === targetFrontendSha
        && (!targetBackendSha || identity?.backend_sha === targetBackendSha)) {
        return { ok: true, observed: identity };
      }
    } catch { /* transient during propagation */ }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  return { ok: false, observed: last };
}

async function main() {
  const packetPath = arg('packet');
  if (!packetPath) refuse('--packet is required', 'Point at the authority packet whose rollback block you want executed.');
  if (!fs.existsSync(packetPath)) refuse('packet not found: ' + packetPath);

  let packet;
  try { packet = JSON.parse(fs.readFileSync(packetPath, 'utf8')); }
  catch (err) { refuse('packet is not valid JSON (' + err.message + ')'); }

  const assessment = assessRollbackBlock(packet);
  if (!assessment.ok) {
    refuse('the packet does not declare a usable rollback target: ' + assessment.problems.join(', '),
      'Both schemas REQUIRE this block. Refusing to guess where to roll back to.');
  }

  const { surface, targetSha, targetId } = assessment.plan;
  console.log('execute-declared-rollback · surface=' + surface + ' target=' + targetSha.slice(0, 12) + ' id=' + targetId);

  if (surface === 'worker') {
    run(process.execPath, [
      path.join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js'),
      'versions', 'deploy', targetId, '--config', 'wrangler.toml', '--yes',
    ], DRY_RUN);
  } else {
    await rollbackPagesDeployment(targetId, DRY_RUN);
  }

  if (DRY_RUN) { console.log('DRY-RUN complete — nothing was changed.'); return; }

  if (surface === 'worker') {
    const timeoutSeconds = Number(arg('timeout-seconds', '120'));
    console.log('  verifying (edge propagation is ~10-25s; a single read would be premature)...');
    const seen = await pollUntilBuild(arg('api-base', 'https://api.xlooop.com'), targetSha, timeoutSeconds);
    if (!seen.ok) {
      refuse('rollback issued but NOT observed within ' + timeoutSeconds + 's (live build=' + (seen.observed || 'unreadable') + ')',
        'The command was sent. Do NOT assume it landed — check wrangler deployments before retrying.');
    }
    console.log('VERIFIED · live build is now ' + seen.observed);
  } else {
    const timeoutSeconds = Number(arg('timeout-seconds', '120'));
    console.log('  verifying the promoted Pages rollback target...');
    const seen = await pollUntilFrontend(
      arg('app-base', 'https://app.xlooop.com'),
      targetSha,
      packet.rollback.backend_sha || null,
      timeoutSeconds,
    );
    if (!seen.ok) {
      refuse(
        `Pages rollback issued but NOT observed within ${timeoutSeconds}s`,
        `observed frontend=${seen.observed?.frontend_sha || 'unreadable'} backend=${seen.observed?.backend_sha || 'unreadable'}`,
      );
    }
    console.log(`VERIFIED · live frontend is now ${seen.observed.frontend_sha}`);
  }
}

function selfTest() {
  const good = {
    candidate_commit_sha: 'a'.repeat(40),
    rollback: { target_sha: 'b'.repeat(40), cloudflare_version_id: '5c20d49c-957b-4a89-8379-7e4bb1bde936', evidence_reference: 'x' },
  };
  const cases = [
    ['a well-formed worker packet is accepted', assessRollbackBlock(good).ok === true],
    ['it resolves the worker surface', assessRollbackBlock(good).plan.surface === 'worker'],
    ['a MISSING rollback block is refused',
      assessRollbackBlock({ candidate_commit_sha: 'a'.repeat(40) }).problems.includes('rollback_block_missing')],
    ['a malformed target sha is refused',
      assessRollbackBlock({ ...good, rollback: { ...good.rollback, target_sha: 'nope' } }).problems.includes('rollback_target_sha_malformed')],
    ['a malformed version id is refused',
      assessRollbackBlock({ ...good, rollback: { ...good.rollback, cloudflare_version_id: 'nope' } }).problems.includes('rollback_target_id_malformed')],
    ['rolling back TO the candidate is refused (a no-op is not a rollback)',
      assessRollbackBlock({ ...good, rollback: { ...good.rollback, target_sha: 'a'.repeat(40) } }).problems.includes('rollback_target_equals_candidate')],
    ['a pages packet resolves the pages surface',
      assessRollbackBlock({ candidate: { frontend_sha: 'a'.repeat(40) }, rollback: { frontend_sha: 'b'.repeat(40), cloudflare_deployment_id: '5c20d49c-957b-4a89-8379-7e4bb1bde936' } }).plan.surface === 'pages'],
    ['a non-object packet is refused', assessRollbackBlock(null).problems.includes('packet_not_an_object')],
  ];
  let bad = 0;
  for (const [name, ok] of cases) { if (!ok) bad += 1; console.log((ok ? '  PASS  ' : '  FAIL  ') + name); }
  if (bad) { console.error('\nSELF-TEST FAIL — ' + bad + ' of ' + cases.length); process.exit(1); }
  console.log('\nSELF-TEST PASS — ' + cases.length + '/' + cases.length);
}

if (SELF_TEST) selfTest();
else await main();
