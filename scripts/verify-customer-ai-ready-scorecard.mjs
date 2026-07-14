#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const model = JSON.parse(fs.readFileSync(path.join(repoRoot, 'data/customer-onboarding-read-model.json'), 'utf8'));
const score = model.scorecard || {};
const failures = [];

for (const key of ['onboarding_readiness', 'ai_ready_ecosystem', 'source_coverage', 'privacy_safety', 'team_invite_readiness']) {
  if (typeof score[key] !== 'number') failures.push(`score missing ${key}`);
}
if ((score.ai_ready_ecosystem || 0) >= 85 && model.authority?.status !== 'confirmed') failures.push('AI-ready score cannot pass threshold while authority is pending');
if (score.verdict !== 'public_discovery_only_private_integrations_blocked') failures.push('initial verdict must block private integrations');

console.log(`verify-customer-ai-ready-scorecard · ${failures.length ? 'FAIL' : 'PASS'} · ai_ready=${score.ai_ready_ecosystem || 0}`);
if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
