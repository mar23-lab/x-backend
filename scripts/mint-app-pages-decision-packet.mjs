#!/usr/bin/env node
// scripts/mint-app-pages-decision-packet.mjs · mint the Pages half of a paired cutover.
//
// WHY THIS EXISTS. `deploy:api` has had a minter since 260728; `deploy:app:prod` never did, so the
// SECOND packet of every paired cutover was hand-authored JSON — typed under a 30-minute clock,
// against a schema with 20+ fields, at the exact moment the operator is least able to proofread.
// Measured 260803: an operator attempting the cutover hit three consecutive failures on this path,
// and the Pages packet had not even been reached. A minter is the difference between one command
// and a JSON transcription exercise.
//
// WHAT IT SYNTHESISES. Everything the deploy will itself derive, read from the SAME source the
// deploy reads — dist-app-pages-release/release-manifest.json — so the packet cannot disagree with
// the artifact it authorises:
//   candidate.frontend_sha / backend_sha, expected_deployment.{contract_hash, schema_head,
//   feature_posture, api_base, environment, authority}
// Reading the manifest rather than re-deriving is the point: a second derivation is a second thing
// that can drift.
//
// WHAT IT WILL NOT SYNTHESISE — the human, exactly as the API minter refuses:
//   --approver is MANDATORY and is never defaulted, inferred, or carried over from a previous
//   packet. That is precisely how an agent-transcribed approval comes to look like an operator
//   decision. This script has no default and no fallback.
//
// commercial_release_allowed is HARD-PINNED false, matching the API minter: a minted packet cannot
// express the unsafe state.
//
// TTL: the verifier caps authorisation at 30 minutes from approved_at. Mint LATE.
//
// PAIRING: prefer --from-api-packet. It inherits cutover_id from the packet the API minter just
// wrote AND asserts that packet's candidate_commit_sha equals this release's backend_sha — so the
// id proves not merely "minted together" but "both halves target the same build". Passing
// --cutover-id as a literal still works when it agrees, but it means retyping a UUID between two
// commands, which is how a documented placeholder ended up pasted verbatim during the 260803
// cutover.
//
// Usage:
//   node scripts/mint-app-pages-decision-packet.mjs \
//     --approver "Your Name" \
//     --approval-reference "conversation:2026-08-03-cutover" \
//     --from-api-packet <path the API minter printed> \
//     --rollback-frontend-sha <40-hex currently-live frontend> \
//     --rollback-deployment-id <uuid from: wrangler pages deployment list --project-name xlooop-app> \
//     [--ttl-minutes 25] [--out <path OUTSIDE the repo>] [--cutover-id <uuid> · legacy literal]
//
//   node scripts/mint-app-pages-decision-packet.mjs --self-test
//
// WRITE IT OUTSIDE THE REPO. `prepare:app:prod` and `deploy:app:prod` both refuse on a dirty
// backend worktree, and an untracked packet under docs/ makes the tree dirty — so a packet written
// into the repo blocks the very deploy it authorises. Default --out is ../_cutover-packets/.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const SHA = /^[0-9a-f]{40}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function arg(name) {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? '' : String(argv[i + 1] ?? '').trim();
}

function refuse(message, hint) {
  console.error(`mint-app-pages-decision-packet · REFUSED · ${message}`);
  if (hint) console.error(`  ${hint}`);
  process.exit(1);
}

/** Pure: build the packet from a manifest + operator inputs. Testable with no filesystem. */
export function buildPagesPacket(manifest, input, nowIso) {
  const approvedAt = nowIso;
  const expiresAt = new Date(Date.parse(nowIso) + input.ttlMinutes * 60 * 1000).toISOString();
  return {
    schema_id: 'xlooop.app_pages_deployment_decision.v1',
    status: 'approved_to_deploy',
    deployment_allowed: true,
    commercial_release_allowed: false, // hard-pinned; the verifier refuses anything else
    cutover_id: input.cutoverId || undefined,
    decision: {
      approver: input.approver,
      approval_reference: input.approvalReference,
      approved_at: approvedAt,
      authorization_id: input.authorizationId,
      expires_at: expiresAt,
    },
    target: {
      operation: 'deploy_pages',
      project_name: 'xlooop-app',
      branch: 'main',
      environment: 'production',
    },
    candidate: {
      frontend_sha: manifest.frontend_sha,
      backend_sha: manifest.backend_sha,
    },
    rollback: {
      frontend_sha: input.rollbackFrontendSha,
      cloudflare_deployment_id: input.rollbackDeploymentId,
      evidence_reference: input.rollbackEvidence,
    },
    expected_deployment: {
      api_base: 'https://api.xlooop.com',
      schema_head: manifest.schema_head,
      contract_hash: manifest.contract_hash,
      environment: 'production',
      authority: 'production',
      feature_posture: manifest.feature_posture,
    },
  };
}

function selfTest() {
  const manifest = {
    frontend_sha: 'a'.repeat(40),
    backend_sha: 'b'.repeat(40),
    contract_hash: 'd'.repeat(64),
    schema_head: 93,
    feature_posture: { single_intake: true },
  };
  const input = {
    approver: 'Test Operator',
    approvalReference: 'conversation:test',
    authorizationId: '78b80df7-a1e6-4cbc-8d51-8cd4250e329d',
    cutoverId: 'cd892ad3-bf63-40ba-8582-0bde19df3fc7',
    rollbackFrontendSha: 'c'.repeat(40),
    rollbackDeploymentId: '5c20d49c-957b-4a89-8379-7e4bb1bde936',
    rollbackEvidence: 'wrangler:pages-deployments-list:test',
    ttlMinutes: 25,
  };
  const p = buildPagesPacket(manifest, input, '2026-08-03T00:00:00.000Z');
  const cases = [
    ['schema_id is the Pages decision schema', p.schema_id === 'xlooop.app_pages_deployment_decision.v1'],
    ['commercial_release_allowed is pinned false', p.commercial_release_allowed === false],
    ['candidate shas come from the MANIFEST, not a re-derivation',
      p.candidate.frontend_sha === manifest.frontend_sha && p.candidate.backend_sha === manifest.backend_sha],
    ['expected_deployment mirrors the manifest',
      p.expected_deployment.contract_hash === manifest.contract_hash
      && p.expected_deployment.schema_head === manifest.schema_head],
    ['ttl is honoured exactly',
      Date.parse(p.decision.expires_at) - Date.parse(p.decision.approved_at) === 25 * 60 * 1000],
    ['rollback frontend differs from the candidate (a rollback to self is not a rollback)',
      p.rollback.frontend_sha !== p.candidate.frontend_sha],
    ['cutover_id is carried so the two halves cannot be from different cutovers',
      p.cutover_id === input.cutoverId],
    ['target is the production Pages project', p.target.project_name === 'xlooop-app' && p.target.environment === 'production'],
  ];
  const failed = cases.filter(([, ok]) => !ok);
  for (const [name, ok] of cases) console.log(`  self-test ${ok ? 'PASS' : 'FAIL'} — ${name}`);
  if (failed.length) {
    console.error(`FAIL mint-app-pages-decision-packet self-test: ${failed.length}/${cases.length}`);
    process.exit(1);
  }
  console.log(`PASS mint-app-pages-decision-packet self-test: ${cases.length}/${cases.length}`);
  process.exit(0);
}

if (argv.includes('--self-test')) selfTest();

const approver = arg('approver');
if (!approver) {
  refuse('--approver is required',
    'The operator identity is never defaulted, inferred, or carried over from a previous packet.');
}
const approvalReference = arg('approval-reference');
if (!approvalReference) refuse('--approval-reference is required', 'Cite where the operator approved this.');

const rollbackFrontendSha = arg('rollback-frontend-sha');
if (!SHA.test(rollbackFrontendSha)) {
  refuse('--rollback-frontend-sha must be a 40-hex commit sha',
    'The frontend sha currently serving app.xlooop.com.');
}
const rollbackDeploymentId = arg('rollback-deployment-id');
if (!UUID.test(rollbackDeploymentId)) {
  refuse('--rollback-deployment-id must be a UUID',
    'From: wrangler pages deployment list --project-name xlooop-app');
}
const ttlMinutes = Number(arg('ttl-minutes') || '25');
if (!Number.isFinite(ttlMinutes) || ttlMinutes < 1 || ttlMinutes > 30) {
  refuse('--ttl-minutes must be 1..30', 'The verifier caps authorisation at 30 minutes.');
}

// The manifest is loaded BEFORE the cutover-id resolution below, because --from-api-packet
// cross-checks the API packet's candidate sha against this release's backend sha.
const releaseDir = path.resolve(process.env.XLOOOP_APP_PAGES_RELEASE_DIR || path.join(root, 'dist-app-pages-release'));
const manifestPath = path.join(releaseDir, 'release-manifest.json');
if (!existsSync(manifestPath)) {
  refuse(`no release manifest at ${manifestPath}`,
    'Assemble the release first: XLOOOP_FRONTEND_ARTIFACT_DIR=<built frontend> npm run prepare:app:prod');
}
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

// CUTOVER ID — inherited, not transcribed.
//
// This asked for --cutover-id as a literal, which meant copying a UUID out of one command's output
// into the next command by hand. Measured 260803: the operator ran the documented command with the
// placeholder text still in it and this script refused with "must be a UUID". The refusal was
// correct; requiring the transcription at all was not. The id already exists on disk in the API
// packet, so reading it is strictly safer than retyping it — and it lets the script check something
// a human copy never could.
//
// --from-api-packet <path> inherits cutover_id AND asserts the API packet's candidate_commit_sha
// equals this release's backend_sha. That is the pairing the id is supposed to attest; asserting it
// here turns "the ids match" into "the ids match AND both halves target the same build". An
// explicit --cutover-id still wins when it agrees, so no existing invocation changes behaviour.
const apiPacketPath = arg('from-api-packet');
let cutoverId = arg('cutover-id');
if (cutoverId && !UUID.test(cutoverId)) {
  refuse('--cutover-id must be a UUID',
    'Printed by mint-authority-decision-packet — or drop it and pass --from-api-packet instead.');
}
if (apiPacketPath) {
  let apiPacket;
  try {
    apiPacket = JSON.parse(readFileSync(path.resolve(apiPacketPath), 'utf8'));
  } catch (err) {
    refuse(`--from-api-packet could not be read: ${err.message}`,
      'Point it at the packet mint-authority-decision-packet wrote.');
  }
  const inherited = apiPacket?.cutover_id;
  if (!inherited || !UUID.test(inherited)) {
    refuse('--from-api-packet carries no usable cutover_id', 'Re-mint the API packet; it prints one.');
  }
  if (cutoverId && cutoverId !== inherited) {
    refuse('--cutover-id disagrees with --from-api-packet',
      `explicit ${cutoverId} vs packet ${inherited} — one of them belongs to a different cutover.`);
  }
  if (apiPacket.candidate_commit_sha && apiPacket.candidate_commit_sha !== manifest.backend_sha) {
    refuse('the API packet and the assembled release target DIFFERENT backend shas',
      `packet ${String(apiPacket.candidate_commit_sha).slice(0, 12)} vs release `
      + `${String(manifest.backend_sha).slice(0, 12)} — re-assemble with prepare:app:prod, or the pair is a lie.`);
  }
  cutoverId = inherited;
}
if (!cutoverId) {
  console.error('mint-app-pages-decision-packet · WARNING · no cutover id.');
  console.error('  The two halves of this cutover will not be provably paired.');
  console.error('  Prefer: --from-api-packet <the API packet you just minted>');
}

if (manifest.frontend_sha === rollbackFrontendSha) {
  refuse('rollback frontend sha equals the candidate', 'A rollback target must differ from what you are shipping.');
}

const packet = buildPagesPacket(manifest, {
  approver,
  approvalReference,
  authorizationId: randomUUID(),
  cutoverId,
  rollbackFrontendSha,
  rollbackDeploymentId,
  rollbackEvidence: `wrangler:pages-deployments-list:${new Date().toISOString().slice(0, 10)}`,
  ttlMinutes,
}, new Date().toISOString());

// Default OUTSIDE the repo: an untracked packet under docs/ makes the worktree dirty, and both
// prepare:app:prod and deploy:app:prod refuse on a dirty tree — the packet would block its own deploy.
const outPath = path.resolve(arg('out') || path.join(root, '..', '_cutover-packets', `app-pages-decision-${manifest.backend_sha.slice(0, 7)}.json`));
mkdirSync(path.dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(packet, null, 2)}\n`);

const inRepo = !path.relative(root, outPath).startsWith('..');
console.log(`minted -> ${outPath}`);
console.log(`  candidate    frontend ${manifest.frontend_sha}`);
console.log(`               backend  ${manifest.backend_sha}`);
console.log(`  rollback to  ${rollbackFrontendSha} / ${rollbackDeploymentId}`);
console.log(`  approver     ${approver}`);
console.log(`  cutover_id   ${cutoverId || '(NONE — halves are not provably paired)'}`
  + (apiPacketPath ? `  [inherited from ${path.basename(path.resolve(apiPacketPath))}, backend sha cross-checked]` : ''));
console.log(`  expires      ${packet.decision.expires_at}  (${ttlMinutes} min — the clock is RUNNING)`);
if (inRepo) {
  console.log('  WARNING: this packet is INSIDE the repo and will make the worktree dirty.');
  console.log('           deploy:app:prod refuses on a dirty tree. Move it out before deploying.');
}
console.log('');
console.log('Deploy with:');
console.log(`  XLOOOP_APP_PAGES_DECISION_PACKET=${outPath} npm run deploy:app:prod`);

try {
  const dirty = execFileSync('git', ['status', '--porcelain=v1'], { cwd: root, encoding: 'utf8' }).trim();
  if (dirty) {
    console.log('');
    console.log('  NOTE: the backend worktree is DIRTY — deploy:app:prod will refuse until it is clean:');
    for (const line of dirty.split('\n').slice(0, 5)) console.log(`    ${line}`);
  }
} catch { /* git absent is not this script's problem */ }
