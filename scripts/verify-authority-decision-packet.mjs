#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeploymentAuthorizationConsumed } from './lib/deployment-authorization-store.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaultPacketPath = resolve(
  root,
  'docs/deployment/evidence/authority-decision-e78e13d-unreconciled.json',
);
const requireApproved = process.argv.includes('--require-approved-to-deploy');
const requireRatified = process.argv.includes('--require-ratified');
const selfTest = process.argv.includes('--self-test');
const shaPattern = /^[0-9a-f]{40}$/;
const hashPattern = /^[0-9a-f]{64}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const postureKeys = [
  'single_intake',
  'role_skill_catalog',
  'context_packet_persistence',
  'chat_history_persistence_required',
  'tenant_projection_queue',
  'current_work_projection',
];

function exactPostureProblems(posture, prefix) {
  const problems = [];
  if (!posture || typeof posture !== 'object' || Array.isArray(posture)) {
    return [`${prefix}`];
  }
  const unknown = Object.keys(posture).filter((key) => !postureKeys.includes(key));
  for (const key of postureKeys) {
    if (typeof posture[key] !== 'boolean') problems.push(`${prefix}.${key}`);
  }
  if (unknown.length) problems.push(`${prefix}.unknown:${unknown.join(',')}`);
  return problems;
}

function posturesEqual(left, right) {
  return (
    exactPostureProblems(left, 'left').length === 0
    && exactPostureProblems(right, 'right').length === 0
    && postureKeys.every((key) => left[key] === right[key])
  );
}

function assessObservedLegacy(packet, problems) {
  if (packet?.production_changes_frozen !== true) problems.push('unreconciled_not_frozen');
  if (packet?.commercial_release_allowed !== false) problems.push('unreconciled_release_allowed');
  if (!Array.isArray(packet?.blocking_gaps) || packet.blocking_gaps.length === 0) {
    problems.push('unreconciled_gaps_missing');
  }
  if (!hashPattern.test(packet?.deployment?.contract_hash || '')) problems.push('contract_hash');
  if (packet?.deployment?.environment !== 'production') problems.push('environment');
  if (packet?.deployment?.authority !== 'production') problems.push('authority');
  if (packet?.health_observation?.response?.status !== 'ok') problems.push('health_status');
}

function assessApprovedShape(packet, problems, currentHead, now) {
  const maxAuthorizationTtlMs = 30 * 60 * 1000;
  const expected = packet?.expected_deployment || {};
  const decision = packet?.decision || {};
  const rollback = packet?.rollback || {};
  const target = packet?.target || {};

  if (packet?.schema_id !== 'xlooop.authority_decision_packet.v2') problems.push('approved_schema_id');
  if (!decision.approver) problems.push('approver');
  if (!decision.approval_reference) problems.push('approval_reference');
  if (!uuidPattern.test(decision.authorization_id || '')) problems.push('authorization_id');
  const approvedAt = Date.parse(decision.approved_at || '');
  const expiresAt = Date.parse(decision.expires_at || '');
  if (Number.isNaN(approvedAt)) problems.push('approved_at');
  if (Number.isNaN(expiresAt)) problems.push('expires_at');
  if (
    Number.isFinite(approvedAt)
    && Number.isFinite(expiresAt)
    && (expiresAt <= approvedAt || expiresAt - approvedAt > maxAuthorizationTtlMs)
  ) {
    problems.push('authorization_window');
  }
  if (
    packet?.status === 'approved_to_deploy'
    && Number.isFinite(approvedAt)
    && approvedAt > Date.parse(now)
  ) {
    problems.push('authorization_not_yet_valid');
  }
  if (
    packet?.status === 'approved_to_deploy'
    && Number.isFinite(expiresAt)
    && expiresAt <= Date.parse(now)
  ) {
    problems.push('authorization_expired');
  }
  if (target.operation !== 'deploy_worker') problems.push('target_operation');
  if (target.worker_name !== 'xlooop-api') problems.push('target_worker_name');
  if (target.environment !== 'production') problems.push('target_environment');
  if (packet?.status === 'approved_to_deploy' && packet?.deployment_allowed !== true) {
    problems.push('deployment_not_allowed');
  }
  if (packet?.status === 'ratified' && packet?.deployment_allowed !== false) {
    problems.push('ratified_deployment_must_be_consumed');
  }
  if (packet?.commercial_release_allowed !== false) {
    problems.push('commercial_release_must_remain_blocked');
  }
  if (!shaPattern.test(rollback.target_sha || '')) problems.push('rollback_target_sha');
  if (rollback.target_sha === packet?.candidate_commit_sha) problems.push('rollback_target_not_distinct');
  if (!uuidPattern.test(rollback.cloudflare_version_id || '')) problems.push('rollback_cloudflare_version_id');
  if (!rollback.evidence_reference) problems.push('rollback_evidence_reference');
  if (expected.worker_name !== target.worker_name) problems.push('expected_worker_name');
  if (expected.build_sha !== packet?.candidate_commit_sha) problems.push('expected_build_sha');
  if (!hashPattern.test(expected.contract_hash || '')) problems.push('expected_contract_hash');
  if (!Number.isSafeInteger(expected.schema_head) || expected.schema_head < 1) {
    problems.push('expected_schema_head');
  }
  if (expected.environment !== 'production') problems.push('expected_environment');
  if (expected.authority !== 'production') problems.push('expected_authority');
  problems.push(...exactPostureProblems(expected.feature_posture, 'expected_feature_posture'));
  if (currentHead && packet?.candidate_commit_sha !== currentHead) problems.push('candidate_not_current_head');
}

function assessRatifiedObservation(packet, problems) {
  const expected = packet?.expected_deployment || {};
  const deployment = packet?.deployment || {};
  const health = packet?.health_observation?.response || {};

  if (packet?.exact_deployed_sha_verified !== true) problems.push('deployed_sha_not_verified');
  if (deployment.reported_build !== expected.build_sha) problems.push('deployment_build');
  if (deployment.contract_hash !== expected.contract_hash) problems.push('deployment_contract_hash');
  if (deployment.schema_head !== expected.schema_head) problems.push('deployment_schema_head');
  if (deployment.environment !== expected.environment) problems.push('deployment_environment');
  if (deployment.authority !== expected.authority) problems.push('deployment_authority');
  if (!posturesEqual(deployment.feature_posture, expected.feature_posture)) {
    problems.push('deployment_feature_posture');
  }
  if (health.status !== 'ok') problems.push('health_status');
  if (health.build !== expected.build_sha) problems.push('health_build');
  if (health.contract_hash !== expected.contract_hash) problems.push('health_contract_hash');
  if (health.schema_head !== expected.schema_head) problems.push('health_schema_head');
  if (health.environment !== expected.environment) problems.push('health_environment');
  if (health.authority !== expected.authority) problems.push('health_authority');
  if (!posturesEqual(health.feature_posture, expected.feature_posture)) {
    problems.push('health_feature_posture');
  }
}

export function assessAuthorityPacket(
  packet,
  requiredPhase = 'observe',
  currentHead = null,
  options = {},
) {
  const problems = [];
  const status = packet?.status;
  const now = options.now || new Date().toISOString();
  if (!['xlooop.authority_decision_packet.v1', 'xlooop.authority_decision_packet.v2'].includes(packet?.schema_id)) {
    problems.push('schema_id');
  }
  if (!['observed_unreconciled', 'approved_to_deploy', 'ratified'].includes(status)) {
    problems.push('status');
  }
  if (!shaPattern.test(packet?.candidate_commit_sha || '')) problems.push('candidate_commit_sha');

  if (status === 'observed_unreconciled') {
    assessObservedLegacy(packet, problems);
  } else if (status === 'approved_to_deploy' || status === 'ratified') {
    assessApprovedShape(packet, problems, currentHead, now);
  }

  if (requiredPhase === 'deploy' && status !== 'approved_to_deploy') {
    problems.push('authority_not_approved_to_deploy');
  }
  if (requiredPhase === 'deploy' && options.authorizationConsumed === true) {
    problems.push('authorization_consumed');
  }
  if (requiredPhase === 'ratified' && status !== 'ratified') {
    problems.push('authority_not_ratified');
  }
  if (status === 'ratified') assessRatifiedObservation(packet, problems);

  return { ok: problems.length === 0, problems };
}

function approvedFixture() {
  const candidate = 'a'.repeat(40);
  const posture = {
    single_intake: true,
    role_skill_catalog: true,
    context_packet_persistence: true,
    chat_history_persistence_required: true,
    tenant_projection_queue: false,
    current_work_projection: false,
  };
  return {
    schema_id: 'xlooop.authority_decision_packet.v2',
    status: 'approved_to_deploy',
    candidate_commit_sha: candidate,
    deployment_allowed: true,
    commercial_release_allowed: false,
    exact_deployed_sha_verified: false,
    decision: {
      approver: 'operator',
      approval_reference: 'conversation:approval-1',
      approved_at: '2026-07-25T00:00:00Z',
      authorization_id: '36eb5d20-49d9-4ed9-b623-0f7250797244',
      expires_at: '2026-07-25T00:30:00Z',
    },
    target: {
      operation: 'deploy_worker',
      worker_name: 'xlooop-api',
      environment: 'production',
    },
    rollback: {
      target_sha: 'c'.repeat(40),
      cloudflare_version_id: '5c20d49c-957b-4a89-8379-7e4bb1bde936',
      evidence_reference: 'wrangler:deployments-list:2026-07-25',
    },
    expected_deployment: {
      worker_name: 'xlooop-api',
      build_sha: candidate,
      contract_hash: 'b'.repeat(64),
      schema_head: 89,
      environment: 'production',
      authority: 'production',
      feature_posture: posture,
    },
  };
}

function runSelfTest() {
  const approved = approvedFixture();
  const assessmentOptions = { now: '2026-07-25T00:10:00Z' };
  const approvedResult = assessAuthorityPacket(
    approved,
    'deploy',
    approved.candidate_commit_sha,
    assessmentOptions,
  );
  const unapprovedResult = assessAuthorityPacket(
    { ...approved, status: 'observed_unreconciled', schema_id: 'xlooop.authority_decision_packet.v1' },
    'deploy',
    approved.candidate_commit_sha,
    assessmentOptions,
  );
  const wrongHead = assessAuthorityPacket(approved, 'deploy', 'd'.repeat(40), assessmentOptions);
  const expired = structuredClone(approved);
  expired.decision.expires_at = '2026-07-25T00:05:00Z';
  const expiredResult = assessAuthorityPacket(
    expired,
    'deploy',
    expired.candidate_commit_sha,
    assessmentOptions,
  );
  const overlong = structuredClone(approved);
  overlong.decision.expires_at = '2026-07-25T00:30:01Z';
  const overlongResult = assessAuthorityPacket(
    overlong,
    'deploy',
    overlong.candidate_commit_sha,
    assessmentOptions,
  );
  const future = structuredClone(approved);
  future.decision.approved_at = '2026-07-25T00:11:00Z';
  const futureResult = assessAuthorityPacket(
    future,
    'deploy',
    future.candidate_commit_sha,
    assessmentOptions,
  );
  const consumedResult = assessAuthorityPacket(
    approved,
    'deploy',
    approved.candidate_commit_sha,
    { ...assessmentOptions, authorizationConsumed: true },
  );
  const ratified = {
    ...approved,
    status: 'ratified',
    deployment_allowed: false,
    exact_deployed_sha_verified: true,
    deployment: {
      reported_build: approved.expected_deployment.build_sha,
      contract_hash: approved.expected_deployment.contract_hash,
      schema_head: approved.expected_deployment.schema_head,
      environment: approved.expected_deployment.environment,
      authority: approved.expected_deployment.authority,
      feature_posture: structuredClone(approved.expected_deployment.feature_posture),
    },
    health_observation: {
      response: {
        status: 'ok',
        build: approved.expected_deployment.build_sha,
        contract_hash: approved.expected_deployment.contract_hash,
        schema_head: approved.expected_deployment.schema_head,
        environment: approved.expected_deployment.environment,
        authority: approved.expected_deployment.authority,
        feature_posture: structuredClone(approved.expected_deployment.feature_posture),
      },
    },
  };
  const ratifiedResult = assessAuthorityPacket(
    ratified,
    'ratified',
    ratified.candidate_commit_sha,
    assessmentOptions,
  );
  const commercialReleaseLeak = structuredClone(ratified);
  commercialReleaseLeak.commercial_release_allowed = true;
  const commercialReleaseLeakResult = assessAuthorityPacket(
    commercialReleaseLeak,
    'ratified',
    commercialReleaseLeak.candidate_commit_sha,
  );
  const reorderedPosture = structuredClone(ratified);
  reorderedPosture.health_observation.response.feature_posture = Object.fromEntries(
    Object.entries(reorderedPosture.health_observation.response.feature_posture).reverse(),
  );
  const reorderedPostureResult = assessAuthorityPacket(
    reorderedPosture,
    'ratified',
    reorderedPosture.candidate_commit_sha,
  );
  const postureDrift = structuredClone(ratified);
  postureDrift.health_observation.response.feature_posture.chat_history_persistence_required = false;
  const postureDriftResult = assessAuthorityPacket(postureDrift, 'ratified', ratified.candidate_commit_sha);

  const ok =
    approvedResult.ok &&
    !unapprovedResult.ok &&
    unapprovedResult.problems.includes('authority_not_approved_to_deploy') &&
    !wrongHead.ok &&
    wrongHead.problems.includes('candidate_not_current_head') &&
    !expiredResult.ok &&
    expiredResult.problems.includes('authorization_expired') &&
    !overlongResult.ok &&
    overlongResult.problems.includes('authorization_window') &&
    !futureResult.ok &&
    futureResult.problems.includes('authorization_not_yet_valid') &&
    !consumedResult.ok &&
    consumedResult.problems.includes('authorization_consumed') &&
    ratifiedResult.ok &&
    !commercialReleaseLeakResult.ok &&
    commercialReleaseLeakResult.problems.includes('commercial_release_must_remain_blocked') &&
    reorderedPostureResult.ok &&
    !postureDriftResult.ok &&
    postureDriftResult.problems.includes('health_feature_posture');
  if (!ok) {
    console.error('verify-authority-decision-packet self-test FAIL');
    console.error(JSON.stringify({
      approvedResult,
      unapprovedResult,
      wrongHead,
      expiredResult,
      overlongResult,
      futureResult,
      consumedResult,
      ratifiedResult,
      commercialReleaseLeakResult,
      reorderedPostureResult,
      postureDriftResult,
    }, null, 2));
    process.exit(1);
  }
  console.log('verify-authority-decision-packet self-test PASS · short-lived approval, exact-HEAD, replay rejection, and health-ratification controls');
}

function currentHead() {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
}

function packetPathForPhase() {
  const supplied = process.env.XLOOOP_AUTHORITY_DECISION_PACKET;
  if ((requireApproved || requireRatified) && !supplied) {
    throw new Error('XLOOOP_AUTHORITY_DECISION_PACKET is required for deploy or post-deploy ratification');
  }
  if (!supplied) return defaultPacketPath;
  return isAbsolute(supplied) ? supplied : resolve(process.cwd(), supplied);
}

if (requireApproved && requireRatified) {
  console.error('verify-authority-decision-packet · FAIL-CLOSED · choose one required phase');
  process.exit(2);
}

if (selfTest) {
  runSelfTest();
} else {
  try {
    const phase = requireApproved ? 'deploy' : requireRatified ? 'ratified' : 'observe';
    const packetPath = packetPathForPhase();
    const packet = JSON.parse(readFileSync(packetPath, 'utf8'));
    const authorizationConsumed = phase === 'deploy'
      && isDeploymentAuthorizationConsumed(root, 'api', packet?.decision?.authorization_id);
    const result = assessAuthorityPacket(
      packet,
      phase,
      phase === 'observe' ? null : currentHead(),
      { authorizationConsumed },
    );
    if (!result.ok) {
      console.error(`verify-authority-decision-packet · FAIL-CLOSED · ${result.problems.join(',')}`);
      process.exit(1);
    }
    console.log(
      `verify-authority-decision-packet · PASS · phase=${phase} status=${packet.status}`
      + ` candidate=${packet.candidate_commit_sha}`,
    );
  } catch (error) {
    console.error(
      `verify-authority-decision-packet · FAIL-CLOSED · ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}
