#!/usr/bin/env node

import {
  assessProductionDeployment,
  canonicalDeploymentMatches,
  deploymentShortId,
} from './lib/pages-production-promotion.mjs';

const sha = 'a'.repeat(40);
const id = '11111111-2222-4333-8444-555555555555';
const deployment = {
  id,
  short_id: '1234abcd',
  environment: 'production',
  latest_stage: { status: 'success' },
  deployment_trigger: { metadata: { commit_hash: sha } },
};
const checks = [
  ['extracts the exact uploaded deployment short id',
    deploymentShortId('Deployment complete: https://1234abcd.xlooop-app.pages.dev') === '1234abcd'],
  ['rejects output without an immutable deployment URL', deploymentShortId('Deployment complete') === null],
  ['accepts a successful exact production deployment',
    assessProductionDeployment(deployment, sha, '1234abcd').length === 0],
  ['rejects a different frontend SHA',
    assessProductionDeployment(deployment, 'b'.repeat(40), '1234abcd').includes('deployment_frontend_sha')],
  ['rejects a failed deployment',
    assessProductionDeployment({ ...deployment, latest_stage: { status: 'failure' } }, sha, '1234abcd')
      .includes('deployment_status')],
  ['requires canonical id and SHA parity', canonicalDeploymentMatches({ canonical_deployment: deployment }, deployment)],
  ['rejects canonical deployment id drift', !canonicalDeploymentMatches({
    canonical_deployment: { ...deployment, id: '99999999-8888-4777-8666-555555555555' },
  }, deployment)],
];
const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
for (const [name, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
if (failed.length) process.exit(1);
const passed = checks.filter(([, ok]) => ok).length;
const expected = 7;
if (checks.length !== expected || passed !== expected) process.exit(1);
console.log(`verify-pages-production-promotion · PASS · ${passed}/${expected}`);
