#!/usr/bin/env node
// mint-authority-decision-packet.mjs · the PRODUCER the authority packet never had.
//
// WHY THIS EXISTS. Before this script there were TEN verifiers referencing `approved_to_deploy`
// (verify-authority-decision-packet.mjs, verify-app-pages-decision-packet.mjs,
// lib/app-pages-release-contract.mjs, …) and ZERO producers. Every packet was hand-authored, and the
// 472c1134 deploy receipt records the consequence in its own words: the AGENT, not the operator,
// transcribed it. A contract with a verifier and no producer is the estate's most-repeated defect
// shape — the same one CONTRACT_PRODUCER_GATE.yml exists to refuse.
//
// WHAT IT DERIVES vs WHAT IT REFUSES TO GUESS.
// Everything mechanically knowable is derived FROM THE LIVE SYSTEM, never from config:
//   candidate_commit_sha   git rev-parse HEAD
//   contract_hash          GET /api/v1/health   (NOT docs/contracts/*.json — config is intent,
//   schema_head            GET /api/v1/health    the running Worker is state. Reading config and
//   environment            GET /api/v1/health    calling it runtime produced several false findings
//   authority              GET /api/v1/health    on 260728.)
//   feature_posture        GET /api/v1/health
//
// The one thing it will NOT synthesise is the human:
//   --approver is MANDATORY. Absent it, the script refuses. The operator's identity must never be
//   defaulted, inferred, or carried over from a previous packet — that is precisely how an
//   agent-transcribed approval came to look like an operator decision.
//
// commercial_release_allowed is HARD-PINNED false. The verifier refuses anything else
// (`commercial_release_must_remain_blocked`); pinning it here means a minted packet cannot even
// express the unsafe state.
//
// TTL: the verifier caps authorisation at 30 minutes and the clock starts at `approved_at`. Mint
// LATE — immediately before deploying — or the window burns while you read the output.
//
// Usage:
//   node scripts/mint-authority-decision-packet.mjs \
//     --approver "Marat Basyrov" \
//     --approval-reference "conversation:2026-07-28-cutover" \
//     --rollback-version-id <uuid from: npx wrangler versions list> \
//     --rollback-sha <40-hex currently-live build> \
//     [--ttl-minutes 25] [--api-base https://api.xlooop.com] [--out <path>]
//
//   node scripts/mint-authority-decision-packet.mjs --self-test
//
// Exit: 0 minted (or self-test passed) · 1 refused

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const SELF_TEST = argv.includes('--self-test');

function arg(name, fallback = null) {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
}

function refuse(reason, hint) {
  console.error('mint-authority-decision-packet · REFUSED — ' + reason);
  if (hint) console.error('  ' + hint);
  process.exit(1);
}

const HEX40 = /^[0-9a-f]{40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// git, with the per-invocation environment stripped. Under a hook, GIT_DIR overrides discovery and
// a cwd-scoped call reads/writes the WRONG repository — the defect fixed in #108. Same rule here.
function git(args) {
  const env = { ...process.env };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_PREFIX', 'GIT_COMMON_DIR',
    'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_QUARANTINE_PATH']) delete env[k];
  return execFileSync('git', args, { cwd: ROOT, env, encoding: 'utf8' }).trim();
}

async function readLiveHealth(apiBase) {
  const url = apiBase.replace(/\/$/, '') + '/api/v1/health?mint=' + Date.now();
  let res;
  try {
    res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(15000) });
  } catch (err) {
    // Fail closed. A packet minted without observing the target asserts an expected_deployment it
    // never measured — exactly the derivation-over-measurement class this script exists to avoid.
    refuse('could not reach ' + url + ' (' + (err.code || err.name || 'fetch failed') + ')',
      'The packet asserts what the deploy MUST produce. That claim has to be measured, not assumed.');
  }
  if (!res.ok) refuse('live /health returned HTTP ' + res.status, 'Refusing to mint against an unhealthy target.');
  try {
    return await res.json();
  } catch {
    refuse('live /health did not return JSON', 'Refusing to mint from an unparseable target.');
  }
}

export function buildPacket({ candidate, live, approver, approvalReference, rollbackSha,
  rollbackVersionId, rollbackEvidence, ttlMinutes, now }) {
  const approvedAt = new Date(now);
  const expiresAt = new Date(approvedAt.getTime() + ttlMinutes * 60 * 1000);
  return {
    schema_id: 'xlooop.authority_decision_packet.v2',
    status: 'approved_to_deploy',
    candidate_commit_sha: candidate,
    deployment_allowed: true,
    // HARD-PINNED. Not a parameter. The verifier refuses any other value, and a minted packet
    // should not be able to express the unsafe state at all.
    commercial_release_allowed: false,
    exact_deployed_sha_verified: false,
    decision: {
      approver,
      approval_reference: approvalReference,
      approved_at: approvedAt.toISOString().replace(/\.\d{3}Z$/, 'Z'),
      authorization_id: randomUUID(),
      expires_at: expiresAt.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    },
    target: { operation: 'deploy_worker', worker_name: 'xlooop-api', environment: 'production' },
    rollback: {
      target_sha: rollbackSha,
      cloudflare_version_id: rollbackVersionId,
      evidence_reference: rollbackEvidence,
    },
    // Measured from the LIVE target, except build_sha which is what the deploy must PRODUCE.
    expected_deployment: {
      worker_name: 'xlooop-api',
      build_sha: candidate,
      contract_hash: live.contract_hash,
      schema_head: Number(live.schema_head),
      environment: live.environment,
      authority: live.authority,
      feature_posture: live.feature_posture,
    },
  };
}

async function main() {
  const approver = arg('approver');
  if (!approver) {
    refuse('--approver is required',
      'An approval with no named approver is not an approval. This is deliberate: the 472c1134 '
      + 'receipt records that an agent transcribed that packet. Name the human.');
  }
  const approvalReference = arg('approval-reference');
  if (!approvalReference) refuse('--approval-reference is required', 'Cite where the operator approved this.');

  const rollbackSha = arg('rollback-sha');
  const rollbackVersionId = arg('rollback-version-id');
  if (!rollbackSha || !HEX40.test(rollbackSha)) {
    refuse('--rollback-sha must be a 40-hex commit sha',
      'This is the build you fall back TO. Get it from the live /health before deploying.');
  }
  if (!rollbackVersionId || !UUID.test(rollbackVersionId)) {
    refuse('--rollback-version-id must be a UUID',
      'From: npx wrangler versions list --config wrangler.toml');
  }

  const ttlMinutes = Number(arg('ttl-minutes', '25'));
  if (!Number.isFinite(ttlMinutes) || ttlMinutes <= 0 || ttlMinutes > 30) {
    refuse('--ttl-minutes must be 1..30', 'The verifier caps authorisation at 30 minutes.');
  }

  const candidate = git(['rev-parse', 'HEAD']);
  if (!HEX40.test(candidate)) refuse('git HEAD is not a 40-hex sha');
  if (git(['status', '--porcelain'])) {
    refuse('the worktree is dirty',
      'A packet naming HEAD as the candidate is a lie if HEAD is not what would deploy.');
  }
  if (candidate === rollbackSha) {
    refuse('rollback target equals the candidate',
      'Rolling back to the thing you are deploying is not a rollback.');
  }

  const live = await readLiveHealth(arg('api-base', 'https://api.xlooop.com'));
  const packet = buildPacket({
    candidate, live, approver, approvalReference, rollbackSha, rollbackVersionId,
    rollbackEvidence: arg('rollback-evidence', 'wrangler:versions-list:' + new Date().toISOString().slice(0, 10)),
    ttlMinutes, now: Date.now(),
  });

  const out = arg('out', path.join(ROOT, 'docs/deployment/evidence/authority-decision-' + candidate.slice(0, 7) + '.json'));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(packet, null, 2) + '\n');

  console.log('minted -> ' + out);
  console.log('  candidate      ' + candidate);
  console.log('  live now       ' + live.build + ' (schema ' + live.schema_head + ')');
  console.log('  rollback to    ' + rollbackSha + ' / ' + rollbackVersionId);
  console.log('  approver       ' + approver);
  console.log('  expires        ' + packet.decision.expires_at + '  (' + ttlMinutes + ' min — the clock is RUNNING)');
  console.log('');
  console.log('Verify before use:');
  console.log('  XLOOOP_AUTHORITY_DECISION_PACKET=' + out + ' npm run verify:authority-decision:deploy');
}

function selfTest() {
  const live = {
    build: 'b'.repeat(40), contract_hash: 'c'.repeat(64), schema_head: 91,
    environment: 'production', authority: 'production',
    feature_posture: {
      single_intake: true, role_skill_catalog: true, context_packet_persistence: true,
      chat_history_persistence_required: true, tenant_projection_queue: false,
      current_work_projection: false,
    },
  };
  const base = {
    candidate: 'a'.repeat(40), live, approver: 'Marat Basyrov',
    approvalReference: 'conversation:selftest', rollbackSha: 'd'.repeat(40),
    rollbackVersionId: '5c20d49c-957b-4a89-8379-7e4bb1bde936',
    rollbackEvidence: 'wrangler:versions-list:selftest', ttlMinutes: 25, now: Date.parse('2026-07-28T00:00:00Z'),
  };
  const checks = [];
  const p = buildPacket(base);
  checks.push(['schema_id is v2', p.schema_id === 'xlooop.authority_decision_packet.v2']);
  checks.push(['commercial_release_allowed is pinned false', p.commercial_release_allowed === false]);
  checks.push(['candidate carried into expected_deployment.build_sha', p.expected_deployment.build_sha === base.candidate]);
  checks.push(['contract_hash comes from LIVE, not config', p.expected_deployment.contract_hash === live.contract_hash]);
  checks.push(['schema_head comes from LIVE', p.expected_deployment.schema_head === 91]);
  checks.push(['authorization_id is a fresh uuid', UUID.test(p.decision.authorization_id)]);
  checks.push(['a second mint gets a DIFFERENT authorization_id',
    buildPacket(base).decision.authorization_id !== p.decision.authorization_id]);
  checks.push(['ttl <= 30 min', (Date.parse(p.decision.expires_at) - Date.parse(p.decision.approved_at)) <= 30 * 60 * 1000]);
  checks.push(['rollback target differs from candidate', p.rollback.target_sha !== p.candidate_commit_sha]);
  // The refusal paths are argument-level and exercised by the child-process cases in the PR body;
  // buildPacket() itself is the shape contract, so that is what is asserted here.
  let bad = 0;
  for (const [name, ok] of checks) {
    if (!ok) bad += 1;
    console.log((ok ? '  PASS  ' : '  FAIL  ') + name);
  }
  if (bad) {
    console.error('\nSELF-TEST FAIL — ' + bad + ' of ' + checks.length);
    process.exit(1);
  }
  console.log('\nSELF-TEST PASS — ' + checks.length + '/' + checks.length);
}

if (SELF_TEST) selfTest();
else await main();
