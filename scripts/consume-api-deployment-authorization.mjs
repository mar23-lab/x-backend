#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { consumeDeploymentAuthorization } from './lib/deployment-authorization-store.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packetPath = process.env.XLOOOP_AUTHORITY_DECISION_PACKET;

function fail(message) {
  console.error(`consume-api-deployment-authorization · FAIL-CLOSED · ${message}`);
  process.exit(1);
}

if (!packetPath) fail('XLOOOP_AUTHORITY_DECISION_PACKET is required');
const verify = spawnSync(
  process.execPath,
  [path.join(root, 'scripts/verify-authority-decision-packet.mjs'), '--require-approved-to-deploy'],
  { cwd: root, env: process.env, encoding: 'utf8' },
);
if (verify.status !== 0) fail(verify.stderr || verify.stdout);

const packet = JSON.parse(readFileSync(path.resolve(packetPath), 'utf8'));
const authorizationId = packet?.decision?.authorization_id;
const backendSha = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: root,
  encoding: 'utf8',
}).trim();

try {
  consumeDeploymentAuthorization(root, 'api', authorizationId, {
    schema_id: 'xlooop.api_deployment_authorization_receipt.v1',
    authorization_id: authorizationId,
    approval_reference: packet.decision.approval_reference,
    backend_sha: backendSha,
    worker_name: packet.target.worker_name,
    state: 'reserved_before_deploy',
    reserved_at: new Date().toISOString(),
    consequence: 'a failed or interrupted deploy attempt requires a new operator authorization',
  });
} catch (error) {
  fail(
    error?.code === 'EEXIST'
      ? 'deployment authorization has already been consumed'
      : error instanceof Error ? error.message : String(error),
  );
}

console.log(
  `consume-api-deployment-authorization · RESERVED · backend=${backendSha}`
  + ` authorization=${authorizationId}`,
);
