#!/usr/bin/env node
// verify-api-contract-artifact.mjs · Wave C0.3 (260713) · regen-and-diff drift gate for the versioned
// producer contract. The committed docs/contracts/api-contract.v1.json must be byte-identical to a
// fresh emit — so any route/envelope/error/CORS change forces a visible contract regeneration in the
// same commit (and the consumer pin, x-ai-front backend-routes.snapshot.json, fails loudly on the
// hash change instead of drifting silently).

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ARTIFACT = join(REPO, 'docs/contracts/api-contract.v1.json');

if (!existsSync(ARTIFACT)) {
  console.error('✗ api-contract artifact missing — run `npm run contract:emit`');
  process.exit(1);
}

const committed = readFileSync(ARTIFACT, 'utf-8');
const fresh = execFileSync(process.execPath, [join(REPO, 'scripts/emit-api-contract.mjs'), '--stdout'], {
  encoding: 'utf-8',
});

if (committed !== fresh) {
  const c = JSON.parse(committed);
  const f = JSON.parse(fresh);
  console.error('✗ api-contract DRIFT — committed artifact != regeneration:');
  if (c.contract_hash !== f.contract_hash) {
    console.error(`  route surface changed: ${c.contract_hash.slice(0, 12)}… → ${f.contract_hash.slice(0, 12)}… (${c.routes.route_count} → ${f.routes.route_count} routes)`);
  } else {
    console.error('  envelope/errors/cors section changed (route hash unchanged)');
  }
  console.error('  Run `npm run contract:emit` and commit the regenerated artifact (+ update the x-ai-front pin).');
  process.exit(1);
}

const c = JSON.parse(committed);
console.log(`☑ api-contract artifact fresh · ${c.contract_version} @ ${c.contract_hash.slice(0, 12)}… · ${c.routes.route_count} routes · ${Object.keys(c.errors.code_to_status).length} error codes`);
