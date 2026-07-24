#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (file) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const rootLock = readJson('package-lock.json');
const mcpLock = readJson('packages/xlooop-mcp-server/package-lock.json');
const mcpPackage = readJson('packages/xlooop-mcp-server/package.json');

const requirements = [
  {
    lock: rootLock,
    path: 'node_modules/sharp',
    minimum: '0.35.0',
    advisories: ['GHSA-f88m-g3jw-g9cj'],
  },
  {
    lock: mcpLock,
    path: 'node_modules/fast-uri',
    minimum: '3.1.4',
    advisories: ['GHSA-v2hh-gcrm-f6hx', 'GHSA-4c8g-83qw-93j6'],
  },
  {
    lock: mcpLock,
    path: 'node_modules/hono',
    minimum: '4.12.27',
    advisories: [
      'GHSA-hvrm-45r6-mjfj',
      'GHSA-w62v-xxxg-mg59',
      'GHSA-xgm2-5f3f-mvvc',
      'GHSA-rv63-4mwf-qqc2',
      'GHSA-wgpf-jwqj-8h8p',
      'GHSA-88fw-hqm2-52qc',
      'GHSA-wwfh-h76j-fc44',
      'GHSA-j6c9-x7qj-28xf',
    ],
  },
  {
    lock: mcpLock,
    path: 'node_modules/@hono/node-server',
    minimum: '2.0.5',
    advisories: ['GHSA-frvp-7c67-39w9'],
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

if (mcpPackage.overrides?.['@hono/node-server'] !== '2.0.5') {
  failures.push('packages/xlooop-mcp-server must pin @hono/node-server override to 2.0.5');
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
