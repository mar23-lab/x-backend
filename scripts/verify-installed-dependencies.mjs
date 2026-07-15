#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (file) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const pkg = readJson('package.json');
const lock = readJson('package-lock.json');
const failures = [];

const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor !== 22) failures.push(`Node ${process.versions.node} is installed; this authority stack requires Node 22.x`);

for (const [name, expected] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
  const lockEntry = lock.packages?.[`node_modules/${name}`];
  if (!lockEntry) {
    failures.push(`${name}: missing from package-lock.json`);
    continue;
  }
  if (lockEntry.version !== expected) failures.push(`${name}: lockfile=${lockEntry.version} package.json=${expected}`);
  try {
    const installed = readJson(`node_modules/${name}/package.json`).version;
    if (installed !== lockEntry.version) failures.push(`${name}: installed=${installed} lockfile=${lockEntry.version}`);
  } catch {
    failures.push(`${name}: not installed; run npm ci`);
  }
}

if (failures.length) {
  console.error(`FAIL installed dependency parity (${failures.length}):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

const directCount = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).length;
console.log(`PASS installed dependency parity (${directCount}/${directCount} direct packages; Node ${process.versions.node})`);
