#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testRoot = path.join(root, 'src/workers');
const batchSize = Number(process.env.XLOOOP_TEST_BATCH_SIZE || 4);
const batchCooldownMs = Number(process.env.XLOOOP_TEST_BATCH_COOLDOWN_MS || 3000);
const files = [];
const nodeEnvironmentTests = new Set([
  'src/workers/__tests__/role-skill-catalog-publisher.test.ts',
  // J-E TASK 1 (260719) · reads wrangler.toml + crons/index.ts via node:fs (unavailable in the workerd pool).
  'src/workers/__tests__/cron-registry-wrangler-parity.test.ts',
]);

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(absolute);
    else if (entry.name.endsWith('.test.ts')) files.push(path.relative(root, absolute));
  }
}
walk(testRoot);
files.sort();

if (!files.length) {
  console.error('FAIL no Workers test files found');
  process.exit(1);
}

const vitest = path.join(root, 'node_modules/vitest/vitest.mjs');
const workerFiles = files.filter((file) => !nodeEnvironmentTests.has(file));
const nodeFiles = files.filter((file) => nodeEnvironmentTests.has(file));

if (nodeFiles.length) {
  console.log(`\n=== Node-environment tests (${nodeFiles.length} files) ===`);
  const result = spawnSync(process.execPath, [vitest, 'run', '--maxWorkers=1', '--no-file-parallelism', ...nodeFiles], {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
  await new Promise((resolve) => setTimeout(resolve, batchCooldownMs));
}

const batches = Math.ceil(workerFiles.length / batchSize);
for (let offset = 0; offset < workerFiles.length; offset += batchSize) {
  const batch = workerFiles.slice(offset, offset + batchSize);
  const index = Math.floor(offset / batchSize) + 1;
  console.log(`\n=== Workers tests batch ${index}/${batches} (${batch.length} files) ===`);
  const result = spawnSync(process.execPath, [
    vitest,
    'run',
    '--config', 'vitest.workers.config.ts',
    '--maxWorkers=1',
    '--no-file-parallelism',
    ...batch,
  ], { cwd: root, stdio: 'inherit', env: process.env });
  if (result.status !== 0) process.exit(result.status ?? 1);
  if (index < batches) await new Promise((resolve) => setTimeout(resolve, batchCooldownMs));
}

console.log(`\nPASS complete backend suite: ${files.length}/${files.length} files (${nodeFiles.length} Node, ${workerFiles.length} Workers) in ${batches} bounded Workers batches`);
