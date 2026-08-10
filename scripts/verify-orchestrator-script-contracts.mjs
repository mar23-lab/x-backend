#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function extractNpmRunNames(source) {
  const names = new Set();
  for (const match of source.matchAll(/\['run',([\s\S]*?)\]/g)) {
    const values = [...match[1].matchAll(/['"]([^'"]+)['"]/g)].map((row) => row[1]);
    const name = values.find((value) => !value.startsWith('-'));
    if (name) names.add(name);
  }
  for (const match of source.matchAll(/\bnpm\s+run(?:\s+--silent)?\s+([A-Za-z0-9:_-]+)/g)) {
    names.add(match[1]);
  }
  return [...names].sort();
}

if (process.argv.includes('--self-test')) {
  const sample = "run('a', 'npm', ['run', '--silent', 'verify:a']); npm run verify:b";
  const actual = extractNpmRunNames(sample);
  const ok = JSON.stringify(actual) === JSON.stringify(['verify:a', 'verify:b']);
  console.log(`orchestrator-script-contracts self-test ${ok ? 'PASS' : 'FAIL'} · ${actual.join(',')}`);
  process.exit(ok ? 0 : 1);
}

const pkg = JSON.parse(read('package.json'));
const declared = new Set(Object.keys(pkg.scripts || {}));
const criticalSources = [
  'scripts/verify-public-production-readiness-hard-stop.mjs',
  'scripts/verify-live-evidence-authority-matrix.mjs',
  'scripts/verify-api-mcp-live-canary-hard-stop.mjs',
  'scripts/ci-local.mjs',
];
const references = [];
const failures = [];

for (const relative of criticalSources) {
  if (!existsSync(path.join(root, relative))) {
    failures.push({ source: relative, script: null, reason: 'critical_orchestrator_missing' });
    continue;
  }
  for (const script of extractNpmRunNames(read(relative))) references.push({ source: relative, script });
}

for (const [source, values] of [
  ['data/cloud-deployment-readiness.json', JSON.parse(read('data/cloud-deployment-readiness.json')).required_local_gates || []],
  ['data/cloudflare-deployment-signal.json', JSON.parse(read('data/cloudflare-deployment-signal.json')).required_local_evidence || []],
]) {
  for (const script of values) references.push({ source, script });
}

for (const reference of references) {
  if (!declared.has(reference.script)) failures.push({ ...reference, reason: 'package_script_missing' });
}

for (const [name, command] of Object.entries(pkg.scripts || {})) {
  for (const dependency of extractNpmRunNames(String(command))) {
    if (!declared.has(dependency)) failures.push({ source: `package.json#${name}`, script: dependency, reason: 'package_dependency_missing' });
  }
}

const uniqueReferences = new Map(references.map((row) => [`${row.source}:${row.script}`, row]));
const report = {
  schema_id: 'xlooop.orchestrator_script_contracts.verifier.v1',
  status: failures.length ? 'FAIL' : 'PASS',
  orchestrator_count: criticalSources.length,
  declared_script_count: declared.size,
  reference_count: uniqueReferences.size,
  failure_count: failures.length,
  failures,
};
console.log(JSON.stringify(report, null, 2));
process.exit(failures.length ? 1 : 0);

function read(relative) {
  return readFileSync(path.join(root, relative), 'utf8');
}
