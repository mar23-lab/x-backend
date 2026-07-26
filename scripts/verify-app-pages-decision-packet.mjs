#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assessPagesDecisionPacket } from './lib/app-pages-release-contract.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const selfTest = process.argv.includes('--self-test');

function fixture() {
  return {
    schema_id: 'xlooop.app_pages_deployment_decision.v1',
    status: 'approved_to_deploy',
    deployment_allowed: true,
    commercial_release_allowed: false,
    decision: {
      approver: 'operator',
      approval_reference: 'conversation:approval-1',
      approved_at: '2026-07-26T00:00:00Z',
      authorization_id: '78b80df7-a1e6-4cbc-8d51-8cd4250e329d',
      expires_at: '2026-07-26T00:30:00Z',
    },
    target: {
      operation: 'deploy_pages',
      project_name: 'xlooop-app',
      branch: 'main',
      environment: 'production',
    },
    candidate: {
      frontend_sha: 'a'.repeat(40),
      backend_sha: 'b'.repeat(40),
    },
    rollback: {
      frontend_sha: 'c'.repeat(40),
      cloudflare_deployment_id: '5c20d49c-957b-4a89-8379-7e4bb1bde936',
      evidence_reference: 'wrangler:pages-deployments-list:2026-07-26',
    },
    expected_deployment: {
      api_base: 'https://api.xlooop.com',
      schema_head: 89,
      contract_hash: 'd'.repeat(64),
      environment: 'production',
      authority: 'production',
      feature_posture: {
        single_intake: true,
        role_skill_catalog: true,
        context_packet_persistence: true,
        chat_history_persistence_required: true,
        tenant_projection_queue: false,
        current_work_projection: false,
      },
    },
  };
}

if (selfTest) {
  const approved = fixture();
  const expected = {
    frontend_sha: approved.candidate.frontend_sha,
    backend_sha: approved.candidate.backend_sha,
    contract_hash: approved.expected_deployment.contract_hash,
    schema_head: approved.expected_deployment.schema_head,
    feature_posture: approved.expected_deployment.feature_posture,
    now: '2026-07-26T00:10:00Z',
  };
  const cases = [
    ['approved', assessPagesDecisionPacket(approved, expected).ok],
    ['unapproved', !assessPagesDecisionPacket({ ...approved, status: 'draft' }, expected).ok],
    ['wrong frontend', !assessPagesDecisionPacket({
      ...approved,
      candidate: { ...approved.candidate, frontend_sha: 'e'.repeat(40) },
    }, expected).ok],
    ['wrong backend', !assessPagesDecisionPacket({
      ...approved,
      candidate: { ...approved.candidate, backend_sha: 'e'.repeat(40) },
    }, expected).ok],
    ['commercial claim', !assessPagesDecisionPacket({
      ...approved,
      commercial_release_allowed: true,
    }, expected).ok],
    ['expired approval', !assessPagesDecisionPacket({
      ...approved,
      decision: { ...approved.decision, expires_at: '2026-07-26T00:05:00Z' },
    }, expected).ok],
    ['overlong approval', !assessPagesDecisionPacket({
      ...approved,
      decision: { ...approved.decision, expires_at: '2026-07-26T00:30:01Z' },
    }, expected).ok],
    ['future approval', !assessPagesDecisionPacket({
      ...approved,
      decision: {
        ...approved.decision,
        approved_at: '2026-07-26T00:11:00Z',
        expires_at: '2026-07-26T00:30:00Z',
      },
    }, expected).ok],
    ['same rollback', !assessPagesDecisionPacket({
      ...approved,
      rollback: { ...approved.rollback, frontend_sha: approved.candidate.frontend_sha },
    }, expected).ok],
  ];
  const failures = cases.filter(([, ok]) => !ok).map(([name]) => name);
  if (failures.length) {
    console.error(`verify-app-pages-decision-packet self-test · FAIL · ${failures.join(',')}`);
    process.exit(1);
  }
  console.log(`verify-app-pages-decision-packet self-test · PASS ${cases.length}/${cases.length}`);
  process.exit(0);
}

try {
  const packetPath = process.env.XLOOOP_APP_PAGES_DECISION_PACKET;
  const releaseDir = path.resolve(
    process.env.XLOOOP_APP_PAGES_RELEASE_DIR || path.join(root, 'dist-app-pages-release'),
  );
  if (!packetPath) throw new Error('XLOOOP_APP_PAGES_DECISION_PACKET is required');
  const packet = JSON.parse(readFileSync(path.resolve(packetPath), 'utf8'));
  const manifest = JSON.parse(readFileSync(path.join(releaseDir, 'release-manifest.json'), 'utf8'));
  const backendSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const result = assessPagesDecisionPacket(packet, {
    frontend_sha: manifest.frontend_sha,
    backend_sha: backendSha,
    contract_hash: manifest.contract_hash,
    schema_head: manifest.schema_head,
    feature_posture: manifest.feature_posture,
    now: new Date().toISOString(),
  });
  if (!result.ok) throw new Error(result.problems.join(','));
  console.log(
    `verify-app-pages-decision-packet · PASS · frontend=${manifest.frontend_sha} backend=${backendSha}`,
  );
} catch (error) {
  console.error(
    `verify-app-pages-decision-packet · FAIL-CLOSED · ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
