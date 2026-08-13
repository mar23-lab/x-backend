#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const forbiddenRepositoryDependencies = [
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
    new RegExp(`X_${donor.replaceAll('-', '_').toUpperCase()}_ROOT`),
    new RegExp(`path\\.resolve\\([^\\n]+['\"]\\.\\.['\"][^\\n]+['\"]${escaped}['\"]`),
    new RegExp(`(?:^|['\"])(?:\\.\\./)+${escaped}(?:/|['\"])`, 'm'),
  ];
}

function walk(directory, output = []) {
  if (!fs.existsSync(directory)) return output;
  const stat = fs.statSync(directory);
  if (stat.isFile()) {
    output.push(directory);
    return output;
  }
  for (const entry of fs.readdirSync(directory)) {
    if (entry === 'node_modules' || entry === '.git') continue;
    walk(path.join(directory, entry), output);
  }
  return output;
}

function activeSourceFiles() {
  const verifierPath = fileURLToPath(import.meta.url);
  return [path.join(root, 'src'), path.join(root, 'scripts'), path.join(root, 'package.json')]
    .flatMap((entry) => walk(entry))
    .filter((entry) => entry !== verifierPath && /(?:\.(?:js|mjs|cjs|ts|tsx|sh)|package\.json)$/.test(entry));
}

if (process.argv.includes('--self-test')) {
  const patterns = dependencyPatterns('Xlooop-XCP-demo');
  const cases = [
    ['/Users/test/WIP/Xlooop/Xlooop-XCP-demo/scripts/run.mjs', true],
    ['https://github.com/mar23-lab/Xlooop-XCP-demo/commit/abc', true],
    ['repos/mar23-lab/Xlooop-XCP-demo/commits/abc/check-runs', true],
    ['"consumer_repo": "Xlooop-XCP-demo"', true],
    ["path.resolve(repoRoot, '..', 'Xlooop-XCP-demo')", true],
    ['X_XLOOOP_XCP_DEMO_ROOT', true],
    ['/Users/test/WIP/Xlooop/x-backend/scripts/run.mjs', false],
  ];
  const passed = cases.filter(([value, expected]) => patterns.some((pattern) => pattern.test(value)) === expected).length;
  console.log(`${passed === cases.length ? 'PASS' : 'FAIL'} active repository dependency controls: ${passed}/${cases.length}`);
  process.exit(passed === cases.length ? 0 : 1);
}

for (const relative of operationalFiles) if (!fs.existsSync(path.join(root, relative))) failures.push(`${relative}:missing`);

const scannedFiles = activeSourceFiles();
if (scannedFiles.length === 0) failures.push('active source denominator is zero');
for (const absolute of scannedFiles) {
  const relative = path.relative(root, absolute);
  const text = fs.readFileSync(absolute, 'utf8');
  for (const repository of forbiddenRepositoryDependencies) {
    if (dependencyPatterns(repository).some((pattern) => pattern.test(text))) {
      failures.push(`${relative}:active filesystem or control dependency on ${repository}`);
    }
  }
}

if (failures.length) {
  console.error(`FAIL active repository dependencies (${failures.length})`);
  failures.forEach((failure) => console.error(` - ${failure}`));
  process.exit(1);
}

console.log(`PASS repository dependency boundaries: ${scannedFiles.length} active source files checked; 0 forbidden filesystem or control dependencies`);
