#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packetPath = resolve(
  root,
  'docs/deployment/evidence/authority-decision-e78e13d-unreconciled.json',
);
const requireRatified = process.argv.includes('--require-ratified');
const selfTest = process.argv.includes('--self-test');
const shaPattern = /^[0-9a-f]{40}$/;
const hashPattern = /^[0-9a-f]{64}$/;

export function assessAuthorityPacket(packet, releaseRequired = false) {
  const problems = [];
  if (packet?.schema_id !== 'xlooop.authority_decision_packet.v1') problems.push('schema_id');
  if (!['observed_unreconciled', 'ratified'].includes(packet?.status)) problems.push('status');
  if (!shaPattern.test(packet?.candidate_commit_sha || '')) problems.push('candidate_commit_sha');
  if (!hashPattern.test(packet?.deployment?.contract_hash || '')) problems.push('contract_hash');
  if (packet?.deployment?.environment !== 'production') problems.push('environment');
  if (packet?.deployment?.authority !== 'production') problems.push('authority');
  if (packet?.health_observation?.response?.status !== 'ok') problems.push('health_status');

  if (packet?.status === 'observed_unreconciled') {
    if (packet?.production_changes_frozen !== true) problems.push('unreconciled_not_frozen');
    if (packet?.commercial_release_allowed !== false) problems.push('unreconciled_release_allowed');
    if (!Array.isArray(packet?.blocking_gaps) || packet.blocking_gaps.length === 0) {
      problems.push('unreconciled_gaps_missing');
    }
  }

  if (releaseRequired || packet?.status === 'ratified') {
    if (packet?.status !== 'ratified') problems.push('authority_not_ratified');
    if (!packet?.decision?.approver) problems.push('approver');
    if (!packet?.decision?.approval_reference) problems.push('approval_reference');
    if (!shaPattern.test(packet?.rollback?.target_sha || '')) problems.push('rollback_target_sha');
    if (!packet?.rollback?.rehearsal_reference) problems.push('rollback_rehearsal_reference');
    if (packet?.deployment?.reported_build !== packet?.candidate_commit_sha) {
      problems.push('exact_deployed_sha');
    }
    if (!Number.isSafeInteger(packet?.deployment?.schema_head) || packet.deployment.schema_head < 1) {
      problems.push('numeric_schema_head');
    }
    if (packet?.exact_deployed_sha_verified !== true) problems.push('deployed_sha_not_verified');
    if (packet?.commercial_release_allowed !== true) problems.push('commercial_release_not_allowed');
    const posture = packet?.health_observation?.response?.feature_posture || {};
    for (const required of [
      'single_intake',
      'role_skill_catalog',
      'context_packet_persistence',
      'chat_history_persistence_required',
      'tenant_projection_queue',
      'current_work_projection',
    ]) {
      if (posture[required] !== true) problems.push(`feature_posture.${required}`);
    }
  }

  return { ok: problems.length === 0, problems };
}

function runSelfTest() {
  const base = {
    schema_id: 'xlooop.authority_decision_packet.v1',
    status: 'observed_unreconciled',
    production_changes_frozen: true,
    commercial_release_allowed: false,
    candidate_commit_sha: 'a'.repeat(40),
    exact_deployed_sha_verified: false,
    decision: { approver: null, approval_reference: null },
    rollback: { target_sha: null, rehearsal_reference: null },
    deployment: {
      reported_build: 'a'.repeat(7),
      contract_hash: 'b'.repeat(64),
      schema_head: null,
      environment: 'production',
      authority: 'production',
    },
    health_observation: {
      response: {
        status: 'ok',
        feature_posture: {},
      },
    },
    blocking_gaps: ['approval missing'],
  };
  const truthful = assessAuthorityPacket(base, false);
  const blocked = assessAuthorityPacket(base, true);
  if (!truthful.ok || blocked.ok || !blocked.problems.includes('authority_not_ratified')) {
    console.error('verify-authority-decision-packet self-test FAIL');
    process.exit(1);
  }
  console.log('verify-authority-decision-packet self-test PASS · truthful-unreconciled and release-block controls');
}

if (selfTest) {
  runSelfTest();
} else {
  try {
    const packet = JSON.parse(readFileSync(packetPath, 'utf8'));
    const result = assessAuthorityPacket(packet, requireRatified);
    if (!result.ok) {
      console.error(`verify-authority-decision-packet · FAIL-CLOSED · ${result.problems.join(',')}`);
      process.exit(1);
    }
    console.log(
      `verify-authority-decision-packet · PASS · status=${packet.status} release_allowed=${packet.commercial_release_allowed}`,
    );
  } catch (error) {
    console.error(
      `verify-authority-decision-packet · FAIL-CLOSED · ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}
