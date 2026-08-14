#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (file) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const rootLock = readJson('package-lock.json');
const rootPackage = readJson('package.json');
const mcpLock = readJson('packages/xlooop-mcp-server/package-lock.json');
const mcpPackage = readJson('packages/xlooop-mcp-server/package.json');

const requirements = [
  {
    lock: rootLock,
    path: 'node_modules/hono',
    minimum: '4.12.34',
    advisories: ['GHSA-54fx-42gc-7vw4', 'GHSA-79qm-7rj5-m7r9', 'GHSA-8j4g-w8fx-2239', 'GHSA-f23p-vx2j-j53r'],
  },
  {
    lock: rootLock,
    path: 'node_modules/nanoid',
    minimum: '5.1.16',
    advisories: ['GHSA-2v37-7h3g-55p8'],
  },
  {
    lock: rootLock,
    path: 'node_modules/postcss',
    minimum: '8.5.23',
    advisories: ['GHSA-fxqj-rqcc-2cmp'],
  },
  {
    lock: rootLock,
    path: 'node_modules/postcss/node_modules/nanoid',
    minimum: '3.3.18',
    advisories: ['GHSA-2v37-7h3g-55p8'],
  },
  {
    lock: rootLock,
    path: 'node_modules/undici',
    minimum: '7.29.0',
    advisories: [
      'GHSA-8xcm-r25x-g524',
      'GHSA-4cwx-7wf7-3272',
      'GHSA-m8rv-5g2x-5cg5',
      'GHSA-jr45-8vmc-qm54',
      'GHSA-v3r7-h72x-cjcm',
    ],
  },
  {
    lock: rootLock,
    path: 'node_modules/sharp',
    minimum: '0.35.0',
    advisories: ['GHSA-f88m-g3jw-g9cj'],
  },
  {
    lock: mcpLock,
    path: 'node_modules/fast-uri',
    minimum: '3.1.5',
    advisories: ['GHSA-v2hh-gcrm-f6hx', 'GHSA-4c8g-83qw-93j6', 'GHSA-7p8r-x3mc-p8w7'],
  },
  {
    lock: mcpLock,
    path: 'node_modules/hono',
    minimum: '4.12.34',
    advisories: [
      'GHSA-hvrm-45r6-mjfj',
      'GHSA-w62v-xxxg-mg59',
      'GHSA-xgm2-5f3f-mvvc',
      'GHSA-rv63-4mwf-qqc2',
      'GHSA-wgpf-jwqj-8h8p',
      'GHSA-88fw-hqm2-52qc',
      'GHSA-wwfh-h76j-fc44',
      'GHSA-j6c9-x7qj-28xf',
      'GHSA-54fx-42gc-7vw4',
      'GHSA-79qm-7rj5-m7r9',
      'GHSA-8j4g-w8fx-2239',
      'GHSA-f23p-vx2j-j53r',
    ],
  },
  {
    lock: mcpLock,
    path: 'node_modules/ip-address',
    minimum: '10.3.1',
    advisories: ['GHSA-22jq-vg5j-6vgg', 'GHSA-4xrf-jv44-h6hh', 'GHSA-mwp4-54f8-5fhr'],
  },
  {
    lock: mcpLock,
    path: 'node_modules/@hono/node-server',
    minimum: '2.0.10',
    advisories: ['GHSA-frvp-7c67-39w9', 'GHSA-9mqv-5hh9-4cgg'],
  },
  {
    lock: mcpLock,
    path: 'node_modules/body-parser',
    minimum: '2.3.0',
    advisories: ['GHSA-v422-hmwv-36x6'],
  },
];

const versionParts = (version) => {
  const parts = String(version).split('-', 1)[0].split('.').map(Number);
  if (parts.length !== 3 || parts.some((part) => !Number.isInteger(part) || part < 0)) {
    throw new Error(`unsupported version format: ${version}`);
  }
  return parts;
};

const isAtLeast = (actual, minimum) => {
  const actualParts = versionParts(actual);
  const minimumParts = versionParts(minimum);
  for (let index = 0; index < minimumParts.length; index += 1) {
    if (actualParts[index] > minimumParts[index]) return true;
    if (actualParts[index] < minimumParts[index]) return false;
  }
  return true;
};

const failures = [];
for (const requirement of requirements) {
  const actual = requirement.lock.packages?.[requirement.path]?.version;
  if (!actual) {
    failures.push(`${requirement.path}: missing from lockfile`);
    continue;
  }
  try {
    if (!isAtLeast(actual, requirement.minimum)) {
      failures.push(
        `${requirement.path}: ${actual} is below ${requirement.minimum} (${requirement.advisories.join(', ')})`,
      );
    }
  } catch (error) {
    failures.push(`${requirement.path}: ${error.message}`);
  }
}

if (mcpPackage.overrides?.['@hono/node-server'] !== '2.0.11') {
  failures.push('packages/xlooop-mcp-server must pin @hono/node-server override to 2.0.11');
}

const requiredMcpOverrides = {
  'fast-uri': '3.1.5',
  hono: '4.13.1',
  'ip-address': '10.3.1',
};
for (const [dependency, expected] of Object.entries(requiredMcpOverrides)) {
  if (mcpPackage.overrides?.[dependency] !== expected) {
    failures.push(`packages/xlooop-mcp-server must pin ${dependency} override to ${expected}`);
  }
}

const requiredRootDevDependencies = {
  '@cloudflare/vitest-pool-workers': '0.20.3',
  '@cloudflare/workers-types': '5.20260810.1',
  wrangler: '4.120.0',
};
for (const [dependency, expected] of Object.entries(requiredRootDevDependencies)) {
  if (rootPackage.devDependencies?.[dependency] !== expected) {
    failures.push(`root devDependency ${dependency} must be pinned to ${expected}`);
  }
}

if (rootPackage.overrides?.postcss?.['.'] !== '8.5.23') {
  failures.push('root postcss override must be pinned to 8.5.23');
}
if (rootPackage.overrides?.postcss?.nanoid !== '3.3.18') {
  failures.push('root postcss nanoid override must be pinned to 3.3.18');
}

if (failures.length) {
  console.error(`FAIL known dependency advisory floors (${failures.length}):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

const advisoryCount = requirements.reduce((count, requirement) => count + requirement.advisories.length, 0);
console.log(
  `PASS known dependency advisory floors (${requirements.length} packages; ${advisoryCount} GHSAs)`,
);
