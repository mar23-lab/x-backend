#!/usr/bin/env node
// verify-deploy-provenance-wiring.mjs · ADR-ABS-004 · the deploy-provenance wiring gate.
//
// FAILURE CLASS: routes/health.ts emits `build` / `built_at` from env.BUILD_SHA / env.BUILD_TIME,
// documenting that they are "injected at `npm run deploy:api` (--var BUILD_SHA / BUILD_TIME)".
// If that injection is ever dropped from the deploy:api script (as it was, producing a live
// /health of build:"dev" / built_at:null on the customer plane), production carries NO attestable
// provenance — you cannot prove which commit is live. That regression is silent: the handler
// simply falls back to its dev defaults and every check still looks green.
//
// This static gate makes that class mechanically impossible: it asserts the deploy:api script
// still injects both vars, so a future edit that drops them fails ci-local instead of shipping a
// provenance hole. Fail-CLOSED on any parse error — provenance wiring must never be unverifiable.
//
// Authority: ADR-ABS-004 (deploy provenance) · HR-CONFIG-REALITY-MATCH-1 (no inference from constants).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

try {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const wrangler = readFileSync(join(root, 'wrangler.toml'), 'utf8');
  const pilotShadow = readFileSync(join(root, 'wrangler.pilot-shadow.toml'), 'utf8');
  const deploy = pkg.scripts?.['deploy:api'];
  const dev = pkg.scripts?.['dev:api'];
  const bundle = pkg.scripts?.['verify:bundle'];
  if (typeof deploy !== 'string') throw new Error('scripts["deploy:api"] missing or not a string');

  const missing = [];
  if (!/--var\s+BUILD_SHA:/.test(deploy)) missing.push('--var BUILD_SHA:<sha>');
  if (!/--var\s+BUILD_TIME:/.test(deploy)) missing.push('--var BUILD_TIME:<iso>');
  if (!/--var\s+XLOOOP_SCHEMA_HEAD:\$XLOOOP_SCHEMA_HEAD/.test(deploy)) {
    missing.push('--var XLOOOP_SCHEMA_HEAD:$XLOOOP_SCHEMA_HEAD');
  }
  if (!/git\s+rev-parse\s+HEAD/.test(deploy) || /git\s+rev-parse\s+--short\s+HEAD/.test(deploy)) {
    missing.push('full 40-character git rev-parse HEAD');
  }
  if (!/verify-deploy-schema-head\.mjs/.test(deploy)) {
    missing.push('verify-deploy-schema-head.mjs preflight');
  }
  if (/DEPLOY_MIGRATION_GATE_NONPROD=1/.test(deploy)) {
    missing.push('deploy:api must not opt out as non-production');
  }
  if (typeof dev !== 'string' || !/DEPLOY_MIGRATION_GATE_NONPROD=1/.test(dev)) {
    missing.push('dev:api explicit non-production migration-gate marker');
  }
  if (typeof bundle !== 'string' || !/DEPLOY_MIGRATION_GATE_NONPROD=1/.test(bundle)) {
    missing.push('verify:bundle explicit non-production migration-gate marker');
  }
  const keepVarsIndex = wrangler.search(/^keep_vars\s*=\s*true\s*$/m);
  const firstTableIndex = wrangler.search(/^\[/m);
  if (keepVarsIndex < 0 || (firstTableIndex >= 0 && keepVarsIndex > firstTableIndex)) {
    missing.push('top-level keep_vars = true before the first TOML table');
  }
  for (const [name, source] of [
    ['production', wrangler],
    ['pilot-shadow', pilotShadow],
  ]) {
    if (!/^CHAT_HISTORY_PERSISTENCE_REQUIRED\s*=\s*"true"\s*$/m.test(source)) {
      missing.push(`${name} CHAT_HISTORY_PERSISTENCE_REQUIRED = "true"`);
    }
    if (!/^IDEMPOTENCY_ENABLED\s*=\s*"true"\s*$/m.test(source)) {
      missing.push(`${name} IDEMPOTENCY_ENABLED = "true"`);
    }
  }

  if (missing.length) {
    console.error('✗ deploy-provenance-wiring · FAIL — deploy:api no longer injects deploy provenance.');
    console.error(`    missing injection(s): ${missing.join(', ')}`);
    console.error('    Consequence: live /health would emit build:"dev" / built_at:null — production is unattestable.');
    console.error('    Fix: restore full-SHA, build-time, and live-verified schema-head injection in scripts["deploy:api"].');
    process.exit(1);
  }

  console.log('☑ deploy-provenance-wiring · PASS · exact provenance, top-level keep_vars, strict chat persistence, and best-effort idempotency retry protection are configured');
  process.exit(0);
} catch (err) {
  console.error(`✗ deploy-provenance-wiring · FAIL-CLOSED — could not verify deploy:api wiring: ${err.message}`);
  process.exit(1);
}
