#!/usr/bin/env node

// Compatibility alias. Deployment authority is governed by DEPLOYED_SURFACES.yml;
// the former demo-era hosted-deployment JSON is preserved only in Git history.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const result = spawnSync(process.execPath, ['scripts/verify-deployed-surfaces.mjs'], {
  cwd: root,
  encoding: 'utf8',
});

process.stdout.write(result.stdout || '');
process.stderr.write(result.stderr || '');
if (result.status !== 0) process.exit(result.status ?? 1);
console.log('verify:hosted-deployment-evidence is a deprecated alias of verify:deployed-surfaces');
