#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];
const evidence = readJson('data/hosted-deployment-evidence.json');

check(evidence.schema_version === 'xlooop.hosted_deployment_evidence.v1', 'schema_version must be xlooop.hosted_deployment_evidence.v1');
check(evidence.product === 'Xlooop', 'product must be Xlooop');
check(evidence.technical_repo_name === 'Xlooop-XCP-demo', 'technical repo must be Xlooop-XCP-demo');
check(evidence.canonical_deploy_surface === 'cloudflare_pages_direct_upload', 'canonical deploy surface must be Cloudflare Pages direct upload');
check(evidence.hosted_commit_artifact === 'dist-cloudflare/deployment-manifest.json', 'hosted commit artifact must be dist-cloudflare/deployment-manifest.json');
check(['pass', 'fail'].includes(evidence.local_evidence), 'local evidence must be pass or fail');
check(['pass', 'fail', 'not_evidenced'].includes(evidence.hosted_evidence), 'hosted evidence must be pass, fail, or not_evidenced');
check(['pass', 'fail', 'not_authoritative_cost_deferred'].includes(evidence.remote_ci), 'remote CI must be pass, fail, or not_authoritative_cost_deferred');
check(evidence.public_self_serve_readiness === 'not_claimed', 'public/self-serve readiness must remain not_claimed');
check(evidence.paid_private_operator === 'operator_gated', 'paid/private Operator must remain operator_gated');
check(evidence.xcp_second_level_access_default === 'disabled', 'XCP second-level access must default disabled');
check(evidence.claim_posture?.xlooop_access_grants_xcp === false, 'Xlooop access must not grant XCP');
check((evidence.environments || []).length === 2, 'hosted evidence must declare dev and test environments');
check((evidence.environments || []).every((row) => row.served_commit_status !== 'pass' || /^[a-f0-9]{40}$/.test(row.served_commit_sha || '')), 'served commit pass requires a 40-character git sha');

const manifestRel = evidence.hosted_commit_artifact;
if (fs.existsSync(path.join(repoRoot, manifestRel))) {
  const manifest = readJson(manifestRel);
  const head = git(['rev-parse', 'HEAD']);
  check(manifest.schema_version === 'xlooop.cloudflare_pages_bundle.v1', 'deployment manifest schema must be xlooop.cloudflare_pages_bundle.v1');
  check(manifest.product === 'Xlooop', 'deployment manifest product must be Xlooop');
  check(/^[a-f0-9]{40}$/.test(manifest.source_commit || ''), 'deployment manifest source_commit must be a 40-character git sha');
  check(
    manifest.source_commit === head || gitOk(['merge-base', '--is-ancestor', manifest.source_commit, head]),
    'deployment manifest source_commit must be current HEAD or an ancestor of current HEAD for tracked local build evidence',
  );
  check(Boolean(manifest.source_branch), 'deployment manifest source_branch must be present');
  check(['cloudflare_pages', 'github_actions', 'local_build'].includes(manifest.build_source), 'deployment manifest build_source must be recognized');
  check(manifest.public_self_serve_readiness === 'not_claimed', 'deployment manifest must keep public/self-serve readiness not_claimed');
  check(manifest.paid_private_operator === 'operator_gated', 'deployment manifest must keep paid/private Operator operator_gated');
  check(manifest.xcp_second_level_access_default === 'disabled', 'deployment manifest must keep XCP second-level access disabled by default');
  check(manifest.xlooop_access_grants_xcp === false, 'deployment manifest must not allow Xlooop access to grant XCP');
  check(manifest.hosted_evidence === 'not_evidenced', 'local deployment manifest must not claim hosted evidence pass');
}

if (errors.length) {
  console.error('hosted-deployment-evidence: FAIL');
  for (const error of errors) console.error('  FAIL ' + error);
  process.exit(1);
}

console.log('hosted-deployment-evidence: PASS (contract valid; manifest checked when present)');

function readJson(relPath) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, relPath), 'utf8'));
}

function git(args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();
}

function gitOk(args) {
  try {
    execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function check(ok, message) {
  if (!ok) errors.push(message);
}
