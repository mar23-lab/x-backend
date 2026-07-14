#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = fs.readFileSync(path.join(root, 'vitest.workers.config.ts'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const baseline = JSON.parse(fs.readFileSync(path.join(root, 'data/orphan-test-baseline.json'), 'utf8'));
const runner = fs.readFileSync(path.join(root, 'scripts/run-worker-test-batches.mjs'), 'utf8');
const failures = [];

if (pkg.scripts?.test !== 'node scripts/run-worker-test-batches.mjs') {
  failures.push('package test script does not invoke the complete bounded-batch runner');
}
if (!config.includes("include: ['src/workers/**/__tests__/**/*.test.ts']")) {
  failures.push('Workers Vitest configuration does not include the complete test glob');
}
if (baseline.max_orphans !== 0 || baseline.exempt.length !== 0) {
  failures.push('backend-only orphan baseline must remain empty');
}
if (!runner.includes("entry.name.endsWith('.test.ts')") || !runner.includes('files.sort()')) {
  failures.push('bounded-batch runner does not discover every test file deterministically');
}

let count = 0;
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(absolute);
    else if (entry.name.endsWith('.test.ts')) count += 1;
  }
}
walk(path.join(root, 'src/workers'));
if (count < 1) failures.push('no Workers tests discovered');

if (failures.length) {
  for (const failure of failures) console.error(`FAIL ${failure}`);
  process.exit(1);
}
console.log(`PASS no-orphan-worker-tests: complete glob governs ${count} test files; exceptions 0`);
