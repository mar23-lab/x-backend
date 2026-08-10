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
  const predeployMigrationGate = readFileSync(
    join(root, 'scripts', 'predeploy-migration-gate.mjs'),
    'utf8',
  );
  const deploy = pkg.scripts?.['deploy:api'];
  const dev = pkg.scripts?.['dev:api'];
  const bundle = pkg.scripts?.['verify:bundle'];
  const authorityDeploy = pkg.scripts?.['verify:authority-decision:deploy'];
  const authorityRatify = pkg.scripts?.['deploy:api:ratify'];
  if (typeof deploy !== 'string') throw new Error('scripts["deploy:api"] missing or not a string');
  const pairedDeploy = readFileSync(join(root, 'scripts', 'deploy-paired-prod.mjs'), 'utf8');
  const deployContract = `${deploy}\n${pairedDeploy}`;

  const missing = [];
  if (!/`BUILD_SHA:\$\{head\}`/.test(deployContract)) missing.push('--var BUILD_SHA:<sha>');
  if (!/`BUILD_TIME:\$\{new Date\(\)/.test(deployContract)) missing.push('--var BUILD_TIME:<iso>');
  if (!/`XLOOOP_SCHEMA_HEAD:\$\{process\.env\.XLOOOP_SCHEMA_HEAD\}`/.test(deployContract)) {
    missing.push('--var XLOOOP_SCHEMA_HEAD:$XLOOOP_SCHEMA_HEAD');
  }
  if (!/execFileSync\('git', \['rev-parse', 'HEAD'\]/.test(deployContract)
      || /rev-parse[^\n]+--short/.test(deployContract)) {
    missing.push('full 40-character git rev-parse HEAD');
  }
  if (!/verify-deploy-schema-head\.mjs/.test(deployContract)) {
    missing.push('verify-deploy-schema-head.mjs preflight');
  }
  // 260727 — the POST-deploy half. A gate's asserted set must cover every step it claims to protect.
  // BACKEND_REPOSITORY_OWNERSHIP.yml advertises a receipt_rule ("emit-deploy-receipt.mjs refuses
  // unless live /health build == local HEAD"), but the cutover dropped that step from deploy:api and
  // THIS gate did not notice — it asserted 3 of 4 steps and reported green while the 4th silently
  // vanished. Consequence, measured 260727: the committed receipt still read ccdc7c69/20260713 while
  // production served 3d7ade27 off-main. The readback is the only step that compares INTENT to LIVE
  // TRUTH, so it is the one that would have caught the fork. Assert it, and assert the propagation
  // window with it — a single-shot readback races the edge and would fail correct deploys.
  if (!/emit-deploy-receipt\.mjs/.test(deployContract)) {
    missing.push('post-deploy receipt step (npm run deploy:api:receipt) chained into deploy:api');
  }
  if (!/ratify-authority-decision-packet\.mjs/.test(deployContract)) {
    missing.push('post-deploy exact health ratification chained into deploy:api');
  }
  if (typeof authorityRatify !== 'string'
    || !/ratify-authority-decision-packet\.mjs/.test(authorityRatify)) {
    missing.push('scripts["deploy:api:ratify"] invoking the ratification producer');
  }
  const receiptScript = pkg.scripts?.['deploy:api:receipt'];
  if (typeof receiptScript !== 'string' || !/emit-deploy-receipt\.mjs/.test(receiptScript)) {
    missing.push('scripts["deploy:api:receipt"] invoking emit-deploy-receipt.mjs');
  } else if (!/--wait\s+\d+/.test(receiptScript)) {
    missing.push('deploy:api:receipt must pass --wait <seconds> (a single-shot /health readback races edge propagation)');
  }
  if (!/verify-operation-event-source-tool-constraint\.mjs[\s\S]{0,120}'--live'/.test(deployContract)) {
    missing.push('deploy:api live operation-event source-tool semantic proof');
  }
  if (!/preflight-model-runtime-keyring\.mjs/.test(deployContract)) {
    missing.push('model-runtime keyring secret preflight');
  }
  if (!/verify-operation-event-source-tool-constraint\.mjs/.test(predeployMigrationGate)
      || !/--live/.test(predeployMigrationGate)) {
    missing.push('raw wrangler predeploy live operation-event source-tool semantic proof');
  }
  if (!/assessAuthorityPacket\(api, 'deploy'/.test(deployContract)) {
    missing.push('verify:authority-decision:deploy preflight');
  }
  if (!/consumeDeploymentAuthorization\(ROOT, 'api'/.test(deployContract)) {
    missing.push('single-use API deployment authorization reservation');
  }
  if (
    typeof authorityDeploy !== 'string'
    || !/verify-authority-decision-packet\.mjs\s+--require-approved-to-deploy/.test(authorityDeploy)
  ) {
    missing.push('exact operator-approved authority packet verifier');
  }
  if (/DEPLOY_MIGRATION_GATE_NONPROD=1/.test(deployContract)) {
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

  console.log('☑ deploy-provenance-wiring · PASS · short-lived single-use approval, provenance, schema/object semantics, strict chat persistence, and idempotency retry protection are configured');
  process.exit(0);
} catch (err) {
  console.error(`✗ deploy-provenance-wiring · FAIL-CLOSED — could not verify deploy:api wiring: ${err.message}`);
  process.exit(1);
}
