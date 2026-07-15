#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';

const catalogPath = 'docs/contracts/role-skill-catalog.json';
const loaderPath = 'src/workers/lib/role-skill-catalog-loader.ts';
const catalogBytes = fs.readFileSync(catalogPath);
const loader = fs.readFileSync(loaderPath, 'utf8');
const actual = crypto.createHash('sha256').update(catalogBytes).digest('hex');
const declared = loader.match(/CATALOG_MANIFEST_SHA256\s*=\s*'([a-f0-9]{64})'/)?.[1] ?? null;

if (!declared || declared !== actual) {
  console.error(`FAIL role-skill catalog loader fingerprint drift: declared=${declared ?? 'missing'} actual=${actual}`);
  process.exit(1);
}

const catalog = JSON.parse(catalogBytes.toString('utf8'));
const assistance = catalog.entries?.find((entry) => entry.key === 'skill.workspace-assistant.grounded-assistance');
const requiredActions = ['assistant:answer', 'assistant:plan', 'assistant:digest', 'assistant:onboard', 'assistant:refine', 'assistant:enrich'];
const missing = requiredActions.filter((action) => !assistance?.actions?.includes(action));
if (missing.length) {
  console.error(`FAIL grounded-assistance catalog is missing runtime actions: ${missing.join(', ')}`);
  process.exit(1);
}

console.log(`PASS role-skill catalog loader fresh: ${actual.slice(0, 12)}… · ${requiredActions.length} assistant actions`);
