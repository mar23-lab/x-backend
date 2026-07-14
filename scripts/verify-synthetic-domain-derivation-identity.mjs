#!/usr/bin/env node
// Verifies stable synthetic-domain identity, source lineage, and derivation fingerprint wiring.

import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..');

let passed = 0;
let failed = 0;
const failures = [];

async function read(rel) {
  return fs.readFile(path.join(repoRoot, rel), 'utf8');
}

async function gate(name, fn) {
  try {
    const result = await fn();
    if (result === true) {
      passed += 1;
      console.log(`  ok ${name}`);
    } else {
      failed += 1;
      failures.push({ name, reason: String(result || 'falsy') });
      console.log(`  fail ${name} - ${String(result || 'falsy')}`);
    }
  } catch (err) {
    failed += 1;
    const reason = err && err.message ? err.message : String(err);
    failures.push({ name, reason });
    console.log(`  fail ${name} - ${reason}`);
  }
}

console.log('verify-synthetic-domain-derivation-identity\n');

await gate('migration 015 exists', async () => {
  return existsSync(path.join(repoRoot, 'src/workers/db/migrations/015_synthetic_domain_derivation_identity.sql'));
});

await gate('migration adds lineage and fingerprint columns', async () => {
  const src = await read('src/workers/db/migrations/015_synthetic_domain_derivation_identity.sql');
  for (const token of [
    'ADD COLUMN IF NOT EXISTS source_domains',
    'ADD COLUMN IF NOT EXISTS derivation_fingerprint',
    'ADD COLUMN IF NOT EXISTS derivation_version',
    'ADD COLUMN IF NOT EXISTS derivative_mutation_allowed',
    "chk_synthetic_derivation_fingerprint_shape",
    "idx_sd_source_domains_gin",
  ]) {
    if (!src.includes(token)) return `missing ${token}`;
  }
  return true;
});

await gate('types expose domain lineage and derivative mutation fields', async () => {
  const identity = await read('src/workers/dal/types/identity.ts');
  const types = await read('src/workers/dal/types/synthetic-domain.ts');
  for (const token of [
    'export type DomainId',
    'SyntheticDerivativeMutationKind',
    "domain_id_in",
    'source_domains: DomainId[]',
    'derivation_fingerprint: string | null',
    'derivation_version: number',
    'derivative_mutation_allowed: SyntheticDerivativeMutationKind[]',
  ]) {
    if (!(identity + types).includes(token)) return `missing ${token}`;
  }
  return true;
});

await gate('fingerprint helper uses canonical sorted SHA-256 inputs', async () => {
  const helper = await read('src/workers/dal/synthetic-domain-identity.ts');
  for (const token of [
    'stableUniqueSorted(input.source_domains)',
    'normalizeBinding(input.binding)',
    'purpose_key',
    "digest('SHA-256'",
    'sdsrc:sha256:',
  ]) {
    if (!helper.includes(token)) return `missing ${token}`;
  }
  return true;
});

await gate('DAL creates and versions derivation identity', async () => {
  const dal = await read('src/workers/dal/WorkersDalAdapter.ts');
  for (const token of [
    'normalizeSyntheticSourceDomains(input.source_domains',
    'computeSyntheticDerivationFingerprint',
    'source_domains, derivation_fingerprint, derivation_version',
    'derivative_mutation_allowed',
    'WHEN synthetic_domains.derivation_fingerprint IS DISTINCT FROM EXCLUDED.derivation_fingerprint',
    'WHEN derivation_fingerprint IS DISTINCT FROM',
  ]) {
    if (!dal.includes(token)) return `missing ${token}`;
  }
  return true;
});

await gate('route accepts explicit derivation lineage fields', async () => {
  const route = await read('src/workers/routes/synthetic-domains.ts');
  for (const token of [
    'source_domains: body.source_domains',
    'derivation_fingerprint: body.derivation_fingerprint',
    'derivation_version: body.derivation_version',
    'derivative_mutation_allowed: body.derivative_mutation_allowed',
  ]) {
    if (!route.includes(token)) return `missing ${token}`;
  }
  return true;
});

await gate('architecture doc forbids concatenated primary IDs', async () => {
  const doc = await read('docs/architecture/synthetic-domain-derivation-identity.md');
  for (const token of [
    'synthetic_domain_id = stable primary identity',
    'source_domains = explicit origin domain refs',
    'derivation_fingerprint = deterministic dedupe key',
    'Do not concatenate origin domain IDs',
    'must not mutate source workspaces',
  ]) {
    if (!doc.includes(token)) return `missing ${token}`;
  }
  return true;
});

if (failed) {
  console.error(`\nsynthetic-domain-derivation-identity: FAIL passed=${passed} failed=${failed}`);
  console.error(JSON.stringify(failures, null, 2));
  process.exit(1);
}

console.log(`\nsynthetic-domain-derivation-identity: PASS passed=${passed}`);
