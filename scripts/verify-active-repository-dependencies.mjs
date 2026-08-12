#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const donorRepositories = [
  'Xlooop-XCP-demo',
  'x-biz',
  'x-docs',
  'x-engine-core',
  'x-front',
  'x-qa',
  'x-web',
  'xlooop-platform-starter',
];
const operationalFiles = [
  'scripts/ensure-mbp-projection-fresh.mjs',
  'scripts/generate-live-read-models.mjs',
  'scripts/generate-operations-live-stream.mjs',
  'scripts/livestream-push-cron.sh',
  'scripts/poll-mbp-operations-live-stream.mjs',
  'scripts/verify-cloudflare-deployment-signal.mjs',
  'scripts/verify-ecosystem-leverage-consumption.mjs',
  'scripts/verify-github-actions-runner-infra.mjs',
  'data/ecosystem-capability-consumer-manifest.json',
];
const failures = [];

function dependencyPatterns(donor) {
  const escaped = donor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [
    new RegExp(`/Users/[^\\s'\"]+/WIP/Xlooop/${escaped}(?:/|['\"])`),
    new RegExp(`(?:mar23-lab|x-ude)/${escaped}(?:/|['\"])`),
    new RegExp(`repos/[^/]+/${escaped}/commits/`),
    new RegExp(`['\"]?(?:consumer_repo|target_repo)['\"]?\\s*[=:]\\s*['\"]${escaped}['\"]`),
  ];
}

if (process.argv.includes('--self-test')) {
  const patterns = dependencyPatterns('Xlooop-XCP-demo');
  const cases = [
    ['/Users/test/WIP/Xlooop/Xlooop-XCP-demo/scripts/run.mjs', true],
    ['https://github.com/mar23-lab/Xlooop-XCP-demo/commit/abc', true],
    ['repos/mar23-lab/Xlooop-XCP-demo/commits/abc/check-runs', true],
    ['"consumer_repo": "Xlooop-XCP-demo"', true],
    ['/Users/test/WIP/Xlooop/x-backend/scripts/run.mjs', false],
  ];
  const passed = cases.filter(([value, expected]) => patterns.some((pattern) => pattern.test(value)) === expected).length;
  console.log(`${passed === cases.length ? 'PASS' : 'FAIL'} active repository dependency controls: ${passed}/${cases.length}`);
  process.exit(passed === cases.length ? 0 : 1);
}

for (const relative of operationalFiles) {
  const absolute = path.join(root, relative);
  if (!fs.existsSync(absolute)) {
    failures.push(`${relative}:missing`);
    continue;
  }
  const text = fs.readFileSync(absolute, 'utf8');
  for (const donor of donorRepositories) {
    if (dependencyPatterns(donor).some((pattern) => pattern.test(text))) {
      failures.push(`${relative}:active dependency on donor ${donor}`);
    }
  }
}

if (failures.length) {
  console.error(`FAIL active repository dependencies (${failures.length})`);
  failures.forEach((failure) => console.error(` - ${failure}`));
  process.exit(1);
}

console.log(`PASS active repository dependencies: ${operationalFiles.length} operational surfaces checked; 0 donor runtime dependencies`);
