#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (file) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const failures = [];

const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor !== 22) failures.push(`Node ${process.versions.node} is installed; this authority stack requires Node 22.x`);

const scopes = [
  {
    label: 'backend',
    directory: '',
    packageFile: 'package.json',
    lockFile: 'package-lock.json',
    exactPins: true,
  },
  {
    label: 'MCP server',
    directory: 'packages/xlooop-mcp-server',
    packageFile: 'packages/xlooop-mcp-server/package.json',
    lockFile: 'packages/xlooop-mcp-server/package-lock.json',
    exactPins: false,
  },
];

let directCount = 0;
let verifiedDirectCount = 0;
for (const scope of scopes) {
  const pkg = readJson(scope.packageFile);
  const lock = readJson(scope.lockFile);
  const dependencies = { ...pkg.dependencies, ...pkg.devDependencies };
  const lockRoot = lock.packages?.[''] ?? {};
  const lockSpecs = { ...lockRoot.dependencies, ...lockRoot.devDependencies };

  for (const [name, expected] of Object.entries(dependencies)) {
    directCount += 1;
    const failureCountBefore = failures.length;
    const lockEntry = lock.packages?.[`node_modules/${name}`];
    if (!lockEntry) {
      failures.push(`${scope.label} ${name}: missing from ${scope.lockFile}`);
      continue;
    }
    if (lockSpecs[name] !== expected) {
      failures.push(
        `${scope.label} ${name}: lockfile spec=${String(lockSpecs[name])} package.json=${expected}`,
      );
    }
    if (scope.exactPins && lockEntry.version !== expected) {
      failures.push(`${scope.label} ${name}: lockfile=${lockEntry.version} package.json=${expected}`);
    }
    try {
      const installedFile = path.join(scope.directory, 'node_modules', name, 'package.json');
      const installed = readJson(installedFile).version;
      if (installed !== lockEntry.version) {
        failures.push(`${scope.label} ${name}: installed=${installed} lockfile=${lockEntry.version}`);
      }
    } catch {
      failures.push(`${scope.label} ${name}: not installed; run npm run bootstrap:local`);
    }
    if (failures.length === failureCountBefore) verifiedDirectCount += 1;
  }
}

if (failures.length) {
  console.error(`FAIL installed dependency parity (${failures.length}):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(
  `PASS installed dependency parity (${verifiedDirectCount}/${directCount} direct packages across backend + MCP server; Node ${process.versions.node})`,
);
