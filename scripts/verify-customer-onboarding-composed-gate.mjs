#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

const commands = [
  ['node', ['scripts/verify-customer-onboarding-standard.mjs']],
  ['node', ['scripts/seam-gates/run.mjs', '--gate', 'customer-privacy-boundary']],
  ['node', ['scripts/verify-customer-projection-honesty.mjs']],
  ['node', ['scripts/verify-customer-workflow-opportunity-radar.mjs']],
  ['node', ['scripts/verify-customer-ai-ready-scorecard.mjs']],
  ['node', ['scripts/verify-aps-ecosystem-skeleton.mjs']],
  ['node', ['scripts/verify-customer-ip-boundary.mjs']],
  ['node', ['scripts/verify-customer-authority-gates.mjs']],
  ['node', ['scripts/verify-customer-ecosystem-template.mjs']],
  ['node', ['scripts/verify-customer-health-value-read-model.mjs']],
  ['node', ['scripts/verify-customer-delete-export.mjs']],
];

const failures = [];
for (const [cmd, args] of commands) {
  const result = spawnSync(cmd, args, {
    stdio: 'pipe',
    encoding: 'utf8',
    env: { ...process.env, XCP_VERIFY_READONLY: process.env.XCP_VERIFY_READONLY || '1' },
  });
  process.stdout.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
  if (result.status !== 0) failures.push(`${cmd} ${args.join(' ')}`);
}

console.log(`verify-customer-onboarding-composed-gate · ${failures.length ? 'FAIL' : 'PASS'} · checks=${commands.length}`);
if (failures.length) {
  console.error(`failed checks:\n${failures.join('\n')}`);
  process.exit(1);
}
