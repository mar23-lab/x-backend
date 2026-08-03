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
//     [--paired-release-dir <dist-app-pages-release>]   <- REQUIRED for a PAIRED cutover; see below
//     [--ttl-minutes 25] [--api-base https://api.xlooop.com] [--out <path OUTSIDE the repo>]
//
// PAIRED CUTOVER (--paired-release-dir). Preflight step 9
// (verify-frontend-pair-before-api-deploy.mjs) passes on exactly two states: the live frontend
// already expects the sha being shipped, OR this packet carries a `paired_frontend_release` block
// naming a locally assembled artifact. When you are shipping BOTH halves the first state is false by
// definition — the live frontend still expects the OLD backend — so the block is mandatory. Until
// 260804 this script emitted no such block and the operator hand-patched four lines into the packet
// mid-TTL. Pass the assembled dir and it is produced from that artifact's own manifest, with the
// cross-check a hand-written block cannot make: manifest.backend_sha MUST equal the candidate.
//
// WRITE IT OUTSIDE THE REPO — and the default now does. `deploy:api` refuses on a dirty backend
// worktree, so a packet written into the repo blocks the very deploy it authorises. The old default
// was docs/deployment/evidence/ (inside); it is now ../_cutover-packets/, matching the Pages minter.
// An explicit in-repo --out is refused rather than silently accepted.
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
  rollbackVersionId, rollbackEvidence, ttlMinutes, now, cutoverId, pairedFrontendRelease = null }) {
  const approvedAt = new Date(now);
  const expiresAt = new Date(approvedAt.getTime() + ttlMinutes * 60 * 1000);
  return {
    // cutover_id · 260728 · makes "atomic" PROVABLE rather than remembered.
    //
    // The API and Pages deploys are two independent scripts holding two independent single-use
    // authorisations with two independent 30-minute TTLs, and NOTHING tied them together. "Deploy
    // both or neither" was an instruction in a runbook, not a property of the artifacts — so a
    // half-executed cutover (API deployed, Pages not) was indistinguishable, after the fact, from
    // two unrelated deploys that happened to be close in time. That half-execution is exactly what
    // stranded the pilot on 260728 and what the pairing gate (#105) now refuses in advance.
    //
    // Stamping the SAME cutover_id into both packets makes the pairing checkable from the receipts
    // alone, after the fact, without re-deriving intent from timestamps. Pass --cutover-id <uuid>
    // when minting the second packet of a pair; omit it and a fresh one is generated, which is the
    // correct default for a standalone API deploy.
    cutover_id: cutoverId,
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
    // paired_frontend_release · 260804 · the block preflight step 9 requires, PRODUCED rather than
    // hand-written. verify-frontend-pair-before-api-deploy.mjs passes on exactly two states: the live
    // frontend already expects the sha being shipped, OR the packet carries this block naming a
    // locally assembled artifact. During the 260804 cutover neither held — the live frontend expected
    // the OLD backend — so the packet had to be hand-patched at the keyboard, mid-TTL, to add four
    // lines. A verifier with no producer is the shape this estate has retired repeatedly; this closes
    // it for the API packet the same way --from-api-packet closed it for the Pages one.
    // Omitted (no --paired-release-dir) => absent, which is correct for a solo API deploy where the
    // live frontend already expects the candidate.
    ...(pairedFrontendRelease ? { paired_frontend_release: pairedFrontendRelease } : {}),
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

  // --paired-release-dir: read the ASSEMBLED release and emit the block preflight step 9 wants.
  // Reading the manifest rather than re-deriving is the point — a second derivation is a second
  // thing that can disagree with the artifact the deploy actually uploads.
  const pairedDirArg = arg('paired-release-dir');
  let pairedFrontendRelease = null;
  if (pairedDirArg) {
    const pairedDir = path.resolve(pairedDirArg);
    const manifestPath = path.join(pairedDir, 'release-manifest.json');
    if (!fs.existsSync(manifestPath)) {
      refuse(`no release-manifest.json in ${pairedDir}`,
        'Run `npm run prepare:app:prod` first — the block must name an artifact that exists.');
    }
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (error) {
      refuse(`release-manifest.json is not readable JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    // The cross-check a hand-written block could never make: the assembled frontend must be compiled
    // against the sha this packet authorises, or the "pair" is two unrelated deploys.
    if (manifest.backend_sha !== candidate) {
      refuse(`the assembled release targets backend ${String(manifest.backend_sha).slice(0, 12)}, not the candidate ${candidate.slice(0, 12)}`,
        'Re-assemble with `npm run prepare:app:prod` from the sha you are deploying, or the pair is a lie.');
    }
    pairedFrontendRelease = { artifact_dir: pairedDir, backend_sha: manifest.backend_sha };
  }

  const live = await readLiveHealth(arg('api-base', 'https://api.xlooop.com'));
  const packet = buildPacket({
    pairedFrontendRelease,
    candidate, live, approver, approvalReference, rollbackSha, rollbackVersionId,
    rollbackEvidence: arg('rollback-evidence', 'wrangler:versions-list:' + new Date().toISOString().slice(0, 10)),
    ttlMinutes, now: Date.now(),
    // Omitted => a fresh id, which is correct for a standalone API deploy. Pass the FIRST packet's
    // id when minting the second half of a pair so the two receipts are provably one cutover.
    cutoverId: arg('cutover-id', randomUUID()),
  });

  // The default MUST be outside the repo. It used to be docs/deployment/evidence/ — INSIDE — and
  // `deploy:api` refuses on a dirty backend worktree, so the default output path blocked the very
  // deploy it authorised. The Pages minter already defaults to ../_cutover-packets/ and says so in
  // its header; this one silently did the opposite. Measured 260804.
  const out = path.resolve(arg('out', path.join(ROOT, '..', '_cutover-packets',
    'authority-decision-' + candidate.slice(0, 7) + '.json')));
  // Refuse an in-repo path even when passed explicitly — a dirty tree is a deploy that cannot run,
  // and finding that out mid-TTL costs the whole authorisation window.
  const repoPrefix = path.resolve(ROOT) + path.sep;
  if (out.startsWith(repoPrefix)) {
    refuse(`--out is inside the repository (${out})`,
      'A packet written into the repo makes the worktree dirty, and deploy:api refuses a dirty '
      + 'backend worktree — so it would block the deploy it authorises. Write it outside, e.g. '
      + path.join(ROOT, '..', '_cutover-packets') + '.');
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(packet, null, 2) + '\n');

  console.log('minted -> ' + out);
  console.log('  candidate      ' + candidate);
  console.log('  live now       ' + live.build + ' (schema ' + live.schema_head + ')');
  console.log('  rollback to    ' + rollbackSha + ' / ' + rollbackVersionId);
  console.log('  approver       ' + approver);
  console.log('  cutover_id     ' + packet.cutover_id);
  console.log('                 ^ pass this to the Pages packet with --cutover-id to prove one cutover');
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
    cutoverId: '11111111-2222-3333-4444-555555555555',
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
  // cutover_id is the ONLY field that must survive verbatim across two independently-minted packets.
  // Everything else (authorization_id, timestamps) is deliberately unique per packet — so asserting
  // both directions is what proves the field can actually correlate a pair rather than just exist.
  checks.push(['cutover_id is carried verbatim, not regenerated', p.cutover_id === base.cutoverId]);
  checks.push(['a SECOND packet given the same cutover_id matches (a pair is correlatable)',
    buildPacket(base).cutover_id === p.cutover_id]);
  checks.push(['…while its authorization_id still differs (they remain separate authorisations)',
    buildPacket(base).decision.authorization_id !== p.decision.authorization_id]);
  // paired_frontend_release · both directions. Absent by default (a solo API deploy must not claim a
  // pair it does not have), present and exact when supplied — this is the block preflight step 9
  // reads, so a wrong shape here reproduces the 260804 hand-patch.
  checks.push(['paired_frontend_release is ABSENT by default (a solo deploy claims no pair)',
    !('paired_frontend_release' in p)]);
  const paired = buildPacket({
    ...base,
    pairedFrontendRelease: { artifact_dir: '/tmp/dist-app-pages-release', backend_sha: base.candidate },
  });
  checks.push(['paired_frontend_release is emitted when supplied',
    !!paired.paired_frontend_release]);
  checks.push(['…its backend_sha equals the candidate (step 9 compares exactly this)',
    paired.paired_frontend_release.backend_sha === base.candidate]);
  checks.push(['…and it names the artifact dir step 9 will read',
    paired.paired_frontend_release.artifact_dir === '/tmp/dist-app-pages-release']);

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
